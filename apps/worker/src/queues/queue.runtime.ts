import { scrubText } from '@contrataflow/observability';
import type { QueueName } from '@contrataflow/types';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import { z } from 'zod';

import type { QueueRuntimeConfig } from '#config/queues.js';
import { createOutboxDatabase } from '#shared/database/outbox-database.js';
import type { OutboxDatabase } from '#shared/database/outbox-database.js';
import { createWorkerDatabase } from '#shared/database/worker-database.js';
import type { WorkerDatabase } from '#shared/database/worker-database.js';
import type { MailProvider } from '#shared/mail/mail-provider.js';
import { SmtpMailProvider } from '#shared/mail/smtp-mail-provider.js';

import { BullQueues } from './bull-queues.js';
import { CIRCUIT_STATE_VALUE, CircuitBreaker } from './circuit-breaker.js';
import { buildDeadLetterRecord, deadLetterJobId } from './dead-letter.js';
import { PermanentJobError } from './job-errors.js';
import { JobHandlerRegistry } from './job-handler-registry.js';
import { JobProducer } from './job-producer.js';
import { otelQueueMetrics } from './queue-metrics.js';
import type { QueueMetrics } from './queue-metrics.js';
import {
  QUEUE_POLICIES,
  WORKER_DEFAULTS,
  backoffStrategy,
  consumerConnection,
  queuePrefix,
} from './queue-options.js';
import type { ConsumedQueue } from './queue-options.js';
import { jobMetaOf, runJob } from './run-job.js';
import type { JobHandler, TenantStatusReader } from './run-job.js';
import { AuditSealTick, DeadlinesTick, MaintenanceDaily } from './scheduled-ticks.js';
import { checkSchedulerSla, syncSchedulers } from './schedulers.js';
import {
  DatabaseOperatorDirectory,
  JwksOperatorTokenVerifier,
  OperatorAuthenticator,
} from '../admin/operator-authenticator.js';
import { PlatformAuditWriter } from '../admin/platform-audit.js';
import type { RunningDashboard } from '../admin/queue-dashboard.js';
import { startQueueDashboard } from '../admin/queue-dashboard.js';
import { AuditSealer } from '../audit/audit-sealer.js';
import { DeadlineScanner } from '../deadlines/deadline-scanner.js';
import { RenditionRequesterLookup } from '../documents/rendition-requester.lookup.js';
import { AttachmentUploaderLookup } from '../files/attachment-uploader.lookup.js';
import { AiProposalsExpireTask } from '../maintenance/ai-proposals-expire.js';
import { AttachmentsAbandonTask } from '../maintenance/attachments-abandon.js';
import { HolidayYearGeneratorTask } from '../maintenance/holiday-year-generator.js';
import { ParticipantsExpireTask } from '../maintenance/participants-expire.js';
import { PreviewsExpireTask } from '../maintenance/previews-expire.js';
import { TenantHousekeepingJob } from '../maintenance/tenant-housekeeping.job.js';
import { ApprovalStakeholdersLookup } from '../notifications/approval-stakeholders.lookup.js';
import { EmailSender } from '../notifications/email/email-sender.js';
import { EmailTemplateRegistry } from '../notifications/email/email-templates.js';
import { InvitationEmailSource } from '../notifications/email/invitation-email-source.js';
import { NotificationEmailSource } from '../notifications/email/notification-email-source.js';
import { MentionNotifiedEffect } from '../notifications/mention-notified.effect.js';
import { NotificationDispatcher } from '../notifications/notification-dispatcher.js';
import { ProcessStakeholdersLookup } from '../notifications/process-stakeholders.lookup.js';
import { RoleHoldersLookup } from '../notifications/role-holders.lookup.js';
import { SqlNotificationDirectory } from '../notifications/sql-notification-directory.js';
import { SqlNotificationPreferences } from '../notifications/sql-notification-preferences.js';
import { SqlProcessVisibility } from '../notifications/sql-process-visibility.js';
import { SqlStageDeadlineSource } from '../notifications/stage-deadline.js';
import { OutboxPurgeJob } from '../outbox/outbox-purge.job.js';

export const QUEUE_RUNTIME_CONFIG = Symbol('QueueRuntimeConfig');
export const QUEUE_METRICS = Symbol('QueueMetrics');

/** Intervalo dos coletores de gauges (DLQ, breakers) e da checagem de SLA dos schedulers. */
const GAUGE_INTERVAL_MS = 15_000;
const SLA_INTERVAL_MS = 60_000;

