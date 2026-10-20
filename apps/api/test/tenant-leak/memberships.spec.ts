// Gestão de vínculos na API inteira sobre PostgreSQL real (US-092 · Tenant incorreto, Sucesso,
// Concorrência, Falha de banco): administradores nos tenants A e B, RLS de `tenant_memberships` e
// `membership_departments`, a substituição da lotação em bloco na transação da nova versão (com
// auditoria e outbox), a corrida de duas edições com a mesma `version` e a de duas suspensões
// simultâneas de administradores — a trava `FOR UPDATE` do POL-12 deixa passar só uma.
// Perfis do vínculo ainda não são lidos de `role_assignments` (US-097): `roleKeys` vem por uma porta
// de teste sobre a `MembershipPort` real; o POL-12 conta as atribuições gravadas.
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { problemDetailsSchema } from '@contrataflow/validation';
import type { TenantMembershipDetailDto, TenantMembershipDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';

import { startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';
import {
  createTestApi,
  TEST_ISSUER,
  TEST_SIGNING_KEY,
  testConfig,
} from '../support/api-test-app.js';
import type { TestApi } from '../support/api-test-app.js';

const A = '0192d000-0000-7000-8000-00000000920a';
const B = '0192d000-0000-7000-8000-00000000920b';
const ANA = '0192d000-0000-7000-8000-0000000920a1';
const ZECA = '0192d000-0000-7000-8000-0000000920a2';
const OTTO = '0192d000-0000-7000-8000-0000000920a3';
const DIEGO = '0192d000-0000-7000-8000-0000000920a4';
const BETO = '0192d000-0000-7000-8000-0000000920b1';
const FABIO = '0192d000-0000-7000-8000-0000000920b2';
const M_ANA = '0192d000-0000-7000-8000-0000000924a1';
const M_ZECA = '0192d000-0000-7000-8000-0000000924a2';
const M_OTTO = '0192d000-0000-7000-8000-0000000924a3';
const M_DIEGO = '0192d000-0000-7000-8000-0000000924a4';
const M_BETO = '0192d000-0000-7000-8000-0000000924b1';
const M_FABIO = '0192d000-0000-7000-8000-0000000924b2';
const PMSJ = '0192d000-0000-7000-8000-0000000921a1';
const ORG_B = '0192d000-0000-7000-8000-0000000921b1';
const COMPRAS = '0192d000-0000-7000-8000-0000000922a1';
const LICITACOES = '0192d000-0000-7000-8000-0000000922a2';
const SETOR_B = '0192d000-0000-7000-8000-0000000922b1';
const ADMIN_A = '0192d000-0000-7000-8000-0000000923a1';
const ADMIN_B = '0192d000-0000-7000-8000-0000000923b1';
const MFA = ['pwd', 'otp'];

/**
 * Otto age com `USER_MANAGE` (perfil personalizado na prática) sem atribuição do `ADMIN_ORGAO`
 * gravada: não conta como administrador para o POL-12.
 */
const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['ADMIN_ORGAO'],
  [ZECA]: ['ADMIN_ORGAO'],
  [OTTO]: ['ADMIN_ORGAO'],
  [BETO]: ['ADMIN_ORGAO'],
};

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code) VALUES
  ('${A}', 'prefeitura-sao-jose-usr', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC'),
  ('${B}', 'prefeitura-b-usr', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC');
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${ANA}', 'sub-ana', 'ana@a.test', true, 'Ana Admin'),
  ('${ZECA}', 'sub-zeca', 'zeca@a.test', true, 'Zeca Admin'),
  ('${OTTO}', 'sub-otto', 'otto@a.test', true, 'Otto Gestor'),
  ('${DIEGO}', 'sub-diego', 'diego@a.test', true, 'Diego Compras'),
  ('${BETO}', 'sub-beto', 'beto@b.test', true, 'Beto LEAK-B'),
  ('${FABIO}', 'sub-fabio', 'fabio@b.test', true, 'Fábio LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${M_ANA}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('${M_ZECA}', '${A}', '${ZECA}', 'INTERNAL', 'ACTIVE'),
  ('${M_OTTO}', '${A}', '${OTTO}', 'INTERNAL', 'ACTIVE'),
  ('${M_DIEGO}', '${A}', '${DIEGO}', 'INTERNAL', 'ACTIVE'),
  ('${M_BETO}', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE'),
  ('${M_FABIO}', '${B}', '${FABIO}', 'INTERNAL', 'ACTIVE');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${PMSJ}', '${A}', 'Prefeitura Municipal', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura B LEAK-B', 'PMB', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${PMSJ}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO departments (id, tenant_id, organization_id, type, name, path, depth) VALUES
  ('${COMPRAS}', '${A}', '${PMSJ}', 'SECTOR', 'Compras', '/${COMPRAS}/', 0),
  ('${LICITACOES}', '${A}', '${PMSJ}', 'SECTOR', 'Setor de Licitações', '/${LICITACOES}/', 0),
  ('${SETOR_B}', '${B}', '${ORG_B}', 'SECTOR', 'Setor LEAK-B', '/${SETOR_B}/', 0);
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192d000-0000-7000-8000-0000000925a1', '${A}', '${M_DIEGO}', '${COMPRAS}', true),
  ('0192d000-0000-7000-8000-0000000925b1', '${B}', '${M_FABIO}', '${SETOR_B}', true);
INSERT INTO roles (id, tenant_id, key, name, is_system) VALUES
  ('${ADMIN_A}', '${A}', 'ADMIN_ORGAO', 'Administrador do órgão', true),
  ('${ADMIN_B}', '${B}', 'ADMIN_ORGAO', 'Administrador LEAK-B', true);
INSERT INTO role_assignments (id, tenant_id, membership_id, role_id, scope_type, granted_by_id) VALUES
  ('0192d000-0000-7000-8000-0000000926a1', '${A}', '${M_ANA}', '${ADMIN_A}', 'TENANT', '${ANA}'),
  ('0192d000-0000-7000-8000-0000000926a2', '${A}', '${M_ZECA}', '${ADMIN_A}', 'TENANT', '${ANA}'),
  ('0192d000-0000-7000-8000-0000000926b1', '${B}', '${M_BETO}', '${ADMIN_B}', 'TENANT', '${BETO}');
`;

/** Perfis do vínculo por usuário, sobre a `MembershipPort` real (leitura de atribuições: US-097). */
class RoleInjectingMembershipPort implements MembershipPort {
  inner!: MembershipPort;

  async findByUserAndTenant(userId: string, tenantId: string): Promise<MembershipRecord | null> {
    const membership = await this.inner.findByUserAndTenant(userId, tenantId);
    return membership ? { ...membership, roleKeys: ROLES[userId] ?? [] } : null;
  }
}

type Row = Readonly<Record<string, unknown>>;

interface Detail {
  readonly data: TenantMembershipDetailDto;
}

describe('Feature: gestão de vínculos isolada por tenant sobre PostgreSQL (US-092)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let dbStopped = false;

  const as = (test: request.Test, subject = 'sub-ana', tenant = A) =>
    test.set('Authorization', api.bearer(subject, { amr: MFA })).set('X-Tenant-Id', tenant);
  const getUser = (userId: string, subject = 'sub-ana') =>
    as(request(api.server).get(`/api/v1/users/${userId}`), subject);
  const mutate = (
    method: 'patch' | 'put' | 'post',
    path: string,
    version: number,
    body: Record<string, unknown> = {},
    subject = 'sub-ana',
  ) =>
    as(request(api.server)[method](`/api/v1/users/${path}`), subject)
      .set('If-Match', `"${String(version)}"`)
      .send(body);
  const codeOf = (response: request.Response) => problemDetailsSchema.parse(response.body).code;
  const membershipRow = async (id: string) =>
    (await db.admin<Row>('SELECT * FROM tenant_memberships WHERE id = $1', [id]))[0];
  const digestOf = async (tenantId: string) => {
    const [result] = await db.admin<{ digest: string }>(
      `SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) ||
              md5(coalesce((SELECT string_agg(d::text, '|' ORDER BY d::text)
                               FROM membership_departments d WHERE d.tenant_id = $1), '')) AS digest
         FROM tenant_memberships t WHERE tenant_id = $1`,
      [tenantId],
    );
    return result?.digest;
  };

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
    });
    api = await createTestApi({
      config,
      providers: [
        { token: MEMBERSHIP_PORT, value: membership },
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
  });

  afterAll(async () => {
    await api.close();
    if (!dbStopped) await db.stop();
    vi.restoreAllMocks();
  });

  it('[Tenant incorreto] usuário só do tenant B: 404 em USR-07..13 sem tocar no vínculo dele', async () => {
    const before = await digestOf(B);
    const detail = await getUser(FABIO);
    expect(detail.status, JSON.stringify(detail.body)).toBe(404);
    expect(codeOf(detail)).toBe('USER_NOT_FOUND');
    expect(JSON.stringify(detail.body)).not.toMatch(/LEAK-B|fabio/i);
    for (const response of [
      await mutate('patch', FABIO, 1, { jobTitle: 'Invasor' }),
      await mutate('put', `${FABIO}/departments`, 1, {
        departmentIds: [SETOR_B],
        primaryDepartmentId: SETOR_B,
      }),
      await mutate('post', `${FABIO}/suspend`, 1),
      await mutate('post', `${FABIO}/reactivate`, 1),
      await mutate('post', `${FABIO}/revoke`, 1),
      // US-090 · USR-13: a RLS esconde o vínculo de B antes de qualquer chamada ao Authentik.
      await as(request(api.server).post(`/api/v1/users/${FABIO}/mfa-reset`)).send({
        reason: 'Perdeu o dispositivo do segundo fator.',
      }),
    ]) {
      expect(response.status, JSON.stringify(response.body)).toBe(404);
      expect(codeOf(response)).toBe('USER_NOT_FOUND');
    }
    // Lotação de B no corpo: 422 sem revelar a unidade; filtro por unidade de B: lista vazia.
    const reference = await mutate('put', `${DIEGO}/departments`, 1, {
      departmentIds: [SETOR_B],
      primaryDepartmentId: SETOR_B,
    });
    expect(reference.status).toBe(422);
    expect(problemDetailsSchema.parse(reference.body).errors).toEqual([
      expect.objectContaining({ field: 'departmentIds', code: 'REFERENCE_NOT_FOUND' }),
    ]);
    const filtered = await as(request(api.server).get(`/api/v1/users?departmentId=${SETOR_B}`));
    expect(filtered.status).toBe(200);
    expect((filtered.body as { data: TenantMembershipDto[] }).data).toEqual([]);
    expect(await digestOf(B)).toBe(before);
  });

  it('[Sucesso] lotação substituída em bloco com a principal, nova versão, auditoria e outbox', async () => {
    const detail = await getUser(DIEGO);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(detail.headers.etag).toBe('"1"');
    const response = await mutate('put', `${DIEGO}/departments`, 1, {
      departmentIds: [COMPRAS, LICITACOES],
      primaryDepartmentId: LICITACOES,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((response.body as Detail).data).toMatchObject({
      departmentIds: [LICITACOES, COMPRAS],
      primaryDepartmentId: LICITACOES,
      version: 2,
    });
    const rows = await db.admin<Row>(
      `SELECT department_id, is_primary FROM membership_departments
        WHERE membership_id = $1 ORDER BY is_primary DESC`,
      [M_DIEGO],
    );
    expect(rows).toEqual([
      { department_id: LICITACOES, is_primary: true },
      { department_id: COMPRAS, is_primary: false },
    ]);
    expect(await membershipRow(M_DIEGO)).toMatchObject({ version: 2, updated_by_id: ANA });
    const [audit] = await db.admin<Row>(
      `SELECT category::text AS category, actor_user_id FROM audit_logs
        WHERE action = 'membership.departments_update' AND entity_id = $1`,
      [M_DIEGO],
    );
    expect(audit).toEqual({ category: 'SECURITY', actor_user_id: ANA });
    const [event] = await db.admin<Row>(
      `SELECT tenant_id, routing_key, payload FROM outbox_events
        WHERE event_type = 'MembershipUpdated' AND aggregate_id = $1`,
      [M_DIEGO],
    );
    expect(event).toEqual({
      tenant_id: A,
      routing_key: 'membership.updated',
      payload: { membershipId: M_DIEGO, changedFields: ['departments'] },
    });
  });

  it('[Concorrência] duas edições com a mesma version: uma grava, a outra recebe 412', async () => {
    const [first, second] = await Promise.all([
      mutate('put', `${DIEGO}/departments`, 2, {
        departmentIds: [COMPRAS],
        primaryDepartmentId: COMPRAS,
      }),
      mutate('put', `${DIEGO}/departments`, 2, {
        departmentIds: [LICITACOES],
        primaryDepartmentId: LICITACOES,
      }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 412]);
    const loser = first.status === 412 ? first : second;
    expect(codeOf(loser)).toBe('VERSION_CONFLICT');
    const winner = (first.status === 200 ? first : second).body as Detail;
    const rows = await db.admin<Row>(
      'SELECT department_id FROM membership_departments WHERE membership_id = $1',
      [M_DIEGO],
    );
    expect(rows).toEqual([{ department_id: winner.data.primaryDepartmentId }]);
    expect(await membershipRow(M_DIEGO)).toMatchObject({ version: 3 });
  });

  it('[Concorrência] POL-12: duas suspensões simultâneas dos dois administradores — só uma passa', async () => {
    const [ana, zeca] = await Promise.all([
      mutate('post', `${ANA}/suspend`, 1, {}, 'sub-otto'),
      mutate('post', `${ZECA}/suspend`, 1, {}, 'sub-otto'),
    ]);
    expect([ana.status, zeca.status].sort()).toEqual([200, 409]);
    const blocked = ana.status === 409 ? ana : zeca;
    expect(codeOf(blocked)).toBe('LAST_ADMIN_REQUIRED');
    const statuses = await db.admin<{ status: string }>(
      `SELECT status::text AS status FROM tenant_memberships WHERE id IN ($1, $2) ORDER BY status`,
      [M_ANA, M_ZECA],
    );
    expect(statuses.map((row) => row.status)).toEqual(['ACTIVE', 'SUSPENDED']);
    const [{ count } = { count: -1 }] = await db.admin<{ count: number }>(
      `SELECT count(*)::int AS count FROM outbox_events WHERE event_type = 'MembershipSuspended'`,
    );
    expect(count).toBe(1);
  });

  it('[Falha de banco] banco fora ao revogar: 503 DEPENDENCY_UNAVAILABLE', async () => {
    // Ana ou Zeca ficou suspenso no cenário anterior: quem age aqui é o Otto.
    const detail = await getUser(DIEGO, 'sub-otto');
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    const version = (detail.body as Detail).data.version;
    dbStopped = true;
    await db.container.stop();
    const response = await mutate(
      'post',
      `${DIEGO}/revoke`,
      version,
      { reason: 'Exonerado' },
      'sub-otto',
    );
    expect(response.status, JSON.stringify(response.body)).toBe(503);
    expect(codeOf(response)).toBe('DEPENDENCY_UNAVAILABLE');
  });
});
