// EmailSender (US-112) sobre PostgreSQL real (papel `cf_worker`, sem BYPASSRLS) e Mailpit: envio
// real com assunto, link e cabeçalhos técnicos; RLS (job da Prefeitura A nunca lê nem atualiza a
// notificação da Prefeitura B); transição condicional a PENDING sob concorrência com a trava
// consultiva real (um único e-mail); tenant suspenso e e-mail desligado → SKIPPED; tentativas
// esgotadas → FAILED; e os GRANTs de `notifications` para o worker.
import type { JobMeta } from '@contrataflow/types';
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { EmailSender } from '../../src/notifications/email/email-sender.js';
import { EmailTemplateRegistry } from '../../src/notifications/email/email-templates.js';
import { InvitationEmailSource } from '../../src/notifications/email/invitation-email-source.js';
import { NotificationEmailSource } from '../../src/notifications/email/notification-email-source.js';
import { SqlNotificationDirectory } from '../../src/notifications/sql-notification-directory.js';
import type { JobHandlerContext } from '../../src/queues/run-job.js';
import { createWorkerDatabase } from '../../src/shared/database/worker-database.js';
import type { WorkerDatabase } from '../../src/shared/database/worker-database.js';
import { MailTransientError } from '../../src/shared/mail/mail-provider.js';
import type { MailMessage, MailProvider } from '../../src/shared/mail/mail-provider.js';
import { SmtpMailProvider } from '../../src/shared/mail/smtp-mail-provider.js';
import { startMailpit, startPostgres } from '../support/containers.js';
import type { TestMailpit, TestPostgres } from '../support/containers.js';
import { TENANT_A, TENANT_B, seedQueueFixtures } from '../support/queue-fixtures.js';

const DIEGO = '0192f0a0-0000-7000-8000-0000000d0001';
const BETO_B = '0192f0a0-0000-7000-8000-0000000d00b1';
const PROCESSO = '0192f0a0-0000-7000-8000-0000000d0f01';
const NOTIFICACAO_B = '0192f0a0-0000-7000-8000-0000000d3b01';
const CARLA_A = '0192f0a0-0000-7000-8000-0000000d0002';
const DANI_B = '0192f0a0-0000-7000-8000-0000000d00b2';
const CONVITE_A = '0192f0a0-0000-7000-8000-0000000d1002';
const CONVITE_B = '0192f0a0-0000-7000-8000-0000000d10b2';
const BASE_URL = 'https://app.contrataflow.test';
const FROM = 'ContrataFlow (teste) <nao-responda@contrataflow.test>';
const T0 = new Date('2026-10-15T12:00:00.000Z');

let db: TestPostgres;
let mailpit: TestMailpit;
let worker: WorkerDatabase;
let smtp: SmtpMailProvider;
let seq = 0;

function newId(): string {
  seq += 1;
  return `0192f0a0-0000-7000-8000-${(0xd10000 + seq).toString(16).padStart(12, '0')}`;
}

async function pendingNotification(tenantId = TENANT_A, recipientId = DIEGO): Promise<string> {
  const id = newId();
  await db.admin(
    `INSERT INTO notifications (id, tenant_id, recipient_id, type, title, body, link, process_id,
                                source_event_id, email_status)
     VALUES ($1, $2, $3, 'APPROVAL_REQUESTED', 'Aprovação pendente',
             'Há uma aprovação aguardando a sua decisão.', $4, $5, $6, 'PENDING')`,
    [id, tenantId, recipientId, `/processos/${PROCESSO}`, PROCESSO, newId()],
  );
  return id;
}

const statusOf = async (id: string) =>
  (
    await db.admin<{
      email_status: string;
      email_sent_at: Date | null;
      email_error: string | null;
    }>(
      'SELECT email_status::text AS email_status, email_sent_at, email_error FROM notifications WHERE id = $1',
      [id],
    )
  )[0];

