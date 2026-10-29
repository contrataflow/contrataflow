// Identidade sobre o PostgreSQL real (US-087): `users`, `tenants`, `tenant_memberships`, a função
// `cf_user_memberships` (leitura entre tenants restrita ao próprio usuário), o vínculo do `sub` no
// primeiro login sob concorrência e o último acesso ao vínculo. Testcontainers + migrações reais.
// spec-531: as chaves de perfil do vínculo (`roleKeys`) derivadas das atribuições vigentes.
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionAuditPort } from '#modules/identity/application/ports.js';
import { RecordSessionTenantCommand } from '#modules/identity/application/record-session-tenant.command.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { InMemoryTenantMfaPolicy } from '#modules/identity/infrastructure/tenant-mfa-policy.js';
import { PrismaTenantRepository } from '#modules/tenancy/infrastructure/prisma-tenant.repository.js';
import { TenantTransaction } from '#shared/database/database.module.js';
import { PlatformTransaction } from '#shared/database/platform-transaction.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { asTenant, startTestDatabase } from './support/postgres.js';
import type { TestDatabase } from './support/postgres.js';

const A = '0192f000-0000-7000-8000-00000000000a';
const B = '0192f000-0000-7000-8000-00000000000b';
const ANA = '0192f000-0000-7000-8000-0000000000a1';
const BIA = '0192f000-0000-7000-8000-0000000000b1';
const RAFAEL = '0192f000-0000-7000-8000-0000000000c1';
const ANA_A = '0192f000-0000-7000-8000-0000000001a1';
const ANA_B = '0192f000-0000-7000-8000-0000000002a1';
const BIA_B = '0192f000-0000-7000-8000-0000000001b1';
const RAFAEL_A = '0192f000-0000-7000-8000-0000000001c1';
const ROLE_AUDITOR_A = '0192f000-0000-7000-8000-0000000003a1';
const ROLE_GESTOR_A = '0192f000-0000-7000-8000-0000000003a2';
const ROLE_CI_A = '0192f000-0000-7000-8000-0000000003a3';
const ROLE_REQ_A = '0192f000-0000-7000-8000-0000000003a4';
const ROLE_COMPRAS_A = '0192f000-0000-7000-8000-0000000003a5';
const ROLE_JURIDICO_A = '0192f000-0000-7000-8000-0000000003a6';
const ROLE_ADMIN_A = '0192f000-0000-7000-8000-0000000003a7';
const ROLE_ADMIN_B = '0192f000-0000-7000-8000-0000000003b1';
const RA_ADMIN_B = '0192f000-0000-7000-8000-0000000004b1';
const SUB_ANA = '6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a01';
const SUB_RAFAEL = '6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a02';

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone, suspension_reason) VALUES
  ('${A}', 'sao-jose', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo', NULL),
  ('${B}', 'santa-luzia', 'Prefeitura de Santa Luzia', 'MUNICIPALITY', 'SUSPENDED', 'SC', 'America/Manaus', 'teste');
INSERT INTO users (id, external_subject, authentik_user_id, email, email_verified, name, social_name) VALUES
  ('${ANA}', '${SUB_ANA}', '11', 'ana@saojose.sp.gov.br', true, 'Ana Ribeiro', NULL),
  ('${BIA}', NULL, NULL, 'Bia@SantaLuzia.gov.br', true, 'Beatriz Lima', 'Bia Lima'),
  ('${RAFAEL}', NULL, '42', 'rafael@saojose.sp.gov.br', false, 'Rafael Nogueira', NULL);
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status, expires_at) VALUES
  ('${ANA_A}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE', NULL),
  ('${ANA_B}', '${B}', '${ANA}', 'EXTERNAL', 'ACTIVE', now() + interval '30 days'),
  ('${BIA_B}', '${B}', '${BIA}', 'INTERNAL', 'INVITED', NULL),
  ('${RAFAEL_A}', '${A}', '${RAFAEL}', 'INTERNAL', 'INVITED', NULL);
