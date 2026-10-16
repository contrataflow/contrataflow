// Convite e aceite na API inteira sobre PostgreSQL real (US-091 · Sucesso, Tenant incorreto,
// Validação, Duplicidade, Concorrência, Falha de banco, Falha de integração): administradores nos
// tenants A e B, `users` + `tenant_memberships` + `membership_departments` + `role_assignments` +
// auditoria + outbox numa transação só, RLS, o aceite pelo `cf_find_invitation` (SystemDbService,
// `INVITATION_LOOKUP`) gravando no tenant DO CONVITE e a compensação do Authentik quando a transação
// falha. O `EmailSender` (worker) é simulado gravando o SHA-256 do token, como no envio real.
// Perfis do vínculo ainda não são lidos de `role_assignments` (US-097): `roleKeys` vem por uma porta
// de teste sobre a `MembershipPort` real.
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { createHash, randomBytes } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type { AcceptedInvitationDto, TenantMembershipDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AUTHENTIK_DIRECTORY } from '#modules/identity/application/ports.js';
import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { InMemoryAuthentikDirectory } from '#modules/identity/infrastructure/in-memory-identity.repositories.js';
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

const A = '0192d000-0000-7000-8000-00000000910a';
const B = '0192d000-0000-7000-8000-00000000910b';
const ANA = '0192d000-0000-7000-8000-0000000910a1';
const CARLA = '0192d000-0000-7000-8000-0000000910a2';
const BETO = '0192d000-0000-7000-8000-0000000910b1';
const LUCIA = '0192d000-0000-7000-8000-0000000910a3';
const PMSJ = '0192d000-0000-7000-8000-0000000911a1';
const ORG_B = '0192d000-0000-7000-8000-0000000911b1';
const COMPRAS = '0192d000-0000-7000-8000-0000000912a1';
const SETOR_B = '0192d000-0000-7000-8000-0000000912b1';
const ROLE_COMPRAS = '0192d000-0000-7000-8000-0000000913a1';
const ROLE_FALHA = '0192d000-0000-7000-8000-0000000913a2';
const ROLE_B = '0192d000-0000-7000-8000-0000000913b1';
const MFA = ['pwd', 'otp'];
const DAY = 24 * 3_600_000;

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['ADMIN_ORGAO'],
  [CARLA]: ['REQUISITANTE'],
  [BETO]: ['ADMIN_ORGAO'],
  [LUCIA]: ['COMPRAS'],
};

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code) VALUES
  ('${A}', 'prefeitura-sao-jose-inv', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC'),
  ('${B}', 'prefeitura-b-inv', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC');
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${ANA}', 'sub-ana', 'ana@a.test', true, 'Ana Admin'),
  ('${CARLA}', 'sub-carla', 'carla@a.test', true, 'Carla Requisitante'),
  ('${BETO}', 'sub-beto', 'beto@b.test', true, 'Beto LEAK-B'),
  ('${LUCIA}', 'sub-lucia', 'lucia@a.test', true, 'Lúcia Compras');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('0192d000-0000-7000-8000-0000000914a1', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('0192d000-0000-7000-8000-0000000914a2', '${A}', '${CARLA}', 'INTERNAL', 'ACTIVE'),
  ('0192d000-0000-7000-8000-0000000914a3', '${A}', '${LUCIA}', 'INTERNAL', 'ACTIVE'),
  ('0192d000-0000-7000-8000-0000000914b1', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${PMSJ}', '${A}', 'Prefeitura Municipal', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura B LEAK-B', 'PMB', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${PMSJ}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO departments (id, tenant_id, organization_id, type, name, path, depth) VALUES
  ('${COMPRAS}', '${A}', '${PMSJ}', 'SECTOR', 'Compras', '/${COMPRAS}/', 0),
  ('${SETOR_B}', '${B}', '${ORG_B}', 'SECTOR', 'Setor LEAK-B', '/${SETOR_B}/', 0);
INSERT INTO roles (id, tenant_id, key, name, is_system) VALUES
  ('${ROLE_COMPRAS}', '${A}', 'COMPRAS', 'Compras', true),
  ('${ROLE_FALHA}', '${A}', 'PERFIL_FALHA', 'Perfil com falha induzida', false),
  ('${ROLE_B}', '${B}', 'COMPRAS', 'Compras LEAK-B', true);
-- Falha induzida DEPOIS de users/tenant_memberships/membership_departments na transação do convite.
CREATE FUNCTION test_fail_role_assignment() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.role_id = '${ROLE_FALHA}'::uuid THEN
    RAISE EXCEPTION 'falha induzida' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER test_fail_role_assignment BEFORE INSERT ON role_assignments
  FOR EACH ROW EXECUTE FUNCTION test_fail_role_assignment();
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

describe('Feature: convite e aceite isolados por tenant sobre PostgreSQL (US-091)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let dbStopped = false;
  const authentik = new InMemoryAuthentikDirectory();

  const invite = (body: Record<string, unknown>, subject = 'sub-ana', tenant = A) =>
    request(api.server)
      .post('/api/v1/users/invitations')
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenant)
      .send(body);
  const admin = (
    method: 'post' | 'delete' | 'get',
    path: string,
    subject = 'sub-ana',
    tenant = A,
  ) => {
    const test = request(api.server)[method](`/api/v1/users${path}`);
    return test.set('Authorization', api.bearer(subject, { amr: MFA })).set('X-Tenant-Id', tenant);
  };
  const accept = (token: string, subject: string, tenant?: string) => {
    const test = request(api.server)
      .post('/api/v1/invitations/accept')
      .set('Authorization', api.bearer(subject, { amr: ['pwd'] }));
    return (tenant ? test.set('X-Tenant-Id', tenant) : test).send({ token });
  };
  const codeOf = (response: request.Response) => problemDetailsSchema.parse(response.body).code;
  const membershipRow = async (id: string) =>
    (await db.admin<Row>('SELECT * FROM tenant_memberships WHERE id = $1', [id]))[0];
  const digestOf = async (tenantId: string) => {
    const [result] = await db.admin<{ digest: string }>(
      `SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS digest
         FROM tenant_memberships t WHERE tenant_id = $1`,
      [tenantId],
    );
    return result?.digest;
  };

  /** O que o `EmailSender` faz no envio: gera o token e grava só o hash. */
  const deliver = async (membershipId: string) => {
    const token = randomBytes(32).toString('base64url');
    const hash = createHash('sha256').update(token).digest('hex');
    await db.admin(
      `UPDATE tenant_memberships SET invite_token_hash = $2
        WHERE id = $1 AND status = 'INVITED' AND invite_token_hash IS NULL`,
      [membershipId, hash],
    );
    return token;
  };
  /** Primeiro login no Authentik: o `sub` é vinculado ao `User` convidado. */
  const signIn = (userId: string, subject: string) =>
    db.admin('UPDATE users SET external_subject = $2 WHERE id = $1', [userId, subject]);
  const invited = async (
    email: string,
    extra: Record<string, unknown> = {},
    subject = 'sub-ana',
  ) => {
    const response = await invite(
      { email, name: 'Pessoa Convidada', type: 'INTERNAL', ...extra },
      subject,
      subject === 'sub-beto' ? B : A,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return (response.body as { data: TenantMembershipDto }).data;
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
        { token: AUTHENTIK_DIRECTORY, value: authentik },
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

  it('[Sucesso] convite numa transação só (users, vínculo, lotação, perfil, auditoria, outbox) e aceite pelo token', async () => {
    const before = await digestOf(B);
    const membership = await invited('bruno@pmsj.gov.br', {
      name: 'Bruno Alves',
      departmentIds: [COMPRAS],
      roleId: ROLE_COMPRAS,
    });
    const row = await membershipRow(membership.id);
    expect(row).toMatchObject({
      tenant_id: A,
      status: 'INVITED',
      invite_token_hash: null,
      invite_resend_count: 0,
      invited_by_id: ANA,
    });
    expect((row?.invite_expires_at as Date).getTime() - (row?.invited_at as Date).getTime()).toBe(
      7 * DAY,
    );
    const [user] = await db.admin<Row>('SELECT * FROM users WHERE email = $1', [
      'bruno@pmsj.gov.br',
    ]);
    expect(user).toMatchObject({
      external_subject: null,
      authentik_user_id: authentik.provisioned.at(-1)?.pk,
    });
    expect(
      await db.admin<Row>(
        'SELECT tenant_id, department_id, is_primary FROM membership_departments WHERE membership_id = $1',
        [membership.id],
      ),
    ).toEqual([{ tenant_id: A, department_id: COMPRAS, is_primary: true }]);
    expect(
      await db.admin<Row>(
        `SELECT tenant_id, role_id, scope_type::text AS scope_type, granted_by_id, revoked_at
           FROM role_assignments WHERE membership_id = $1`,
        [membership.id],
      ),
    ).toEqual([
      {
        tenant_id: A,
        role_id: ROLE_COMPRAS,
        scope_type: 'TENANT',
        granted_by_id: ANA,
        revoked_at: null,
      },
    ]);
    expect(
      await db.admin<Row>(
        `SELECT tenant_id, event_type, routing_key, status FROM outbox_events WHERE aggregate_id = $1`,
        [membership.id],
      ),
    ).toEqual([
      {
        tenant_id: A,
        event_type: 'UserInvited',
        routing_key: 'membership.invited',
        status: 'PENDING',
      },
    ]);
    expect(
      await db.admin<Row>(
        `SELECT tenant_id, action, category::text AS category FROM audit_logs WHERE entity_id = $1`,
        [membership.id],
      ),
    ).toEqual([{ tenant_id: A, action: 'membership.invite', category: 'SECURITY' }]);

    await signIn(membership.userId, 'sub-bruno');
    const token = await deliver(membership.id);
    const accepted = await accept(token, 'sub-bruno');
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect((accepted.body as { data: AcceptedInvitationDto }).data.tenant.id).toBe(A);
    expect(await membershipRow(membership.id)).toMatchObject({
      status: 'ACTIVE',
      invite_token_hash: null,
      updated_by_id: membership.userId,
    });
    expect(
      await db.admin<Row>(
        `SELECT tenant_id, event_type FROM outbox_events WHERE aggregate_id = $1 ORDER BY occurred_at`,
        [membership.id],
      ),
    ).toEqual([
      { tenant_id: A, event_type: 'UserInvited' },
      { tenant_id: A, event_type: 'MembershipActivated' },
    ]);
    expect(await digestOf(B)).toBe(before);
    expect(codeOf(await accept(token, 'sub-bruno'))).toBe('INVITATION_INVALID');
  });

  it('[Tenant incorreto] convite de B aceito com A ativa: ativa só em B, sem tocar em A', async () => {
    const membership = await invited('lucia@a.test', { name: 'Lúcia Compras' }, 'sub-beto');
    expect(membership.userId).toBe(LUCIA);
    const token = await deliver(membership.id);
    const before = await digestOf(A);
    const accepted = await accept(token, 'sub-lucia', A);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(await membershipRow(membership.id)).toMatchObject({ tenant_id: B, status: 'ACTIVE' });
    expect(await digestOf(A)).toBe(before);
    expect(
      await db.admin<Row>(
        `SELECT tenant_id FROM audit_logs WHERE entity_id = $1 AND action = 'membership.activate'`,
        [membership.id],
      ),
    ).toEqual([{ tenant_id: B }]);
  });

  it('[Tenant incorreto] referências, reenvio, cancelamento e lista nunca atravessam tenants', async () => {
    const leak = await invite({
      email: 'fulano@pmsj.gov.br',
      name: 'Fulano',
      type: 'INTERNAL',
      departmentIds: [SETOR_B],
      roleId: ROLE_B,
    });
    expect(leak.status).toBe(422);
    expect(problemDetailsSchema.parse(leak.body).errors).toEqual([
      expect.objectContaining({ field: 'departmentIds', code: 'REFERENCE_NOT_FOUND' }),
      expect.objectContaining({ field: 'roleId', code: 'REFERENCE_NOT_FOUND' }),
    ]);
    const pendingOfB = await invited('so.de.b@b.test', { name: 'Só de B' }, 'sub-beto');
    const before = await digestOf(B);
    expect(codeOf(await admin('post', `/invitations/${pendingOfB.userId}/resend`))).toBe(
      'USER_NOT_FOUND',
    );
    expect(codeOf(await admin('delete', `/invitations/${pendingOfB.userId}`))).toBe(
      'USER_NOT_FOUND',
    );
    expect(await digestOf(B)).toBe(before);
    const list = await admin('get', '?pageSize=100');
    expect(list.status).toBe(200);
    const items = (list.body as { data: TenantMembershipDto[] }).data;
    expect(items.some((item) => item.userId === BETO || item.userId === pendingOfB.userId)).toBe(
      false,
    );
    expect(JSON.stringify(list.body)).not.toContain('LEAK-B');
  });

  it('[Permissão][Duplicidade] REQUISITANTE → 403; mesmo e-mail pendente → 409 sem gravar', async () => {
    expect(
      codeOf(await invite({ email: 'x@pmsj.gov.br', name: 'Xis', type: 'INTERNAL' }, 'sub-carla')),
    ).toBe('PERMISSION_DENIED');
    await invited('repetido@pmsj.gov.br');
    const [{ total } = { total: '0' }] = await db.admin<{ total: string }>(
      'SELECT count(*)::text AS total FROM outbox_events',
    );
    const again = await invite({ email: 'REPETIDO@pmsj.gov.br', name: 'Outro', type: 'INTERNAL' });
    expect(again.status).toBe(409);
    expect(codeOf(again)).toBe('MEMBERSHIP_ALREADY_EXISTS');
    const [after] = await db.admin<{ total: string }>(
      'SELECT count(*)::text AS total FROM outbox_events',
    );
    expect(after?.total).toBe(total);
  });

  it('[Concorrência] aceite com o token original e reenvio simultâneos: só um vence', async () => {
    const membership = await invited('corrida@pmsj.gov.br');
    await signIn(membership.userId, 'sub-corrida');
    const token = await deliver(membership.id);
    // Libera o intervalo mínimo de reenvio (RN-IAM-53).
    await db.admin(
      `UPDATE tenant_memberships SET invited_at = invited_at - interval '2 minutes' WHERE id = $1`,
      [membership.id],
    );
    const [accepted, resent] = await Promise.all([
      accept(token, 'sub-corrida'),
      admin('post', `/invitations/${membership.userId}/resend`),
    ]);
    const row = await membershipRow(membership.id);
    if (accepted.status === 200) {
      expect(row?.status).toBe('ACTIVE');
      expect(resent.status).not.toBe(200);
    } else {
      expect(['INVITATION_INVALID', 'INVITATION_EXPIRED']).toContain(codeOf(accepted));
      expect(resent.status).toBe(200);
      expect(row).toMatchObject({
        status: 'INVITED',
        invite_token_hash: null,
        invite_resend_count: 1,
      });
    }
    const activations = await db.admin<Row>(
      `SELECT 1 FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'MembershipActivated'`,
      [membership.id],
    );
    expect(activations.length).toBe(accepted.status === 200 ? 1 : 0);
  });

  it('[Concorrência] dois aceites simultâneos: um ativa, o outro INVITATION_INVALID', async () => {
    const membership = await invited('duplo@pmsj.gov.br');
    await signIn(membership.userId, 'sub-duplo');
    const token = await deliver(membership.id);
    const results = await Promise.all([accept(token, 'sub-duplo'), accept(token, 'sub-duplo')]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 404]);
  });

  it('[Falha de banco] a transação falha depois do Authentik: nada persiste e a conta é removida', async () => {
    const response = await invite({
      email: 'atomico@pmsj.gov.br',
      name: 'Atômico',
      type: 'INTERNAL',
      departmentIds: [COMPRAS],
      roleId: ROLE_FALHA,
    });
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(await db.admin('SELECT 1 FROM users WHERE email = $1', ['atomico@pmsj.gov.br'])).toEqual(
      [],
    );
    const created = authentik.provisioned.find((item) => item.email === 'atomico@pmsj.gov.br');
    expect(created).toBeDefined();
    expect(authentik.removed).toContain(created?.pk);
  });

  it('[Falha de integração] Authentik fora → 503 sem User nem vínculo', async () => {
    authentik.unavailable = true;
    try {
      const response = await invite({
        email: 'sem.idp@pmsj.gov.br',
        name: 'Sem IdP',
        type: 'INTERNAL',
      });
      expect(response.status).toBe(503);
      expect(codeOf(response)).toBe('DEPENDENCY_UNAVAILABLE');
      expect(
        await db.admin('SELECT 1 FROM users WHERE email = $1', ['sem.idp@pmsj.gov.br']),
      ).toEqual([]);
    } finally {
      authentik.unavailable = false;
    }
  });

  it('[Falha de banco] PostgreSQL indisponível → 503 DEPENDENCY_UNAVAILABLE, Authentik nem chamado', async () => {
    const provisioned = authentik.provisioned.length;
    dbStopped = true;
    await db.container.stop();
    const response = await invite({
      email: 'banco.fora@pmsj.gov.br',
      name: 'Banco Fora',
      type: 'INTERNAL',
    });
    expect(response.status).toBe(503);
    expect(codeOf(response)).toBe('DEPENDENCY_UNAVAILABLE');
    expect(authentik.provisioned).toHaveLength(provisioned);
  });
});