function contextFor(
  tenantId: string,
  overrides: Partial<JobHandlerContext> = {},
): JobHandlerContext {
  const meta: JobMeta = {
    schemaVersion: 1,
    tenantId,
    actor: { type: 'SYSTEM', userId: null, membershipId: null },
    correlationId: 'corr-email-it',
    causationId: null,
    enqueuedAt: T0.toISOString(),
  };
  return {
    meta,
    queue: 'email',
    jobName: 'send',
    jobId: 'job',
    attempt: 1,
    maxAttempts: 5,
    signal: new AbortController().signal,
    logger: new Logger('EmailSenderIT'),
    tenantTransaction: (work) => worker.tenantTransaction(tenantId, work),
    platformTransaction: () => Promise.reject(new Error('não usado')),
    ...overrides,
  };
}

function senderWith(provider: MailProvider): EmailSender {
  return new EmailSender({
    provider,
    lock: worker,
    from: FROM,
    notifications: new NotificationEmailSource(
      new EmailTemplateRegistry(BASE_URL),
      new SqlNotificationDirectory(),
    ),
    now: () => T0,
  });
}

/** Conta os envios e deixa o primeiro "lento" (concorrência real sobre a trava). */
class CountingProvider implements MailProvider {
  readonly name = 'counting';
  readonly sent: MailMessage[] = [];
  readonly failures: Error[] = [];

  async send(message: MailMessage) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const failure = this.failures.shift();
    if (failure) throw failure;
    this.sent.push(message);
    return { providerMessageId: message.messageId };
  }
}

interface MailpitSummary {
  readonly ID: string;
  readonly Subject: string;
  readonly To: { readonly Address: string }[];
}

async function mailpitMessages(): Promise<MailpitSummary[]> {
  const response = await fetch(`${mailpit.apiUrl}/api/v1/messages`);
  return ((await response.json()) as { messages: MailpitSummary[] }).messages;
}

beforeAll(async () => {
  Logger.overrideLogger(false);
  [db, mailpit] = await Promise.all([startPostgres(), startMailpit()]);
  await seedQueueFixtures(db);
  await db.admin(`
    INSERT INTO users (id, external_subject, email, name, status) VALUES
      ('${DIEGO}', 'sub-diego-mail', 'diego@pmsj.gov.br', 'Diego', 'ACTIVE'),
      ('${BETO_B}', 'sub-beto-mail', 'beto@leak-b.test', 'Beto LEAK-B', 'ACTIVE'),
      ('${CARLA_A}', 'sub-carla-mail', 'carla@pmsj.gov.br', 'Carla Souza', 'ACTIVE'),
      ('${DANI_B}', 'sub-dani-mail', 'dani@leak-b.test', 'Dani LEAK-B', 'ACTIVE');
    INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
      ('0192f0a0-0000-7000-8000-0000000d1001', '${TENANT_A}', '${DIEGO}', 'INTERNAL', 'ACTIVE'),
      ('0192f0a0-0000-7000-8000-0000000d10b1', '${TENANT_B}', '${BETO_B}', 'INTERNAL', 'ACTIVE');
    INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status, invited_at, invite_expires_at) VALUES
      ('${CONVITE_A}', '${TENANT_A}', '${CARLA_A}', 'INTERNAL', 'INVITED', now(), now() + interval '7 days'),
      ('${CONVITE_B}', '${TENANT_B}', '${DANI_B}', 'INTERNAL', 'INVITED', now(), now() + interval '7 days');
    INSERT INTO notifications (id, tenant_id, recipient_id, type, title, body, source_event_id, email_status)
      VALUES ('${NOTIFICACAO_B}', '${TENANT_B}', '${BETO_B}', 'MENTIONED', 'LEAK-B', 'LEAK-B',
              '0192f0a0-0000-7000-8000-0000000d4b01', 'PENDING');
  `);
  worker = createWorkerDatabase({ url: db.url('cf_worker') });
  smtp = new SmtpMailProvider({ url: mailpit.smtpUrl });
}, 180_000);

afterAll(async () => {
  await smtp.close();
  await worker.close();
  await Promise.all([db.stop(), mailpit.stop()]);
});

beforeEach(async () => {
  await db.admin(
    `UPDATE tenants SET status = 'ACTIVE', suspension_reason = NULL WHERE id = '${TENANT_A}'`,
  );
  await db.admin(`DELETE FROM tenant_settings WHERE key = 'notifications.emailEnabled'`);
});

const inviteStateOf = async (id: string) =>
  (
    await db.admin<{ invite_token_hash: string | null; version: number }>(
      'SELECT invite_token_hash, version FROM tenant_memberships WHERE id = $1',
      [id],
    )
  )[0];

