// Gestão de perfis na API inteira sobre PostgreSQL real (US-095 · Sucesso, Tenant incorreto,
// Permissão, Duplicidade, Concorrência, Falha de banco, Falha de integração): administradores nos
// tenants A e B, perfis padrão semeados pelo seeder real, auditoria e outbox na mesma transação,
// RLS, índices únicos `(tenant_id, key)`/`(tenant_id, lower(name))`, diff em `role_permissions` e a
// extensão de isolamento. Atribuições de perfil ainda não existem como registro (US-096): o vínculo
// ganha `roleKeys` por uma porta de teste sobre a `MembershipPort` real.
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { problemDetailsSchema } from '@contrataflow/validation';
import type { RoleDto, RoleWithPermissionsDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { SeedDefaultRolesHandler } from '#modules/access/application/seed-default-roles.handler.js';
import { PrismaRoleRepository } from '#modules/access/infrastructure/prisma-role.repository.js';
import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';
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

const A = '0192c000-0000-7000-8000-00000000095a';
const B = '0192c000-0000-7000-8000-00000000095b';
const MARTA = '0192c000-0000-7000-8000-0000000095a1';
const CARLOS = '0192c000-0000-7000-8000-0000000095a2';
const BETO = '0192c000-0000-7000-8000-0000000095b1';
const MFA = ['pwd', 'otp'];
const NOW = new Date('2026-10-15T12:00:00.000Z');

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [MARTA]: ['ADMIN_ORGAO'],
  [CARLOS]: ['REQUISITANTE'],
  [BETO]: ['ADMIN_ORGAO'],
};

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code) VALUES
  ('${A}', 'prefeitura-a-rol95', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC'),
  ('${B}', 'prefeitura-b-rol95', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC');
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${MARTA}', 'sub-marta-95', 'marta@a95.test', true, 'Marta Ribeiro'),
  ('${CARLOS}', 'sub-carlos-95', 'carlos@a95.test', true, 'Carlos Lima'),
  ('${BETO}', 'sub-beto-95', 'beto@b95.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('0192c000-0000-7000-8000-0000000096a1', '${A}', '${MARTA}', 'INTERNAL', 'ACTIVE'),
  ('0192c000-0000-7000-8000-0000000096a2', '${A}', '${CARLOS}', 'INTERNAL', 'ACTIVE'),
  ('0192c000-0000-7000-8000-0000000096b1', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
`;

/** Perfis do vínculo por usuário, sobre a `MembershipPort` real (atribuições: US-096). */
class RoleInjectingMembershipPort implements MembershipPort {
  inner!: MembershipPort;

  async findByUserAndTenant(userId: string, tenantId: string): Promise<MembershipRecord | null> {
    const membership = await this.inner.findByUserAndTenant(userId, tenantId);
    return membership ? { ...membership, roleKeys: ROLES[userId] ?? [] } : null;
  }
}

const noAudit = {
  record: () => Promise.resolve({ kind: 'recorded', id: 'x', occurredAt: NOW, rowHash: 'h' }),
} as unknown as AuditTrailPort;

type Row = Readonly<Record<string, unknown>>;

describe('Feature: perfis e matriz de permissões isolados por tenant sobre PostgreSQL (US-095)', () => {
  let db: TestDatabase;
  let api: TestApi;

  const roleIdOf = async (tenantId: string, key: string) => {
    const [row] = await db.admin<{ id: string }>(
      'SELECT id FROM roles WHERE tenant_id = $1 AND key = $2',
      [tenantId, key],
    );
    return row?.id ?? '';
  };
  const grantsOf = async (roleId: string) =>
    (
      await db.admin<{ permission_code: string }>(
        'SELECT permission_code FROM role_permissions WHERE role_id = $1 ORDER BY permission_code',
        [roleId],
      )
    ).map((row) => row.permission_code);
  const digestOf = async (tenantId: string) => {
    const [row] = await db.admin<{ digest: string }>(
      `SELECT md5(coalesce((SELECT string_agg(r::text, '|' ORDER BY r::text) FROM roles r WHERE tenant_id = $1), '')
               || coalesce((SELECT string_agg(p::text, '|' ORDER BY p::text) FROM role_permissions p WHERE tenant_id = $1), '')) AS digest`,
      [tenantId],
    );
    return row?.digest;
  };
  const events = (aggregateId: string) =>
    db.admin<Row>(
      `SELECT tenant_id, event_type, routing_key, status, payload FROM outbox_events
        WHERE aggregate_id = $1 ORDER BY occurred_at`,
      [aggregateId],
    );
  const audits = (entityId: string) =>
    db.admin<Row>(
      `SELECT tenant_id, action, category, result, metadata FROM audit_logs
        WHERE entity_id = $1 ORDER BY occurred_at`,
      [entityId],
    );
  const deniedReasons = async () =>
    (
      await db.admin<{ reason_code: string }>(
        `SELECT reason_code FROM audit_logs WHERE action = 'access.denied' AND tenant_id = $1
          ORDER BY occurred_at`,
        [A],
      )
    ).map((row) => row.reason_code);

  const send = (
    method: 'get' | 'post' | 'patch' | 'put',
    subject: string,
    tenant: string,
    path: string,
    body?: object,
    ifMatch?: string,
  ) => {
    const agent = request(api.server);
    let test = agent[method](`/api/v1/roles${path}`)
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenant);
    if (ifMatch) test = test.set('If-Match', ifMatch);
    return body === undefined ? test : test.send(body);
  };
  const create = (name: string, subject = 'sub-marta-95') => send('post', subject, A, '', { name });
  const putPermissions = (
    id: string,
    permissions: readonly string[],
    ifMatch: string,
    subject = 'sub-marta-95',
    tenant = A,
  ) => send('put', subject, tenant, `/${id}/permissions`, { permissions }, ifMatch);
  const detail = async (id: string) =>
    (
      (await send('get', 'sub-marta-95', A, `/${id}`)).body as {
        data: RoleWithPermissionsDto;
      }
    ).data;

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    db = await startTestDatabase();
    await db.admin(FIXTURE_SQL);
    // Background: os 15 perfis padrão semeados nos dois tenants pelo seeder real.
    const seeder = new SeedDefaultRolesHandler(new PrismaRoleRepository(), () => NOW, noAudit);
    const app = db.client('cf_app');
    for (const tenantId of [A, B]) {
      await runAsSystem({ name: 'teste', tenantId }, () =>
        app.$tenantTransaction((tx) => seeder.execute(tx)),
      );
    }
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
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso] criar perfil e ajustar a matriz: linhas, auditoria SECURITY e eventos PENDING (relay fora)', async () => {
    const created = await create('Fiscal de Obras');
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.headers.etag).toBe('"1"');
    const role = (created.body as { data: RoleDto }).data;
    const [row] = await db.admin<Row>('SELECT * FROM roles WHERE id = $1', [role.id]);
    expect(row).toMatchObject({
      tenant_id: A,
      key: 'FISCAL_DE_OBRAS',
      is_system: false,
      is_protected: false,
      is_active: true,
      version: 1,
      created_by_id: MARTA,
    });

    const updated = await putPermissions(role.id, ['SUPPLIER_VIEW', 'PROCESS_VIEW'], '"1"');
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.headers.etag).toBe('"2"');
    expect(await grantsOf(role.id)).toEqual(['PROCESS_VIEW', 'SUPPLIER_VIEW']);
    const swapped = await putPermissions(role.id, ['SUPPLIER_VIEW'], '"2"');
    expect(swapped.status).toBe(200);
    expect(await grantsOf(role.id)).toEqual(['SUPPLIER_VIEW']);

    expect(await audits(role.id)).toEqual([
      expect.objectContaining({ tenant_id: A, action: 'role.create', category: 'SECURITY' }),
      expect.objectContaining({ action: 'role.permissions_update', category: 'SECURITY' }),
      expect.objectContaining({
        action: 'role.permissions_update',
        metadata: expect.objectContaining({
          permissionsAdded: [],
          permissionsRemoved: ['PROCESS_VIEW'],
        }) as unknown,
      }),
    ]);
    // [Falha de integração] o relay não roda aqui: os eventos ficam PENDING até ele voltar.
    expect(await events(role.id)).toEqual([
      expect.objectContaining({
        tenant_id: A,
        event_type: 'RoleCreated',
        routing_key: 'role.created',
        status: 'PENDING',
      }),
      expect.objectContaining({
        event_type: 'RoleUpdated',
        status: 'PENDING',
        payload: {
          roleId: role.id,
          key: 'FISCAL_DE_OBRAS',
          permissionsAdded: ['SUPPLIER_VIEW', 'PROCESS_VIEW'],
          permissionsRemoved: [],
        },
      }),
      expect.objectContaining({ event_type: 'RoleUpdated', status: 'PENDING' }),
    ]);
  });

  it('[Tenant incorreto] perfil de B → 404 ROLE_NOT_FOUND em todas as rotas; B intacto; a lista de A não mostra B', async () => {
    const digestOfB = await digestOf(B);
    const ofB = await roleIdOf(B, 'AUDITOR');

    for (const response of [
      await send('get', 'sub-marta-95', A, `/${ofB}`),
      await send('patch', 'sub-marta-95', A, `/${ofB}`, { name: 'Invadido' }, '"1"'),
      await putPermissions(ofB, ['SETTINGS_MANAGE'], '"1"'),
      await send('post', 'sub-marta-95', A, `/${ofB}/duplicate`, {}),
      await send('post', 'sub-marta-95', A, `/${ofB}/deactivate`, {}, '"1"'),
    ]) {
      expect(response.status, JSON.stringify(response.body)).toBe(404);
      expect(problemDetailsSchema.parse(response.body).code).toBe('ROLE_NOT_FOUND');
    }
    expect(await digestOf(B)).toBe(digestOfB);

    const listOfA = (
      (await send('get', 'sub-marta-95', A, '')).body as { data: RoleDto[] }
    ).data.map((role) => role.id);
    const idsOfB = (
      await db.admin<{ id: string }>('SELECT id FROM roles WHERE tenant_id = $1', [B])
    ).map((row) => row.id);
    expect(listOfA.length).toBeGreaterThanOrEqual(15);
    expect(listOfA.filter((id) => idsOfB.includes(id))).toEqual([]);

    // O mesmo nome em outro tenant é permitido (unicidade por tenant).
    const sameNameInB = await send('post', 'sub-beto-95', B, '', { name: 'Fiscal de Obras' });
    expect(sameNameInB.status).toBe(201);
    // Vínculo só em B não entra em A.
    const crossTenant = await send('get', 'sub-beto-95', A, '');
    expect(problemDetailsSchema.parse(crossTenant.body).code).toBe('MEMBERSHIP_INACTIVE');
  });

  it('[Permissão] POL-13: Carlos (REQUISITANTE + ROLE_MANAGE) não concede SETTINGS_MANAGE; access.denied gravado', async () => {
    const requisitante = await roleIdOf(A, 'REQUISITANTE');
    const current = await grantsOf(requisitante);
    const granted = await putPermissions(
      requisitante,
      [...current, 'ROLE_VIEW', 'ROLE_MANAGE'],
      '"1"',
    );
    expect(granted.status, JSON.stringify(granted.body)).toBe(200);
    const target = (await create('Fiscal de Iluminação')).body as { data: RoleDto };

    const response = await putPermissions(
      target.data.id,
      ['SETTINGS_MANAGE'],
      '"1"',
      'sub-carlos-95',
    );

    expect(response.status).toBe(403);
    expect(problemDetailsSchema.parse(response.body).code).toBe('PRIVILEGE_ESCALATION_FORBIDDEN');
    expect(await grantsOf(target.data.id)).toEqual([]);
    expect((await deniedReasons()).at(-1)).toBe('PRIVILEGE_ESCALATION_FORBIDDEN');
    const own = await putPermissions(target.data.id, ['PROCESS_VIEW'], '"1"', 'sub-carlos-95');
    expect(own.status, JSON.stringify(own.body)).toBe(200);
  });

  it('[Permissão] ADMIN_ORGAO: remover USER_MANAGE → 422 e nada removido; desativar → 409 LAST_ADMIN_REQUIRED', async () => {
    const admin = await roleIdOf(A, 'ADMIN_ORGAO');
    const before = await grantsOf(admin);
    const role = await detail(admin);

    const removal = await putPermissions(
      admin,
      before.filter((code) => code !== 'USER_MANAGE'),
      `"${role.version}"`,
    );
    expect(removal.status).toBe(422);
    expect(problemDetailsSchema.parse(removal.body).code).toBe('BUSINESS_RULE_VIOLATION');
    expect(await grantsOf(admin)).toEqual(before);

    const deactivation = await send(
      'post',
      'sub-marta-95',
      A,
      `/${admin}/deactivate`,
      { confirmDeactivate: true },
      `"${role.version}"`,
    );
    expect(deactivation.status).toBe(409);
    expect(problemDetailsSchema.parse(deactivation.body).code).toBe('LAST_ADMIN_REQUIRED');
    const [row] = await db.admin<Row>('SELECT is_active FROM roles WHERE id = $1', [admin]);
    expect(row?.is_active).toBe(true);
    expect((await deniedReasons()).at(-1)).toBe('LAST_ADMIN_REQUIRED');
  });

  it('[Duplicidade] nome repetido sem distinção de maiúsculas → 409; criação concorrente → uma 201 e uma 409', async () => {
    const repeated = await create('fiscal de obras');
    expect(repeated.status).toBe(409);
    expect(problemDetailsSchema.parse(repeated.body).code).toBe('ROLE_ALREADY_EXISTS');

    const results = await Promise.all([create('Fiscal de Pontes'), create('FISCAL DE PONTES')]);
    expect(results.map((response) => response.status).sort()).toEqual([201, 409]);
    const [count] = await db.admin<{ count: string }>(
      `SELECT count(*) FROM roles WHERE tenant_id = $1 AND lower(name) = 'fiscal de pontes'`,
      [A],
    );
    expect(Number(count?.count)).toBe(1);
  });

  it('[Duplicidade] duplicar duas vezes: "(cópia)" e "(cópia 2)" com as permissões da origem', async () => {
    const source = await roleIdOf(A, 'FISCAL_DE_OBRAS');
    const first = await send('post', 'sub-marta-95', A, `/${source}/duplicate`, {});
    const second = await send('post', 'sub-marta-95', A, `/${source}/duplicate`, {});
    expect([first.status, second.status]).toEqual([201, 201]);
    const copies = [first, second].map((response) => (response.body as { data: RoleDto }).data);
    expect(copies.map((copy) => copy.name)).toEqual([
      'Fiscal de Obras (cópia)',
      'Fiscal de Obras (cópia 2)',
    ]);
    for (const copy of copies) expect(await grantsOf(copy.id)).toEqual(await grantsOf(source));
  });

  it('[Concorrência] duas edições da matriz na mesma versão: uma 200 e outra 412 com currentVersion', async () => {
    const role = ((await create('Fiscal de Praças')).body as { data: RoleDto }).data;
    const results = await Promise.all([
      putPermissions(role.id, ['PROCESS_VIEW'], '"1"'),
      putPermissions(role.id, ['SUPPLIER_VIEW'], '"1"'),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 412]);
    const conflict = results.find((response) => response.status === 412);
    expect((conflict?.body as { currentVersion?: number }).currentVersion).toBe(2);
    expect(await grantsOf(role.id)).toHaveLength(1);
  });

  it('[Falha de banco] banco indisponível ao desativar → 503 com Retry-After', async () => {
    const role = ((await create('Fiscal de Escolas')).body as { data: RoleDto }).data;
    await db.container.stop();
    const response = await send('post', 'sub-marta-95', A, `/${role.id}/deactivate`, {}, '"1"');
    expect(response.status).toBe(503);
    expect(problemDetailsSchema.parse(response.body).code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(response.headers['retry-after']).toBeDefined();
  });
});
