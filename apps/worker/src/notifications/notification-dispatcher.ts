import { decideEmailStatus, notificationGroupKey } from '@contrataflow/types';
import type { DomainEventEnvelope } from '@contrataflow/types';
import { domainEventEnvelopeSchema } from '@contrataflow/validation';
import { z } from 'zod';

import type { SqlClient } from '#shared/database/outbox-database.js';

import { planNotification } from './notification-rules.js';
import type { NotificationPlan } from './notification-rules.js';
import { NotificationStore } from './notification-store.js';
import type { NotificationWriteOutcome } from './notification-store.js';
import { notificationMetrics } from './notification-telemetry.js';
import type { NotificationInstruments } from './notification-telemetry.js';
import { REGISTRY_DEFAULT_PREFERENCES, RecipientResolver } from './recipient-resolver.js';
import type {
  NotificationDirectory,
  NotificationPreferences,
  RecipientResolverDeps,
} from './recipient-resolver.js';
import { PermanentJobError } from '../queues/job-errors.js';
import type { HandlerResult, JobHandler, JobHandlerContext } from '../queues/run-job.js';

type Payload = Readonly<Record<string, unknown>>;

/** Enfileiramento do e-mail após o commit (padrão B — `jobId = notificationId`; US-112 consome). */
export interface EmailEnqueuer {
  enqueue(notificationId: string): Promise<void>;
}

export interface NotificationDispatcherDeps extends Omit<RecipientResolverDeps, 'directory'> {
  readonly directory: NotificationDirectory;
  readonly email: EmailEnqueuer;
  readonly preferences?: NotificationPreferences;
  readonly store?: Pick<NotificationStore, 'upsertGrouped'>;
  readonly now?: () => Date;
  readonly metrics?: NotificationInstruments;
}

const payloadSchema = z.strictObject({ envelope: domainEventEnvelopeSchema });
type NotificationJobPayload = z.infer<typeof payloadSchema>;

/**
 * `NotificationDispatcher` (US-111 · queues.md §4.2 · events.md §3/§6): consumidor da fila
 * `notifications` (`jobId = eventId`, alimentada pelo fan-out do `domain-events`). Aplica o registro
 * `NotificationType` ao evento, resolve os destinatários (nunca o ator, só quem vê o processo) e,
 * numa ÚNICA transação do tenant, grava/agrupa uma `Notification` por destinatário com o
 * `emailStatus` decidido — banco fora, nada fica gravado e o job é repetido pela política da fila.
 * Depois do commit, (re)enfileira o e-mail das `PENDING`. Idempotente por natureza: a reentrega
 * acha o evento na notificação e não grava nada (RN-NTF-03).
 */
export class NotificationDispatcher implements JobHandler<NotificationJobPayload> {
  readonly queue = 'notifications' as const;
  readonly name = 'event';
  readonly payloadSchema = payloadSchema;

  private readonly resolver: RecipientResolver;
  private readonly store: Pick<NotificationStore, 'upsertGrouped'>;
  private readonly preferences: NotificationPreferences;
  private readonly now: () => Date;
  private readonly metrics: NotificationInstruments;

  constructor(private readonly deps: NotificationDispatcherDeps) {
    this.resolver = new RecipientResolver(deps);
    this.store = deps.store ?? new NotificationStore();
    this.preferences = deps.preferences ?? REGISTRY_DEFAULT_PREFERENCES;
    this.now = deps.now ?? (() => new Date());
    this.metrics = deps.metrics ?? notificationMetrics();
  }

  async handle(
    payload: NotificationJobPayload,
    context: JobHandlerContext,
  ): Promise<HandlerResult> {
    const { envelope } = payload;
    const { logger } = context;
    if (envelope.tenantId !== context.meta.tenantId) {
      throw new PermanentJobError('TENANT_MISMATCH', 'notifications: tenant do evento ≠ do job');
    }
    const outcome = planNotification(envelope);
    if (outcome.kind === 'unmapped') {
      logger.warn({ event: 'notification.type_unmapped', eventType: envelope.eventType });
      return 'skipped';
    }
    if (outcome.kind !== 'notify') {
      logger.log({
        event: 'notification.not_applicable',
        eventType: envelope.eventType,
        ...(outcome.kind === 'deferred'
          ? { notificationType: outcome.type, owner: 'US-114' }
          : { reason: outcome.reason }),
      });
      return 'skipped';
    }

    const startedAt = Date.now();
    try {
      const written = await context.tenantTransaction((client) =>
        this.write(client, outcome, envelope, context),
      );
      for (const item of written) {
        if (item.emailStatus === 'PENDING') await this.deps.email.enqueue(item.notificationId);
      }
      if (written.length > 0) {
        logger.log({
          event: 'notification.dispatched',
          eventType: envelope.eventType,
          notificationType: outcome.type,
          recipientCount: written.length,
          groupedCount: written.filter((item) => item.kind === 'grouped').length,
          duplicateCount: written.filter((item) => item.kind === 'duplicate').length,
          durationMs: Date.now() - startedAt,
          correlationId: envelope.correlationId,
        });
      }
      return written.length > 0 ? 'completed' : 'skipped';
    } catch (error) {
      logger.error({
        event: 'notification.dispatch_failed',
        eventType: envelope.eventType,
        notificationType: outcome.type,
        errorCode: errorCodeOf(error),
        correlationId: envelope.correlationId,
      });
      throw error;
    }
  }

  private async write(
    client: SqlClient,
    plan: NotificationPlan,
    envelope: DomainEventEnvelope<Payload>,
    context: JobHandlerContext,
  ): Promise<NotificationWriteOutcome[]> {
    const tenantId = context.meta.tenantId;
    if (tenantId === null) return [];
    const now = this.now();
    const { recipients, unresolved } = await this.resolver.resolve(client, plan, envelope, now);
    if (recipients.length === 0) {
      context.logger.warn({
        event: 'notification.recipient_unresolved',
        eventType: envelope.eventType,
        notificationType: plan.type,
        reasons: unresolved.length > 0 ? unresolved : ['NO_RECIPIENT'],
      });
      return [];
    }
    const tenantEmailEnabled = await this.deps.directory.tenantEmailEnabled(client);
    const preferences = await this.preferences.emailPreferences(client, plan.type, recipients);
    const groupKey = notificationGroupKey(plan.type, plan.processId);
    const written: NotificationWriteOutcome[] = [];
    for (const recipientId of recipients) {
      const emailStatus = decideEmailStatus({
        type: plan.type,
        emailPreference: preferences.get(recipientId),
        tenantEmailEnabled,
      });
      const result = await this.store.upsertGrouped(client, {
        tenantId,
        recipientId,
        type: plan.type,
        priority: plan.priority,
        link: plan.link,
        processId: plan.processId,
        entityType: plan.entityType,
        entityId: plan.entityId,
        sourceEventId: envelope.eventId,
        groupKey,
        content: plan.content,
        emailStatus,
        now,
      });
      written.push(result);
      if (result.kind !== 'duplicate') {
        this.metrics.dispatched.add(1, { type: plan.type, outcome: result.kind });
        if (result.kind === 'inserted' && emailStatus === 'SKIPPED') {
          this.metrics.emailSkipped.add(1, { type: plan.type });
        }
      }
    }
    return written;
  }
}

/** Código técnico do erro para o log (nunca a mensagem, que pode trazer dados — DEC-138). */
function errorCodeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const { code, name } = error as { code?: unknown; name?: unknown };
    if (typeof code === 'string') return code;
    if (typeof name === 'string') return name;
  }
  return 'UNKNOWN';
}