describe('EmailSender sobre PostgreSQL e Mailpit (US-112)', () => {
  it('[Sucesso] envia de verdade pelo SMTP (Mailpit) e grava SENT com emailSentAt', async () => {
    const id = await pendingNotification();
    await expect(
      senderWith(smtp).handle({ kind: 'NOTIFICATION', notificationId: id }, contextFor(TENANT_A)),
    ).resolves.toBe('completed');
    expect(await statusOf(id)).toEqual({
      email_status: 'SENT',
      email_sent_at: T0,
      email_error: null,
    });

    const messages = await mailpitMessages();
    const summary = messages.find((message) => message.To[0]?.Address === 'diego@pmsj.gov.br');
    expect(summary?.Subject).toBe('[ContrataFlow] Aprovação pendente');
    const detail = (await (
      await fetch(`${mailpit.apiUrl}/api/v1/message/${summary?.ID ?? ''}`)
    ).json()) as {
      MessageID: string;
      Text: string;
      HTML: string;
    };
    expect(detail.MessageID).toBe(`notification.${id}@contrataflow.test`);
    expect(detail.Text).toContain(`Decidir a aprovação: ${BASE_URL}/processos/${PROCESSO}`);
    expect(detail.HTML).toContain(`href="${BASE_URL}/processos/${PROCESSO}"`);
    const headers = (await (
      await fetch(`${mailpit.apiUrl}/api/v1/message/${summary?.ID ?? ''}/headers`)
    ).json()) as Record<string, string[]>;
    const header = (name: string) =>
      Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]?.[0];
    expect(header('Auto-Submitted')).toBe('auto-generated');
    expect(header('X-Correlation-Id')).toBe('corr-email-it');
    expect(header('X-CF-Notification-Id')).toBe(id);
  });

  it('[Tenant incorreto · RLS] job da Prefeitura A não lê nem atualiza notificação da B', async () => {
    const provider = new CountingProvider();
    const before = await statusOf(NOTIFICACAO_B);
    await expect(
      senderWith(provider).handle(
        { kind: 'NOTIFICATION', notificationId: NOTIFICACAO_B },
        contextFor(TENANT_A),
      ),
    ).resolves.toBe('skipped');
    expect(provider.sent).toHaveLength(0);
    expect(await statusOf(NOTIFICACAO_B)).toEqual(before);
  });

  it('[Tenant incorreto] tenant suspenso após o PENDING → SKIPPED, sem envio', async () => {
    const id = await pendingNotification();
    await db.admin(
      `UPDATE tenants SET status = 'SUSPENDED', suspension_reason = 'Inadimplência' WHERE id = '${TENANT_A}'`,
    );
    const provider = new CountingProvider();
    await expect(
      senderWith(provider).handle(
        { kind: 'NOTIFICATION', notificationId: id },
        contextFor(TENANT_A),
      ),
    ).resolves.toBe('skipped');
    expect(provider.sent).toHaveLength(0);
    expect((await statusOf(id))?.email_status).toBe('SKIPPED');
  });

  it('[Permissão] notifications.emailEnabled desligado após o PENDING → SKIPPED', async () => {
    const id = await pendingNotification();
    await db.admin(
      `INSERT INTO tenant_settings (id, tenant_id, key, value)
       VALUES ($1, $2, 'notifications.emailEnabled', 'false'::jsonb)`,
      [newId(), TENANT_A],
    );
    const provider = new CountingProvider();
    await expect(
      senderWith(provider).handle(
        { kind: 'NOTIFICATION', notificationId: id },
        contextFor(TENANT_A),
      ),
    ).resolves.toBe('skipped');
    expect(provider.sent).toHaveLength(0);
    expect((await statusOf(id))?.email_status).toBe('SKIPPED');
  });

  it('[Concorrência] dois workers no mesmo job: trava consultiva real → um único envio', async () => {
    const id = await pendingNotification();
    const provider = new CountingProvider();
    const sender = senderWith(provider);
    const payload = { kind: 'NOTIFICATION', notificationId: id } as const;
    const results = await Promise.all([
      sender.handle(payload, contextFor(TENANT_A)),
      sender.handle(payload, contextFor(TENANT_A)),
    ]);
    expect(results.sort()).toEqual(['completed', 'skipped']);
    expect(provider.sent).toHaveLength(1);
    expect((await statusOf(id))?.email_status).toBe('SENT');

    // [Duplicidade] reentrega depois do SENT é no-op.
    await expect(sender.handle(payload, contextFor(TENANT_A))).resolves.toBe('skipped');
    expect(provider.sent).toHaveLength(1);
  });

  it('[Falha de integração] tentativas esgotadas → FAILED com emailError', async () => {
    const id = await pendingNotification();
    const provider = new CountingProvider();
    provider.failures.push(
      new MailTransientError('Falha transitória do provedor (ECONNECTION)', 'ECONNECTION'),
    );
    await expect(
      senderWith(provider).handle(
        { kind: 'NOTIFICATION', notificationId: id },
        contextFor(TENANT_A, { attempt: 3, maxAttempts: 3 }),
      ),
    ).rejects.toBeInstanceOf(MailTransientError);
    expect(await statusOf(id)).toMatchObject({
      email_status: 'FAILED',
      email_sent_at: null,
      email_error: 'Tentativas esgotadas (3): Falha transitória do provedor (ECONNECTION)',
    });
  });

  it('[GRANT] cf_worker atualiza o estado do e-mail; cf_app não', async () => {
    const id = await pendingNotification();
    await expect(
      worker.tenantTransaction(TENANT_A, (client) =>
        client.query(`UPDATE notifications SET email_error = 'x' WHERE id = $1`, [id]),
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
    const app = createWorkerDatabase({ url: db.url('cf_app') });
    try {
      await expect(
        app.tenantTransaction(TENANT_A, (client) =>
          client.query(`UPDATE notifications SET email_status = 'SENT' WHERE id = $1`, [id]),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await app.close();
    }
  });
});

describe('EmailSender — convite sobre PostgreSQL (US-091)', () => {
  const invitationSender = (provider: MailProvider) =>
    new EmailSender({
      provider,
      lock: worker,
      from: FROM,
      notifications: new NotificationEmailSource(
        new EmailTemplateRegistry(BASE_URL),
        new SqlNotificationDirectory(),
      ),
      invitations: new InvitationEmailSource(BASE_URL, { now: () => new Date() }),
      now: () => T0,
    });

  it('[Sucesso] envia o link e grava só o hash do token, sem mexer na version', async () => {
    const provider = new CountingProvider();
    const before = await inviteStateOf(CONVITE_A);
    await expect(
      invitationSender(provider).handle(
        { kind: 'INVITATION', membershipId: CONVITE_A },
        contextFor(TENANT_A),
      ),
    ).resolves.toBe('completed');
    const token = /\/convite\/([A-Za-z0-9_-]{43})/.exec(provider.sent[0]?.text ?? '')?.[1] ?? '';
    expect(token).toHaveLength(43);
    const after = await inviteStateOf(CONVITE_A);
    expect(after?.invite_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(after?.version).toBe(before?.version);
    await db.admin('UPDATE tenant_memberships SET invite_token_hash = NULL WHERE id = $1', [
      CONVITE_A,
    ]);
  });

  it('[Tenant incorreto · RLS] job da Prefeitura A não lê nem atualiza o convite da B', async () => {
    const provider = new CountingProvider();
    const before = await inviteStateOf(CONVITE_B);
    await expect(
      invitationSender(provider).handle(
        { kind: 'INVITATION', membershipId: CONVITE_B },
        contextFor(TENANT_A),
      ),
    ).resolves.toBe('skipped');
    expect(provider.sent).toHaveLength(0);
    expect(await inviteStateOf(CONVITE_B)).toEqual(before);
    // E o UPDATE do markSent também não alcança a linha da B com o contexto da A.
    const source = new InvitationEmailSource(BASE_URL);
    const receipt = JSON.stringify({ hash: 'f'.repeat(64), expiresAt: new Date().toISOString() });
    await expect(
      worker.tenantTransaction(TENANT_A, (client) =>
        source.markSent(client, CONVITE_B, T0, receipt),
      ),
    ).resolves.toBe(false);
    expect((await inviteStateOf(CONVITE_B))?.invite_token_hash).toBeNull();
  });
});
