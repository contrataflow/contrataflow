import type { JobMeta } from '@contrataflow/types';
import type { Logger } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import type { SqlClient } from '#shared/database/outbox-database.js';
import type { WorkerDatabase } from '#shared/database/worker-database.js';
import { MailRejectedError, MailTransientError } from '#shared/mail/mail-provider.js';
import { FakeMailProvider } from '#shared/mail/testing.js';

import { EmailSender, emailJobPayloadSchema } from './email-sender.js';
import type { EmailSenderDeps } from './email-sender.js';
import type { EmailInstruments } from './email-telemetry.js';
import { EmailTemplateRegistry } from './email-templates.js';
import { MemoryEmailSendLock, MemoryEmailSource } from './testing.js';
import { PermanentJobError } from '../../queues/job-errors.js';
import { runJob } from '../../queues/run-job.js';
import type { JobHandlerContext, RunnableJob } from '../../queues/run-job.js';
import { MemoryDeadLetter, RecordingQueueMetrics } from '../../queues/testing.js';

const TENANT = '0192f111-0000-7000-8000-00000000000a';
const N10 = '0192f111-0000-7000-8000-000000000010';
const MEMBERSHIP = '0192f111-0000-7000-8000-0000000000e1';
const T0 = new Date('2026-10-15T12:00:00.000Z');
const FROM = 'ContrataFlow <nao-responda@contrataflow.gov.br>';

const meta: JobMeta = {
  schemaVersion: 1,
  tenantId: TENANT,
  actor: { type: 'SYSTEM', userId: null, membershipId: null },
  correlationId: 'corr-email-1',
  causationId: null,
  enqueuedAt: T0.toISOString(),
};

const NO_SQL = {} as SqlClient;

function setup(overrides: Partial<EmailSenderDeps> = {}) {
  const templates = new EmailTemplateRegistry('https://app.contrataflow.test');
  const source = new MemoryEmailSource(templates);
  const provider = new FakeMailProvider();
  const lists = { sent: [] as unknown[], failed: [] as unknown[], skipped: [] as unknown[] };
  const metrics = {
    sent: { add: (_v: number, attrs: unknown) => lists.sent.push(attrs) },
    failed: { add: (_v: number, attrs: unknown) => lists.failed.push(attrs) },
    skipped: { add: (_v: number, attrs: unknown) => lists.skipped.push(attrs) },
  } as unknown as EmailInstruments;
  const sender = new EmailSender({
    provider,
    lock: new MemoryEmailSendLock(),
    from: FROM,
    notifications: source,
    now: () => T0,
    metrics,
    ...overrides,
  });
  return { sender, source, provider, lists };
}

function context(overrides: Partial<JobHandlerContext> = {}) {
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const ctx: JobHandlerContext = {
    meta,
    queue: 'email',
    jobName: 'send',
    jobId: N10,
    attempt: 1,
    maxAttempts: 5,
    signal: new AbortController().signal,
    logger: logger as unknown as Logger,
    tenantTransaction: (work) => work(NO_SQL),
    platformTransaction: () => Promise.reject(new Error('não usado')),
    ...overrides,
  };
  return { ctx, logger };
}

const job = { kind: 'NOTIFICATION', notificationId: N10 } as const;

