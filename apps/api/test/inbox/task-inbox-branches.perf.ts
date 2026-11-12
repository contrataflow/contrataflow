// US-125 · RN-WF2-38 / RN-INBOX-12 — "Testes necessários — Performance": p95 da caixa de tarefas
// < 500 ms POR VISÃO com 10.000 processos ativos, 20% deles em ramificação (uma linha por ramo).
// Mede a leitura inteira do `PrismaInboxReader` (página + total numa instrução, e os contadores
// numa instrução) sobre as views `v_inbox_*` no PostgreSQL real com o papel da aplicação (RLS). A
// carga clona por SQL um processo do tronco e um em ramificação — todas as linhas do agregado com
// ids novos — para não passar 10 mil vezes pelo PRC-02. Suíte de performance (DEC-087: medida no
// endurecimento, fora do card): `pnpm --filter @contrataflow/api test:perf`. Para conferir só a
// mecânica, baixe `TOTAL` localmente (ex.: 20) — sem commitar.
import { TASK_INBOX_VIEWS } from '@contrataflow/validation';
import type { TaskInboxView } from '@contrataflow/validation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { inboxViewerOf } from '../../src/modules/inbox/domain/task-inbox.js';
import { PrismaInboxReader } from '../../src/modules/inbox/infrastructure/task-inbox.readers.js';
import {
  A,
  ANA,
  CONTROLE,
  NOW,
  PROCURADORIA,
  startBranchDatabase,
} from '../support/branch-pg-fixtures.js';
import type { BranchDatabase } from '../support/branch-pg-fixtures.js';
import { reportPerf } from '../support/perf-report.js';

const TOTAL = 10_000;
const BRANCHED_SHARE = 0.2;
const WARMUP = 2;
const SAMPLES = 20;
const P95_BUDGET_MS = 500;

/** Tabelas do agregado clonadas (na ordem das FKs) e a coluna que as liga ao processo. */
const AGGREGATE_TABLES = [
  ['processes', 'id'],
  ['process_movements', 'process_id'],
  ['process_stages', 'process_id'],
  ['process_branches', 'process_id'],
  ['process_assignments', 'process_id'],
  ['process_access', 'process_id'],
] as const;

/**
 * Clona `copies` vezes todas as linhas do processo `baseId` (ids novos e referências internas
 * remapeadas; código e número nulos para não colidir), por SQL dinâmico que pula as colunas
 * geradas. Roda como superusuário (sem RLS), uma transação por lote.
 */
function cloneSql(baseId: string, copies: number): string {
  const tables = AGGREGATE_TABLES.map(([table, key]) => `('${table}', '${key}')`).join(', ');
  return `
DO $clone$
DECLARE
  v_copy int;
  v_table record;
  v_columns text;
  v_values text;
BEGIN
  SET LOCAL session_replication_role = replica; -- gatilhos de imutabilidade/consistência fora
  CREATE TEMP TABLE IF NOT EXISTS clone_ids (old uuid PRIMARY KEY, new uuid) ON COMMIT DROP;
  FOR v_copy IN 1..${String(copies)} LOOP
    TRUNCATE clone_ids;
    INSERT INTO clone_ids SELECT id, gen_random_uuid() FROM processes WHERE id = '${baseId}';
    INSERT INTO clone_ids SELECT id, gen_random_uuid() FROM process_stages WHERE process_id = '${baseId}';
    INSERT INTO clone_ids SELECT id, gen_random_uuid() FROM process_branches WHERE process_id = '${baseId}';
    INSERT INTO clone_ids SELECT id, gen_random_uuid() FROM process_assignments WHERE process_id = '${baseId}';
    INSERT INTO clone_ids SELECT id, gen_random_uuid() FROM process_access WHERE process_id = '${baseId}';
    INSERT INTO clone_ids SELECT id, gen_random_uuid() FROM process_movements WHERE process_id = '${baseId}';
    FOR v_table IN SELECT * FROM (VALUES ${tables}) AS t(name, key) LOOP
      SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position),
             string_agg(
               CASE
                 WHEN v_table.name = 'processes' AND column_name IN ('code', 'number', 'internal_code')
                   THEN 'NULL'
                 WHEN udt_name = 'uuid'
                   THEN format('COALESCE((SELECT m.new FROM clone_ids m WHERE m.old = r.%1$I), r.%1$I)', column_name)
                 ELSE format('r.%I', column_name)
               END, ', ' ORDER BY ordinal_position)
        INTO v_columns, v_values
        FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = v_table.name AND is_generated = 'NEVER';
      EXECUTE format('INSERT INTO %I (%s) SELECT %s FROM %I r WHERE r.%I = %L',
                     v_table.name, v_columns, v_values, v_table.name, v_table.key, '${baseId}');
    END LOOP;
  END LOOP;
END
$clone$;`;
}

