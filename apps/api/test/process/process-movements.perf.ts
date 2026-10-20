// US-054 · "Objetivo" e DoD "p95 < 1 s com 1.000 tramitações e limit = 50": a leitura do histórico
// de tramitações (`PrismaProcessRepository.listMovements` — primeira página, página no meio por
// cursor e filtros de ação + unidade + período) no PostgreSQL real com o papel da aplicação e o
// índice único `(tenant_id, process_id, sequence)`, com 1.000 tramitações no processo lido e 100 mil
// em outros processos do tenant. A hidratação dos nomes é em lote (uma leitura por tipo — provada
// em `list-process-movements.query.spec.ts`). Suíte de performance (DEC-087: medida no
// endurecimento, fora do CI do PR): `pnpm --filter @contrataflow/api test:perf`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TenantTransaction } from '#shared/database/database.module.js';
import type { TenantPrismaClient } from '#shared/database/prisma-client.js';

import type { MovementFeedSearch } from '../../src/modules/process/domain/process-movements.js';
import { PrismaProcessRepository } from '../../src/modules/process/infrastructure/prisma-process.repository.js';
import { asTenant, startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';

const A = '0192d054-0000-7000-8000-00000000111a';
const PROCESS = '0192d054-0000-7000-8000-0000000111b1';
const UNIT = '0192d054-0000-7000-8000-0000000111d1';
const MOVEMENTS_IN_PROCESS = 1_000;
const OTHER_PROCESSES = 1_000;
const MOVEMENTS_PER_OTHER = 100;
const WARMUP = 10;
const SAMPLES = 100;
const P95_BUDGET_MS = 1_000;

function p95(samples: number[]): number {
  const sorted = [...samples].sort((x, y) => x - y);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
}

describe('[Desempenho] histórico de tramitações com 1.000 tramitações (US-054)', () => {
  let db: TestDatabase;
  let app: TenantPrismaClient;

  beforeAll(async () => {
    db = await startTestDatabase();
    // Só a leitura é medida: as FKs (processo, unidades, usuários) ficam desligadas na carga.
    await db.admin(`
      INSERT INTO tenants (id, slug, name, type, status, state_code)
        VALUES ('${A}', 'prefeitura-a-us054', 'Prefeitura A', 'MUNICIPALITY', 'ACTIVE', 'SC');
      SET session_replication_role = replica;
      INSERT INTO process_movements (id, tenant_id, process_id, sequence, action, to_department_id,
                                     from_department_id, status_to, actor_type, actor_id,
                                     comment, correlation_id, occurred_at)
      SELECT gen_random_uuid(), '${A}', '${PROCESS}', g,
             (CASE WHEN g = 1 THEN 'CREATE' WHEN g % 3 = 0 THEN 'RETURN' ELSE 'FORWARD' END)::movement_action,
             CASE WHEN g % 2 = 0 THEN '${UNIT}'::uuid ELSE gen_random_uuid() END,
             gen_random_uuid(), 'IN_PROGRESS', 'USER', gen_random_uuid(),
             CASE WHEN g % 3 = 0 THEN 'Devolução para ajuste.' END, 'perf-' || g,
             now() - ((${String(MOVEMENTS_IN_PROCESS)} - g) || ' minutes')::interval
        FROM generate_series(1, ${String(MOVEMENTS_IN_PROCESS)}) AS g;
      INSERT INTO process_movements (id, tenant_id, process_id, sequence, action, status_to,
                                     actor_type, correlation_id, occurred_at)
      SELECT gen_random_uuid(), '${A}', p.id, g, 'FORWARD', 'IN_PROGRESS', 'USER', 'perf',
             now() - (g || ' minutes')::interval
        FROM generate_series(1, ${String(OTHER_PROCESSES)}) AS o
        CROSS JOIN LATERAL (SELECT gen_random_uuid() AS id, o AS seq) AS p
        CROSS JOIN generate_series(1, ${String(MOVEMENTS_PER_OTHER)}) AS g;
      SET session_replication_role = origin;
      ANALYZE process_movements;
    `);
    app = db.client('cf_app');
  }, 300_000);

  afterAll(async () => {
    await db.stop();
  });

  it(`PRC-11 fica em p95 < ${String(P95_BUDGET_MS)} ms`, async () => {
    const transaction = new TenantTransaction(app);
    const repository = new PrismaProcessRepository();
    const now = Date.now();
    const base: MovementFeedSearch = {
      processId: PROCESS,
      actions: null,
      fromDepartmentId: null,
      toDepartmentId: null,
      actorId: null,
      occurredFrom: null,
      occurredTo: null,
      beforeSequence: null,
      take: 51,
    };
    const page = (search: Partial<MovementFeedSearch>) => () =>
      transaction.read((tx) => repository.listMovements(tx, { ...base, ...search }));
    const operations: (() => Promise<unknown>)[] = [
      page({}),
      // Página no meio do histórico (cursor da tramitação nº 500).
      page({ beforeSequence: 500 }),
      page({
        actions: ['FORWARD', 'RETURN'],
        toDepartmentId: UNIT,
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
