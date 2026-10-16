// Atribuição de perfis na API inteira sobre PostgreSQL real (US-096 · Tenant incorreto, Sucesso,
// Concorrência, Falha de banco): administradores nos tenants A e B, RLS de `role_assignments`, a
// atribuição com auditoria e outbox na mesma transação, a corrida de duas atribuições idênticas
// (índice único parcial `role_assignments_active_key`) e a de duas revogações simultâneas dos dois
// administradores — a trava `FOR UPDATE` do POL-12 deixa passar só uma. O ator é resolvido pelas
// atribuições gravadas (`AssignmentActorResolver`), não pelas chaves do contexto.
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { problemDetailsSchema } from '@contrataflow/validation';
import type { RoleAssignmentDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { TOKEN_VERIFIER } from '#shared/auth/ports.js';

import { startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';
import {
  createTestApi,
  TEST_ISSUER,
  TEST_SIGNING_KEY,
  testConfig,
} from '../support/api-test-app.js';
import type { TestApi } from '../support/api-test-app.js';

const A = '0192d000-0000-7000-8000-00000000960a';
const B = '0192d000-0000-7000-8000-00000000960b';
const ANA = '0192d000-0000-7000-8000-0000000960a1';
const ZECA = '0192d000-0000-7000-8000-0000000960a2';
const DIEGO = '0192d000-0000-7000-8000-0000000960a3';
const BETO = '0192d000-0000-7000-8000-0000000960b1';
const FABIO = '0192d000-0000-7000-8000-0000000960b2';
const M_ANA = '0192d000-0000-7000-8000-0000000964a1';
const M_ZECA = '0192d000-0000-7000-8000-0000000964a2';
const M_DIEGO = '0192d000-0000-7000-8000-0000000964a3';
const M_BETO = '0192d000-0000-7000-8000-0000000964b1';
const M_FABIO = '0192d000-0000-7000-8000-0000000964b2';
const ORG_A = '0192d000-0000-7000-8000-0000000961a1';
const ORG_B = '0192d000-0000-7000-8000-0000000961b1';
const OBRAS = '0192d000-0000-7000-8000-0000000962a1';
const SETOR_B = '0192d000-0000-7000-8000-0000000962b1';
const ADMIN_A = '0192d000-0000-7000-8000-0000000963a1';
const REQ_A = '0192d000-0000-7000-8000-0000000963a2';
const ADMIN_B = '0192d000-0000-7000-8000-0000000963b1';
const REQ_B = '0192d000-0000-7000-8000-0000000963b2';
const RA_ANA = '0192d000-0000-7000-8000-0000000966a1';
const RA_ZECA = '0192d000-0000-7000-8000-0000000966a2';
const RA_BETO = '0192d000-0000-7000-8000-0000000966b1';
const RA_FABIO = '0192d000-0000-7000-8000-0000000966b2';
const MFA = ['pwd', 'otp'];

const ADMIN_PERMISSIONS = ['ROLE_ASSIGN', 'ROLE_VIEW', 'USER_VIEW', 'USER_MANAGE', 'PROCESS_VIEW'];

const grants = (tenant: string, role: string, codes: readonly string[], prefix: string) =>
  codes
    .map(
      (code, index) =>
        `('0192d000-0000-7000-8000-${prefix}${String(index).padStart(4, '0')}', '${tenant}', '${role}', '${code}')`,
    )
    .join(',\n  ');

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code) VALUES
  ('${A}', 'prefeitura-a-rol', 'Prefeitura A', 'MUNICIPALITY', 'ACTIVE', 'SC'),
  ('${B}', 'prefeitura-b-rol', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC');
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${ANA}', 'sub-ana', 'ana@a.test', true, 'Ana Admin'),
  ('${ZECA}', 'sub-zeca', 'zeca@a.test', true, 'Zeca Admin'),
  ('${DIEGO}', 'sub-diego', 'diego@a.test', true, 'Diego Obras'),
  ('${BETO}', 'sub-beto', 'beto@b.test', true, 'Beto LEAK-B'),
  ('${FABIO}', 'sub-fabio', 'fabio@b.test', true, 'Fábio LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${M_ANA}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('${M_ZECA}', '${A}', '${ZECA}', 'INTERNAL', 'ACTIVE'),
  ('${M_DIEGO}', '${A}', '${DIEGO}', 'INTERNAL', 'ACTIVE'),
  ('${M_BETO}', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE'),
  ('${M_FABIO}', '${B}', '${FABIO}', 'INTERNAL', 'ACTIVE');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal', 'PMA', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura B LEAK-B', 'PMB', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO departments (id, tenant_id, organization_id, type, name, path, depth) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', 'SECRETARIAT', 'Secretaria de Obras', '/${OBRAS}/', 0),
  ('${SETOR_B}', '${B}', '${ORG_B}', 'SECTOR', 'Setor LEAK-B', '/${SETOR_B}/', 0);
INSERT INTO roles (id, tenant_id, key, name, is_system) VALUES
  ('${ADMIN_A}', '${A}', 'ADMIN_ORGAO', 'Administrador do órgão', true),
  ('${REQ_A}', '${A}', 'REQUISITANTE', 'Requisitante', true),
  ('${ADMIN_B}', '${B}', 'ADMIN_ORGAO', 'Administrador LEAK-B', true),
  ('${REQ_B}', '${B}', 'REQUISITANTE', 'Requisitante LEAK-B', true);
INSERT INTO role_permissions (id, tenant_id, role_id, permission_code) VALUES
  ${grants(A, ADMIN_A, ADMIN_PERMISSIONS, '00967a00')},
  ${grants(A, REQ_A, ['PROCESS_VIEW'], '00968a00')},
  ${grants(B, ADMIN_B, ADMIN_PERMISSIONS, '00967b00')},
  ${grants(B, REQ_B, ['PROCESS_VIEW'], '00968b00')};
INSERT INTO role_assignments (id, tenant_id, membership_id, role_id, scope_type, granted_by_id, valid_from) VALUES
  ('${RA_ANA}', '${A}', '${M_ANA}', '${ADMIN_A}', 'TENANT', '${ANA}', now() - interval '1 day'),
  ('${RA_ZECA}', '${A}', '${M_ZECA}', '${ADMIN_A}', 'TENANT', '${ANA}', now() - interval '1 day'),
  ('${RA_BETO}', '${B}', '${M_BETO}', '${ADMIN_B}', 'TENANT', '${BETO}', now() - interval '1 day'),
  ('${RA_FABIO}', '${B}', '${M_FABIO}', '${REQ_B}', 'TENANT', '${BETO}', now() - interval '1 day');
`;

type Row = Readonly<Record<string, unknown>>;

describe('Feature: atribuição de perfis isolada por tenant sobre PostgreSQL (US-096)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let dbStopped = false;

  const as = (test: request.Test, subject = 'sub-ana', tenant = A) =>
    test.set('Authorization', api.bearer(subject, { amr: MFA })).set('X-Tenant-Id', tenant);
  const assign = (userId: string, body: Record<string, unknown>, subject = 'sub-ana') =>
    as(request(api.server).post(`/api/v1/users/${userId}/role-assignments`), subject).send(body);
  const revoke = (id: string, version: number, subject = 'sub-ana') =>
    as(request(api.server).post(`/api/v1/role-assignments/${id}/revoke`), subject)
      .set('If-Match', `"${String(version)}"`)
      .send({});
  const codeOf = (response: request.Response) => problemDetailsSchema.parse(response.body).code;
  const digestOf = async (tenantId: string) => {
    const [result] = await db.admin<{ digest: string }>(
      `SELECT md5(coalesce(string_agg(r::text, '|' ORDER BY r::text), '')) AS digest
         FROM role_assignments r WHERE tenant_id = $1`,
      [tenantId],
    );
    return result?.digest;
  };
  const activeOf = (membershipId: string, roleId: string) =>
    db.admin<Row>(
      'SELECT * FROM role_assignments WHERE membership_id = $1 AND role_id = $2 AND revoked_at IS NULL',
      [membershipId, roleId],
    );

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    db = await startTestDatabase();
    await db.admin(FIXTURE_SQL);
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
    if (!dbStopped) await db.stop();
    vi.restoreAllMocks();
  });

  it('[Tenant incorreto] ids e referências de B: 404/422 sem revelar nem tocar nas atribuições de B', async () => {
    const before = await digestOf(B);
    const notFound = [
      await assign(FABIO, { roleId: REQ_A, scopeType: 'TENANT' }),
      await as(request(api.server).get(`/api/v1/users/${FABIO}/role-assignments`)),
    ];
    for (const response of notFound) {
      expect(response.status, JSON.stringify(response.body)).toBe(404);
      expect(codeOf(response)).toBe('USER_NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toMatch(/LEAK-B|fabio/i);
    }
    const foreignAssignment = await revoke(RA_FABIO, 1);
    expect(foreignAssignment.status, JSON.stringify(foreignAssignment.body)).toBe(404);
    expect(codeOf(foreignAssignment)).toBe('ROLE_ASSIGNMENT_NOT_FOUND');
    const foreignRole = await as(request(api.server).get(`/api/v1/roles/${ADMIN_B}/assignments`));
    expect(foreignRole.status, JSON.stringify(foreignRole.body)).toBe(404);
    expect(codeOf(foreignRole)).toBe('ROLE_NOT_FOUND');

    for (const [body, field] of [
      [{ roleId: REQ_B, scopeType: 'TENANT' }, 'roleId'],
      [
        { roleId: REQ_A, scopeType: 'ORGANIZATION', scopeOrganizationId: ORG_B },
        'scopeOrganizationId',
      ],
      [{ roleId: REQ_A, scopeType: 'DEPARTMENT', scopeDepartmentId: SETOR_B }, 'scopeDepartmentId'],
    ] as const) {
      const response = await assign(DIEGO, body);
      expect(response.status, JSON.stringify(response.body)).toBe(422);
      expect(problemDetailsSchema.parse(response.body).errors).toEqual([
        expect.objectContaining({ field, code: 'REFERENCE_NOT_FOUND' }),
      ]);
      expect(JSON.stringify(response.body)).not.toMatch(/LEAK-B/);
    }
    expect(await digestOf(B)).toBe(before);
    expect(await activeOf(M_DIEGO, REQ_A)).toHaveLength(0);
  });

  it('[Sucesso] atribui com escopo de unidade: linha, auditoria e outbox na mesma transação', async () => {
    const response = await assign(DIEGO, {
      roleId: REQ_A,
      scopeType: 'DEPARTMENT',
      scopeDepartmentId: OBRAS,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const created = (response.body as { data: RoleAssignmentDto }).data;
    expect(created).toMatchObject({
      membershipId: M_DIEGO,
      userId: DIEGO,
      userName: 'Diego Obras',
      roleKey: 'REQUISITANTE',
      scopeType: 'DEPARTMENT',
      scopeName: 'Secretaria de Obras',
      grantedBy: { id: ANA, name: 'Ana Admin' },
      status: 'ACTIVE',
    });
    const [row] = await db.admin<Row>('SELECT * FROM role_assignments WHERE id = $1', [created.id]);
    expect(row).toMatchObject({
      tenant_id: A,
      scope_department_id: OBRAS,
      include_subtree: true,
      granted_by_id: ANA,
      created_by_id: ANA,
      revoked_at: null,
    });
    const [audit] = await db.admin<Row>(
      `SELECT * FROM audit_logs WHERE action = 'role.assign' AND entity_id = $1`,
      [created.id],
    );
    expect(audit).toMatchObject({ tenant_id: A, actor_user_id: ANA });
    const [event] = await db.admin<Row>(
      `SELECT * FROM outbox_events WHERE event_type = 'RoleAssigned' AND aggregate_id = $1`,
      [created.id],
    );
    expect(event).toMatchObject({ tenant_id: A, routing_key: 'role.assigned', status: 'PENDING' });

    const listed = await as(request(api.server).get(`/api/v1/users/${DIEGO}/role-assignments`));
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect((listed.body as { data: RoleAssignmentDto[] }).data.map((item) => item.id)).toEqual([
      created.id,
    ]);
  });

  it('[Concorrência] duas atribuições idênticas simultâneas: uma 201, a outra 409', async () => {
    const body = { roleId: REQ_A, scopeType: 'TENANT' };
    const [first, second] = await Promise.all([
      assign(DIEGO, body),
      assign(DIEGO, body, 'sub-zeca'),
    ]);
    expect([first.status, second.status].sort()).toEqual([201, 409]);
    expect(codeOf(first.status === 409 ? first : second)).toBe('ROLE_ASSIGNMENT_ALREADY_EXISTS');
    const rows = await db.admin<Row>(
      `SELECT id FROM role_assignments
        WHERE membership_id = $1 AND role_id = $2 AND scope_type = 'TENANT' AND revoked_at IS NULL`,
      [M_DIEGO, REQ_A],
    );
    expect(rows).toHaveLength(1);
  });

  it('[Concorrência] POL-12: Ana e Zeca revogam o ADMIN_ORGAO um do outro ao mesmo tempo — só uma passa', async () => {
    const [byAna, byZeca] = await Promise.all([
      revoke(RA_ZECA, 1, 'sub-ana'),
      revoke(RA_ANA, 1, 'sub-zeca'),
    ]);
    expect([byAna.status, byZeca.status].sort()).toEqual([200, 409]);
    expect(codeOf(byAna.status === 409 ? byAna : byZeca)).toBe('LAST_ADMIN_REQUIRED');
    const admins = await db.admin<Row>(
      `SELECT id FROM role_assignments WHERE role_id = $1 AND revoked_at IS NULL`,
      [ADMIN_A],
    );
    expect(admins).toHaveLength(1);
    const [{ count } = { count: -1 }] = await db.admin<{ count: number }>(
      `SELECT count(*)::int AS count FROM outbox_events WHERE event_type = 'RoleRevoked' AND tenant_id = $1`,
      [A],
    );
    expect(count).toBe(1);
  });

  it('[Falha de banco] banco fora ao atribuir: 503 DEPENDENCY_UNAVAILABLE', async () => {
    dbStopped = true;
    await db.container.stop();
    const response = await assign(DIEGO, { roleId: ADMIN_A, scopeType: 'TENANT' }, 'sub-ana');
    expect(response.status, JSON.stringify(response.body)).toBe(503);
    expect(codeOf(response)).toBe('DEPENDENCY_UNAVAILABLE');
  });
});