/** Job com nome sem handler numa fila consumida: falha permanente → dead-letter. */
function unknownHandler(queue: QueueName): JobHandler {
  return {
    queue,
    name: '<sem handler>',
    payloadSchema: z.unknown(),
    handle: () => Promise.reject(new PermanentJobError('JOB_NOT_REGISTERED')),
  };
}

/** Estado do tenant pela tabela de plataforma `tenants` (colunas visíveis ao `cf_worker`). */
class DatabaseTenantStatusReader implements TenantStatusReader {
  constructor(private readonly database: WorkerDatabase) {}

  async findStatus(tenantId: string): Promise<string | null> {
    const { rows } = await this.database.platformTransaction((client) =>
      client.query<{ status: string }>('SELECT status::text AS status FROM tenants WHERE id = $1', [
        tenantId,
      ]),
    );
    return rows[0]?.status ?? null;
  }
}

/**
 * Processo de filas do worker (US-083 · DEC-052/163/164): um `Worker` BullMQ por fila com
 * handler registrado, todos pelo `runJob` (contrato comum, timeouts, classificação de erros,
 * dead-letter); schedulers únicos sincronizados no bootstrap de toda réplica; coletores de
 * métricas; e o Bull Board na porta interna. Encerra no shutdown gracioso (queues.md §14).
 */
