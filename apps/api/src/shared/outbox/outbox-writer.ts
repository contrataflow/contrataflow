import type { DomainEventEnvelope } from '@contrataflow/types';
import type { DomainEventDraft } from '@contrataflow/validation';

import type { TenantTx } from '../database/prisma.js';

/*
 * Outbox transacional (US-082 · DEC-161 · DEC-072 · ADR-004) — porta do shared kernel, para que
 * qualquer módulo grave eventos de domínio sem importar o módulo `platform` (dono de
 * `OutboxEvent`, que implementa a porta e é global). Padrão obrigatório de todo caso de uso que
 * produz um fato de domínio (RN-FND-49):
 *
 *   await this.transaction.run(async (tx) => {
 *     const process = await this.processes.create(tx, input);
 *     await this.audit.record(tx, { action: 'process.create', ... });   // auditoria explícita
 *     await this.outbox.record(tx, ProcessCreated.of({                    // mesmo tx
 *       aggregateId: process.id, processId: process.id, payload: { ... } }));
 *     return process;
 *   });
 *
 * Tenant, ator e correlação vêm do `RequestContext`; o evento só é publicado pelo relay do worker
 * depois do commit. Nenhum caso de uso publica direto num broker.
 */

/** Envelope gravado (DEC-160), com o `occurredAt` do banco (`clock_timestamp()`). */
export type RecordedDomainEvent = DomainEventEnvelope<Record<string, unknown>>;

export interface OutboxWriterPort {
  /**
   * Valida o envelope e o payload (RN-FND-50), grava a linha `PENDING` no `tx` do caso de uso
   * (RN-FND-49), emite `pg_notify('cf_outbox')` (entregue só no commit) e executa os handlers
   * síncronos no mesmo `tx` (RN-FND-52). Qualquer erro propaga e desfaz a transação inteira.
   */
  record(tx: TenantTx, event: DomainEventDraft): Promise<RecordedDomainEvent>;
  /**
   * Como `record`, com `eventId` determinístico (chave natural do fato — ex.: UUID v5 de
   * `(tenant, mês, faixa)` do aviso de consumo de IA, US-116): se o id já existe no outbox, nada é
   * gravado nem despachado e devolve `null` (`INSERT … ON CONFLICT (id) DO NOTHING`).
   */
  recordOnce(
    tx: TenantTx,
    event: DomainEventDraft,
    eventId: string,
  ): Promise<RecordedDomainEvent | null>;
}

export const OUTBOX_WRITER = Symbol('OutboxWriter');

/**
 * Únicos handlers síncronos in-process do MVP 1 (DEC-161 · RN-FND-52): projeções que precisam ser
 * atômicas com o fato. Todo outro efeito é assíncrono, via relay e fila `domain-events`.
 */
export const SYNC_EVENT_HANDLER_NAMES = ['TimelineProjector', 'ProcessAccessProjector'] as const;

export type SyncEventHandlerName = (typeof SYNC_EVENT_HANDLER_NAMES)[number];

export interface SyncEventHandler {
  readonly name: SyncEventHandlerName;
  /** Padrões de routing key assinados (queues.md §7.1: `process.*`, `document.created.*`…). */
  readonly routingKeys: readonly string[];
  /**
   * Grava a projeção no `tx` do caso de uso — com `app.tenant_id` do tenant do evento, então a
   * RLS impede ler ou alterar outro tenant. Lançar desfaz agregado, evento e projeções.
   */
  handle(tx: TenantTx, event: RecordedDomainEvent): Promise<void>;
}

export interface SyncEventHandlerRegistryPort {
  /**
   * Registra o handler (no `onModuleInit` do módulo dono — US-059 timeline, US-001/US-047
   * `ProcessAccess`). Nome fora da lista fechada ou repetido → `SyncEventHandlerNotAllowedError`.
   */
  register(handler: SyncEventHandler): void;
}

export const SYNC_EVENT_HANDLERS = Symbol('SyncEventHandlers');

/** Registro de handler síncrono fora de RN-FND-52 (erro de programação, falha na subida). */
export class SyncEventHandlerNotAllowedError extends Error {
  constructor(name: string, reason: 'NOT_ALLOWED' | 'DUPLICATE') {
    super(
      reason === 'DUPLICATE'
        ? `Handler síncrono ${name} já registrado.`
        : `Handler síncrono ${name} não permitido: só ${SYNC_EVENT_HANDLER_NAMES.join(', ')} (RN-FND-52).`,
    );
    this.name = 'SyncEventHandlerNotAllowedError';
  }
}