describe('EmailSender (US-112)', () => {
  it('[Sucesso] notificação PENDING é enviada pelo MailProvider e vira SENT com emailSentAt', async () => {
    const { sender, source, provider, lists } = setup();
    source.add(N10);
    const { ctx, logger } = context();

    await expect(sender.handle(job, ctx)).resolves.toBe('completed');

    expect(provider.sent).toHaveLength(1);
    const [message] = provider.sent;
    expect(message).toMatchObject({
      from: FROM,
      to: 'diego@pmsj.gov.br',
      subject: '[ContrataFlow] Aprovação pendente',
      messageId: `<notification.${N10}@contrataflow.gov.br>`,
      headers: {
        'X-Correlation-Id': 'corr-email-1',
        'X-CF-Notification-Id': N10,
        'Auto-Submitted': 'auto-generated',
      },
    });
    expect(message?.text).toContain(
      'Decidir a aprovação: https://app.contrataflow.test/processos/',
    );
    expect(source.rows.get(N10)).toMatchObject({ status: 'SENT', sentAt: T0, error: null });
    expect(lists.sent).toEqual([{ kind: 'NOTIFICATION', provider: 'fake' }]);
    const logged = logger.log.mock.calls.map(([entry]) => entry as Record<string, unknown>);
    const sentLog = logged.find((entry) => entry.event === 'email.sent');
    expect(sentLog).toMatchObject({
      notificationId: N10,
      provider: 'fake',
      correlationId: 'corr-email-1',
    });
    // DEC-138: o log nunca traz o endereço nem o corpo.
    expect(JSON.stringify(logged)).not.toMatch(/diego@|aguardando a sua decisão/);
  });

  it('[Validação] job com referência inexistente: nada é enviado, log error e fila segue', async () => {
    const { sender, provider } = setup();
    const { ctx, logger } = context();
    await expect(sender.handle(job, ctx)).resolves.toBe('skipped');
    expect(provider.sent).toHaveLength(0);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'email.source_missing', notificationId: N10 }),
    );
  });

  it('[Validação] payload só aceita a referência (nunca endereço — RN-NTF-14)', () => {
    expect(emailJobPayloadSchema.safeParse(job).success).toBe(true);
    expect(emailJobPayloadSchema.safeParse({ ...job, to: 'diego@pmsj.gov.br' }).success).toBe(
      false,
    );
    expect(emailJobPayloadSchema.safeParse({ notificationId: N10 }).success).toBe(false);
    expect(emailJobPayloadSchema.safeParse({ kind: 'INVITATION', membershipId: 'x' }).success).toBe(
      false,
    );
  });

  it('[Permissão] e-mail desligado no tenant depois do PENDING → SKIPPED, sem envio', async () => {
    const { sender, source, provider, lists } = setup();
    source.add(N10);
    source.emailEnabled = false;
    const { ctx, logger } = context();
    await expect(sender.handle(job, ctx)).resolves.toBe('skipped');
    expect(provider.sent).toHaveLength(0);
    expect(source.rows.get(N10)?.status).toBe('SKIPPED');
    expect(lists.skipped).toEqual([{ kind: 'NOTIFICATION', reason: 'EMAIL_DISABLED' }]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'email.skipped', reason: 'EMAIL_DISABLED' }),
    );
  });

  it('[Tenant incorreto] tenant suspenso depois do PENDING → SKIPPED, sem envio', async () => {
    const { sender, source, provider } = setup();
    source.add(N10);
    source.tenantStatus = 'SUSPENDED';
    await expect(sender.handle(job, context().ctx)).resolves.toBe('skipped');
    expect(provider.sent).toHaveLength(0);
    expect(source.rows.get(N10)?.status).toBe('SKIPPED');
  });

  it('[Duplicidade] reentrega com emailStatus SENT não envia de novo', async () => {
    const { sender, source, provider } = setup();
    source.add(N10, { status: 'SENT', sentAt: T0 });
    await expect(sender.handle(job, context().ctx)).resolves.toBe('skipped');
    expect(provider.sent).toHaveLength(0);
    expect(source.rows.get(N10)).toMatchObject({ status: 'SENT', sentAt: T0 });
  });

  it('[Concorrência] dois workers no mesmo job: um único envio e uma única transição', async () => {
    const { sender, source, provider } = setup();
    source.add(N10);
    provider.delayMs = 20;
    const results = await Promise.all([
      sender.handle(job, context().ctx),
      sender.handle(job, context().ctx),
    ]);
    expect(results.sort()).toEqual(['completed', 'skipped']);
    expect(provider.sent).toHaveLength(1);
    expect(source.rows.get(N10)?.status).toBe('SENT');
    // Depois de resolvido, um terceiro processamento é no-op.
    await expect(sender.handle(job, context().ctx)).resolves.toBe('skipped');
    expect(provider.sent).toHaveLength(1);
  });

  it('[Falha de banco] banco fora ao gravar SENT: o job falha para ser reprocessado', async () => {
    const { sender, source, provider } = setup();
    source.add(N10);
    source.failMarkSent = Object.assign(new Error('Connection terminated'), { code: '57P01' });
    await expect(sender.handle(job, context().ctx)).rejects.toThrow('Connection terminated');
    expect(provider.sent).toHaveLength(1);
    expect(source.rows.get(N10)?.status).toBe('PENDING');
  });

  it('[Falha de integração] provedor fora: falha transitória com retentativa; esgotada → FAILED', async () => {
    const { sender, source, provider, lists } = setup();
    source.add(N10);
    provider.failures.push(
      new MailTransientError('Falha transitória do provedor (ECONNECTION)', 'ECONNECTION'),
    );
    const first = context({ attempt: 1 });
    await expect(sender.handle(job, first.ctx)).rejects.toBeInstanceOf(MailTransientError);
    expect(source.rows.get(N10)?.status).toBe('PENDING');
    expect(first.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'email.retry', attempt: 1, errorCode: 'ECONNECTION' }),
    );

    provider.failures.push(
      new MailTransientError('Falha transitória do provedor (SMTP 421)', 'SMTP_421'),
    );
    const last = context({ attempt: 5, maxAttempts: 5 });
    await expect(sender.handle(job, last.ctx)).rejects.toBeInstanceOf(MailTransientError);
    expect(source.rows.get(N10)).toMatchObject({
      status: 'FAILED',
      error: 'Tentativas esgotadas (5): Falha transitória do provedor (SMTP 421)',
    });
    expect(lists.failed).toEqual([{ kind: 'NOTIFICATION', reason: 'EXHAUSTED' }]);
    expect(provider.sent).toHaveLength(0);
  });

  it('[RN-NTF-16] rejeição definitiva do provedor → FAILED com emailError resumido, sem retentar', async () => {
    const { sender, source, lists, provider } = setup();
    source.add(N10);
    provider.failures.push(
      new MailRejectedError(
        'Destinatário ou mensagem recusados pelo provedor (SMTP 550)',
        'SMTP_550',
      ),
    );
    await expect(sender.handle(job, context().ctx)).resolves.toBe('completed');
    expect(source.rows.get(N10)).toMatchObject({
      status: 'FAILED',
      error: 'Destinatário ou mensagem recusados pelo provedor (SMTP 550)',
    });
    expect(lists.failed).toEqual([{ kind: 'NOTIFICATION', reason: 'REJECTED' }]);
  });

  it('[FA-02] destinatário sem e-mail válido → FAILED "destinatário sem e-mail" + log error', async () => {
    const { sender, source, provider } = setup();
    source.add(N10, { email: '' });
    const { ctx, logger } = context();
    await expect(sender.handle(job, ctx)).resolves.toBe('completed');
    expect(provider.sent).toHaveLength(0);
    expect(source.rows.get(N10)).toMatchObject({
      status: 'FAILED',
      error: 'destinatário sem e-mail',
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'email.failed', errorCode: 'NO_RECIPIENT' }),
    );
  });

  it('[FA-03] tipo sem template → FAILED "template ausente" + alerta de operação', async () => {
    const { sender, source, provider } = setup();
    source.add(N10, { type: 'TIPO_NOVO' });
    const { ctx, logger } = context();
    await expect(sender.handle(job, ctx)).resolves.toBe('completed');
    expect(provider.sent).toHaveLength(0);
    expect(source.rows.get(N10)).toMatchObject({ status: 'FAILED', error: 'template ausente' });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'email.failed',
        errorCode: 'TEMPLATE_MISSING',
        alert: true,
      }),
    );
  });

  it('[RN-NTF-20] convite sem a origem da US-091 é falha permanente (DLQ)', async () => {
    const { sender } = setup();
    await expect(
      sender.handle({ kind: 'INVITATION', membershipId: MEMBERSHIP }, context().ctx),
    ).rejects.toBeInstanceOf(PermanentJobError);
  });

  it('[RN-NTF-20] convite com origem registrada usa a mesma infraestrutura de envio', async () => {
    const invitations = new MemoryEmailSource(new EmailTemplateRegistry('https://app.test'));
    invitations.add(MEMBERSHIP, { type: 'ROLE_CHANGED', email: 'novo@pmsj.gov.br' });
    const { sender, provider } = setup({ invitations });
    await expect(
      sender.handle({ kind: 'INVITATION', membershipId: MEMBERSHIP }, context().ctx),
    ).resolves.toBe('completed');
    expect(provider.sent[0]).toMatchObject({
      to: 'novo@pmsj.gov.br',
      messageId: `<invitation.${MEMBERSHIP}@contrataflow.gov.br>`,
      headers: { 'X-CF-Membership-Id': MEMBERSHIP },
    });
    expect(invitations.rows.get(MEMBERSHIP)?.status).toBe('SENT');
  });

  it('recusa job sem tenant (contexto de plataforma)', async () => {
    const { sender, source } = setup();
    source.add(N10);
    await expect(
      sender.handle(job, context({ meta: { ...meta, tenantId: null } }).ctx),
    ).rejects.toBeInstanceOf(PermanentJobError);
  });
});

