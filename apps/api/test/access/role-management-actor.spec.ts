// Gestão de perfis com o vínculo real do PostgreSQL (spec-530 · US-095/096/097): o
// `PrismaIdentityRepository` devolve o vínculo sem `roleKeys`, e o ator de ROL-02..08 decide pelas
// permissões efetivas — atribuições gravadas, inclusive as feitas pela ROL-11. Sem porta de teste
// injetando chaves (como em `test/tenant-leak/role-management.spec.ts`): o caminho do ambiente real.
// `pnpm --filter @contrataflow/api exec vitest run --config vitest.integration.config.ts test/access`.
import { problemDetailsSchema } from '@contrataflow/validation';
import type { RoleDto, RoleWithPermissionsDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { SeedDefaultRolesHandler } from '#modules/access/application/seed-default-roles.handler.js';
import { PrismaRoleRepository } from '#modules/access/infrastructure/prisma-role.repository.js';
import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { TOKEN_VERIFIER } from '#shared/auth/ports.js';
import { runAsSystem } from '#shared/context/request-context.js';

import { startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';
import {
  createTestApi,
  TEST_ISSUER,
  TEST_SIGNING_KEY,
  testConfig,
} from '../support/api-test-app.js';
import type { TestApi } from '../support/api-test-app.js';

const A = '0192e000-0000-7000-8000-00000000530a';
const ANA = '0192e000-0000-7000-8000-0000000530a1';
const DIEGO = '0192e000-0000-7000-8000-0000000530a2';
const ZECA = '0192e000-0000-7000-8000-0000000530a3';
const GABI = '0192e000-0000-7000-8000-0000000530a4';
const M_ANA = '0192e000-0000-7000-8000-0000000531a1';
const M_DIEGO = '0192e000-0000-7000-8000-0000000531a2';
const M_ZECA = '0192e000-0000-7000-8000-0000000531a3';
const M_GABI = '0192e000-0000-7000-8000-0000000531a4';
const MFA = ['pwd', 'otp'];
const NOW = new Date('2026-10-29T12:00:00.000Z');

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code) VALUES
  ('${A}', 'prefeitura-a-530', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC');
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${ANA}', 'sub-ana-530', 'ana@a530.test', true, 'Ana Admin'),
  ('${DIEGO}', 'sub-diego-530', 'diego@a530.test', true, 'Diego Lima'),
  ('${ZECA}', 'sub-zeca-530', 'zeca@a530.test', true, 'Zeca Requisitante'),
  ('${GABI}', 'sub-gabi-530', 'gabi@a530.test', true, 'Gabi Gestora');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${M_ANA}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('${M_DIEGO}', '${A}', '${DIEGO}', 'INTERNAL', 'ACTIVE'),
  ('${M_ZECA}', '${A}', '${ZECA}', 'INTERNAL', 'ACTIVE'),
  ('${M_GABI}', '${A}', '${GABI}', 'INTERNAL', 'ACTIVE');
`;

/** Atribuição gravada do perfil padrão (como o convite/provisionamento deixa no banco). */
const ASSIGNMENTS_SQL = `
INSERT INTO role_assignments (id, tenant_id, membership_id, role_id, scope_type, granted_by_id, valid_from)
SELECT '0192e000-0000-7000-8000-0000000532a1', '${A}', '${M_ANA}', id, 'TENANT', '${ANA}', now() - interval '1 day'
  FROM roles WHERE tenant_id = '${A}' AND key = 'ADMIN_ORGAO';
INSERT INTO role_assignments (id, tenant_id, membership_id, role_id, scope_type, granted_by_id, valid_from)
SELECT '0192e000-0000-7000-8000-0000000532a3', '${A}', '${M_ZECA}', id, 'TENANT', '${ANA}', now() - interval '1 day'
  FROM roles WHERE tenant_id = '${A}' AND key = 'REQUISITANTE';
`;

const noAudit = {
  record: () => Promise.resolve({ kind: 'recorded', id: 'x', occurredAt: NOW, rowHash: 'h' }),
} as unknown as AuditTrailPort;

describe('Feature: gerenciar perfis com o vínculo real do PostgreSQL (spec-530)', () => {
  let db: TestDatabase;
  let api: TestApi;

  const as = (test: request.Test, subject: string) =>
    test.set('Authorization', api.bearer(subject, { amr: MFA })).set('X-Tenant-Id', A);
  const listRoles = (subject: string) => as(request(api.server).get('/api/v1/roles'), subject);
  const getRole = (id: string, subject: string) =>
    as(request(api.server).get(`/api/v1/roles/${id}`), subject);
  const createRole = (body: object, subject: string) =>
    as(request(api.server).post('/api/v1/roles'), subject).send(body);
  const putPermissions = (id: string, permissions: readonly string[], subject: string) =>
    as(request(api.server).put(`/api/v1/roles/${id}/permissions`), subject)
      .set('If-Match', '"1"')
      .send({ permissions });
  const assign = (userId: string, roleId: string, subject = 'sub-ana-530') =>
    as(request(api.server).post(`/api/v1/users/${userId}/role-assignments`), subject).send({
      roleId,
      scopeType: 'TENANT',
    });
  const codeOf = (response: request.Response) => problemDetailsSchema.parse(response.body).code;
  const roleIdOf = async (key: string) => {
    const [row] = await db.admin<{ id: string }>(
      'SELECT id FROM roles WHERE tenant_id = $1 AND key = $2',
      [A, key],
    );
    return row?.id ?? '';
  };
  const deniedReasons = async (userId: string) =>
    (
      await db.admin<{ reason_code: string }>(
        `SELECT reason_code FROM audit_logs
          WHERE action = 'access.denied' AND tenant_id = $1 AND actor_user_id = $2`,
        [A, userId],
      )
    ).map((row) => row.reason_code);

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    db = await startTestDatabase();
    await db.admin(FIXTURE_SQL);
    // Background: os 15 perfis padrão pelo seeder real e as atribuições gravadas.
    const seeder = new SeedDefaultRolesHandler(new PrismaRoleRepository(), () => NOW, noAudit);
    await runAsSystem({ name: 'teste', tenantId: A }, () =>
      db.client('cf_app').$tenantTransaction((tx) => seeder.execute(tx)),
    );
    await db.admin(ASSIGNMENTS_SQL);
    const config = testConfig({
      OIDC_FAKE_SIGNING_KEY: '',
      DATABASE_URL: db.url('cf_app'),
      DATABASE_URL_PLATFORM: db.url('cf_platform'),
    });
    api = await createTestApi({
      config,
      providers: [
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
  });

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso] ADMIN_ORGAO gravado: lista, detalha e cria perfil com permissão que não tem (isento do POL-13)', async () => {
    const listed = await listRoles('sub-ana-530');
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const roles = (listed.body as { data: RoleDto[] }).data;
    expect(roles).toHaveLength(15);
    expect(roles.find((role) => role.key === 'ADMIN_ORGAO')).toMatchObject({
      activeAssignmentsCount: 1,
    });

    const detail = await getRole(await roleIdOf('REQUISITANTE'), 'sub-ana-530');
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);

    // `APPROVAL_DECIDE` não está no ADMIN_ORGAO: só passa pela isenção do anti-escalonamento.
    const created = await createRole(
      { name: 'Comissão de Obras', permissions: ['APPROVAL_DECIDE', 'PROCESS_VIEW'] },
      'sub-ana-530',
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const [row] = await db.admin<{ created_by_id: string }>(
      'SELECT created_by_id FROM roles WHERE id = $1',
      [(created.body as { data: RoleDto }).data.id],
    );
    expect(row?.created_by_id).toBe(ANA);
  });

  it('[Sucesso] ROL-11 → ADMIN_ORGAO: Diego, antes recusado, passa a listar, criar e editar a matriz', async () => {
    const before = await listRoles('sub-diego-530');
    expect(before.status, JSON.stringify(before.body)).toBe(403);
    expect(codeOf(before)).toBe('PERMISSION_DENIED');

    const assigned = await assign(DIEGO, await roleIdOf('ADMIN_ORGAO'));
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(201);

    const listed = await listRoles('sub-diego-530');
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const created = await createRole({ name: 'Fiscal de Contratos' }, 'sub-diego-530');
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const { id } = (created.body as { data: RoleDto }).data;
    const updated = await putPermissions(id, ['APPROVAL_DECIDE', 'SUPPLIER_VIEW'], 'sub-diego-530');
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    const detail = await getRole(id, 'sub-diego-530');
    expect((detail.body as { data: RoleWithPermissionsDto }).data.permissions).toEqual([
      'APPROVAL_DECIDE',
      'SUPPLIER_VIEW',
    ]);
  });

  it('[Permissão] sem ROLE_VIEW/ROLE_MANAGE → 403 PERMISSION_DENIED em ROL-02, ROL-04 e ROL-03, auditado', async () => {
    const requisitante = await roleIdOf('REQUISITANTE');
    for (const response of [
      await listRoles('sub-zeca-530'),
      await getRole(requisitante, 'sub-zeca-530'),
      await createRole({ name: 'Perfil do Zeca' }, 'sub-zeca-530'),
    ]) {
      expect(response.status, JSON.stringify(response.body)).toBe(403);
      expect(codeOf(response)).toBe('PERMISSION_DENIED');
    }
    expect(await deniedReasons(ZECA)).toEqual(expect.arrayContaining(['ROLE_VIEW', 'ROLE_MANAGE']));
    const [count] = await db.admin<{ count: string }>(
      `SELECT count(*) FROM roles WHERE tenant_id = $1 AND name = 'Perfil do Zeca'`,
      [A],
    );
    expect(Number(count?.count)).toBe(0);
  });

  it('[Permissão] POL-13 vale para quem gerencia perfis sem ADMIN_ORGAO: só concede o que tem', async () => {
    const manager = await createRole(
      {
        name: 'Gestor de perfis',
        permissions: ['ROLE_VIEW', 'ROLE_MANAGE', 'PROCESS_VIEW'],
      },
      'sub-ana-530',
    );
    expect(manager.status, JSON.stringify(manager.body)).toBe(201);
    const assigned = await assign(GABI, (manager.body as { data: RoleDto }).data.id);
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(201);

    const allowed = await createRole(
      { name: 'Leitor de processos', permissions: ['PROCESS_VIEW'] },
      'sub-gabi-530',
    );
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);
    const escalated = await createRole(
      { name: 'Configurador', permissions: ['SETTINGS_MANAGE'] },
      'sub-gabi-530',
    );
    expect(escalated.status, JSON.stringify(escalated.body)).toBe(403);
    expect(codeOf(escalated)).toBe('PRIVILEGE_ESCALATION_FORBIDDEN');
  });
});