describe('[Desempenho] caixa de tarefas com ramos paralelos (US-125)', () => {
  let fixture: BranchDatabase;
  const reader = new PrismaInboxReader();
  const viewer = inboxViewerOf({
    userId: ANA,
    ownDepartmentIds: [PROCURADORIA, CONTROLE],
    headOfDepartmentIds: [],
    claim: { tenantWide: true, organizationIds: [], departmentIds: [] },
    leadership: { headOf: [], deputyOf: [] },
    roles: [],
    visibility: { userId: ANA, tenantWide: true, organizationIds: [], departmentIds: [] },
    historicalDepartmentsCanView: true,
  });

  beforeAll(async () => {
    fixture = await startBranchDatabase();
    const branched = await fixture.openBranches();
    const trunk = await fixture.createProcess();
    const branchedCopies = Math.round(TOTAL * BRANCHED_SHARE) - 1;
    const trunkCopies = TOTAL - branchedCopies - 2;
    const batch = 500;
    for (let done = 0; done < branchedCopies; done += batch) {
      await fixture.db.admin(cloneSql(branched.processId, Math.min(batch, branchedCopies - done)));
    }
    for (let done = 0; done < trunkCopies; done += batch) {
      await fixture.db.admin(cloneSql(trunk.id, Math.min(batch, trunkCopies - done)));
    }
    await fixture.db.admin('ANALYZE');
  }, 1_800_000);

  afterAll(async () => {
    await fixture.close();
  });

  const measure = async (label: string, work: () => Promise<unknown>) => {
    const samples: number[] = [];
    for (let run = 0; run < WARMUP + SAMPLES; run += 1) {
      const startedAt = performance.now();
      await work();
      if (run >= WARMUP) samples.push(performance.now() - startedAt);
    }
    return reportPerf(label, samples, P95_BUDGET_MS);
  };

  it.each(TASK_INBOX_VIEWS)(
    `TSK-01 p95 < ${String(P95_BUDGET_MS)} ms na visão %s`,
    async (view: TaskInboxView) => {
      const p95 = await measure(`US-125 TSK-01 ${view} (${String(TOTAL)} processos)`, () =>
        fixture.inTenant(A, (tx) =>
          reader.page(tx, {
            view,
            sort: { field: 'dueAt', direction: 'desc' },
            page: 1,
            pageSize: 20,
            viewer,
            now: NOW,
            branchKey: null,
          }),
        ),
      );
      expect(p95).toBeLessThan(P95_BUDGET_MS);
    },
    600_000,
  );

  it(`TSK-02 p95 < ${String(P95_BUDGET_MS)} ms (todas as visões numa instrução)`, async () => {
    const counts = await fixture.inTenant(A, (tx) => reader.counts(tx, viewer, NOW));
    // Fila das duas unidades: 2 linhas por processo em ramificação (RN-WF2-31).
    expect(counts.UNIT_QUEUE).toBeGreaterThanOrEqual(2 * Math.round(TOTAL * BRANCHED_SHARE));
    const p95 = await measure(`US-125 TSK-02 contadores (${String(TOTAL)} processos)`, () =>
      fixture.inTenant(A, (tx) => reader.counts(tx, viewer, NOW)),
    );
    expect(p95).toBeLessThan(P95_BUDGET_MS);
  }, 600_000);
});
