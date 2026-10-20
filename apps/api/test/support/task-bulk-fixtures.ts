import { randomUUID } from 'node:crypto';

import type { ProcessDto } from '@contrataflow/validation';
import request from 'supertest';
import { expect } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';

import { createTestApi, TEST_ISSUER, TEST_SIGNING_KEY, testConfig } from './api-test-app.js';
import type { TestApi } from './api-test-app.js';
import { runTenantSeeders } from './process-fixtures.js';
import { CATALOG_CLOCK } from '../../src/modules/catalog/application/catalog-ports.js';
import { PROCESS_CLOCK } from '../../src/modules/process/application/ports.js';
import { startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';

/*
 * Ações em lote da caixa de tarefas sobre PostgreSQL real (US-058): dois tenants com a mesma
 * estrutura (Obras → Manutenção, Coordenadoria de Planejamento), a API inteira como `cf_app` (RLS)
 * com os seeders reais do provisionamento, REQUISITANTE no tenant gravado em `role_assignments`
 * (US-097) e processos levados à fila da Coordenadoria (sem responsável). Usado pela suíte "tenant
 * leak" (`test/tenant-leak/task-bulk.spec.ts`) e pela de performance (`task-bulk.perf.ts`).
 */

export const BULK_TENANT_A = '0192c058-0000-7000-8000-00000000010a';
export const BULK_TENANT_B = '0192c058-0000-7000-8000-00000000010b';
const ORG_A = '0192c058-0000-7000-8000-0000000010a0';
const ORG_B = '0192c058-0000-7000-8000-0000000010b0';
const OBRAS = '0192c058-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c058-0000-7000-8000-0000000010a2';
const PLANEJAMENTO = '0192c058-0000-7000-8000-0000000010a3';
const OBRAS_B = '0192c058-0000-7000-8000-0000000010b1';
const MANUTENCAO_B = '0192c058-0000-7000-8000-0000000010b2';
const PLANEJAMENTO_B = '0192c058-0000-7000-8000-0000000010b3';
export const BULK_ANA = '0192c058-0000-7000-8000-0000000010c1';
const BETO = '0192c058-0000-7000-8000-0000000010c3';
export const BULK_DANI = '0192c058-0000-7000-8000-0000000010c4';
const ANA_M = '0192c058-0000-7000-8000-0000000010d1';
const BETO_M = '0192c058-0000-7000-8000-0000000010d3';
const DANI_M = '0192c058-0000-7000-8000-0000000010d4';
const NOW = new Date('2026-10-05T15:00:00.000Z');
const MFA = ['pwd', 'otp'];
const A = BULK_TENANT_A;
const B = BULK_TENANT_B;

export const BULK_SUBJECTS = {
  ana: 'sub-ana-us058',
  dani: 'sub-dani-us058',
  beto: 'sub-beto-us058',
} as const;

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [BULK_ANA]: ['REQUISITANTE'],
  [BULK_DANI]: ['REQUISITANTE'],
  [BETO]: ['REQUISITANTE'],
};

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us058', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us058', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal de São José', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura B LEAK-B', 'PMB', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${BULK_ANA}', '${BULK_SUBJECTS.ana}', 'ana@a.test', true, 'Ana Souza'),
  ('${BULK_DANI}', '${BULK_SUBJECTS.dani}', 'dani@a.test', true, 'Dani Alves'),
  ('${BETO}', '${BULK_SUBJECTS.beto}', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth, head_user_id) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Obras', '${path(OBRAS)}', 0, NULL),
  ('${MANUTENCAO}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Manutenção', '${path(OBRAS, MANUTENCAO)}', 1, NULL),
  ('${PLANEJAMENTO}', '${A}', '${ORG_A}', NULL, 'SECTOR', 'Coordenadoria de Planejamento', '${path(PLANEJAMENTO)}', 0, NULL),
  ('${OBRAS_B}', '${B}', '${ORG_B}', NULL, 'SECRETARIAT', 'Obras LEAK-B', '${path(OBRAS_B)}', 0, NULL),
  ('${MANUTENCAO_B}', '${B}', '${ORG_B}', '${OBRAS_B}', 'SECTOR', 'Manutenção LEAK-B', '${path(OBRAS_B, MANUTENCAO_B)}', 1, NULL),
  ('${PLANEJAMENTO_B}', '${B}', '${ORG_B}', NULL, 'SECTOR', 'Planejamento LEAK-B', '${path(PLANEJAMENTO_B)}', 0, NULL);
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${BULK_ANA}', 'INTERNAL', 'ACTIVE'),
  ('${DANI_M}', '${A}', '${BULK_DANI}', 'INTERNAL', 'ACTIVE'),
  ('${BETO_M}', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c058-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${PLANEJAMENTO}', true),
  ('0192c058-0000-7000-8000-0000000010e3', '${B}', '${BETO_M}', '${PLANEJAMENTO_B}', true),
  ('0192c058-0000-7000-8000-0000000010e4', '${A}', '${DANI_M}', '${PLANEJAMENTO}', true);
`;

/** Perfis do vínculo por usuário, sobre a `MembershipPort` real (atribuições: US-096). */
class RoleInjectingMembershipPort implements MembershipPort {
  inner!: MembershipPort;

  async findByUserAndTenant(userId: string, tenantId: string): Promise<MembershipRecord | null> {
    const membership = await this.inner.findByUserAndTenant(userId, tenantId);
    return membership ? { ...membership, roleKeys: ROLES[userId] ?? [] } : null;
  }
}

export interface BulkStructure {
  readonly tenantId: string;
  readonly subject: string;
  readonly secretariat: string;
  readonly requesting: string;
  readonly queue: string;
  readonly catalog: { readonly contractingType: string; readonly origin: string };
}

export interface TaskBulkDatabase {
  readonly db: TestDatabase;
  readonly api: TestApi;
  readonly tenantA: BulkStructure;
  readonly tenantB: BulkStructure;
  /** PRC-02 e a passagem ESTUDOS_PRELIMINARES ativa na fila da Coordenadoria, SEM responsável. */
  processInQueue(structure?: BulkStructure): Promise<string>;
  /** TSK-03 com `Idempotency-Key` nova. */
  bulkClaim(processIds: readonly string[], subject?: string): request.Test;
  close(): Promise<void>;
}

const words = (count: number) =>
  Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

export async function startTaskBulkDatabase(): Promise<TaskBulkDatabase> {
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
  for (const tenantId of [A, B]) {
    await runTenantSeeders(api, tenantId, [
      'catalog.items',
      'catalog.holidays',
      'access.defaultRoles',
      'document.systemTypes',
      'workflow.seedWorkflows',
    ]);
  }
  // Permissões efetivas lidas das atribuições gravadas no banco (US-097): REQUISITANTE no tenant.
  for (const [tenantId, membershipId, grantedBy] of [
    [A, ANA_M, BULK_ANA],
    [A, DANI_M, BULK_ANA],
    [B, BETO_M, BETO],
  ] as const) {
    await db.admin(
      `INSERT INTO role_assignments (id, tenant_id, membership_id, role_id, scope_type, granted_by_id)
       SELECT $1, $2, $3, r.id, 'TENANT', $4 FROM roles r WHERE r.tenant_id = $2 AND r.key = 'REQUISITANTE'`,
      [randomUUID(), tenantId, membershipId, grantedBy],
    );
  }
  const catalogId = async (tenantId: string, type: string, code: string) => {
    const [row] = await db.admin<{ id: string }>(
      'SELECT id FROM catalog_items WHERE tenant_id = $1 AND catalog_type = $2 AND code = $3',
      [tenantId, type, code],
    );
    if (!row) throw new Error(`${type}/${code} ausente`);
    return row.id;
  };
  const stageOf = async (processId: string, key: string) => {
    const [row] = await db.admin<{ id: string }>(
      `SELECT s.id FROM workflow_stages s JOIN processes p ON p.workflow_version_id = s.workflow_version_id
        WHERE p.id = $1 AND s.key = $2`,
      [processId, key],
    );
    if (!row) throw new Error(`workflow_stages/${key} ausente`);
    return row.id;
  };
  const structureOf = async (
    tenantId: string,
    subject: string,
    units: { secretariat: string; requesting: string; queue: string },
  ): Promise<BulkStructure> => ({
    tenantId,
    subject,
    ...units,
    catalog: {
      contractingType: await catalogId(tenantId, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
      origin: await catalogId(tenantId, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
    },
  });
  const tenantA = await structureOf(A, BULK_SUBJECTS.ana, {
    secretariat: OBRAS,
    requesting: MANUTENCAO,
    queue: PLANEJAMENTO,
  });
  const tenantB = await structureOf(B, BULK_SUBJECTS.beto, {
    secretariat: OBRAS_B,
    requesting: MANUTENCAO_B,
    queue: PLANEJAMENTO_B,
  });

  async function processInQueue(structure: BulkStructure = tenantA): Promise<string> {
    const response = await request(api.server)
      .post('/api/v1/processes')
      .set('Authorization', api.bearer(structure.subject, { amr: MFA }))
      .set('X-Tenant-Id', structure.tenantId)
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Compra ${words(2)}`,
        object: `Objeto ${words(3)}`,
        contractingTypeId: structure.catalog.contractingType,
        requestingSecretariatId: structure.secretariat,
        requestingDepartmentId: structure.requesting,
        originId: structure.catalog.origin,
        pcaStatus: 'NOT_APPLICABLE',
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const created = (response.body as { data: ProcessDto }).data;
    const stageId = randomUUID();
    const workflowStage = await stageOf(created.id, 'ESTUDOS_PRELIMINARES');
    const tenant = structure.tenantId;
    await db.admin(
      `BEGIN;
       UPDATE process_stages SET status = 'COMPLETED', exited_at = '2026-10-01T12:00:00Z'
        WHERE process_id = '${created.id}';
       UPDATE process_assignments SET is_active = false, ended_at = '2026-10-01T12:00:00Z'
        WHERE process_id = '${created.id}';
       INSERT INTO process_stages (id, tenant_id, process_id, workflow_stage_id, sequence, status,
                                   department_id, assignee_id, entered_at, sla_days, sla_type)
         VALUES ('${stageId}', '${tenant}', '${created.id}', '${workflowStage}', 2, 'ACTIVE',
                 '${structure.queue}', NULL, '2026-10-01T12:00:00Z', 15, 'BUSINESS');
       INSERT INTO process_assignments (id, tenant_id, process_id, process_stage_id, department_id,
                                        assignee_id, type, started_at)
         VALUES ('${randomUUID()}', '${tenant}', '${created.id}', '${stageId}', '${structure.queue}', NULL,
                 'STAGE_ENTRY', '2026-10-01T12:00:00Z');
       UPDATE processes SET status = 'IN_PROGRESS', current_stage_id = '${stageId}',
              current_workflow_stage_id = '${workflowStage}', current_department_id = '${structure.queue}',
              current_responsible_id = NULL
        WHERE id = '${created.id}';
       UPDATE process_access SET revoked_at = '2026-10-01T12:00:00Z'
        WHERE process_id = '${created.id}' AND reason IN ('CURRENT', 'RESPONSIBLE');
       INSERT INTO process_access (id, tenant_id, process_id, principal_type, department_id, user_id, reason)
         VALUES ('${randomUUID()}', '${tenant}', '${created.id}', 'DEPARTMENT', '${structure.requesting}', NULL, 'HISTORICAL'),
                ('${randomUUID()}', '${tenant}', '${created.id}', 'DEPARTMENT', '${structure.queue}', NULL, 'CURRENT');
       COMMIT;`,
    );
    return created.id;
  }

  const tenantOf = (subject: string) => (subject === BULK_SUBJECTS.beto ? B : A);
  const bulkClaim = (processIds: readonly string[], subject: string = BULK_SUBJECTS.ana) =>
    request(api.server)
      .post('/api/v1/tasks/bulk-claim')
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenantOf(subject))
      .set('Idempotency-Key', randomUUID())
      .send({ processIds });

  return {
    db,
    api,
    tenantA,
    tenantB,
    processInQueue,
    bulkClaim,
    close: async () => {
      await api.close();
      await db.stop();
    },
  };
}
