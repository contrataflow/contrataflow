import { PRESENCE_TTL_MS } from '@contrataflow/validation';
import type { DocumentPresenceDto } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import type { Counter } from '@opentelemetry/api';

import { requireRequestContext } from '#shared/context/request-context.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { DOCUMENT_PRESENCE_STORE } from '#shared/document/document-presence.js';
import type {
  DocumentPresenceEntry,
  DocumentPresenceStorePort,
} from '#shared/document/document-presence.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';

import { DocumentLifecycleService } from './document-lifecycle.service.js';
import type { DocumentContext, ResolvedDocumentActor } from './document-lifecycle.service.js';
import { documentNotEditable, sectionNotInTemplate } from './document.errors.js';
import { DOCUMENT_CLOCK, DOCUMENT_TRANSACTIONS } from './ports.js';
import type { DocumentClock, DocumentTransactions } from './ports.js';
import { IdentityFacade } from '../../identity/application/identity.facade.js';
import { otherActiveEditors } from '../domain/document-presence.js';
import { DOCUMENT_EDITABLE_PROCESS_STATUSES, isEditable } from '../domain/document.js';

/*
 * Indicador de edição concorrente (US-070 · DEC-055 · RN-DOC-87..94 · api/03-documents.md
 * DOC-24/25). `RegisterDocumentPresenceCommand` (heartbeat): numa leitura curta, documento visível
 * (404 — DEC-024) → com seções (422 `NOT_ALLOWED` — V-02) → a mesma regra de edição do DOC-05
 * (permissão de edição do tipo cobrindo o processo + custódia/participação + processo editável +
 * tipo na etapa + documento `DRAFT`/`RETURNED` — POL-02), aqui SEM negar com 403 nem auditar
 * `access.denied`: quem não pode editar recebe 409 `DOCUMENT_NOT_EDITABLE` e o indicador não é
 * exibido → grava/renova a presença no Redis (TTL 60 s) → nomes dos demais editores. Seção fora do
 * template: a presença é renovada com a seção anterior e a resposta é 422 (V-01, silenciosa no
 * front). Redis fora do ar: 200 com `editors: []` e `warn presence.store_unavailable` — nunca
 * bloqueia a edição (RN-DOC-92). Sem evento, versão nem auditoria (RN-DOC-93).
 */

/** Intervalo mínimo entre logs `presence.store_unavailable` (um por minuto durante a queda). */
const UNAVAILABLE_LOG_INTERVAL_MS = 60_000;

type HeartbeatResult = 'alone' | 'with_editors' | 'degraded';

let heartbeatsCounter: Counter | undefined;

/** `document_presence_heartbeats_total{result}` — uso do indicador (DoD da US-070). */
function countHeartbeat(result: HeartbeatResult): void {
  heartbeatsCounter ??= metrics
    .getMeter('contrataflow-api')
    .createCounter('document_presence_heartbeats_total', {
      description: 'Heartbeats de presença no editor (DOC-24), por resultado.',
    });
  heartbeatsCounter.add(1, { result });
}

/** Presença indisponível no armazenamento: um `warn` por minuto (o heartbeat segue degradado). */
class UnavailableLog {
  private lastLogAt = 0;

  constructor(private readonly logger: Logger) {}

  report(error: unknown, operation: 'heartbeat' | 'leave'): void {
    const now = Date.now();
    if (now - this.lastLogAt < UNAVAILABLE_LOG_INTERVAL_MS) return;
    this.lastLogAt = now;
    this.logger.warn(
      {
        event: 'presence.store_unavailable',
        operation,
        cause: error instanceof Error ? error.name : 'unknown',
      },
      'presence.store_unavailable',
    );
  }
}

export interface RegisterDocumentPresenceInput {
  readonly documentId: string;
  readonly sectionKey: string | undefined;
}

/** A regra de edição do DOC-05 (POL-02), sem lançar: `false` = 409 no heartbeat. */
function canEdit(
  context: DocumentContext,
  actor: ResolvedDocumentActor,
  typeAllowedInStage: boolean,
): boolean {
  return (
    actor.canEditType &&
    (actor.isCustodian || actor.isCollaborator) &&
    DOCUMENT_EDITABLE_PROCESS_STATUSES.has(context.process.status) &&
    typeAllowedInStage &&
    isEditable(context.document)
  );
}

@Injectable()
export class RegisterDocumentPresenceCommand {
  private readonly logger = new Logger('DocumentPresence');
  private readonly unavailable = new UnavailableLog(this.logger);

