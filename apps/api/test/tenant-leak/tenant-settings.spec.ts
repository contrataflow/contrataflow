// Configurações do tenant na API inteira sobre PostgreSQL real (US-103 · Tenant incorreto,
// Permissão, Duplicidade, Concorrência, Falha de banco, Falha de integração): administradores nos
// tenants A e B, auditoria e outbox reais na mesma transação, RLS de `tenant_settings`, versão por
// chave com concorrência de verdade e o seeder `tenancy.settings` reaplicado a tenant existente.
// Perfis ainda não existem como registro (US-096): o vínculo ganha `roleKeys` por uma porta de teste
// sobre a `MembershipPort` real.
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { problemDetailsSchema, SETTING_DEFINITIONS } from '@contrataflow/validation';
import type { SettingsMapDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { TOKEN_VERIFIER, MEMBERSHIP_PORT } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';

import { ApplyTenantSeedersCommand } from '../../src/modules/tenancy/application/apply-tenant-seeders.command.js';
import { asTenant, startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';
import {
  createTestApi,
  TEST_ISSUER,
  TEST_SIGNING_KEY,
  testConfig,
} from '../support/api-test-app.js';
import type { TestApi } from '../support/api-test-app.js';

const A = '0192c000-0000-7000-8000-00000000103a';
const B = '0192c000-0000-7000-8000-00000000103b';
const MARTA = '0192c000-0000-7000-8000-0000000103a1';
const LUCIA = '0192c000-0000-7000-8000-0000000103a2';
const BETO = '0192c000-0000-7000-8000-0000000103b1';
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [MARTA]: ['ADMIN_ORGAO'],
  [LUCIA]: ['GESTOR_CONTRATACOES'],
  [BETO]: ['ADMIN_ORGAO'],
};

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code) VALUES
  ('${A}', 'prefeitura-a-set', 'Prefeitura A', 'MUNICIPALITY', 'ACTIVE', 'SC'),
  ('${B}', 'prefeitura-b-set', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC');
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${MARTA}', 'sub-marta', 'marta@a.test', true, 'Marta Ribeiro'),
  ('${LUCIA}', 'sub-lucia', 'lucia@a.test', true, 'Lúcia Matos'),
  ('${BETO}', 'sub-beto', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('0192c000-0000-7000-8000-0000000113a1', '${A}', '${MARTA}', 'INTERNAL', 'ACTIVE'),
  ('0192c000-0000-7000-8000-0000000113a2', '${A}', '${LUCIA}', 'INTERNAL', 'ACTIVE'),
  ('0192c000-0000-7000-8000-0000000113b1', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO tenant_settings (id, tenant_id, key, value, version) VALUES
  ('0192c000-0000-7000-8000-0000000123a1', '${A}', 'labels.secretariat', '"Secretaria"', 1),
  ('0192c000-0000-7000-8000-0000000123a2', '${A}', 'security.sessionIdleMinutes', '30', 1),
  ('0192c000-0000-7000-8000-0000000123a3', '${A}', 'deadlines.warnBeforeBusinessDays', '2', 5),
  ('0192c000-0000-7000-8000-0000000123a4', '${A}', 'branding.primaryColor', '"#1D4ED8"', 1),
  ('0192c000-0000-7000-8000-0000000123b1', '${B}', 'branding.primaryColor', '"#000000"', 3),
  ('0192c000-0000-7000-8000-0000000123b2', '${B}', 'labels.secretariat', '"Pasta LEAK-B"', 2);
`;

/** Perfis do vínculo por usuário, sobre a `MembershipPort` real (perfis como registro: US-096). */
class RoleInjectingMembershipPort implements MembershipPort {
  inner!: MembershipPort;

  async findByUserAndTenant(userId: string, tenantId: string): Promise<MembershipRecord | null> {
    const membership = await this.inner.findByUserAndTenant(userId, tenantId);
    return membership ? { ...membership, roleKeys: ROLES[userId] ?? [] } : null;
  }
}

type Row = Readonly<Record<string, unknown>>;

describe('Feature: configurações isoladas por tenant sobre PostgreSQL (US-103)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let dbStopped = false;

  const as = (subject: string, amr: readonly string[] = MFA) => api.bearer(subject, { amr });
  const settingsOf = (tenantId: string) =>
    db.admin<Row>(
      'SELECT key, value, version, created_by_id, updated_by_id FROM tenant_settings WHERE tenant_id = $1 ORDER BY key',
      [tenantId],
    );
  const settingOf = async (tenantId: string, key: string) =>
    (await settingsOf(tenantId)).find((row) => row.key === key);
  const digestOf = async (tenantId: string) => {
    const [row] = await db.admin<{ digest: string }>(
      `SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS digest
         FROM tenant_settings t WHERE tenant_id = $1`,
      [tenantId],
    );
    return row?.digest;
  };
  const events = (tenantId: string) =>
    db.admin<Row>(
      `SELECT tenant_id, event_type, routing_key, status, payload FROM outbox_events
        WHERE tenant_id = $1 AND event_type = 'TenantSettingsChanged' ORDER BY occurred_at`,
      [tenantId],
    );
  const audits = (tenantId: string, action = 'settings.update') =>
    db.admin<Row>(
      `SELECT tenant_id, action, category, result, reason_code, actor_user_id, changes, metadata
         FROM audit_logs WHERE tenant_id = $1 AND action = $2 ORDER BY occurred_at`,
      [tenantId, action],
    );

  const patch = (
    subject: string,
    tenant: string,
    values: Record<string, unknown>,
    expectedVersions: Record<string, number>,
    amr = MFA,
  ) =>
    request(api.server)
      .patch('/api/v1/settings')
      .set('Authorization', as(subject, amr))
      .set('X-Tenant-Id', tenant)
      .send({ values, expectedVersions });
  const get = (subject: string, tenant: string, path = '') =>
    request(api.server)
      .get(`/api/v1/settings${path}`)
      .set('Authorization', as(subject))
      .set('X-Tenant-Id', tenant);

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

  it('[Sucesso] Marta altera o rótulo: versão 2, auditoria settings.update e evento PENDING, só em A', async () => {
    const digestOfB = await digestOf(B);

    const response = await patch(
      'sub-marta',
      A,
      { 'labels.secretariat': 'Diretoria' },
      { 'labels.secretariat': 1 },
    );

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((response.body as { data: SettingsMapDto }).data).toEqual({
      'labels.secretariat': { value: 'Diretoria', version: 2 },
    });
    expect(await settingOf(A, 'labels.secretariat')).toMatchObject({
      value: 'Diretoria',
      version: 2,
      updated_by_id: MARTA,
    });
    expect(await audits(A)).toEqual([
      expect.objectContaining({
        tenant_id: A,
        category: 'CONFIGURATION',
        result: 'SUCCESS',
        actor_user_id: MARTA,
        metadata: { key: 'labels.secretariat', group: 'labels' },
        changes: [{ path: 'labels.secretariat', old: 'Secretaria', new: 'Diretoria' }],
      }),
    ]);
    // [Falha de integração] o relay não roda aqui: o evento fica PENDING até ele voltar.
    expect(await events(A)).toEqual([
      expect.objectContaining({
        tenant_id: A,
        routing_key: 'tenant.settings_changed',
        status: 'PENDING',
        payload: { keys: ['labels.secretariat'] },
      }),
    ]);
    expect(await digestOf(B)).toBe(digestOfB);
    expect(await audits(B)).toHaveLength(0);
  });

  it('[Sucesso] primeira gravação de chave sem linha (versão 0 → 1) e leitura SET-01 com padrão para as ausentes', async () => {
    const before = await get('sub-marta', A);
    const data = (before.body as { data: SettingsMapDto }).data;
    expect(data['uploads.maxFileSizeMb']).toEqual({ value: 50, version: 0 });
    expect(data['deadlines.warnBeforeBusinessDays']).toEqual({ value: 2, version: 5 });
    expect(Object.keys(data)).toHaveLength(SETTING_DEFINITIONS.length);

    const response = await patch(
      'sub-marta',
      A,
      { 'uploads.maxFileSizeMb': 80 },
      {
        'uploads.maxFileSizeMb': 0,
      },
    );

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(await settingOf(A, 'uploads.maxFileSizeMb')).toMatchObject({
      value: 80,
      version: 1,
      created_by_id: MARTA,
    });
  });

  it('[Validação] máscara inválida e chave desconhecida rejeitam o lote inteiro (nada gravado, nenhum evento)', async () => {
    const digestOfA = await digestOf(A);
    const totalEvents = (await events(A)).length;

    const mask = await patch(
      'sub-marta',
      A,
      { 'numbering.process.mask': 'PROC-{seq:4}', 'labels.department': 'Divisão' },
      { 'numbering.process.mask': 0, 'labels.department': 0 },
    );
    expect(mask.status).toBe(422);
    expect(problemDetailsSchema.parse(mask.body).code).toBe('NUMBERING_MASK_INVALID');

    const unknown = await patch(
      'sub-marta',
      A,
      { 'labels.department': 'Divisão', 'nao.existe': 1 },
      { 'labels.department': 0, 'nao.existe': 0 },
    );
    expect(unknown.status).toBe(422);
    expect(problemDetailsSchema.parse(unknown.body).code).toBe('SETTING_KEY_UNKNOWN');

    const missing = await patch('sub-marta', A, { 'labels.department': 'Divisão' }, {});
    expect(missing.status).toBe(428);
    expect(problemDetailsSchema.parse(missing.body).code).toBe('PRECONDITION_REQUIRED');

    expect(await digestOf(A)).toBe(digestOfA);
    expect(await events(A)).toHaveLength(totalEvents);
  });

  it('[Permissão] Lúcia sem SETTINGS_MANAGE: 403 com access.denied; a leitura pública continua liberada', async () => {
    const digestOfA = await digestOf(A);

    const denied = await patch(
      'sub-lucia',
      A,
      { 'labels.secretariat': 'Hack' },
      {
        'labels.secretariat': 2,
      },
    );
    expect(denied.status).toBe(403);
    expect(problemDetailsSchema.parse(denied.body).code).toBe('PERMISSION_DENIED');
    expect((await get('sub-lucia', A)).status).toBe(403);
    expect(await audits(A, 'access.denied')).toEqual([
      expect.objectContaining({
        result: 'DENIED',
        reason_code: 'SETTINGS_MANAGE',
        actor_user_id: LUCIA,
      }),
      expect.objectContaining({ reason_code: 'SETTINGS_MANAGE', actor_user_id: LUCIA }),
    ]);

    const publicRead = await get('sub-lucia', A, '/public');
    expect(publicRead.status, JSON.stringify(publicRead.body)).toBe(200);
    expect((publicRead.body as { data: Record<string, unknown> }).data).toMatchObject({
      'labels.secretariat': 'Diretoria',
    });
    expect(await digestOf(A)).toBe(digestOfA);
  });

  it('[Tenant incorreto] a leitura pública de A não traz valor de B e a RLS esconde as linhas de B', async () => {
    const response = await get('sub-marta', A, '/public');
    expect(JSON.stringify(response.body)).not.toContain('LEAK-B');
    expect((response.body as { data: Record<string, unknown> }).data['branding.primaryColor']).toBe(
      '#1D4ED8',
    );

    const other = await get('sub-beto', B, '/public');
    expect((other.body as { data: Record<string, unknown> }).data).toMatchObject({
      'branding.primaryColor': '#000000',
      'labels.secretariat': 'Pasta LEAK-B',
    });

    // Marta (só A) pedindo o tenant B: o pipeline recusa e nada de B aparece.
    const crossTenant = await get('sub-marta', B);
    expect(crossTenant.status).toBe(403);
    expect(JSON.stringify(crossTenant.body)).not.toContain('LEAK-B');

    // Cliente da aplicação: com `app.tenant_id = A` só as linhas de A existem.
    const app = db.client('cf_app');
    const visible = await asTenant(A, () =>
      app.$tenantTransaction((tx) => tx.tenantSetting.findMany({ select: { tenantId: true } })),
    );
    expect(new Set(visible.map((row) => row.tenantId))).toEqual(new Set([A]));
  });

  it('[Duplicidade] reenvio do mesmo PATCH: aplicado uma vez; o segundo responde 412 VERSION_CONFLICT', async () => {
    const body = { 'security.sessionIdleMinutes': 45 };
    const first = await patch('sub-marta', A, body, { 'security.sessionIdleMinutes': 1 });
    const second = await patch('sub-marta', A, body, { 'security.sessionIdleMinutes': 1 });

    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(second.status).toBe(412);
    expect(problemDetailsSchema.parse(second.body)).toMatchObject({
      code: 'VERSION_CONFLICT',
      currentVersion: 2,
    });
    expect(await settingOf(A, 'security.sessionIdleMinutes')).toMatchObject({
      value: 45,
      version: 2,
    });
    expect(
      (await audits(A)).filter(
        (entry) => (entry.metadata as { key: string }).key === 'security.sessionIdleMinutes',
      ),
    ).toHaveLength(1);
  });

  it('[Concorrência] mesma chave na versão 5 em duas edições: uma aplicada (versão 6), a outra 412 com currentVersion 6', async () => {
    const results = await Promise.all([
      patch(
        'sub-marta',
        A,
        { 'deadlines.warnBeforeBusinessDays': 3 },
        {
          'deadlines.warnBeforeBusinessDays': 5,
        },
      ),
      patch(
        'sub-marta',
        A,
        { 'deadlines.warnBeforeBusinessDays': 4 },
        {
          'deadlines.warnBeforeBusinessDays': 5,
        },
      ),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([200, 412]);
    const loser = results.find((result) => result.status === 412);
    expect(problemDetailsSchema.parse(loser?.body)).toMatchObject({
      code: 'VERSION_CONFLICT',
      currentVersion: 6,
    });
    expect((await settingOf(A, 'deadlines.warnBeforeBusinessDays'))?.version).toBe(6);
    // A edição perdedora não deixou auditoria nem evento próprios (a transação foi desfeita).
    expect(
      (await audits(A)).filter(
        (entry) => (entry.metadata as { key: string }).key === 'deadlines.warnBeforeBusinessDays',
      ),
    ).toHaveLength(1);
  });

  it('[Concorrência] corrida pela primeira gravação de uma chave sem linha: uma 200 e outra 412', async () => {
    const results = await Promise.all([
      patch(
        'sub-marta',
        A,
        { 'priceResearch.minQuotations': 4 },
        { 'priceResearch.minQuotations': 0 },
      ),
      patch(
        'sub-marta',
        A,
        { 'priceResearch.minQuotations': 5 },
        { 'priceResearch.minQuotations': 0 },
      ),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([200, 412]);
    expect(await settingOf(A, 'priceResearch.minQuotations')).toMatchObject({ version: 1 });
    const loser = results.find((result) => result.status === 412);
    expect(problemDetailsSchema.parse(loser?.body)).toMatchObject({ currentVersion: 1 });
  });

  it('[Concorrência] chaves diferentes não se bloqueiam; conflito num lote cancela o lote todo', async () => {
    const both = await Promise.all([
      patch(
        'sub-marta',
        A,
        { 'notifications.emailEnabled': false },
        {
          'notifications.emailEnabled': 0,
        },
      ),
      patch(
        'sub-marta',
        A,
        { 'process.requireInternalCode': true },
        {
          'process.requireInternalCode': 0,
        },
      ),
    ]);
    expect(both.map((result) => result.status)).toEqual([200, 200]);

    const digestOfA = await digestOf(A);
    const batch = await patch(
      'sub-marta',
      A,
      { 'labels.department': 'Lote', 'notifications.emailEnabled': true },
      { 'labels.department': 0, 'notifications.emailEnabled': 7 },
    );
    expect(batch.status).toBe(412);
    expect(problemDetailsSchema.parse(batch.body)).toMatchObject({
      code: 'VERSION_CONFLICT',
      conflicts: [{ key: 'notifications.emailEnabled', currentVersion: 1 }],
    });
    expect(await digestOf(A)).toBe(digestOfA);
  });

  it('[Sucesso] seeder tenancy.settings reaplicado a tenant existente: só as chaves ausentes, valores preservados', async () => {
    const digestOfB = await digestOf(B);
    const before = await settingsOf(A);
    const apply = api.app.get(ApplyTenantSeedersCommand, { strict: false });

    const first = await apply.execute({
      slug: 'prefeitura-a-set',
      seederKey: 'tenancy.settings',
      dryRun: false,
    });

    expect(first).toEqual([
      expect.objectContaining({
        key: 'tenancy.settings',
        result: 'APPLIED',
        created: SETTING_DEFINITIONS.length - before.length,
      }),
    ]);
    const after = await settingsOf(A);
    expect(after).toHaveLength(SETTING_DEFINITIONS.length);
    for (const row of before) {
      expect(after.find((candidate) => candidate.key === row.key)).toMatchObject({
        value: row.value,
        version: row.version,
      });
    }
    expect(after.find((row) => row.key === 'risk.scale')).toMatchObject({ version: 1 });

    const second = await apply.execute({
      slug: 'prefeitura-a-set',
      seederKey: 'tenancy.settings',
      dryRun: false,
    });
    expect(second).toEqual([expect.objectContaining({ result: 'UP_TO_DATE' })]);
    expect(await settingsOf(A)).toHaveLength(SETTING_DEFINITIONS.length);
    expect(await digestOf(B)).toBe(digestOfB);
  });

  it('[Banco] checks de chave, imutabilidade de tenant e chave, e ausência de DELETE para a aplicação', async () => {
    await expect(
      db.admin(
        `INSERT INTO tenant_settings (id, tenant_id, key, value)
         VALUES ('0192c000-0000-7000-8000-0000000124a1', '${A}', 'semponto', '1')`,
      ),
    ).rejects.toThrow(/tenant_settings_key_format/);
    await expect(
      db.admin(
        `INSERT INTO tenant_settings (id, tenant_id, key, value)
         VALUES ('0192c000-0000-7000-8000-0000000124a2', '${A}', 'labels.secretariat', '"duplicada"')`,
      ),
    ).rejects.toThrow(/tenant_settings_tenant_id_key_key/);
    await expect(
      db.admin(
        `UPDATE tenant_settings SET tenant_id = '${B}' WHERE tenant_id = '${A}' AND key = 'labels.secretariat'`,
      ),
    ).rejects.toThrow(/imutáveis|tenant_id/);
    await expect(
      db.admin(
        `UPDATE tenant_settings SET key = 'labels.outra' WHERE tenant_id = '${A}' AND key = 'labels.secretariat'`,
      ),
    ).rejects.toThrow(/imutáveis|key/);

    const app = db.client('cf_app');
    await expect(
      asTenant(A, () => app.$tenantTransaction((tx) => tx.tenantSetting.deleteMany({}))),
    ).rejects.toSatisfy((error: unknown) => /permission denied/i.test(String(error)));
    expect((await settingsOf(A)).length).toBeGreaterThan(0);
  });

  it('[Falha de banco] banco indisponível ao salvar → 503 com Retry-After e nenhuma chave alterada', async () => {
    dbStopped = true;
    await db.container.stop();
    const response = await patch(
      'sub-marta',
      A,
      { 'labels.department': 'Sem banco' },
      {
        'labels.department': 0,
      },
    );
    expect(response.status).toBe(503);
    expect(problemDetailsSchema.parse(response.body).code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(response.headers['retry-after']).toBeDefined();
  });
});
