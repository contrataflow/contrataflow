// US-076 · RN-DASH-11 "p95 < 1 s por endpoint (resumo e cada widget) com até 10.000 processos
// ativos no tenant": cada leitura agregada do painel (`PrismaDashboardReader` — resumo, por status,
// por etapa, atrasados/a vencer por secretaria, tempo médio por etapa em 90 dias, abertos por mês,
// valor por secretaria com POL-09 e atividade recente) no PostgreSQL real com o papel da aplicação
// e as views `v_dashboard_*`, para uma gestora em escopo TENANT e uma requisitante só das lotações.
// Carga: 10 mil processos abertos, 30 mil passagens concluídas e 100 mil entradas de timeline.
// Suíte de performance (DEC-087: medida no endurecimento, fora do CI do PR):
// `pnpm --filter @contrataflow/api test:perf`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TenantTransaction } from '#shared/database/database.module.js';
import type { TenantPrismaClient } from '#shared/database/prisma-client.js';

import type { DashboardSearch } from '../../src/modules/dashboard/application/ports.js';
import { dashboardWindowOf, NO_SCOPE } from '../../src/modules/dashboard/domain/dashboard.js';
import { PrismaDashboardReader } from '../../src/modules/dashboard/infrastructure/dashboard.readers.js';
import { asTenant, startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';

const A = '0192d076-0000-7000-8000-00000000111a';
const ORG = '0192d076-0000-7000-8000-0000000111a0';
const USER = '0192d076-0000-7000-8000-0000000111c1';
const SECRETARIATS = Array.from(
  { length: 10 },
  (_, n) => `0192d076-0000-7000-8000-0000000112${String(n).padStart(2, '0')}`,
);
const STAGES = Array.from(
  { length: 8 },
  (_, n) => `0192d076-0000-7000-8000-0000000113${String(n).padStart(2, '0')}`,
);
const PROCESSES = 10_000;
const PASSAGES_PER_PROCESS = 3;
const ENTRIES_PER_PROCESS = 10;
const WARMUP = 5;
const SAMPLES = 50;
const P95_BUDGET_MS = 1_000;
const NOW = new Date();

function p95(samples: number[]): number {
  const sorted = [...samples].sort((x, y) => x - y);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
}

const sqlArray = (ids: readonly string[]) => `ARRAY['${ids.join("','")}']::uuid[]`;

describe('[Desempenho] dashboard com 10 mil processos ativos (US-076)', () => {
  let db: TestDatabase;
  let app: TenantPrismaClient;

  beforeAll(async () => {
    db = await startTestDatabase();
    // Só as leituras do painel são medidas: as FKs ficam desligadas durante a carga.
    await db.admin(`
      INSERT INTO tenants (id, slug, name, type, status, state_code)
        VALUES ('${A}', 'prefeitura-a-us076', 'Prefeitura A', 'MUNICIPALITY', 'ACTIVE', 'SC');
      SET session_replication_role = replica;
      INSERT INTO processes (id, tenant_id, organization_id, year, number, code, title, object,
                             contracting_type_id, requesting_secretariat_id,
                             requesting_department_id, current_department_id, workflow_version_id,
                             current_workflow_stage_id, current_stage_due_at, overdue_since,
                             opened_at, status, estimated_value, estimated_value_source,
                             is_budget_confidential, origin_id, pca_status, created_by_id)
      SELECT gen_random_uuid(), '${A}', '${ORG}', 2026, g, lpad(g::text, 5, '0') || '/2026',
             'Processo ' || g, 'Objeto ' || g, gen_random_uuid(),
             (${sqlArray(SECRETARIATS)})[1 + g % 10], (${sqlArray(SECRETARIATS)})[1 + g % 10],
             (${sqlArray(SECRETARIATS)})[1 + g % 10], gen_random_uuid(),
             (${sqlArray(STAGES)})[1 + g % 8], now() + ((g % 20) || ' days')::interval,
             CASE WHEN g % 7 = 0 THEN now() - interval '3 days' END,
             now() - ((g % 360) || ' days')::interval,
             (ARRAY['IN_PROGRESS','AWAITING_APPROVAL','RETURNED','SUSPENDED','COMPLETED'])[1 + g % 5]::process_status,
             (g * 10)::numeric(18, 2), 'MANUAL', g % 9 = 0, gen_random_uuid(), 'NOT_APPLICABLE',
             '${USER}'
        FROM generate_series(1, ${String(PROCESSES)}) AS g;
      INSERT INTO process_access (id, tenant_id, process_id, principal_type, department_id, reason)
      SELECT gen_random_uuid(), p.tenant_id, p.id, 'DEPARTMENT', p.requesting_department_id, 'REQUESTING'
        FROM processes p WHERE p.tenant_id = '${A}';
      INSERT INTO process_stages (id, tenant_id, process_id, workflow_stage_id, sequence, status,
                                  department_id, entered_at, exited_at)
      SELECT gen_random_uuid(), p.tenant_id, p.id, (${sqlArray(STAGES)})[1 + s], s, 'COMPLETED',
             p.current_department_id, now() - ((s * 10 + 5) || ' days')::interval,
             now() - ((s * 10) || ' days')::interval
        FROM processes p CROSS JOIN generate_series(1, ${String(PASSAGES_PER_PROCESS)}) AS s
       WHERE p.tenant_id = '${A}';
      INSERT INTO process_timeline_entries (id, tenant_id, process_id, occurred_at, type, actor_type,
                                            params, visibility, source_event_id)
      SELECT gen_random_uuid(), p.tenant_id, p.id, now() - ((random() * 100000) || ' minutes')::interval,
             'PROCESS_FORWARDED', 'SYSTEM', '{}'::jsonb,
             CASE WHEN e % 10 = 0 THEN 'BUDGET_RESTRICTED' ELSE 'STANDARD' END::timeline_visibility,
             gen_random_uuid()
        FROM processes p CROSS JOIN generate_series(1, ${String(ENTRIES_PER_PROCESS)}) AS e
       WHERE p.tenant_id = '${A}';
      SET session_replication_role = origin;
      ANALYZE processes; ANALYZE process_access; ANALYZE process_stages;
      ANALYZE process_timeline_entries;
    `);
    app = db.client('cf_app');
  }, 600_000);

  afterAll(async () => {
    await db.stop();
  });

  it(`cada leitura do painel fica em p95 < ${String(P95_BUDGET_MS)} ms`, async () => {
    const transaction = new TenantTransaction(app);
    const reader = new PrismaDashboardReader();
    const businessDaysAfterToday = Array.from({ length: 10 }, (_, n) =>
      new Date(NOW.getTime() + (n + 1) * 86_400_000).toISOString().slice(0, 10),
    );
    const window = dashboardWindowOf({
      now: NOW,
      timezone: 'America/Sao_Paulo',
      warnBeforeBusinessDays: 2,
      businessDaysAfterToday,
    });
    const viewer = (tenantWide: boolean): DashboardSearch['viewer'] => ({
      userId: USER,
      visibility: {
        userId: USER,
        tenantWide,
        organizationIds: [],
        departmentIds: tenantWide ? [] : SECRETARIATS.slice(0, 2),
      },
      historicalDepartmentsCanView: true,
      budget: {
        userId: USER,
        tenantWide: false,
        organizationIds: [],
        departmentIds: [],
        custodyDepartmentIds: [],
      },
    });
    for (const tenantWide of [true, false]) {
      const search: DashboardSearch = { viewer: viewer(tenantWide), scope: NO_SCOPE, window };
      const operations: (() => Promise<unknown>)[] = [
        () => transaction.read((tx) => reader.processCounts(tx, search)),
        () => transaction.read((tx) => reader.countByStatus(tx, search)),
        () => transaction.read((tx) => reader.countByStage(tx, search)),
        () => transaction.read((tx) => reader.countDeadlinesBySecretariat(tx, search, 'OVERDUE')),
        () => transaction.read((tx) => reader.countDeadlinesBySecretariat(tx, search, 'DUE_SOON')),
        () => transaction.read((tx) => reader.averageStageDurations(tx, search)),
        () => transaction.read((tx) => reader.openedByMonth(tx, search)),
        () => transaction.read((tx) => reader.valueBySecretariat(tx, search)),
        () => transaction.read((tx) => reader.recentActivity(tx, search, 20)),
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
    }
  }, 900_000);
});
