// Ramos paralelos nas LEITURAS sobre PostgreSQL real (US-125 · DEC-194 · RN-WF2-29..38): a
// migração `20261112130000_inbox_branch_rows` — `v_inbox_processes` com uma linha por etapa ativa
// de ramo (o split fora, a responsabilidade casada pela etapa) e as colunas aditivas;
// `v_inbox_pending_approvals_v2` com a etapa e o ramo da aprovação — o `TaskInboxQueryBuilder`
// (página e contadores do mesmo snapshot contando LINHAS, filtro por ramo, "Acompanhando" uma
// linha por processo), os filtros da lista por qualquer etapa ativa e a RLS das views entre tenants.
// `pnpm --filter @contrataflow/api exec vitest run --config vitest.integration.config.ts test/tenant-leak/inbox-branches.spec.ts`.
import { TASK_INBOX_VIEWS } from '@contrataflow/validation';
import type { TaskInboxView } from '@contrataflow/validation';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TenantTx } from '#shared/database/prisma.js';

import { inboxViewerOf } from '../../src/modules/inbox/domain/task-inbox.js';
import type { InboxViewer } from '../../src/modules/inbox/domain/task-inbox.js';
import { PrismaInboxReader } from '../../src/modules/inbox/infrastructure/task-inbox.readers.js';
import {
  A,
  ANA,
  B,
  CONTROLE,
  MFA,
  NOW,
  PROCURADORIA,
  startBranchDatabase,
} from '../support/branch-pg-fixtures.js';
import type { BranchDatabase } from '../support/branch-pg-fixtures.js';

describe('Feature: Ramos paralelos na caixa e na lista sobre PostgreSQL (US-125)', () => {
  let fixture: BranchDatabase;
  const inTenant = <T>(tenantId: string, work: (tx: TenantTx) => Promise<T>) =>
    fixture.inTenant(tenantId, work);
  const openBranches = () => fixture.openBranches();

  beforeAll(async () => {
    fixture = await startBranchDatabase();
  }, 300_000);

  afterAll(async () => {
    await fixture.close();
  });

  /** Quem consulta a caixa: fila das duas unidades dos ramos, visibilidade ampla (DEC-024). */
  const viewer: InboxViewer = inboxViewerOf({
    userId: ANA,
    ownDepartmentIds: [PROCURADORIA, CONTROLE],
    headOfDepartmentIds: [],
    claim: { tenantWide: true, organizationIds: [], departmentIds: [] },
    leadership: { headOf: [], deputyOf: [] },
    roles: [],
    visibility: { userId: ANA, tenantWide: true, organizationIds: [], departmentIds: [] },
    historicalDepartmentsCanView: true,
  });
  const reader = new PrismaInboxReader();
  const page = (tenantId: string, view: TaskInboxView, branchKey: string | null = null) =>
    inTenant(tenantId, (tx) =>
      reader.page(tx, {
        view,
        sort: { field: 'dueAt', direction: 'asc' },
        page: 1,
        pageSize: 50,
        viewer,
        now: NOW,
        branchKey,
      }),
    );

  it('[View] uma linha por etapa ativa de ramo — o split fica de fora e a responsabilidade é a da etapa', async () => {
    const opened = await openBranches();

    const rows = await inTenant(
      A,
      (tx) =>
        tx.$queryRaw<
          {
            stage_id: string;
            process_stage_id: string;
            branch_key: string | null;
            stage_department_id: string;
            assignment_department_id: string | null;
            active_stages_count: number;
          }[]
        >`SELECT stage_id, process_stage_id, branch_key, stage_department_id,
               assignment_department_id, active_stages_count
          FROM v_inbox_processes WHERE id = ${opened.processId}::uuid ORDER BY branch_key`,
    );

    expect(rows).toEqual([
      {
        stage_id: opened.controle,
        process_stage_id: opened.controle,
        branch_key: 'CONTROLE_INTERNO',
        stage_department_id: CONTROLE,
        assignment_department_id: CONTROLE,
        active_stages_count: 2,
      },
      {
        stage_id: opened.juridico,
        process_stage_id: opened.juridico,
        branch_key: 'JURIDICO',
        stage_department_id: PROCURADORIA,
        assignment_department_id: PROCURADORIA,
        active_stages_count: 2,
      },
    ]);
    // A view das aprovações ganhou a etapa e o ramo (colunas aditivas ao final).
    await inTenant(
      A,
      (tx) =>
        tx.$queryRaw`SELECT process_stage_id, branch_key FROM v_inbox_pending_approvals_v2 LIMIT 1`,
    );
  });

  it('[Caixa] página e contadores contam LINHAS no mesmo snapshot; filtro por ramo; "Acompanhando" uma por processo', async () => {
    const opened = await openBranches();

    const queue = await page(A, 'UNIT_QUEUE');
    const ofProcess = queue.rows.filter((row) => row.process.id === opened.processId);
    expect(ofProcess.map((row) => [row.key, row.stageId, row.process.branchKey]).sort()).toEqual(
      [
        [opened.processId, opened.controle, 'CONTROLE_INTERNO'],
        [opened.processId, opened.juridico, 'JURIDICO'],
      ].sort(),
    );
    const counts = await inTenant(A, (tx) => reader.counts(tx, viewer, NOW));
    expect(counts.UNIT_QUEUE).toBe(queue.totalItems);

    const juridico = await page(A, 'UNIT_QUEUE', 'JURIDICO');
    expect(
      juridico.rows.filter((row) => row.process.id === opened.processId).map((row) => row.stageId),
    ).toEqual([opened.juridico]);

    for (const view of TASK_INBOX_VIEWS) {
      const result = await page(A, view);
      expect(counts[view], view).toBe(view === 'UNIT_QUEUE' ? queue.totalItems : result.totalItems);
      if (view === 'FOLLOWING') {
        expect(result.rows.every((row) => row.stageId === null)).toBe(true);
      }
    }
  });

  it('[Tenant incorreto] as linhas e os ramos de A não aparecem para B (RLS das views)', async () => {
    const opened = await openBranches();

    const rows = await inTenant(
      B,
      (tx) =>
        tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM v_inbox_processes WHERE id = ${opened.processId}::uuid`,
    );
    expect(rows).toEqual([]);
    const queue = await page(B, 'UNIT_QUEUE');
    expect(queue.rows.map((row) => row.process.id)).not.toContain(opened.processId);
    const keys = await inTenant(B, (tx) =>
      fixture.repository.branchKeysOf(tx, [opened.juridico, opened.controle]),
    );
    expect(keys.size).toBe(0);
    const own = await inTenant(A, (tx) =>
      fixture.repository.branchKeysOf(tx, [opened.juridico, opened.controle, opened.split]),
    );
    expect([...own.values()].map((entry) => entry.branchKey).sort()).toEqual([
      'CONTROLE_INTERNO',
      'JURIDICO',
    ]);
  });

  it('[Lista] a unidade de QUALQUER ramo casa o filtro; a linha traz as etapas ativas', async () => {
    const opened = await openBranches();

    const response = await request(fixture.api.server)
      .get(`/api/v1/processes?currentDepartmentId=${CONTROLE}`)
      .set('Authorization', fixture.api.bearer('sub-ana-us125', { amr: MFA }))
      .set('X-Tenant-Id', A);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const item = (
      response.body as {
        data: { id: string; activeStagesCount?: number; activeStages?: unknown[] }[];
      }
    ).data.find((row) => row.id === opened.processId);
    expect(item?.activeStagesCount).toBe(2);
    expect(item?.activeStages).toHaveLength(2);
  });
});