describe('EmailSender pelo runJob (contrato comum das filas)', () => {
  const database = {
    tenantTransaction: (_tenantId: string, work: (client: SqlClient) => Promise<unknown>) =>
      work(NO_SQL),
    platformTransaction: () => Promise.reject(new Error('não usado')),
    withAdvisoryLock: () => Promise.reject(new Error('não usado')),
    close: () => Promise.resolve(),
  } as unknown as WorkerDatabase;

  function emailJob(attemptsMade: number): RunnableJob {
    return {
      id: N10,
      name: 'send',
      queueName: 'email',
      data: { meta, payload: job },
      attemptsMade,
      opts: { attempts: 5, backoff: { type: 'cf-exponential-jitter', delay: 5_000 } },
      timestamp: T0.getTime(),
    };
  }

  function deps(tenantStatus: string) {
    return {
      deadLetter: new MemoryDeadLetter(),
      metrics: new RecordingQueueMetrics(),
      timeoutMs: 30_000,
      postpone: () => Promise.resolve(),
      database,
      tenants: { findStatus: () => Promise.resolve(tenantStatus) },
    };
  }

  it('[FA-04] roda com o tenant suspenso para gravar SKIPPED (não deixa PENDING para sempre)', async () => {
    const { sender, source, provider } = setup();
    source.add(N10);
    source.tenantStatus = 'SUSPENDED';
    await expect(runJob(emailJob(0), sender, deps('SUSPENDED'))).resolves.toBe('skipped');
    expect(source.rows.get(N10)?.status).toBe('SKIPPED');
    expect(provider.sent).toHaveLength(0);
  });

  it('[RN-NTF-17] falha transitória retenta e, na 5ª tentativa, grava FAILED e copia para a DLQ', async () => {
    const { sender, source, provider } = setup();
    source.add(N10);
    const transient = () =>
      new MailTransientError('Falha transitória do provedor (ETIMEDOUT)', 'ETIMEDOUT');
    provider.failures.push(transient());
    const retry = deps('ACTIVE');
    await expect(runJob(emailJob(0), sender, retry)).rejects.toBeInstanceOf(MailTransientError);
    expect(retry.deadLetter.records.size).toBe(0);
    expect(source.rows.get(N10)?.status).toBe('PENDING');

    provider.failures.push(transient());
    const final = deps('ACTIVE');
    await expect(runJob(emailJob(4), sender, final)).rejects.toBeInstanceOf(MailTransientError);
    expect(final.deadLetter.records.size).toBe(1);
    expect(source.rows.get(N10)?.status).toBe('FAILED');
  });

  it('convite sem origem vai direto para a DLQ como permanente', async () => {
    const { sender } = setup();
    const invitation = {
      ...emailJob(0),
      data: { meta, payload: { kind: 'INVITATION', membershipId: MEMBERSHIP } },
    };
    const result = deps('ACTIVE');
    await expect(runJob(invitation, sender, result)).rejects.toBeInstanceOf(UnrecoverableError);
    expect(result.deadLetter.records.size).toBe(1);
  });
});