@Injectable()
export class QueueRuntime implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('QueueRuntime');
  private readonly metrics: QueueMetrics;
  private readonly startedAt = new Date();
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly workers: Worker[] = [];
  private readonly timers: NodeJS.Timeout[] = [];
  private bull: BullQueues | undefined;
  private database: WorkerDatabase | undefined;
  private maintenance: OutboxDatabase | undefined;
  private dashboard: RunningDashboard | undefined;
  private producerInstance: JobProducer | undefined;
  private mailProvider: MailProvider | undefined;

  constructor(
    @Inject(QUEUE_RUNTIME_CONFIG) private readonly config: QueueRuntimeConfig,
    private readonly registry: JobHandlerRegistry,
    @Optional() @Inject(QUEUE_METRICS) metrics?: QueueMetrics,
  ) {
    this.metrics = metrics ?? otelQueueMetrics();
  }

  /** Produtor de jobs com `meta` do contexto (handlers que enfileiram filhos). */
  get producer(): JobProducer {
    if (!this.producerInstance) throw new Error('QueueRuntime ainda não inicializado');
    return this.producerInstance;
  }

  get queues(): BullQueues {
    if (!this.bull) throw new Error('QueueRuntime ainda não inicializado');
    return this.bull;
  }

  /** Circuit breaker da dependência (um por processo — `cf_circuit_breaker_state`). */
  breaker(dependency: string): CircuitBreaker {
    let breaker = this.breakers.get(dependency);
    if (!breaker) {
      breaker = new CircuitBreaker({ dependency });
      this.breakers.set(dependency, breaker);
    }
    return breaker;
  }

  onModuleInit(): void {
    const { redisUrl, appEnv, workerDatabaseUrl } = this.config;
    this.bull = new BullQueues({ redisUrl, appEnv });
    this.producerInstance = new JobProducer(this.bull);
    if (workerDatabaseUrl === null) {
      this.logger.warn({ event: 'worker.database_disabled' }, 'schedulers e TenantTransaction off');
      return;
    }
    this.database = createWorkerDatabase({ url: workerDatabaseUrl });
    const tickDeps = {
      producer: this.producerInstance,
      database: this.database,
      metrics: this.metrics,
      isHandled: (queue: QueueName, name: string) => this.registry.isHandled(queue, name),
    };
    this.registry
      .register(new DeadlinesTick(tickDeps))
      .register(new AuditSealTick(tickDeps))
      .register(new MaintenanceDaily(tickDeps))
      // US-055: prazos das etapas por tenant (`deadlines.tick` → `scan-tenant`).
      .register(new DeadlineScanner({ database: this.database }))
      // US-074: selagem horária por tenant (`audit-seal.tick` → `seal-tenant`).
      .register(new AuditSealer())
      // Tarefas diárias por tenant: cada módulo dono acrescenta a sua (US-106: calendário).
      .register(
        new TenantHousekeepingJob([
          new HolidayYearGeneratorTask(),
          new AiProposalsExpireTask(),
          // US-068 · RN-DOC-78: intenções de upload abandonadas há mais de 24 h.
          new AttachmentsAbandonTask(),
          // US-067 · RN-DOC-68: prévias em PDF vencidas.
          new PreviewsExpireTask(),
          // US-012 · RN-PROC-134: consultores com validade vencida.
          new ParticipantsExpireTask(),
        ]),
      );
    const producer = this.producerInstance;
    // US-111: as fontes que dependem de outros módulos entram com as stories donas — visibilidade
    // do processo (`ProcessAccess`, US-001/US-012), permissão por escopo (US-096) e os `lookups`
    // de processo, aprovação, anexo e renderização. Sem a fonte, o destinatário não é resolvido.
    // US-068: quem enviou o anexo rejeitado (`ATTACHMENT_UPLOADER`); US-067: quem pediu o PDF que
    // falhou (`RENDITION_REQUESTER`).
    // Um handler já registrado para a fila (testes de integração do runtime) prevalece.
    if (!this.registry.isHandled('notifications', 'event')) {
      this.registry.register(
        new NotificationDispatcher({
          directory: new SqlNotificationDirectory(),
          preferences: new SqlNotificationPreferences(),
          lookups: [
            new AttachmentUploaderLookup(),
            new RenditionRequesterLookup(),
            // US-051: detentores do perfil aprovador com competência sobre o processo.
            new RoleHoldersLookup(),
            // US-008: criador, responsável e participantes com `notify` (PROCESS_STATUS_CHANGED).
            new ProcessStakeholdersLookup(),
            // US-052: solicitante e responsáveis dos documentos cobertos (APPROVAL_DECIDED).
            new ApprovalStakeholdersLookup(),
          ],
          // US-072: visibilidade do processo (DEC-024) e `Mention.notifiedAt`.
          visibility: new SqlProcessVisibility(),
          effects: [new MentionNotifiedEffect()],
          // US-114: nome da etapa e fuso do tenant nos avisos de prazo.
          stageDeadlines: new SqlStageDeadlineSource(),
          email: {
            enqueue: (notificationId) =>
              producer.enqueue(
                'email',
                'send',
                { kind: 'NOTIFICATION', notificationId },
                { jobId: notificationId },
              ),
          },
        }),
      );
    }
    this.registerEmailSender(this.database);
    const { maintenanceDatabaseUrl } = this.config;
    if (maintenanceDatabaseUrl) {
      this.maintenance = createOutboxDatabase({
        url: maintenanceDatabaseUrl,
        poolSize: 1,
        statementTimeoutMs: 60_000,
        applicationName: 'contrataflow-maintenance',
      });
      this.registry.register(new OutboxPurgeJob(this.maintenance, this.database));
    }
  }

  /**
   * US-112: o `EmailSender` (fila `email`) sobe só com o e-mail configurado — sem ele, os jobs
   * esperam na fila. O convite (US-091) é a segunda origem de e-mail.
   */
  private registerEmailSender(database: WorkerDatabase): void {
    const { email } = this.config;
    if (this.registry.isHandled('email', 'send')) return;
    if (!email) {
      this.logger.warn({ event: 'email.disabled' }, 'SMTP_URL ausente: e-mails não serão enviados');
      return;
    }
    this.mailProvider = new SmtpMailProvider({ url: email.smtpUrl });
    this.registry.register(
      new EmailSender({
        provider: this.mailProvider,
        lock: database,
        from: email.from,
        notifications: new NotificationEmailSource(
          new EmailTemplateRegistry(email.appBaseUrl),
          new SqlNotificationDirectory(),
        ),
        // US-091: o convite gera o link no envio e grava só o hash do token.
        invitations: new InvitationEmailSource(email.appBaseUrl),
      }),
    );
  }

  async onApplicationBootstrap(): Promise<void> {
    const bull = this.queues;
    for (const queue of this.registry.queues()) this.startWorker(queue as ConsumedQueue);
    if (this.database) {
      await syncSchedulers((queue) => bull.queue(queue), new Date());
      this.every(SLA_INTERVAL_MS, () =>
        checkSchedulerSla(bull, this.metrics, this.startedAt, new Date()).then(() => undefined),
      );
    }
    this.every(GAUGE_INTERVAL_MS, async () => {
      for (const [dependency, breaker] of this.breakers) {
        this.metrics.circuitState(dependency, CIRCUIT_STATE_VALUE[breaker.state]);
      }
      this.metrics.deadLetterJobs(await bull.deadLetterCounts());
    });
    const { admin } = this.config;
    if (admin && this.database) {
      this.dashboard = await startQueueDashboard(
        {
          queues: bull.all(),
          authenticator: new OperatorAuthenticator(
            new JwksOperatorTokenVerifier({ issuer: admin.issuer, audience: admin.audience }),
            new DatabaseOperatorDirectory(this.database),
          ),
          audit: new PlatformAuditWriter(this.database),
        },
        admin.port,
      );
      this.logger.log({ event: 'worker.admin_started', port: this.dashboard.port });
    }
    this.logger.log(
      { event: 'worker.queues_started', queues: this.registry.queues() },
      'queue workers started',
    );
  }

  /**
   * Handlers que chegam depois do bootstrap — os jobs dos módulos da API, resolvidos num contexto
   * Nest próprio (DEC-052): registra e sobe o `Worker` das filas que ainda não tinham um.
   */
  consume(handlers: readonly JobHandler<never>[]): void {
    const running = new Set(this.registry.queues());
    for (const handler of handlers) this.registry.register(handler);
    const started = this.registry.queues().filter((queue) => !running.has(queue));
    for (const queue of started) this.startWorker(queue as ConsumedQueue);
    if (started.length > 0) {
      this.logger.log({ event: 'worker.queues_started', queues: started }, 'queue workers started');
    }
  }

  private every(intervalMs: number, task: () => Promise<void>): void {
    const timer = setInterval(() => {
      task().catch((error: unknown) => {
        this.logger.warn({ event: 'worker.collector_failed', cause: String(error) });
      });
    }, intervalMs);
    timer.unref();
    this.timers.push(timer);
  }

  private startWorker(queue: ConsumedQueue): void {
    const policy = QUEUE_POLICIES[queue];
    // RN-NTF-21: a cota do provedor de e-mail vem de `EMAIL_RATE_PER_SECOND` (plataforma).
    const emailRate = queue === 'email' ? this.config.email?.ratePerSecond : undefined;
    const limiter = emailRate
      ? { max: emailRate, duration: 1_000 }
      : policy.limiter && { ...policy.limiter };
    const tenants = this.database ? new DatabaseTenantStatusReader(this.database) : undefined;
    const databaseBreaker = this.database ? this.breaker('postgres') : undefined;
    const deps = {
      deadLetter: this.queues,
      metrics: this.metrics,
      timeoutMs: policy.timeoutMs,
      database: this.database,
      databaseBreaker,
      tenants,
    };
    const worker: Worker = new Worker(
      queue,
      (job: Job, token?: string) =>
        runJob(job, this.registry.get(queue, job.name) ?? unknownHandler(queue), {
          ...deps,
          postpone: (ms) => job.moveToDelayed(Date.now() + ms, token),
        }),
      {
        connection: consumerConnection(this.config.redisUrl),
        prefix: queuePrefix(this.config.appEnv),
        concurrency: policy.concurrency,
        ...(limiter ? { limiter } : {}),
        ...WORKER_DEFAULTS,
        settings: { backoffStrategy },
      },
    );
    worker.on('error', (error) => {
      this.logger.warn({
        event: 'queue.worker_error',
        queue,
        cause: error.name,
        message: scrubText(error.message).slice(0, 300),
      });
    });
    worker.on('failed', (job, error) => {
      // FA-02: job que derrubou o worker além do limite falha fora do `runJob` — a cópia na
      // dead-letter vem daqui (idempotente pelo `jobId`).
      if (!job || !/stalled more than allowable limit/i.test(error.message)) return;
      this.parkStalled(queue, job, error).catch((parkError: unknown) => {
        this.logger.error({ event: 'worker.dead_letter_failed', queue, cause: String(parkError) });
      });
    });
    this.workers.push(worker);
  }

  private async parkStalled(queue: string, job: Job, error: Error): Promise<void> {
    await this.queues.park(
      deadLetterJobId(queue, job.id ?? ''),
      buildDeadLetterRecord(
        {
          queue,
          jobName: job.name,
          jobId: job.id ?? '',
          attemptsMade: job.attemptsMade,
          enqueuedAt: job.timestamp,
          data: job.data,
          meta: jobMetaOf(job.data),
        },
        error,
        'TRANSIENT_EXHAUSTED',
        new Date(),
      ),
    );
    this.logger.error({
      event: 'worker.job_dead_lettered',
      alert: true,
      queue,
      jobName: job.name,
      jobId: job.id,
      attempts: job.attemptsMade,
      errorClass: 'STALLED',
    });
  }

  async onModuleDestroy(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer);
    await this.dashboard?.close();
    await Promise.all(this.workers.map((worker) => worker.close()));
    await this.bull?.close();
    await this.mailProvider?.close?.();
    await this.maintenance?.close();
    await this.database?.close();
  }
}