INSERT INTO roles (id, tenant_id, key, name, is_system, is_active) VALUES
  ('${ROLE_AUDITOR_A}', '${A}', 'AUDITOR', 'Auditor', true, true),
  ('${ROLE_GESTOR_A}', '${A}', 'GESTOR_CONTRATACOES', 'Gestor de contratações', true, true),
  ('${ROLE_CI_A}', '${A}', 'CONTROLE_INTERNO', 'Controle interno', true, true),
  ('${ROLE_REQ_A}', '${A}', 'REQUISITANTE', 'Requisitante', true, true),
  ('${ROLE_COMPRAS_A}', '${A}', 'COMPRAS', 'Compras', true, true),
  ('${ROLE_JURIDICO_A}', '${A}', 'JURIDICO', 'Jurídico', true, false),
  ('${ROLE_ADMIN_A}', '${A}', 'ADMIN_ORGAO', 'Administrador do órgão', true, true),
  ('${ROLE_ADMIN_B}', '${B}', 'ADMIN_ORGAO', 'Administrador do órgão', true, true);
-- Ana em A: duas vigentes (uma com fim futuro) e uma de cada caso que NÃO conta — revogada,
-- vencida, ainda não iniciada e de perfil inativo. Ana em B: ADMIN_ORGAO (que em A ela não tem).
INSERT INTO role_assignments
  (id, tenant_id, membership_id, role_id, scope_type, granted_by_id, valid_from, valid_until,
   revoked_at, revoked_by_id) VALUES
  ('0192f000-0000-7000-8000-0000000004a1', '${A}', '${ANA_A}', '${ROLE_AUDITOR_A}', 'TENANT',
   '${ANA}', now() - interval '1 day', NULL, NULL, NULL),
  ('0192f000-0000-7000-8000-0000000004a2', '${A}', '${ANA_A}', '${ROLE_GESTOR_A}', 'TENANT',
   '${ANA}', now() - interval '1 day', now() + interval '30 days', NULL, NULL),
  ('0192f000-0000-7000-8000-0000000004a3', '${A}', '${ANA_A}', '${ROLE_CI_A}', 'TENANT',
   '${ANA}', now() - interval '2 days', NULL, now() - interval '1 day', '${ANA}'),
  ('0192f000-0000-7000-8000-0000000004a4', '${A}', '${ANA_A}', '${ROLE_REQ_A}', 'TENANT',
   '${ANA}', now() - interval '30 days', now() - interval '1 day', NULL, NULL),
  ('0192f000-0000-7000-8000-0000000004a5', '${A}', '${ANA_A}', '${ROLE_COMPRAS_A}', 'TENANT',
   '${ANA}', now() + interval '1 day', NULL, NULL, NULL),
  ('0192f000-0000-7000-8000-0000000004a6', '${A}', '${ANA_A}', '${ROLE_JURIDICO_A}', 'TENANT',
   '${ANA}', now() - interval '1 day', NULL, NULL, NULL),
  ('${RA_ADMIN_B}', '${B}', '${ANA_B}', '${ROLE_ADMIN_B}', 'TENANT',
   '${ANA}', now() - interval '1 day', NULL, NULL, NULL);
