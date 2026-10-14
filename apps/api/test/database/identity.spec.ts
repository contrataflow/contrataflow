// Identidade sobre o PostgreSQL real (US-087): `users`, `tenants`, `tenant_memberships`, a função
// `cf_user_memberships` (leitura entre tenants restrita ao próprio usuário), o vínculo do `sub` no
// primeiro login sob concorrência e o último acesso ao vínculo. Testcontainers + migrações reais.
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { PrismaTenantRepository } from '#modules/tenancy/infrastructure/prisma-tenant.repository.js';
import { TenantTransaction } from '#shared/database/database.module.js';
import { PlatformTransaction } from '#shared/database/platform-transaction.js';

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
`;

describe('identidade no PostgreSQL (US-087)', () => {
  let db: TestDatabase;
  let identities: PrismaIdentityRepository;
  let tenants: PrismaTenantRepository;

  beforeAll(async () => {
    db = await startTestDatabase();
    await db.admin(FIXTURE_SQL);
    const client = db.client('cf_app');
    const platform = new PlatformTransaction(client);
    identities = new PrismaIdentityRepository(platform, new TenantTransaction(client));
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
          roleKeys: [],
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
          roleKeys: [],
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
        // Colunas mínimas: nada de convite, cargo ou matrícula.
        expect(Object.keys(own.rows[0] as object).sort()).toEqual([
          'expires_at',
          'membership_id',
          'membership_status',
          'membership_type',
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

  describe('pipeline de guards (UserPort, MembershipPort, TenantStatusPort)', () => {
    it('resolve o usuário pelo sub e o vínculo no tenant do cabeçalho', async () => {
      expect(await identities.findByExternalSubject(SUB_ANA)).toEqual({
        id: ANA,
        status: 'ACTIVE',
      });
      expect(await identities.findByExternalSubject('desconhecido')).toBeNull();
      expect(await asTenant(null, () => identities.findByUserAndTenant(ANA, A))).toEqual({
        id: ANA_A,
        userId: ANA,
        tenantId: A,
        status: 'ACTIVE',
        expiresAt: null,
        roleKeys: [],
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
