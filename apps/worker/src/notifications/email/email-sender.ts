import { z } from 'zod';

import type { AdvisoryLockResult } from '#shared/database/worker-database.js';
import { MailRejectedError } from '#shared/mail/mail-provider.js';
import type { MailProvider } from '#shared/mail/mail-provider.js';

import type { EmailPreparation, EmailSource } from './email-source.js';
import { emailMetrics } from './email-telemetry.js';
import type { EmailInstruments } from './email-telemetry.js';
import { buildMailMessage } from './mail-message.js';
import type { EmailSourceKind } from './mail-message.js';
import { PermanentJobError } from '../../queues/job-errors.js';
import type { HandlerResult, JobHandler, JobHandlerContext } from '../../queues/run-job.js';

/** `JobData` mínimo da fila `email` (queues.md §4.3): só a referência, nunca o endereço. */
export const emailJobPayloadSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('NOTIFICATION'), notificationId: z.uuid() }),
  z.strictObject({ kind: z.literal('INVITATION'), membershipId: z.uuid() }),
]);
export type EmailJobPayload = z.infer<typeof emailJobPayloadSchema>;

/**
 * Trava de envio por origem (`pg_try_advisory_lock` de sessão — `WorkerDatabase`): dois workers
 * com o mesmo job (reentrega de *stalled*) não enviam duas vezes — o segundo não pega a trava e
 * encerra sem efeito. A trava não segura transação: o I/O do provedor fica fora do banco.
 */
export interface EmailSendLock {
  withAdvisoryLock<T>(key: string, work: () => Promise<T>): Promise<AdvisoryLockResult<T>>;
}

export interface EmailSenderDeps {
  readonly provider: MailProvider;
  readonly lock: EmailSendLock;
  /** Remetente autenticado no domínio do produto (SPF/DKIM/DMARC — RN-NTF-19). */
  readonly from: string;
  readonly notifications: EmailSource;
  /** Convite (US-091): conteúdo e estado são da story dona; sem ela, o job vai para a DLQ. */
  readonly invitations?: EmailSource;
  readonly now?: () => Date;
  readonly metrics?: EmailInstruments;
}

interface Target {
  readonly kind: EmailSourceKind;
  readonly sourceId: string;
  readonly source: EmailSource;
  /** Campo de log do id (`notificationId`/`membershipId`). */
  readonly idField: 'notificationId' | 'membershipId';
}

/**
 * `EmailSender` — `SendTransactionalEmailJob` (US-112 · queues.md §4.3): consumidor da fila
 * `email` (`jobId = notificationId`). Padrão B: o registro de origem é o estado durável; o sender
 * 1. lê e revalida a origem numa transação curta do tenant (RLS) — não `PENDING` é no-op;
 *    tenant fora de `ACTIVE` ou e-mail desligado → `SKIPPED`; sem endereço ou sem template →
 *    `FAILED`;
 * 2. envia pelo `MailProvider` FORA da transação;
 * 3. grava o resultado noutra transação curta, condicional a `PENDING`: aceite → `SENT`;
 *    rejeição definitiva → `FAILED` sem DLQ; falha transitória → retentativa da fila e, na
 *    última, `FAILED` + DLQ (RN-NTF-16/17).
 * Roda também com o tenant suspenso (`ignoresTenantStatus`) justamente para gravar `SKIPPED`
 * em vez de deixar a notificação pendente para sempre (FA-04).
 */
export class EmailSender implements JobHandler<EmailJobPayload> {
  readonly queue = 'email' as const;
  readonly name = 'send';
  readonly payloadSchema = emailJobPayloadSchema;
  readonly ignoresTenantStatus = true;

  private readonly now: () => Date;
  private readonly metrics: EmailInstruments;

  constructor(private readonly deps: EmailSenderDeps) {
    this.now = deps.now ?? (() => new Date());
    this.metrics = deps.metrics ?? emailMetrics();
  }

  async handle(payload: EmailJobPayload, context: JobHandlerContext): Promise<HandlerResult> {
    const target = this.targetOf(payload, context);
    const lock = await this.deps.lock.withAdvisoryLock(
      `email:${target.kind}:${target.sourceId}`,
      () => this.deliver(target, context),
    );
    if (!lock.acquired || lock.result === undefined) {
      context.logger.log({
        event: 'email.concurrent_delivery',
        [target.idField]: target.sourceId,
        correlationId: context.meta.correlationId,
      });
      return 'skipped';
    }
    return lock.result;
  }