`;

describe('identidade no PostgreSQL (US-087)', () => {
  let db: TestDatabase;
  let identities: PrismaIdentityRepository;
  let tenants: PrismaTenantRepository;
  let tenantTransactions: TenantTransaction;

  beforeAll(async () => {
    db = await startTestDatabase();
    await db.admin(FIXTURE_SQL);
    const client = db.client('cf_app');
    const platform = new PlatformTransaction(client);
    tenantTransactions = new TenantTransaction(client);
    identities = new PrismaIdentityRepository(platform, tenantTransactions);
    tenants = new PrismaTenantRepository(platform);
  });

  afterAll(async () => {
    await db.stop();
  });

  beforeEach(async () => {
    await db.admin(
      `UPDATE users SET external_subject = NULL WHERE id = '${RAFAEL}'; UPDATE tenant_memberships SET last_access_at = NULL`,
    );
  });

  it('[Validação] tenant SUSPENDED exige motivo (CHECK de entities.md)', async () => {
    await expect(
      db.admin(`UPDATE tenants SET suspension_reason = NULL WHERE id = '${B}'`),
    ).rejects.toThrow(/tenants_suspension_reason_required/);
  });

  describe('cf_user_memberships (Lacuna 4 · multi-tenancy.md §6)', () => {
    it('lista os vínculos do próprio usuário em todos os tenants, com nome, status e fuso', async () => {
      const memberships = await identities.listMemberships(ANA);
      expect(memberships).toEqual([
        {
          id: ANA_B,
          tenant: {
            id: B,
            name: 'Prefeitura de Santa Luzia',
            status: 'SUSPENDED',
            timezone: 'America/Manaus',
          },
          type: 'EXTERNAL',
          status: 'ACTIVE',
          expiresAt: expect.any(Date) as Date,
          roleKeys: ['ADMIN_ORGAO'],
        },
        {
          id: ANA_A,
          tenant: {
            id: A,
            name: 'Prefeitura de São José',
            status: 'ACTIVE',
            timezone: 'America/Sao_Paulo',
          },
          type: 'INTERNAL',
          status: 'ACTIVE',
          expiresAt: null,
          roleKeys: ['AUDITOR', 'GESTOR_CONTRATACOES'],
        },
      ]);
    });

    it('[Tenant incorreto] não devolve dados de outro usuário; a tabela segue fechada ao cf_app', async () => {
      const connection = new pg.Client({ connectionString: db.url('cf_app') });
      await connection.connect();
      try {
        await connection.query('BEGIN');
        await connection.query("SELECT set_config('app.user_id', $1, true)", [ANA]);
        const own = await connection.query('SELECT * FROM cf_user_memberships($1)', [ANA]);
        expect(own.rowCount).toBe(2);
        // Pedir os vínculos de outra pessoa com o contexto da Ana não devolve nada.
        const other = await connection.query('SELECT * FROM cf_user_memberships($1)', [BIA]);
        expect(other.rowCount).toBe(0);
        // Colunas mínimas: nada de convite, cargo ou matrícula (perfis só pela chave — spec-531).
        expect(Object.keys(own.rows[0] as object).sort()).toEqual([
          'expires_at',
          'membership_id',
          'membership_status',
          'membership_type',
          'role_keys',
          'tenant_id',
          'tenant_name',
          'tenant_status',
          'tenant_timezone',
        ]);
        await connection.query('ROLLBACK');
        await connection.query('BEGIN');
        await expect(connection.query('SELECT * FROM tenant_memberships')).rejects.toThrow(
          /app\.tenant_id/,
        );
        await connection.query('ROLLBACK');
        // Sem app.user_id, a função não responde a ninguém.
        const anonymous = await connection.query('SELECT * FROM cf_user_memberships($1)', [ANA]);
        expect(anonymous.rowCount).toBe(0);
      } finally {
        await connection.end();
      }
    });

    it('a função pertence ao cf_definer (BYPASSRLS, sem login) e só o cf_app/cf_worker a executam', async () => {
      const [fn] = await db.admin<{ owner: string; definer: boolean; config: string[] }>(`
        SELECT pg_get_userbyid(proowner) AS owner, prosecdef AS definer, proconfig AS config
          FROM pg_proc WHERE proname = 'cf_user_memberships'`);
      expect(fn).toEqual({
        owner: 'cf_definer',
        definer: true,
        config: ['search_path=pg_catalog, public'],
      });
      const grants = await db.admin<{ role: string; allowed: boolean }>(`
        SELECT r AS role, has_function_privilege(r, 'cf_user_memberships(uuid)', 'EXECUTE') AS allowed
          FROM unnest(ARRAY['cf_app','cf_worker','cf_relay','cf_readonly_report']) AS r ORDER BY r`);
      expect(grants).toEqual([
        { role: 'cf_app', allowed: true },
        { role: 'cf_readonly_report', allowed: false },
        { role: 'cf_relay', allowed: false },
        { role: 'cf_worker', allowed: true },
      ]);
    });
  });

  describe('chaves de perfil do vínculo derivadas das atribuições (spec-531)', () => {
    const inTenant = <T>(tenantId: string, work: (tx: TenantTx) => Promise<T>) =>
      asTenant(tenantId, () => tenantTransactions.read(work));

    it('[Sucesso] só atribuições vigentes de perfil ativo: revogada, vencida, futura e de perfil inativo não contam', async () => {
      expect((await identities.findByUserAndTenant(ANA, A))?.roleKeys).toEqual([
        'AUDITOR',
        'GESTOR_CONTRATACOES',
      ]);
      const [member] = await inTenant(A, (tx) => identities.membersInTenant(tx, [ANA]));
      expect(member).toMatchObject({
        membershipId: ANA_A,
        roleKeys: ['AUDITOR', 'GESTOR_CONTRATACOES'],
      });
      const matches = await inTenant(A, (tx) =>
        identities.searchActiveMembers(tx, 'ribeiro', 10, new Date()),
      );
      expect(matches).toEqual([
        {
          userId: ANA,
          membershipId: ANA_A,
          name: 'Ana Ribeiro',
          roleKeys: ['AUDITOR', 'GESTOR_CONTRATACOES'],
        },
      ]);
      // Vínculo sem nenhuma atribuição: lista vazia (a ponte por chave fica só no modo fake).
      const [rafael] = await inTenant(A, (tx) => identities.membersInTenant(tx, [RAFAEL]));
      expect(rafael?.roleKeys).toEqual([]);
    });

    it('[Tenant incorreto] as chaves nunca vêm de outro tenant: cada vínculo só com as próprias', async () => {
      // ADMIN_ORGAO existe nos dois tenants, mas Ana só o tem atribuído em B.
      expect((await identities.findByUserAndTenant(ANA, B))?.roleKeys).toEqual(['ADMIN_ORGAO']);
      expect((await identities.findByUserAndTenant(ANA, A))?.roleKeys).not.toContain('ADMIN_ORGAO');
      const [inB] = await inTenant(B, (tx) => identities.membersInTenant(tx, [ANA]));
      expect(inB).toMatchObject({ membershipId: ANA_B, roleKeys: ['ADMIN_ORGAO'] });
      const [inA] = await inTenant(A, (tx) => identities.membersInTenant(tx, [ANA]));
      expect(inA?.roleKeys).not.toContain('ADMIN_ORGAO');
    });

    it('[Estado inválido] revogar a atribuição ou inativar o perfil tira a chave na leitura seguinte', async () => {
      try {
        await db.admin(
          `UPDATE roles SET is_active = false WHERE id = '${ROLE_GESTOR_A}';
           UPDATE role_assignments SET revoked_at = now(), revoked_by_id = '${ANA}'
            WHERE id = '${RA_ADMIN_B}'`,
        );
        expect((await identities.findByUserAndTenant(ANA, A))?.roleKeys).toEqual(['AUDITOR']);
        expect((await identities.findByUserAndTenant(ANA, B))?.roleKeys).toEqual([]);
      } finally {
        await db.admin(
          `UPDATE roles SET is_active = true WHERE id = '${ROLE_GESTOR_A}';
           UPDATE role_assignments SET revoked_at = NULL, revoked_by_id = NULL
            WHERE id = '${RA_ADMIN_B}'`,
        );
      }
    });

    it('o dono da função lê só as colunas de vigência das atribuições e de chave/status dos perfis', async () => {
      const columns = await db.admin<{ table_name: string; column_name: string }>(`
        SELECT table_name, column_name FROM information_schema.column_privileges
         WHERE grantee = 'cf_definer' AND privilege_type = 'SELECT'
           AND table_name IN ('role_assignments', 'roles')
         ORDER BY table_name, column_name`);
      expect(columns).toEqual([
        { table_name: 'role_assignments', column_name: 'membership_id' },
        { table_name: 'role_assignments', column_name: 'revoked_at' },
        { table_name: 'role_assignments', column_name: 'role_id' },
        { table_name: 'role_assignments', column_name: 'tenant_id' },
        { table_name: 'role_assignments', column_name: 'valid_from' },
        { table_name: 'role_assignments', column_name: 'valid_until' },
        { table_name: 'roles', column_name: 'id' },
        { table_name: 'roles', column_name: 'is_active' },
        { table_name: 'roles', column_name: 'key' },
        { table_name: 'roles', column_name: 'tenant_id' },
      ]);
    });
  });

  describe('troca de instituição ativa (US-093)', () => {
    function switchCommand() {
      const tenantSwitched = vi.fn<SessionAuditPort['tenantSwitched']>(() => Promise.resolve());
      const audit: SessionAuditPort = {
        sessionStarted: () => Promise.resolve(),
        tenantSwitched,
        sessionEnded: () => Promise.resolve('recorded'),
      };
      const command = new RecordSessionTenantCommand(
        identities,
        audit,
        new InMemoryTenantMfaPolicy(),
        () => new Date(),
      );
      const execute = () =>
        asTenant(null, () =>
          command.execute({
            subject: SUB_ANA,
            tenantId: null,
            membershipId: ANA_B,
            kind: 'switch',
            selection: 'MANUAL',
            firstLogin: false,
            fromTenantId: A,
            setAsDefault: true,
            amr: ['pwd'],
            sessionIdHash: 'd'.repeat(64),
            ip: null,
            userAgent: null,
          }),
        );
      return { execute, tenantSwitched };
    }

    it('revalida no banco o status da instituição e do vínculo a cada troca (RN-IAM-65/68)', async () => {
      const { execute, tenantSwitched } = switchCommand();
      try {
        // Prefeitura de Santa Luzia suspensa pela plataforma.
        await expect(execute()).rejects.toMatchObject({ code: 'TENANT_SUSPENDED' });
        await db.admin(
          `UPDATE tenants SET status = 'ACTIVE', suspension_reason = NULL WHERE id = '${B}'`,
        );
        await expect(execute()).resolves.toMatchObject({
          outcome: 'activated',
          membership: { id: ANA_B, tenant: { id: B } },
          defaultTenantId: B,
        });
        expect(tenantSwitched).toHaveBeenCalledOnce();
        await db.admin(`UPDATE tenant_memberships SET status = 'SUSPENDED' WHERE id = '${ANA_B}'`);
        await expect(execute()).rejects.toMatchObject({ code: 'MEMBERSHIP_INACTIVE' });
      } finally {
        await db.admin(
          `UPDATE tenants SET status = 'SUSPENDED', suspension_reason = 'teste' WHERE id = '${B}';
           UPDATE tenant_memberships SET status = 'ACTIVE' WHERE id = '${ANA_B}';
           UPDATE users SET preferences = '{}' WHERE id = '${ANA}'`,
        );
      }
    });

    it('"Usar como padrão" grava só preferences.defaultTenantId, sem tocar as demais nem a versão', async () => {
      await db.admin(`UPDATE users SET preferences = '{"theme":"dark"}' WHERE id = '${ANA}'`);
      try {
        await identities.setDefaultTenant(ANA, B);
        const [row] = await db.admin<{ preferences: unknown; version: number }>(
          `SELECT preferences, version FROM users WHERE id = '${ANA}'`,
        );
        expect(row?.preferences).toEqual({ theme: 'dark', defaultTenantId: B });
        expect(row?.version).toBe(1);
        expect((await identities.findUserBySubject(SUB_ANA))?.preferences).toEqual({
          theme: 'dark',
          defaultTenantId: B,
        });
      } finally {
        await db.admin(`UPDATE users SET preferences = '{}' WHERE id = '${ANA}'`);
      }
    });
  });

  describe('pipeline de guards (UserPort, MembershipPort, TenantStatusPort)', () => {
    it('resolve o usuário pelo sub e o vínculo no tenant do cabeçalho', async () => {
      expect(await identities.findByExternalSubject(SUB_ANA)).toEqual({
        id: ANA,
        status: 'ACTIVE',
        displayName: 'Ana Ribeiro',
      });
      expect(await identities.findByExternalSubject('desconhecido')).toBeNull();
      expect(await asTenant(null, () => identities.findByUserAndTenant(ANA, A))).toEqual({
        id: ANA_A,
        userId: ANA,
        tenantId: A,
        status: 'ACTIVE',
        expiresAt: null,
        roleKeys: ['AUDITOR', 'GESTOR_CONTRATACOES'],
      });
      expect(await identities.findByUserAndTenant(BIA, A)).toBeNull();
      expect(await tenants.findStatus(B)).toBe('SUSPENDED');
      expect(await tenants.findStatus('0192f000-0000-7000-8000-0000000000ff')).toBeNull();
    });

    it('último acesso ao vínculo: grava no tenant em contexto, no máximo 1×/5 min', async () => {
      const at = new Date('2026-10-14T12:00:00Z');
      await asTenant(A, () => identities.touchMembershipAccess(A, ANA_A, at));
      const [first] = await db.admin<{ last_access_at: Date }>(
        `SELECT last_access_at FROM tenant_memberships WHERE id = '${ANA_A}'`,
      );
      expect(first?.last_access_at.toISOString()).toBe(at.toISOString());
      await asTenant(A, () =>
        identities.touchMembershipAccess(A, ANA_A, new Date(at.getTime() + 60_000)),
      );
      const [second] = await db.admin<{ last_access_at: Date; version: number }>(
        `SELECT last_access_at, version FROM tenant_memberships WHERE id = '${ANA_A}'`,
      );
      expect(second?.last_access_at.toISOString()).toBe(at.toISOString());
      // Acesso não é alteração do vínculo.
      expect(second?.version).toBe(1);
    });
  });

  describe('vínculo do sub no primeiro login (RN-IAM-06)', () => {
    it('encontra o convidado pelo authentikUserId ou pelo e-mail (citext), só se ainda sem sub', async () => {
      expect((await identities.findUnboundUserByAuthentikId('42'))?.id).toBe(RAFAEL);
      expect(await identities.findUnboundUserByAuthentikId('11')).toBeNull();
      expect((await identities.findUnboundUserByEmail('bia@santaluzia.gov.br'))?.id).toBe(BIA);
      // Rafael tem authentikUserId: o e-mail não basta.
      expect(await identities.findUnboundUserByEmail('rafael@saojose.sp.gov.br')).toBeNull();
      expect((await identities.findUserById(BIA))?.socialName).toBe('Bia Lima');
    });

    it('[Concorrência] dois primeiros logins simultâneos: o sub é gravado uma única vez', async () => {
      const at = new Date('2026-10-14T12:00:00Z');
      const results = await Promise.all([
        identities.recordLogin(RAFAEL, at, SUB_RAFAEL),
        identities.recordLogin(RAFAEL, at, SUB_RAFAEL),
      ]);
      expect(results.filter((result) => result.kind === 'recorded' && result.bound)).toHaveLength(
        1,
      );
      expect(results.every((result) => result.kind === 'recorded')).toBe(true);
      const [row] = await db.admin<{ external_subject: string; last_login_at: Date }>(
        `SELECT external_subject, last_login_at FROM users WHERE id = '${RAFAEL}'`,
      );
      expect(row?.external_subject).toBe(SUB_RAFAEL);
      expect(row?.last_login_at.toISOString()).toBe(at.toISOString());
      expect((await identities.findUserBySubject(SUB_RAFAEL))?.id).toBe(RAFAEL);
    });

    it('sub já de outra pessoa ou usuário já com outro sub → conflito, nada alterado', async () => {
      const at = new Date('2026-10-14T12:00:00Z');
      expect(await identities.recordLogin(RAFAEL, at, SUB_ANA)).toEqual({
        kind: 'subject_conflict',
      });
      expect(await identities.recordLogin(ANA, at, SUB_RAFAEL)).toEqual({
        kind: 'subject_conflict',
      });
      const [row] = await db.admin<{ external_subject: string | null }>(
        `SELECT external_subject FROM users WHERE id = '${RAFAEL}'`,
      );
      expect(row?.external_subject).toBeNull();
      expect(await identities.recordLogin(ANA, at, null)).toEqual({
        kind: 'recorded',
        bound: false,
      });
    });
  });
});
