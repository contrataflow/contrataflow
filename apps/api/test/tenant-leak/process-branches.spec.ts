// Ramos paralelos sobre PostgreSQL real (US-124 · DEC-194 · M2-05/M2-06/M2-07): a migração
// `20261112120000_process_branches` (tipo da passagem preenchido, contagem de etapas ativas), a
// troca dos índices únicos (um tronco ativo; uma etapa ativa por ramo; uma responsabilidade ativa
// por etapa), o check de escopo do ramo, a RLS de `process_branches` entre tenants, a gravação
// atômica da mudança do runtime (`applyRuntimeChange` — falha no meio da junção não deixa nada) e o
// `FOR UPDATE` na passagem do split serializando duas transações (a junção acontece uma vez).
// `pnpm --filter @contrataflow/api exec vitest run --config vitest.integration.config.ts test/tenant-leak/process-branches.spec.ts`.
import { randomUUID } from 'node:crypto';

import type { ProcessDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';
import type { TenantPrismaClient } from '#shared/database/prisma-client.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { CATALOG_CLOCK } from '../../src/modules/catalog/application/catalog-ports.js';
import { PROCESS_CLOCK } from '../../src/modules/process/application/ports.js';
import type { RuntimeChange } from '../../src/modules/process/domain/process-branches.js';
import { PrismaProcessRepository } from '../../src/modules/process/infrastructure/prisma-process.repository.js';
import { asTenant, startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';
import {
  createTestApi,
  TEST_ISSUER,
  TEST_SIGNING_KEY,
  testConfig,
} from '../support/api-test-app.js';
import type { TestApi } from '../support/api-test-app.js';
import { runTenantSeeders } from '../support/process-fixtures.js';

const A = '0192c124-0000-7000-8000-00000000010a';
const B = '0192c124-0000-7000-8000-00000000010b';
const ORG_A = '0192c124-0000-7000-8000-0000000010a0';
const ORG_B = '0192c124-0000-7000-8000-0000000010b0';
const OBRAS = '0192c124-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c124-0000-7000-8000-0000000010a2';
const PROCURADORIA = '0192c124-0000-7000-8000-0000000010a3';
const CONTROLE = '0192c124-0000-7000-8000-0000000010a4';
const ANA = '0192c124-0000-7000-8000-0000000010c1';
const BETO = '0192c124-0000-7000-8000-0000000010c3';
const ANA_M = '0192c124-0000-7000-8000-0000000010d1';
const NOW = new Date('2026-10-05T15:00:00.000Z');
const MFA = ['pwd', 'otp'];

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us124', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us124', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal de São José', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura B LEAK-B', 'PMB', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${ANA}', 'sub-ana-us124', 'ana@a.test', true, 'Ana Souza'),
  ('${BETO}', 'sub-beto-us124', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth, head_user_id) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Obras', '${path(OBRAS)}', 0, NULL),
  ('${MANUTENCAO}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Manutenção', '${path(OBRAS, MANUTENCAO)}', 1, NULL),
  ('${PROCURADORIA}', '${A}', '${ORG_A}', NULL, 'SECTOR', 'Procuradoria', '${path(PROCURADORIA)}', 0, NULL),
  ('${CONTROLE}', '${A}', '${ORG_A}', NULL, 'SECTOR', 'Controle Interno', '${path(CONTROLE)}', 0, NULL);
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('0192c124-0000-7000-8000-0000000010d3', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c124-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true);
`;

class RoleInjectingMembershipPort implements MembershipPort {
  inner!: MembershipPort;

  async findByUserAndTenant(userId: string, tenantId: string): Promise<MembershipRecord | null> {
    const membership = await this.inner.findByUserAndTenant(userId, tenantId);
    return membership ? { ...membership, roleKeys: ['REQUISITANTE'] } : null;
  }
}

type Row = Readonly<Record<string, unknown>>;

const words = (count: number) =>
  Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

/** O bloco aberto por `openBranches` (ids das passagens e dos ramos). */
interface Opened {
  readonly processId: string;
  readonly split: string;
  readonly juridico: string;
  readonly controle: string;
  readonly branches: { readonly juridico: string; readonly controle: string };
  readonly version: number;
}

describe('Feature: Executar ramos paralelos sobre PostgreSQL (US-124)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let client: TenantPrismaClient;
  let catalog: { contractingType: string; origin: string };
  const repository = new PrismaProcessRepository();

  const inTenant = <T>(tenantId: string, work: (tx: TenantTx) => Promise<T>) =>
    asTenant(tenantId, () => client.$tenantTransaction(work));
  const catalogId = async (tenantId: string, type: string, code: string) => {
    const [row] = await db.admin<{ id: string }>(
      'SELECT id FROM catalog_items WHERE tenant_id = $1 AND catalog_type = $2 AND code = $3',
      [tenantId, type, code],
    );
    if (!row) throw new Error(`${type}/${code} ausente`);
    return row.id;
  };
  /** Etapas da versão fixada no processo (só a FK importa: o tipo da passagem é o do runtime). */
  const workflowStages = async (processId: string) =>
    db.admin<{ id: string; key: string }>(
      `SELECT ws.id, ws.key FROM workflow_stages ws
         JOIN processes p ON p.workflow_version_id = ws.workflow_version_id
        WHERE p.id = $1 ORDER BY ws.display_order`,
      [processId],
    );

  async function createProcess(): Promise<ProcessDto> {
    const response = await request(api.server)
      .post('/api/v1/processes')
      .set('Authorization', api.bearer('sub-ana-us124', { amr: MFA }))
      .set('X-Tenant-Id', A)
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Licitação ${words(2)}`,
        object: `Objeto ${words(3)}`,
        contractingTypeId: catalog.contractingType,
        requestingSecretariatId: OBRAS,
        requestingDepartmentId: MANUTENCAO,
        originId: catalog.origin,
        pcaStatus: 'NOT_APPLICABLE',
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return (response.body as { data: ProcessDto }).data;
  }

  /**
   * Abre o bloco pela mudança genérica do runtime (o que o `BranchEngine.open` grava): fecha a
   * passagem de abertura, cria o split, as duas passagens de ramo, as responsabilidades, os ramos
   * `OPEN` e o movimento único.
   */
  async function openBranches(): Promise<Opened> {
    const created = await createProcess();
    const stages = await workflowStages(created.id);
    const [opening] = await db.admin<{ id: string; sequence: number }>(
      "SELECT id, sequence FROM process_stages WHERE process_id = $1 AND status = 'ACTIVE'",
      [created.id],
    );
    if (!opening || stages.length < 3) throw new Error('fixture incompleta');
    const [splitStage, juridicoStage, controleStage] = [
      stages[1],
      stages[2],
      stages[3] ?? stages[2],
    ];
    const ids = {
      split: randomUUID(),
      juridico: randomUUID(),
      controle: randomUUID(),
      movement: randomUUID(),
      branchJ: randomUUID(),
      branchC: randomUUID(),
    };
    const entry = (
      id: string,
      workflowStageId: string,
      sequence: number,
      departmentId: string,
      type: 'PARALLEL_SPLIT' | 'TASK',
      branchKey: string | null,
    ) => ({
      id,
      tenantId: A,
      processId: created.id,
      workflowStageId,
      sequence,
      departmentId,
      assigneeId: null,
      enteredAt: NOW,
      dueAt: null,
      slaDays: null,
      slaType: null,
      dueDateOverridden: false,
      dueDateOverrideReason: null,
      enteredViaMovementId: ids.movement,
      stageType: type,
      branchKey,
      splitProcessStageId: branchKey === null ? null : ids.split,
      finishedAt: null,
    });
    const [processRow] = await db.admin<Row & { version: number }>(
      'SELECT version FROM processes WHERE id = $1',
      [created.id],
    );
    const version = processRow?.version ?? 1;
    const aggregate = await inTenant(A, (tx) => repository.loadAggregate(tx, created.id));
    if (aggregate === null) throw new Error('processo ausente');
    const change: RuntimeChange = {
      process: {
        ...aggregate.process,
        status: 'IN_PROGRESS',
        currentStageId: ids.split,
        currentWorkflowStageId: splitStage?.id ?? null,
        currentDepartmentId: PROCURADORIA,
        currentResponsibleId: null,
        activeStagesCount: 2,
        version: version + 1,
        updatedAt: NOW,
      },
      expectedVersion: version,
      completion: null,
      closeStages: [
        { id: opening.id, status: 'COMPLETED', exitedAt: NOW, exitedViaMovementId: ids.movement },
      ],
      insertStages: [
        entry(ids.split, splitStage?.id ?? '', 2, PROCURADORIA, 'PARALLEL_SPLIT', null),
        entry(ids.juridico, juridicoStage?.id ?? '', 3, PROCURADORIA, 'TASK', 'JURIDICO'),
        entry(ids.controle, controleStage?.id ?? '', 4, CONTROLE, 'TASK', 'CONTROLE_INTERNO'),
      ],
      insertAssignments: [ids.juridico, ids.controle].map((stageId, index) => ({
        id: randomUUID(),
        tenantId: A,
        processId: created.id,
        processStageId: stageId,
        departmentId: index === 0 ? PROCURADORIA : CONTROLE,
        assigneeId: null,
        type: 'STAGE_ENTRY' as const,
        assignedById: null,
        startedAt: NOW,
      })),
      insertBranches: [
        [ids.branchJ, 'JURIDICO'],
        [ids.branchC, 'CONTROLE_INTERNO'],
      ].map(([id = '', branchKey = '']) => ({
        id,
        tenantId: A,
        processId: created.id,
        splitProcessStageId: ids.split,
        branchKey,
        status: 'OPEN' as const,
        arrivedAt: null,
        canceledAt: null,
        cancellationReason: null,
        createdAt: NOW,
      })),
      updateBranches: [],
      movements: [
        {
          id: ids.movement,
          tenantId: A,
          processId: created.id,
          sequence: 2,
          action: 'FORWARD',
          workflowTransitionId: null,
          fromProcessStageId: opening.id,
          toProcessStageId: ids.split,
          fromWorkflowStageId: null,
          toWorkflowStageId: splitStage?.id ?? '',
          fromDepartmentId: MANUTENCAO,
          toDepartmentId: PROCURADORIA,
          fromUserId: ANA,
          toUserId: null,
          statusFrom: 'DRAFT',
          statusTo: 'IN_PROGRESS',
          actorType: 'USER',
          actorId: ANA,
          actorDepartmentId: MANUTENCAO,
          comment: null,
          dueAt: null,
          documents: [],
          approvalId: null,
          ip: null,
          userAgent: null,
          correlationId: 'us124',
          metadata: {},
          occurredAt: NOW,
          branchKey: null,
        },
      ],
    };
    expect(await inTenant(A, (tx) => repository.applyRuntimeChange(tx, change))).toBe(true);
    return {
      processId: created.id,
      split: ids.split,
      juridico: ids.juridico,
      controle: ids.controle,
      branches: { juridico: ids.branchJ, controle: ids.branchC },
      version: version + 1,
    };
  }

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    db = await startTestDatabase();
    await db.admin(FIXTURE_SQL);
    const membership = new RoleInjectingMembershipPort();
    const config = testConfig({
      OIDC_FAKE_SIGNING_KEY: '',
      DATABASE_URL: db.url('cf_app'),
      DATABASE_URL_PLATFORM: db.url('cf_platform'),
      DATABASE_POOL_SIZE: '10',
    });
    api = await createTestApi({
      config,
      providers: [
        { token: MEMBERSHIP_PORT, value: membership },
        { token: PROCESS_CLOCK, value: () => NOW },
        { token: CATALOG_CLOCK, value: () => NOW },
        {
          token: TOKEN_VERIFIER,
          value: new FakeJwksProvider({
            signingKey: TEST_SIGNING_KEY,
            issuer: TEST_ISSUER,
            audiences: config.oidc.audiences,
            clockToleranceSeconds: 30,
          }),
        },
      ],
    });
    membership.inner = api.app.get(PrismaIdentityRepository);
    await runTenantSeeders(api, A, [
      'catalog.items',
      'catalog.holidays',
      'access.defaultRoles',
      'document.systemTypes',
      'workflow.seedWorkflows',
    ]);
    await runTenantSeeders(api, B);
    catalog = {
      contractingType: await catalogId(A, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
      origin: await catalogId(A, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
    };
    client = db.client('cf_app');
  });

  afterAll(async () => {
    await client.$disconnect();
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Migração] a passagem criada sem tipo recebe o da etapa e o processo nasce com 1 etapa ativa', async () => {
    const created = await createProcess();
    const [stage] = await db.admin<{ stage_type: string }>(
      'SELECT stage_type::text FROM process_stages WHERE process_id = $1',
      [created.id],
    );
    expect(stage?.stage_type).toBe('START');
    const [row] = await db.admin<{ active_stages_count: number }>(
      'SELECT active_stages_count FROM processes WHERE id = $1',
      [created.id],
    );
    expect(row?.active_stages_count).toBe(1);
    // Carga por SQL sem `stage_type` (testes e integrações): o gatilho preenche.
    const [opening] = await db.admin<{ id: string; workflow_stage_id: string }>(
      'SELECT id, workflow_stage_id FROM process_stages WHERE process_id = $1',
      [created.id],
    );
    await db.admin(
      `BEGIN;
       UPDATE process_stages SET status = 'COMPLETED', exited_at = now() WHERE id = '${opening?.id ?? ''}';
       INSERT INTO process_stages (id, tenant_id, process_id, workflow_stage_id, sequence, status, department_id)
         VALUES ('${randomUUID()}', '${A}', '${created.id}', '${opening?.workflow_stage_id ?? ''}', 2, 'ACTIVE', '${MANUTENCAO}');
       COMMIT;`,
    );
    const types = await db.admin<{ stage_type: string }>(
      'SELECT stage_type::text FROM process_stages WHERE process_id = $1 ORDER BY sequence',
      [created.id],
    );
    expect(types.map((type) => type.stage_type)).toEqual(['START', 'START']);
  });

  it('[Sucesso] abrir o bloco grava split, passagens de ramo, responsabilidades e ramos OPEN no mesmo commit', async () => {
    const opened = await openBranches();
    const stages = await db.admin<Row>(
      `SELECT stage_type::text, branch_key, split_process_stage_id, status::text
         FROM process_stages WHERE process_id = $1 ORDER BY sequence`,
      [opened.processId],
    );
    expect(stages.slice(1)).toEqual([
      {
        stage_type: 'PARALLEL_SPLIT',
        branch_key: null,
        split_process_stage_id: null,
        status: 'ACTIVE',
      },
      {
        stage_type: 'TASK',
        branch_key: 'JURIDICO',
        split_process_stage_id: opened.split,
        status: 'ACTIVE',
      },
      {
        stage_type: 'TASK',
        branch_key: 'CONTROLE_INTERNO',
        split_process_stage_id: opened.split,
        status: 'ACTIVE',
      },
    ]);
    const active = await db.admin<Row>(
      'SELECT process_stage_id FROM process_assignments WHERE process_id = $1 AND is_active',
      [opened.processId],
    );
    expect(active).toHaveLength(2);
    const branches = await db.admin<Row>(
      'SELECT branch_key, status::text FROM process_branches WHERE process_id = $1 ORDER BY branch_key',
      [opened.processId],
    );
    expect(branches).toEqual([
      { branch_key: 'CONTROLE_INTERNO', status: 'OPEN' },
      { branch_key: 'JURIDICO', status: 'OPEN' },
    ]);
    const [process] = await db.admin<Row>(
      'SELECT active_stages_count, current_stage_id FROM processes WHERE id = $1',
      [opened.processId],
    );
    expect(process).toEqual({ active_stages_count: 2, current_stage_id: opened.split });
  });

  it('[Validação] índices únicos e check: um tronco ativo, uma etapa por ramo, uma responsabilidade por etapa', async () => {
    const opened = await openBranches();
    const [stage] = await workflowStages(opened.processId);
    const insertStage = (sequence: number, branchKey: string | null, split: string | null) =>
      db.admin(
        `INSERT INTO process_stages (id, tenant_id, process_id, workflow_stage_id, sequence, status,
                                     department_id, stage_type, branch_key, split_process_stage_id)
         VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6, 'TASK', $7, $8)`,
        [randomUUID(), A, opened.processId, stage?.id, sequence, PROCURADORIA, branchKey, split],
      );
    await expect(insertStage(10, null, null)).rejects.toThrow(/process_stages_trunk_active_key/);
    await expect(insertStage(11, 'JURIDICO', opened.split)).rejects.toThrow(
      /process_stages_branch_active_key/,
    );
    await expect(insertStage(12, 'JURIDICO', null)).rejects.toThrow(/process_stages_branch_scope/);
    await expect(
      db.admin(
        `INSERT INTO process_assignments (id, tenant_id, process_id, process_stage_id, department_id, type)
         VALUES ($1, $2, $3, $4, $5, 'CLAIM')`,
        [randomUUID(), A, opened.processId, opened.juridico, PROCURADORIA],
      ),
    ).rejects.toThrow(/process_assignments_stage_active_key/);
    await expect(
      db.admin(
        `INSERT INTO process_branches (id, tenant_id, process_id, split_process_stage_id, branch_key)
         VALUES ($1, $2, $3, $4, 'JURIDICO')`,
        [randomUUID(), A, opened.processId, opened.split],
      ),
    ).rejects.toThrow(/process_branches_split_branch_key/);
    await expect(
      db.admin("UPDATE process_branches SET status = 'ARRIVED' WHERE id = $1", [
        opened.branches.juridico,
      ]),
    ).rejects.toThrow(/process_branches_arrived/);
  });

  it('[Tenant incorreto] RLS: o tenant B não vê nem grava ramos do tenant A; PRC-39 de B → 404', async () => {
    const opened = await openBranches();
    const seen = await inTenant(
      B,
      (tx) =>
        tx.$queryRaw<
          Row[]
        >`SELECT id FROM process_branches WHERE process_id = ${opened.processId}::uuid`,
    );
    expect(seen).toEqual([]);
    const stages = await inTenant(
      B,
      (tx) =>
        tx.$queryRaw<
          Row[]
        >`SELECT id FROM process_stages WHERE process_id = ${opened.processId}::uuid`,
    );
    expect(stages).toEqual([]);
    await expect(
      inTenant(
        B,
        (tx) =>
          tx.$executeRaw`INSERT INTO process_branches (id, tenant_id, process_id, split_process_stage_id, branch_key)
          VALUES (${randomUUID()}::uuid, ${A}::uuid, ${opened.processId}::uuid, ${opened.split}::uuid, 'OUTRO')`,
      ),
    ).rejects.toThrow();
    const response = await request(api.server)
      .get(`/api/v1/processes/${opened.processId}/branches`)
      .set('Authorization', api.bearer('sub-beto-us124', { amr: MFA }))
      .set('X-Tenant-Id', B);
    expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain(opened.processId.slice(0, 8) + 'LEAK');
  });

  it('[Falha de banco] falha no meio da junção: a transação inteira é desfeita (ramo OPEN, sem passagem de junção)', async () => {
    const opened = await openBranches();
    const before = await db.admin<Row>(
      'SELECT id, status::text FROM process_stages WHERE process_id = $1 ORDER BY sequence',
      [opened.processId],
    );
    await expect(
      inTenant(A, async (tx) => {
        const rows = await repository.loadAggregate(tx, opened.processId);
        if (rows === null) throw new Error('processo ausente');
        await repository.lockStage(tx, opened.split);
        await repository.applyRuntimeChange(tx, {
          process: { ...rows.process, version: rows.process.version + 1, activeStagesCount: 1 },
          expectedVersion: rows.process.version,
          completion: null,
          closeStages: [
            { id: opened.controle, status: 'COMPLETED', exitedAt: NOW, exitedViaMovementId: null },
          ],
          insertStages: [],
          insertAssignments: [],
          insertBranches: [],
          updateBranches: [
            { id: opened.branches.controle, status: 'ARRIVED', at: NOW, cancellationReason: null },
          ],
          movements: [],
        });
        throw new Error('falha induzida antes de gravar a etapa seguinte');
      }),
    ).rejects.toThrow(/falha induzida/);
    const after = await db.admin<Row>(
      'SELECT id, status::text FROM process_stages WHERE process_id = $1 ORDER BY sequence',
      [opened.processId],
    );
    expect(after).toEqual(before);
    const branches = await db.admin<Row>(
      'SELECT status::text FROM process_branches WHERE id = $1',
      [opened.branches.controle],
    );
    expect(branches).toEqual([{ status: 'OPEN' }]);
  });

  it('[Concorrência] FOR UPDATE no split serializa duas chegadas: a segunda espera a primeira', async () => {
    const opened = await openBranches();
    const order: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstLocked: () => void = () => undefined;
    const locked = new Promise<void>((resolve) => {
      firstLocked = resolve;
    });
    const first = inTenant(A, async (tx) => {
      await repository.lockStage(tx, opened.split);
      order.push('primeira travou');
      firstLocked();
      await held;
      order.push('primeira liberou');
    });
    await locked;
    const second = inTenant(A, async (tx) => {
      await repository.lockStage(tx, opened.split);
      order.push('segunda travou');
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(order).toEqual(['primeira travou']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['primeira travou', 'primeira liberou', 'segunda travou']);
  });
});
