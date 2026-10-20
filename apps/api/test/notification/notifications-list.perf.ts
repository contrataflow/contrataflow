// US-111 · Meta "GET /notifications com 10k linhas por usuário → p95 < 300 ms": a lista (NTF-01,
// primeira página e página seguinte por cursor, com e sem `unreadOnly`) e o contador (NTF-02)
// pelo repositório de produção, no PostgreSQL real com o papel da aplicação e o índice
// `notifications_recipient_idx`. Suíte de performance (DEC-087: medida no endurecimento, fora do
// CI do PR): `pnpm --filter @contrataflow/api test:perf`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TenantTransaction } from '#shared/database/database.module.js';
import type { TenantPrismaClient } from '#shared/database/prisma-client.js';

import { PrismaNotificationRepository } from '../../src/modules/notification/infrastructure/prisma-notification.repository.js';
import { asTenant, startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';

const A = '0192d000-0000-7000-8000-00000000111a';
const CARLA = '0192d000-0000-7000-8000-0000000111a1';
const OUTRO = '0192d000-0000-7000-8000-0000000111a2';
const ROWS_PER_USER = 10_000;
const WARMUP = 10;
const SAMPLES = 100;
const P95_BUDGET_MS = 300;

function p95(samples: number[]): number {
  const sorted = [...samples].sort((x, y) => x - y);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
}

describe('[Desempenho] central de notificações com 10k linhas por usuário (US-111)', () => {
  let db: TestDatabase;
  let app: TenantPrismaClient;

  beforeAll(async () => {
    db = await startTestDatabase();
    await db.admin(`
      INSERT INTO tenants (id, slug, name, type, status, state_code)
        VALUES ('${A}', 'prefeitura-a', 'Prefeitura A', 'MUNICIPALITY', 'ACTIVE', 'SC');
      INSERT INTO users (id, external_subject, email, name) VALUES
        ('${CARLA}', 'sub-carla', 'carla@a.test', 'Carla'),
        ('${OUTRO}', 'sub-outro', 'outro@a.test', 'Outro');
      INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
        ('0192d000-0000-7000-8000-0000000113a1', '${A}', '${CARLA}', 'INTERNAL', 'ACTIVE'),
        ('0192d000-0000-7000-8000-0000000113a2', '${A}', '${OUTRO}', 'INTERNAL', 'ACTIVE');
      INSERT INTO notifications (id, tenant_id, recipient_id, type, title, body, link, process_id,
                                 source_event_id, group_key, read_at, archived_at, created_at)
      SELECT gen_random_uuid(), '${A}', u.id, 'PROCESS_RETURNED', 'Processo devolvido',
             'Um processo foi devolvido para ajustes.', '/processos/' || p.id, p.id,
             gen_random_uuid(), 'PROCESS_RETURNED:' || p.id,
             CASE WHEN g % 3 = 0 THEN now() END,
             CASE WHEN g % 10 = 0 THEN now() END,
             now() - (g || ' minutes')::interval
        FROM generate_series(1, ${String(ROWS_PER_USER)}) AS g
        CROSS JOIN (VALUES ('${CARLA}'::uuid), ('${OUTRO}'::uuid)) AS u(id)
        CROSS JOIN LATERAL (SELECT gen_random_uuid() AS id) AS p;
      ANALYZE notifications;
    `);
    app = db.client('cf_app');
  }, 300_000);

  afterAll(async () => {
    await db.stop();
  });

  it(`NTF-01/02 ficam em p95 < ${String(P95_BUDGET_MS)} ms`, async () => {
    const transaction = new TenantTransaction(app);
    const repository = new PrismaNotificationRepository();
    const now = new Date();
    const page = (unreadOnly: boolean, after: Date | null) => () =>
      transaction.read((tx) =>
        repository.list(tx, {
          recipientId: CARLA,
          unreadOnly,
          after:
            after === null
              ? null
              : { createdAt: after, id: 'ffffffff-ffff-7fff-bfff-ffffffffffff' },
          take: 21,
          now,
        }),
      );
    const operations: (() => Promise<unknown>)[] = [
      page(false, null),
      page(true, null),
      // Página no meio do histórico (cursor de ~5 mil minutos atrás).
      page(false, new Date(now.getTime() - 5_000 * 60_000)),
      () => transaction.read((tx) => repository.countUnread(tx, CARLA, now)),
    ];

    for (const operation of operations) {
      const samples: number[] = [];
      for (let i = 0; i < WARMUP + SAMPLES; i += 1) {
        const started = performance.now();
        await asTenant(A, operation);
        if (i >= WARMUP) samples.push(performance.now() - started);
      }
      const value = p95(samples);
      expect(value, `p95 = ${value.toFixed(1)} ms`).toBeLessThan(P95_BUDGET_MS);
    }
  });
});