  private targetOf(payload: EmailJobPayload, context: JobHandlerContext): Target {
    if (payload.kind === 'NOTIFICATION') {
      return {
        kind: 'NOTIFICATION',
        sourceId: payload.notificationId,
        source: this.deps.notifications,
        idField: 'notificationId',
      };
    }
    if (!this.deps.invitations) {
      context.logger.error({
        event: 'email.invitation_source_missing',
        alert: true,
        membershipId: payload.membershipId,
      });
      throw new PermanentJobError('INVITATION_SOURCE_MISSING', 'convite sem origem registrada');
    }
    return {
      kind: 'INVITATION',
      sourceId: payload.membershipId,
      source: this.deps.invitations,
      idField: 'membershipId',
    };
  }

  private async deliver(target: Target, context: JobHandlerContext): Promise<HandlerResult> {
    const { logger, meta } = context;
    const tenantId = meta.tenantId;
    if (tenantId === null) {
      throw new PermanentJobError('TENANT_CONTEXT_REQUIRED', 'e-mail sem tenant');
    }
    const { source, kind, sourceId, idField } = target;
    const base = { [idField]: sourceId, correlationId: meta.correlationId };
    const preparation: EmailPreparation = await context.tenantTransaction((client) =>
      source.prepare(client, sourceId, tenantId),
    );

    switch (preparation.kind) {
      case 'missing':
        // V-01: log de erro e job concluído — não trava a fila nem vai para a DLQ.
        logger.error({ event: 'email.source_missing', kind, ...base });
        return 'skipped';
      case 'not-pending':
        // V-02 · RN-NTF-13: reentrega de algo já resolvido.
        logger.log({ event: 'email.already_processed', kind, status: preparation.status, ...base });
        return 'skipped';
      case 'skip':
        await context.tenantTransaction((client) => source.markSkipped(client, sourceId));
        this.metrics.skipped.add(1, { kind, reason: preparation.reason });
        logger.warn({ event: 'email.skipped', kind, reason: preparation.reason, ...base });
        return 'skipped';
      case 'fail':
        await context.tenantTransaction((client) =>
          source.markFailed(client, sourceId, preparation.error),
        );
        this.metrics.failed.add(1, { kind, reason: preparation.code });
        logger.error({
          event: 'email.failed',
          kind,
          errorCode: preparation.code,
          alert: true,
          ...base,
        });
        return 'completed';
      case 'send':
        break;
    }

    const message = buildMailMessage({
      kind,
      sourceId,
      from: this.deps.from,
      to: preparation.to,
      correlationId: meta.correlationId,
      content: preparation.content,
    });
    const provider = this.deps.provider.name;
    const startedAt = Date.now();
    try {
      await this.deps.provider.send(message, context.signal);
    } catch (error) {
      return this.onSendFailure(error, target, context, base);
    }
    const updated = await context.tenantTransaction((client) =>
      source.markSent(client, sourceId, this.now(), preparation.receipt),
    );
    this.metrics.sent.add(1, { kind, provider });
    logger.log({
      event: 'email.sent',
      kind,
      type: preparation.type,
      provider,
      durationMs: Date.now() - startedAt,
      ...base,
    });
    if (!updated) {
      // Outro caminho resolveu a linha durante o envio (não deveria, com a trava): registra.
      logger.warn({ event: 'email.sent_status_conflict', kind, ...base });
    }
    return 'completed';
  }

  private async onSendFailure(
    error: unknown,
    target: Target,
    context: JobHandlerContext,
    base: Readonly<Record<string, string>>,
  ): Promise<HandlerResult> {
    const { source, kind, sourceId } = target;
    const { logger } = context;
    const errorCode = errorCodeOf(error);
    if (error instanceof MailRejectedError) {
      await context.tenantTransaction((client) =>
        source.markFailed(client, sourceId, error.reason),
      );
      this.metrics.failed.add(1, { kind, reason: 'REJECTED' });
      logger.error({ event: 'email.failed', kind, errorCode, ...base });
      return 'completed';
    }
    if (context.attempt >= context.maxAttempts) {
      const reason = error instanceof Error && 'reason' in error ? String(error.reason) : errorCode;
      await context.tenantTransaction((client) =>
        source.markFailed(
          client,
          sourceId,
          `Tentativas esgotadas (${String(context.attempt)}): ${reason}`,
        ),
      );
      this.metrics.failed.add(1, { kind, reason: 'EXHAUSTED' });
      logger.error({
        event: 'email.failed',
        kind,
        errorCode,
        attempt: context.attempt,
        alert: true,
        ...base,
      });
    } else {
      logger.warn({ event: 'email.retry', kind, attempt: context.attempt, errorCode, ...base });
    }
    // Transitório: o `runJob` reaplica o backoff ou, na última tentativa, copia para a DLQ.
    throw error;
  }
}

/** Código técnico do erro (nunca a mensagem nem a resposta do provedor — DEC-138). */
function errorCodeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const { code, name } = error as { code?: unknown; name?: unknown };
    if (typeof code === 'string') return code;
    if (typeof name === 'string') return name;
  }
  return 'UNKNOWN';
}