  constructor(
    @Inject(DOCUMENT_TRANSACTIONS) private readonly transactions: DocumentTransactions,
    @Inject(DOCUMENT_PRESENCE_STORE) private readonly store: DocumentPresenceStorePort,
    @Inject(DOCUMENT_CLOCK) private readonly clock: DocumentClock,
    private readonly lifecycle: DocumentLifecycleService,
    private readonly identity: IdentityFacade,
  ) {}

  execute(input: RegisterDocumentPresenceInput): Promise<DocumentPresenceDto> {
    const request = requireRequestContext();
    const tenantId = request.tenantId ?? '';
    const userId = request.actor.userId ?? '';
    if (userId === '') throw new ApiError('UNAUTHENTICATED');
    return this.transactions.read(async (tx) => {
      const context = await this.lifecycle.load(tx, input.documentId);
      const sections = context.template?.sections ?? [];
      if (context.type.kind === 'UPLOADED' || sections.length === 0) {
        throw validationError([
          {
            field: 'id',
            code: 'NOT_ALLOWED',
            message: 'Este documento não tem seções editáveis.',
          },
        ]);
      }
      const actor = await this.lifecycle.actorOf(context);
      const { typeAllowedInStage } = this.lifecycle.processStateOf(context);
      if (!canEdit(context, actor, typeAllowedInStage)) {
        throw documentNotEditable(context.document);
      }
      const validSection =
        input.sectionKey === undefined ||
        sections.some((section) => section.key === input.sectionKey);

      const now = this.clock();
      let entries: readonly DocumentPresenceEntry[];
      try {
        entries = await this.store.touch({
          tenantId,
          documentId: context.document.id,
          userId,
          sectionKey: validSection ? (input.sectionKey ?? null) : null,
          now,
          ttlMs: PRESENCE_TTL_MS,
        });
      } catch (error) {
        this.unavailable.report(error, 'heartbeat');
        countHeartbeat('degraded');
        if (!validSection) throw sectionNotInTemplate();
        return { editors: [] };
      }
      if (!validSection) throw sectionNotInTemplate();

      this.sampleLog(entries, userId, now, context.document.id, tenantId);
      const others = otherActiveEditors(entries, userId, now, PRESENCE_TTL_MS);
      countHeartbeat(others.length === 0 ? 'alone' : 'with_editors');
      const names = await this.namesOf(
        tx,
        others.map((entry) => entry.userId),
      );
      return {
        editors: others.map((entry) => ({
          userId: entry.userId,
          name: names.get(entry.userId) ?? null,
          sectionKey: entry.sectionKey,
          since: entry.since.toISOString(),
        })),
      };
    });
  }

  private async namesOf(tx: TenantTx, userIds: readonly string[]): Promise<Map<string, string>> {
    return userIds.length === 0 ? new Map() : this.identity.userDisplayNames(tx, userIds);
  }

  /**
   * `info presence.heartbeat` com amostragem: só quando a presença começa ou troca de seção (o
   * `since` do chamador é este heartbeat) — nunca a cada heartbeat (1 a cada 20 s por editor).
   */
  private sampleLog(
    entries: readonly DocumentPresenceEntry[],
    userId: string,
    now: Date,
    documentId: string,
    tenantId: string,
  ): void {
    const own = entries.find((entry) => entry.userId === userId);
    if (own?.since.getTime() !== now.getTime()) return;
    this.logger.log(
      { event: 'presence.heartbeat', documentId, sectionKey: own.sectionKey, tenantId },
      'presence.heartbeat',
    );
  }
}

/**
 * DOC-25: encerra a presença do próprio usuário (sessão autenticada). Documento não visível ou de
 * outro tenant → 404 (DEC-024); armazenamento fora do ar → 204 do mesmo jeito (o TTL expira a
 * presença em até 60 s — RN-DOC-89).
 */
@Injectable()
export class RemoveDocumentPresenceCommand {
  private readonly logger = new Logger('DocumentPresence');
  private readonly unavailable = new UnavailableLog(this.logger);

  constructor(
    @Inject(DOCUMENT_TRANSACTIONS) private readonly transactions: DocumentTransactions,
    @Inject(DOCUMENT_PRESENCE_STORE) private readonly store: DocumentPresenceStorePort,
    private readonly lifecycle: DocumentLifecycleService,
  ) {}

  async execute(documentId: string): Promise<void> {
    const request = requireRequestContext();
    const userId = request.actor.userId ?? '';
    if (userId === '') throw new ApiError('UNAUTHENTICATED');
    const document = await this.transactions.read(
      async (tx) => (await this.lifecycle.load(tx, documentId)).document,
    );
    try {
      await this.store.remove({
        tenantId: request.tenantId ?? '',
        documentId: document.id,
        userId,
      });
    } catch (error) {
      this.unavailable.report(error, 'leave');
    }
  }
}
