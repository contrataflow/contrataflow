// US-060 · RN-TML-16 "p95 de PRC-12 < 300 ms para páginas de até 50 itens": a leitura da timeline
// (`PrismaTimelineEntryStore.list` — primeira página, página no meio por cursor, filtros de grupo
// + autor + período e POL-09 excluindo as restritas) no PostgreSQL real com o papel da aplicação e
// o índice `process_timeline_entries_process_idx`, com 5 mil entradas no processo lido e 100 mil
// em outros processos do tenant. Suíte de performance (DEC-087: medida no endurecimento, fora do
// CI do PR): `pnpm --filter @contrataflow/api test:perf`.
import { timelineTypesOfGroups } from '@contrataflow/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TenantTransaction } from '#shared/database/database.module.js';
import type { TenantPrismaClient } from '#shared/database/prisma-client.js';

import type { TimelineFeedSearch } from '../../src/modules/timeline/domain/timeline-feed.js';
import { PrismaTimelineEntryStore } from '../../src/modules/timeline/infrastructure/prisma-timeline-entry.store.js';
import { asTenant, startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';

const A = '0192d060-0000-7000-8000-00000000111a';
const PROCESS = '0192d060-0000-7000-8000-0000000111b1';
const CARLOS = '0192d060-0000-7000-8000-0000000111c1';
const ENTRIES_IN_PROCESS = 5_000;
const OTHER_PROCESSES = 1_000;
const ENTRIES_PER_OTHER = 100;
const WARMUP = 10;
const SAMPLES = 100;
const P95_BUDGET_MS = 300;
const TYPES = ['PROCESS_FORWARDED', 'APPROVAL_DECIDED', 'COMMENT_ADDED', 'PROCESS_UPDATED'];

function p95(samples: number[]): number {
  const sorted = [...samples].sort((x, y) => x - y);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
}

describe('[Desempenho] timeline do processo com 5 mil entradas (US-060)', () => {
  let db: TestDatabase;
  let app: TenantPrismaClient;

  beforeAll(async () => {
    db = await startTestDatabase();
    // Só a timeline é medida: as FKs para `processes` ficam desligadas durante a carga.
    await db.admin(`
      INSERT INTO tenants (id, slug, name, type, status, state_code)
        VALUES ('${A}', 'prefeitura-a-us060', 'Prefeitura A', 'MUNICIPALITY', 'ACTIVE', 'SC');
      SET session_replication_role = replica;
      INSERT INTO process_timeline_entries (id, tenant_id, process_id, occurred_at, type, actor_type,
                                            actor_id, actor_name, params, visibility, source_event_id)
      SELECT gen_random_uuid(), '${A}', '${PROCESS}', now() - (g || ' minutes')::interval,
             (ARRAY['${TYPES.join("','")}'])[1 + g % 4], 'USER',
             CASE WHEN g % 2 = 0 THEN '${CARLOS}'::uuid ELSE gen_random_uuid() END, 'Ator',
             '{}'::jsonb,
             CASE WHEN g % 10 = 0 THEN 'BUDGET_RESTRICTED' ELSE 'STANDARD' END::timeline_visibility,
             gen_random_uuid()
        FROM generate_series(1, ${String(ENTRIES_IN_PROCESS)}) AS g;
      INSERT INTO process_timeline_entries (id, tenant_id, process_id, occurred_at, type, actor_type,
                                            actor_id, actor_name, params, visibility, source_event_id)
      SELECT gen_random_uuid(), '${A}', p.id, now() - (g || ' minutes')::interval,
             'PROCESS_FORWARDED', 'USER', gen_random_uuid(), 'Ator', '{}'::jsonb, 'STANDARD',
             gen_random_uuid()
        FROM generate_series(1, ${String(OTHER_PROCESSES)}) AS o
        CROSS JOIN LATERAL (SELECT gen_random_uuid() AS id, o AS seq) AS p
        CROSS JOIN generate_series(1, ${String(ENTRIES_PER_OTHER)}) AS g;
      SET session_replication_role = origin;
      ANALYZE process_timeline_entries;
    `);
    app = db.client('cf_app');
  }, 300_000);

  afterAll(async () => {
    await db.stop();
  });

  it(`PRC-12 fica em p95 < ${String(P95_BUDGET_MS)} ms`, async () => {
    const transaction = new TenantTransaction(app);
    const store = new PrismaTimelineEntryStore();
    const now = Date.now();
    const base: TimelineFeedSearch = {
      processId: PROCESS,
      types: null,
      actorIds: null,
      occurredFrom: null,
      occurredTo: null,
      includeRestricted: false,
      after: null,
      take: 51,
    };
    const page = (search: Partial<TimelineFeedSearch>) => () =>
      transaction.read((tx) => store.list(tx, { ...base, ...search }));
    const operations: (() => Promise<unknown>)[] = [
      page({}),
      page({ includeRestricted: true }),
      // Página no meio da timeline (cursor de ~2,5 mil minutos atrás).
      page({
        after: {
          occurredAt: new Date(now - 2_500 * 60_000),
          id: 'ffffffff-ffff-7fff-bfff-ffffffffffff',
        },
      }),
      page({
        types: timelineTypesOfGroups(['APROVACOES', 'TRAMITACAO']),
        actorIds: [CARLOS],
        occurredFrom: new Date(now - 7 * 24 * 3_600_000),
        occurredTo: new Date(now),
      }),
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
