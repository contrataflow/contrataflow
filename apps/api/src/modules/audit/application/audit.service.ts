import { AUDIT_ACTIONS, isAuditAction } from '@contrataflow/types';
import type { ActorType, AuditActionSpec, AuditCategory, AuditResult } from '@contrataflow/types';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';
import type {
  AuditCoalesceHint,
  AuditEntry,
  AuditOutcome,
  AuditTrailPort,
} from '#shared/audit/audit-trail.js';
import { AUDIT_SAMPLING_STORE } from '#shared/audit/sampling-store.js';
import type {
  AuditSamplingDecision,
  AuditSamplingStorePort,
} from '#shared/audit/sampling-store.js';
import { normalizeIp } from '#shared/context/client-address.js';
import { currentRequestContext, requireRequestContext } from '#shared/context/request-context.js';
import type { RequestContext } from '#shared/context/request-context.js';
import { isActiveTransaction } from '#shared/database/active-transaction.js';
import { isRetryableTransactionError, isTransientDatabaseError } from '#shared/database/errors.js';
import { isUuid, newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { AuditContractError, AuditUnavailableError } from './audit-errors.js';
import { auditMetrics } from './audit-telemetry.js';
import {
  AUDIT_CLOCK,
  AUDIT_LOG_STORE,
  AUDIT_TRANSACTIONS,
  AuditPartitionMissingError,
} from './ports.js';
import type { AuditClock, AuditLogStore, AuditTransactions } from './ports.js';
import { shouldCoalesce } from '../domain/audit-coalescer.js';
import { maskChanges, maskMetadata } from '../domain/audit-masking.js';
import { seal } from '../domain/audit-record.js';
import type { AuditRecord } from '../domain/audit-record.js';
import { columnText } from '../domain/canonical-json.js';

/** Ator do contexto → `ActorType` do registro (sem usuário identificado = tentativa de usuário). */
const ACTOR_TYPES: Readonly<Record<RequestContext['actor']['type'], ActorType>> = {
  ANONYMOUS: 'USER',
  USER: 'USER',
  SYSTEM: 'SYSTEM',
  PLATFORM_OPERATOR: 'PLATFORM_OPERATOR',
  INTEGRATION: 'INTEGRATION',
};

/** Intervalo mínimo entre logs agregados (`audit.coalesced`, `audit.sampling_unavailable`). */
const SUMMARY_LOG_INTERVAL_MS = 60_000;

/** Erros já registrados como `audit.write_failed` (não repetir o log em `recordStandalone`). */
const loggedFailures = new WeakSet<object>();

function assertActiveTransaction(tx: TenantTx): void {
  if (!isActiveTransaction(tx)) {
    throw new AuditContractError(
      'V-03',
      'AuditService.record exige o tx da transação ativa do caso de uso.',
    );
  }
}

function specOf(action: string): AuditActionSpec {
  if (!isAuditAction(action)) {
    throw new AuditContractError(
      'V-01',
      `ação fora do catálogo de events.md §7 (${action.slice(0, 80)}).`,
    );
  }
  return AUDIT_ACTIONS[action];
}

function optionalUuid(value: string | null | undefined, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (!isUuid(value)) throw new AuditContractError('IDS', `${field} não é um UUID.`);
  return value.toLowerCase();
}

/**
 * `AuditService` (US-073 · DEC-161 · ADR-009): completa o registro com o contexto da requisição ou
 * do job (RN-AUD-05), mascara `changes`/`metadata` (RN-AUD-03), aplica a coalescência (RN-AUD-06) e
 * a amostragem de `access.denied` (RN-AUD-07), calcula o `rowHash` (RN-AUD-08) e grava no `tx` do
 * caso de uso (RN-AUD-01). Não há configuração — de tenant ou de perfil — que desligue a gravação.
 */
@Injectable()
export class AuditService implements AuditTrailPort {
  private readonly logger = new Logger('Audit');
  private coalescedSinceLog = 0;
  private lastCoalescedLogAt = Number.NEGATIVE_INFINITY;
  private lastSamplingWarnAt = Number.NEGATIVE_INFINITY;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AUDIT_LOG_STORE) private readonly store: AuditLogStore,
    @Inject(AUDIT_TRANSACTIONS) private readonly transactions: AuditTransactions,
    @Inject(AUDIT_SAMPLING_STORE) private readonly sampling: AuditSamplingStorePort,
    @Inject(AUDIT_CLOCK) private readonly clock: AuditClock,
  ) {}

  async record(tx: TenantTx, entry: AuditEntry): Promise<AuditOutcome> {
    const startedAt = performance.now();
    assertActiveTransaction(tx);
    const spec = specOf(entry.action);
    const result = entry.result ?? 'SUCCESS';
    const reasonCode = columnText(entry.reasonCode, 80);
    if (result !== 'SUCCESS' && reasonCode === null) {
      throw new AuditContractError(
        'V-02',
        `${entry.action} com resultado ${result} exige reasonCode.`,
      );
    }
    const now = this.clock();
    const draft = this.draft(
      entry,
      spec.category,
      result,
      reasonCode,
      requireRequestContext(),
      now,
    );

    let { metadata } = draft;
    if (spec.coalescible && entry.coalesce) {
      if (await this.isCoalesced(tx, draft, entry.coalesce, now)) return { kind: 'coalesced' };
      metadata = {
        ...metadata,
        coalesce: {
          scope: entry.coalesce.scope ?? null,
          revision: entry.coalesce.revision,
          size: entry.coalesce.size,
        },
      };
    }
    if (entry.action === 'access.denied') {
      const sampled = await this.sample(draft);
      if (!sampled.record) return { kind: 'sampled_out' };
      if (sampled.suppressed > 0) metadata = { ...metadata, suppressedCount: sampled.suppressed };
    }

    const record = seal({ ...draft, metadata });
    try {
      await this.store.insert(tx, record);
    } catch (error) {
      throw this.writeFailed(error, record);
    }

    const durationMs = Math.round((performance.now() - startedAt) * 10) / 10;
    const telemetry = auditMetrics();
    telemetry.recorded.add(1, { category: record.category, result: record.result });
    telemetry.duration.record(durationMs, { category: record.category });
    this.logger.log(
      {
        event: 'audit.recorded',
        action: record.action,
        category: record.category,
        result: record.result,
        entityType: record.entityType,
        durationMs,
      },
      'audit.recorded',
    );
    return {
      kind: 'recorded',
      id: record.id,
      occurredAt: record.occurredAt,
      rowHash: record.rowHash,
    };
  }

  async recordStandalone(entry: AuditEntry): Promise<AuditOutcome> {
    const tenantId = currentRequestContext()?.tenantId ?? null;
    try {
      return await (tenantId === null
        ? this.transactions.inPlatform((tx) => this.record(tx, entry))
        : this.transactions.inTenant((tx) => this.record(tx, entry)));
    } catch (error) {
      if (
        !(error instanceof AuditContractError) &&
        !(typeof error === 'object' && error !== null && loggedFailures.has(error))
      ) {
        auditMetrics().writeFailed.add(1, { reason: 'database_unavailable' });
        this.logger.error(
          {
            event: 'audit.write_failed',
            action: entry.action,
            reason: error instanceof Error ? error.name : 'unknown',
          },
          'audit.write_failed',
        );
      }
      throw error;
    }
  }

  /** Registro completo a partir da entrada e do contexto (tudo explícito: tudo entra no hash). */
  private draft(
    entry: AuditEntry,
    category: AuditCategory,
    result: AuditResult,
    reasonCode: string | null,
    context: RequestContext,
    now: Date,
  ): AuditRecord {
    const actorType = ACTOR_TYPES[context.actor.type];
    const system = actorType === 'SYSTEM';
    const changes = entry.changes && entry.changes.length > 0 ? maskChanges(entry.changes) : null;
    return {
      id: newId(),
      occurredAt: now,
      tenantId: context.tenantId,
      actorType,
      actorUserId: system ? null : context.actor.userId,
      actorName: columnText(context.actor.name, 200),
      actorMembershipId: system ? null : context.actor.membershipId,
      onBehalfOfUserId: optionalUuid(context.actor.onBehalfOfUserId, 'onBehalfOfUserId'),
      action: entry.action,
      category,
      result,
      entityType: columnText(entry.entityType, 60),
      entityId: optionalUuid(entry.entityId, 'entityId'),
      processId: optionalUuid(entry.processId, 'processId'),
      changes,
      metadata: maskMetadata(entry.metadata ?? {}),
      reasonCode,
      ip: normalizeIp(context.ip),
      userAgent: columnText(context.userAgent, 512),
      correlationId: columnText(context.correlationId, 64),
      requestId: columnText(context.requestId, 64),
      sessionIdHash: context.sessionIdHash ?? null,
    };
  }

  /** RN-AUD-06: o último registro da chave na janela representa esta chamada? */
  private async isCoalesced(
    tx: TenantTx,
    draft: AuditRecord,
    hint: AuditCoalesceHint,
    now: Date,
  ): Promise<boolean> {
    const { tenantId, entityType, entityId, actorUserId } = draft;
    if (tenantId === null || entityType === null || entityId === null || actorUserId === null) {
      return false;
    }
    const policy = this.config.audit.coalesce;
    const last = await this.store.findLastCoalesced(tx, {
      tenantId,
      action: draft.action,
      entityType,
      entityId,
      actorUserId,
      scope: hint.scope ?? null,
      since: new Date(now.getTime() - policy.windowMs),
    });
    if (!shouldCoalesce(last, hint, policy)) return false;
    auditMetrics().coalesced.add(1, { action: draft.action });
    this.coalescedSinceLog += 1;
    if (now.getTime() - this.lastCoalescedLogAt >= SUMMARY_LOG_INTERVAL_MS) {
      this.logger.warn(
        { event: 'audit.coalesced', action: draft.action, suppressed: this.coalescedSinceLog },
        'audit.coalesced',
      );
      this.coalescedSinceLog = 0;
      this.lastCoalescedLogAt = now.getTime();
    }
    return true;
  }

  /** RN-AUD-07: amostragem por (tenant, usuário ou IP, ação); Redis fora → grava tudo. */
  private async sample(draft: AuditRecord): Promise<AuditSamplingDecision> {
    const subject = draft.actorUserId
      ? `u:${draft.actorUserId}`
      : draft.ip
        ? `ip:${draft.ip}`
        : 'anonymous';
    const { windowSeconds, maxPerWindow } = this.config.audit.accessDeniedSampling;
    try {
      const decision = await this.sampling.sample(
        { tenantId: draft.tenantId, subject, action: draft.action },
        windowSeconds,
        maxPerWindow,
      );
      if (!decision.record) auditMetrics().sampledOut.add(1);
      return decision;
    } catch (error) {
      const now = Date.now();
      if (now - this.lastSamplingWarnAt >= SUMMARY_LOG_INTERVAL_MS) {
        this.lastSamplingWarnAt = now;
        this.logger.warn(
          {
            event: 'audit.sampling_unavailable',
            reason: error instanceof Error ? error.name : 'unknown',
          },
          'audit.sampling_unavailable',
        );
      }
      return { record: true, suppressed: 0 };
    }
  }

  /** Falha do INSERT: log + métrica; partição ausente → 503 (a transação de negócio é desfeita). */
  private writeFailed(error: unknown, record: AuditRecord): unknown {
    // Deadlock/serialização: a TenantTransaction refaz a transação inteira (architecture.md §6.4).
    if (isRetryableTransactionError(error)) return error;
    const partitionMissing = error instanceof AuditPartitionMissingError;
    const reason = partitionMissing
      ? 'partition_missing'
      : isTransientDatabaseError(error)
        ? 'database_unavailable'
        : 'database_error';
    auditMetrics().writeFailed.add(1, { reason });
    if (partitionMissing) {
      this.logger.error(
        { event: 'audit.partition_missing', month: record.occurredAt.toISOString().slice(0, 7) },
        'audit.partition_missing',
      );
    }
    this.logger.error(
      {
        event: 'audit.write_failed',
        action: record.action,
        category: record.category,
        correlationId: record.correlationId,
        reason,
        errorName: error instanceof Error ? error.name : 'unknown',
      },
      'audit.write_failed',
    );
    // A stack (e a mensagem do banco) só em `debug` (story US-073 · Logs).
    this.logger.debug({ event: 'audit.write_failed', err: error }, 'audit.write_failed');
    const failure = partitionMissing ? new AuditUnavailableError(error) : error;
    if (typeof failure === 'object' && failure !== null) loggedFailures.add(failure);
    return failure;
  }
}
