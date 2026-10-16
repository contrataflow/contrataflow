// US-112 · Meta "10 envios/s sustentados sem acumular atraso na fila": o `EmailSender` de produção
// (PostgreSQL real com o papel `cf_worker` + SMTP real no Mailpit) processa 200 notificações
// PENDING com a concorrência da fila `email` (5 por réplica). A capacidade medida precisa ficar
// acima da cota de 10/s (com folga de 2×) — senão o `limiter` deixaria de ser o gargalo e a fila
// acumularia atraso. Suíte de performance (DEC-087: medida no endurecimento, fora do CI do PR):
// `pnpm --filter @contrataflow/worker test:perf`.
import type { JobMeta } from '@contrataflow/types';
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EmailSender } from '../../src/notifications/email/email-sender.js';
import { EmailTemplateRegistry } from '../../src/notifications/email/email-templates.js';
import { NotificationEmailSource } from '../../src/notifications/email/notification-email-source.js';
import { SqlNotificationDirectory } from '../../src/notifications/sql-notification-directory.js';
import { QUEUE_POLICIES } from '../../src/queues/queue-options.js';
import type { JobHandlerContext } from '../../src/queues/run-job.js';
import { createWorkerDatabase } from '../../src/shared/database/worker-database.js';
import type { WorkerDatabase } from '../../src/shared/database/worker-database.js';
import { SmtpMailProvider } from '../../src/shared/mail/smtp-mail-provider.js';
import { startMailpit, startPostgres } from '../support/containers.js';
import type { TestMailpit, TestPostgres } from '../support/containers.js';
import { TENANT_A, seedQueueFixtures } from '../support/queue-fixtures.js';

const DIEGO = '0192f0a0-0000-7000-8000-0000000e0001';
const TOTAL = 200;
const RATE_PER_SECOND = 10;
const HEADROOM = 2;

function p95(samples: number[]): number {
  const sorted = [...samples].sort((x, y) => x - y);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
}

describe('[Desempenho] vazão do EmailSender (US-112)', () => {
  let db: TestPostgres;
  let mailpit: TestMailpit;
  let worker: WorkerDatabase;
  let smtp: SmtpMailProvider;
  const ids: string[] = [];

  beforeAll(async () => {
    Logger.overrideLogger(false);
    [db, mailpit] = await Promise.all([startPostgres(), startMailpit()]);
    await seedQueueFixtures(db);
    await db.admin(`
      INSERT INTO users (id, external_subject, email, name) VALUES
        ('${DIEGO}', 'sub-diego-perf', 'diego@pmsj.gov.br', 'Diego');
      INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
        ('0192f0a0-0000-7000-8000-0000000e1001', '${TENANT_A}', '${DIEGO}', 'INTERNAL', 'ACTIVE');
    `);
    for (let index = 0; index < TOTAL; index += 1) {
      const suffix = (0xe20000 + index).toString(16).padStart(12, '0');
      ids.push(`0192f0a0-0000-7000-8000-${suffix}`);
    }
    await db.admin(
      `INSERT INTO notifications (id, tenant_id, recipient_id, type, title, body, link, source_event_id, email_status)
       SELECT id, $1, $2, 'APPROVAL_REQUESTED', 'Aprovação pendente',
              'Há uma aprovação aguardando a sua decisão.', '/notificacoes', id, 'PENDING'
         FROM unnest($3::uuid[]) AS id`,
      [TENANT_A, DIEGO, ids],
    );
    worker = createWorkerDatabase({ url: db.url('cf_worker') });
    smtp = new SmtpMailProvider({ url: mailpit.smtpUrl });
  }, 180_000);

  afterAll(async () => {
    await smtp.close();
    await worker.close();
    await Promise.all([db.stop(), mailpit.stop()]);
  });

  it(`capacidade ≥ ${String(RATE_PER_SECOND * HEADROOM)}/s com a concorrência da fila`, async () => {
    const sender = new EmailSender({
      provider: smtp,
      lock: worker,
      from: 'ContrataFlow <nao-responda@contrataflow.test>',
      notifications: new NotificationEmailSource(
        new EmailTemplateRegistry('https://app.contrataflow.test'),
        new SqlNotificationDirectory(),
      ),
    });
    const meta: JobMeta = {
      schemaVersion: 1,
      tenantId: TENANT_A,
      actor: { type: 'SYSTEM', userId: null, membershipId: null },
      correlationId: 'corr-email-perf',
      causationId: null,
      enqueuedAt: new Date().toISOString(),
    };
    const context: JobHandlerContext = {
      meta,
      queue: 'email',
      jobName: 'send',
      jobId: 'perf',
      attempt: 1,
      maxAttempts: 5,
      signal: new AbortController().signal,
      logger: new Logger('EmailPerf'),
      tenantTransaction: (work) => worker.tenantTransaction(TENANT_A, work),
      platformTransaction: () => Promise.reject(new Error('não usado')),
    };
    const pending = [...ids];
    const latencies: number[] = [];
    const started = Date.now();
    await Promise.all(
      Array.from({ length: QUEUE_POLICIES.email.concurrency }, async () => {
        for (let id = pending.shift(); id !== undefined; id = pending.shift()) {
          const t0 = performance.now();
          await sender.handle({ kind: 'NOTIFICATION', notificationId: id }, context);
          latencies.push(performance.now() - t0);
        }
      }),
    );
    const perSecond = TOTAL / ((Date.now() - started) / 1_000);
    const sent = await db.admin<{ count: string }>(
      `SELECT count(*) AS count FROM notifications WHERE email_status = 'SENT'`,
    );
    expect(Number(sent[0]?.count)).toBe(TOTAL);
    expect(perSecond).toBeGreaterThanOrEqual(RATE_PER_SECOND * HEADROOM);
    // Cada envio cabe com folga no timeout da fila (30 s) e não segura o `limiter`.
    expect(p95(latencies)).toBeLessThan(1_000);
  });
});
