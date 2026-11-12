// Preparo em PostgreSQL real dos testes de ramos paralelos nas leituras (US-125): o tenant A com
// Procuradoria e Controle Interno, o tenant B, a API sobre `cf_app` e o processo aberto em dois
// ramos pela mudança genérica do runtime (o que o `BranchEngine.open` grava — o mesmo preparo de
// `test/tenant-leak/process-branches.spec.ts`, da US-124). Usado pelo isolamento
// (`test/tenant-leak/inbox-branches.spec.ts`) e pelo desempenho (`test/inbox/task-inbox-branches.perf.ts`).
import { randomUUID } from 'node:crypto';

import type { ProcessDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { expect, vi } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';
import type { TenantPrismaClient } from '#shared/database/prisma-client.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { createTestApi, TEST_ISSUER, TEST_SIGNING_KEY, testConfig } from './api-test-app.js';
import type { TestApi } from './api-test-app.js';
import { runTenantSeeders } from './process-fixtures.js';
import { CATALOG_CLOCK } from '../../src/modules/catalog/application/catalog-ports.js';
import { PROCESS_CLOCK } from '../../src/modules/process/application/ports.js';
import type { RuntimeChange } from '../../src/modules/process/domain/process-branches.js';
import { PrismaProcessRepository } from '../../src/modules/process/infrastructure/prisma-process.repository.js';
import { asTenant, startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';

export const A = '0192c125-0000-7000-8000-00000000010a';
export const B = '0192c125-0000-7000-8000-00000000010b';
export const ORG_A = '0192c125-0000-7000-8000-0000000010a0';
export const ORG_B = '0192c125-0000-7000-8000-0000000010b0';
export const OBRAS = '0192c125-0000-7000-8000-0000000010a1';
export const MANUTENCAO = '0192c125-0000-7000-8000-0000000010a2';
export const PROCURADORIA = '0192c125-0000-7000-8000-0000000010a3';
export const CONTROLE = '0192c125-0000-7000-8000-0000000010a4';
export const ANA = '0192c125-0000-7000-8000-0000000010c1';
export const BETO = '0192c125-0000-7000-8000-0000000010c3';
export const ANA_M = '0192c125-0000-7000-8000-0000000010d1';
export const NOW = new Date('2026-10-05T15:00:00.000Z');
export const MFA = ['pwd', 'otp'];

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us125', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us125', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal de São José', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura B LEAK-B', 'PMB', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${ANA}', 'sub-ana-us125', 'ana@a.test', true, 'Ana Souza'),
  ('${BETO}', 'sub-beto-us125', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth, head_user_id) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Obras', '${path(OBRAS)}', 0, NULL),
  ('${MANUTENCAO}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Manutenção', '${path(OBRAS, MANUTENCAO)}', 1, NULL),
  ('${PROCURADORIA}', '${A}', '${ORG_A}', NULL, 'SECTOR', 'Procuradoria', '${path(PROCURADORIA)}', 0, NULL),
  ('${CONTROLE}', '${A}', '${ORG_A}', NULL, 'SECTOR', 'Controle Interno', '${path(CONTROLE)}', 0, NULL);
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('0192c125-0000-7000-8000-0000000010d3', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c125-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true);
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
export interface Opened {
  readonly processId: string;
  readonly split: string;
  readonly juridico: string;
  readonly controle: string;
  readonly branches: { readonly juridico: string; readonly controle: string };
  readonly version: number;
}

export interface BranchDatabase {
  readonly db: TestDatabase;
  readonly api: TestApi;
  readonly client: TenantPrismaClient;
  readonly repository: PrismaProcessRepository;
  inTenant<T>(tenantId: string, work: (tx: TenantTx) => Promise<T>): Promise<T>;
  createProcess(): Promise<ProcessDto>;
  /** Um processo novo do tenant A aberto em dois ramos (JURIDICO e CONTROLE_INTERNO, na fila). */
  openBranches(): Promise<Opened>;
  close(): Promise<void>;
}

export async function startBranchDatabase(): Promise<BranchDatabase> {
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
      .set('Authorization', api.bearer('sub-ana-us125', { amr: MFA }))
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
          correlationId: 'us125',
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

  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  const db = await startTestDatabase();
  await db.admin(FIXTURE_SQL);
  const membership = new RoleInjectingMembershipPort();
  const config = testConfig({
    OIDC_FAKE_SIGNING_KEY: '',
    DATABASE_URL: db.url('cf_app'),
    DATABASE_URL_PLATFORM: db.url('cf_platform'),
    DATABASE_POOL_SIZE: '10',
  });
  const api = await createTestApi({
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
  const catalog = {
    contractingType: await catalogId(A, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
    origin: await catalogId(A, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
  };
  const client = db.client('cf_app');
  return {
    db,
    api,
    client,
    repository,
    inTenant,
    createProcess,
    openBranches,
    close: async () => {
      await client.$disconnect();
      await api.close();
      await db.stop();
      vi.restoreAllMocks();
    },
  };
}
