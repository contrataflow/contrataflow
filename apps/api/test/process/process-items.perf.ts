// US-006 · "Objetivo": até 1.000 itens por processo com resposta < 400 ms (p95) por operação. Mede o
// acesso a dados do PRC-13 (`PrismaProcessItemRepository.listActive` + `stats`) e da renumeração do
// PRC-17 (`resequence` em duas fases dos 1.000 itens, invertendo a ordem) no PostgreSQL real com o
// papel da aplicação e o índice `process_items_process_idx`, com 1.000 itens no processo medido e
// 200 mil em outros processos do tenant. Suíte de performance (DEC-087: medida no endurecimento,
// fora do CI do PR): `pnpm --filter @contrataflow/api test:perf`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TenantTransaction } from '#shared/database/database.module.js';
import type { TenantPrismaClient } from '#shared/database/prisma-client.js';

import { PrismaProcessItemRepository } from '../../src/modules/process/infrastructure/process-item.repositories.js';
import { asTenant, startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';
import { reportPerf } from '../support/perf-report.js';

const A = '0192d006-0000-7000-8000-00000000111a';
const PROCESS = '0192d006-0000-7000-8000-0000000111b1';
const USER = '0192d006-0000-7000-8000-0000000111c1';
const UNIT = '0192d006-0000-7000-8000-0000000111d1';
const ITEMS = 1_000;
const OTHER_PROCESSES = 1_000;
const ITEMS_PER_OTHER = 200;
const WARMUP = 5;
const SAMPLES = 50;
const P95_BUDGET_MS = 400;

describe('[Desempenho] itens do processo com 1.000 itens (US-006)', () => {
  let db: TestDatabase;
  let app: TenantPrismaClient;

  beforeAll(async () => {
    db = await startTestDatabase();
    // Só os itens são medidos: as FKs ficam desligadas na carga. O processo medido, a unidade e o
    // usuário existem de verdade — a renumeração em duas fases reescreve a linha criada na própria
    // transação e o PostgreSQL volta a conferir as FKs (`process_items_process_fkey` e as de autoria).
    await db.admin(`
      INSERT INTO tenants (id, slug, name, type, status, state_code)
        VALUES ('${A}', 'prefeitura-a-us006', 'Prefeitura A', 'MUNICIPALITY', 'ACTIVE', 'SC');
      SET session_replication_role = replica;
      INSERT INTO users (id, external_subject, email, email_verified, name)
        VALUES ('${USER}', 'sub-us006-perf', 'perf@us006.test', true, 'Perf US-006');
      INSERT INTO catalog_items (id, tenant_id, catalog_type, code, label, is_system, sort_order,
                                 metadata)
        VALUES ('${UNIT}', '${A}', 'UNIT_OF_MEASURE', 'UNIDADE', 'Unidade', true, 1, '{}');
      INSERT INTO processes (id, tenant_id, organization_id, year, number, code, title, object,
                             contracting_type_id, requesting_secretariat_id,
                             requesting_department_id, current_department_id, workflow_version_id,
                             status, origin_id, pca_status, created_by_id)
        VALUES ('${PROCESS}', '${A}', gen_random_uuid(), 2026, 1, '00001/2026',
                'Processo de teste', 'Objeto do processo de teste', gen_random_uuid(),
                gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
                'IN_PROGRESS', gen_random_uuid(), 'NOT_APPLICABLE', '${USER}');
      INSERT INTO process_items (id, tenant_id, process_id, sequence, lot_number, lot_name, kind,
                                 description, unit_of_measure_id, created_by_id, updated_by_id)
      SELECT gen_random_uuid(), '${A}', '${PROCESS}', g, 1 + g % 10, 'Lote ' || (1 + g % 10),
             'GOOD', 'Item de teste número ' || g, '${UNIT}', '${USER}', '${USER}'
        FROM generate_series(1, ${String(ITEMS)}) AS g;
      INSERT INTO process_items (id, tenant_id, process_id, sequence, kind, description,
                                 unit_of_measure_id)
      SELECT gen_random_uuid(), '${A}', p.id, g, 'SERVICE', 'Outro item ' || g, '${UNIT}'
        FROM generate_series(1, ${String(OTHER_PROCESSES)}) AS o
        CROSS JOIN LATERAL (SELECT gen_random_uuid() AS id, o AS seq) AS p
        CROSS JOIN generate_series(1, ${String(ITEMS_PER_OTHER)}) AS g;
      SET session_replication_role = origin;
      ANALYZE process_items;
    `);
    app = db.client('cf_app');
  }, 300_000);

  afterAll(async () => {
    await app.$disconnect();
    await db.stop();
  });

  const measure = async (scenario: string, operation: () => Promise<unknown>) => {
    const samples: number[] = [];
    for (let i = 0; i < WARMUP + SAMPLES; i += 1) {
      const started = performance.now();
      await asTenant(A, operation);
      if (i >= WARMUP) samples.push(performance.now() - started);
    }
    return reportPerf(scenario, samples, P95_BUDGET_MS);
  };

  it(`PRC-13 (lista + contagem) fica em p95 < ${String(P95_BUDGET_MS)} ms`, async () => {
    const transaction = new TenantTransaction(app);
    const repository = new PrismaProcessItemRepository();
    const value = await measure('US-006 PRC-13 lista + contagem (1.000 itens)', () =>
      transaction.snapshot(async (tx) => {
        const items = await repository.listActive(tx, PROCESS);
        const stats = await repository.stats(tx, PROCESS);
        expect(items).toHaveLength(ITEMS);
        expect(stats.count).toBe(ITEMS);
      }),
    );
    expect(value, `p95 = ${value.toFixed(1)} ms`).toBeLessThan(P95_BUDGET_MS);
  });

  it(`PRC-17 (renumeração em duas fases de 1.000 itens) fica em p95 < ${String(P95_BUDGET_MS)} ms`, async () => {
    const transaction = new TenantTransaction(app);
    const repository = new PrismaProcessItemRepository();
    const value = await measure('US-006 PRC-17 renumeração (1.000 itens)', () =>
      transaction.run(async (tx) => {
        const items = await repository.listActive(tx, PROCESS);
        // Inverte a ordem: todo número muda (o pior caso do índice único parcial).
        const changes = items.map((item, index) => ({ id: item.id, to: items.length - index }));
        await repository.resequence(tx, changes, new Date(), USER);
      }),
    );
    expect(value, `p95 = ${value.toFixed(1)} ms`).toBeLessThan(P95_BUDGET_MS);
  });
});
