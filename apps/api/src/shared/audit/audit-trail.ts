import type { AuditAction, AuditResult } from '@contrataflow/types';

import type { TenantTx } from '../database/prisma.js';

/*
 * Trilha de auditoria transacional (US-073 · DEC-161 · ADR-009) — porta do shared kernel, para que
 * qualquer módulo (inclusive os de nível 1, que não importam o módulo `audit`) e o pipeline HTTP
 * gravem auditoria. Implementada pelo `AuditService` do módulo `audit` (módulo global).
 *
 * Padrão obrigatório de todo caso de uso mutável:
 *
 *   await this.transaction.run(async (tx) => {
 *     const process = await this.processes.create(tx, input);
 *     await this.audit.record(tx, { action: 'process.create', entityType: 'Process',
 *       entityId: process.id, processId: process.id, metadata: { processCode: process.code } });
 *     return process;
 *   });
 *
 * Tenant, ator, IP, user-agent, correlação e sessão vêm do `RequestContext` (RN-AUD-05); a
 * categoria vem do catálogo `AUDIT_ACTIONS` (events.md §7). Falha ao gravar desfaz a transação.
 */

/** Campo alterado (RN-AUD-03): só o que mudou, com valores já mascarados pelo serviço. */
export interface AuditChange {
  /** Caminho do campo (`title`, `items[2].quantity`, `sections.JUSTIFICATION.content`). */
  readonly path: string;
  readonly old: unknown;
  readonly new: unknown;
}

/** Dados da ação coalescível (RN-AUD-06 · `document.draft_update`). */
export interface AuditCoalesceHint {
  /** Escopo dentro da entidade (ex.: a seção `JUSTIFICATION` do documento). */
  readonly scope?: string | null;
  /** Revisão atual (da seção) — salto maior que `maxRevisionGap` grava novo registro. */
  readonly revision: number;
  /** Tamanho atual do conteúdo — variação maior que `maxSizeVariationPct` grava novo registro. */
  readonly size: number;
}

export interface AuditEntry {
  /** Valor do catálogo fechado de events.md §7 (V-01). */
  readonly action: AuditAction;
  /** Padrão `SUCCESS`; `DENIED`/`FAILURE` exigem `reasonCode` (V-02). */
  readonly result?: AuditResult;
  readonly entityType?: string | null;
  readonly entityId?: string | null;
  readonly processId?: string | null;
  readonly changes?: readonly AuditChange[] | null;
  /** RN-AUD-04: `processCode`, `documentCode`, `fromStatus`/`toStatus`, `idempotencyKey`… */
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly reasonCode?: string | null;
  readonly coalesce?: AuditCoalesceHint;
  /**
   * Horário real do fato, para gravação POSTERIOR a ele (varredura de sessões — US-088: o fim da
   * sessão é o limite atingido, não o instante em que o job o detectou). Padrão: agora. Entra no
   * `rowHash` e escolhe a partição mensal. No futuro (> agora + 1 s) → `AuditContractError`.
   */
  readonly occurredAt?: Date;
  /**
   * Grava no máximo um registro por (tenant, ação, `occurredAt`, sessão) — idempotência de quem
   * pode repetir a gravação (varredura refeita depois de falha). Exige `sessionIdHash` e tenant
   * no contexto; o registro já existente devolve `{ kind: 'duplicate' }` sem gravar.
   */
  readonly oncePerSession?: boolean;
}

export type AuditOutcome =
  | {
      readonly kind: 'recorded';
      readonly id: string;
      readonly occurredAt: Date;
      readonly rowHash: string;
    }
  /** Coalescida (RN-AUD-06): o registro anterior da janela representa esta chamada. */
  | { readonly kind: 'coalesced' }
  /** Amostrada (RN-AUD-07): somada em `metadata.suppressedCount` do próximo registro. */
  | { readonly kind: 'sampled_out' }
  /** `oncePerSession`: a sessão já tem este registro (mesma ação e horário); nada foi gravado. */
  | { readonly kind: 'duplicate' };

export interface AuditTrailPort {
  /**
   * Grava no `tx` da transação do caso de uso (RN-AUD-01) — nunca abre transação própria. Erro de
   * contrato (V-01..V-03) ou de gravação propaga e desfaz a transação de negócio.
   */
  record(tx: TenantTx, entry: AuditEntry): Promise<AuditOutcome>;
  /**
   * Ação cujo único efeito persistente é a própria auditoria (acesso negado, início de sessão):
   * abre a transação do tenant do contexto — ou de plataforma, sem tenant (`tenantId` nulo) — e
   * grava nela.
   */
  recordStandalone(entry: AuditEntry): Promise<AuditOutcome>;
}

export const AUDIT_TRAIL = Symbol('AuditTrail');

/**
 * Negações de autorização sempre auditadas como `access.denied` (RN-AUD-10), sujeitas só à
 * amostragem de rajadas (RN-AUD-07).
 */
export const AUDITED_DENIAL_CODES: ReadonlySet<string> = new Set([
  'PERMISSION_DENIED',
  'MFA_REQUIRED',
  'MEMBERSHIP_INACTIVE',
  'TENANT_SUSPENDED',
  // US-095: violações de POL-13 (anti-escalonamento) e POL-12 (anti-bloqueio) na gestão de perfis.
  'PRIVILEGE_ESCALATION_FORBIDDEN',
  'LAST_ADMIN_REQUIRED',
]);
