// Numeração configurável na API inteira sobre PostgreSQL real (US-105 · todas as categorias do
// Gherkin): prévia (SET-04) e salvamento (SET-02) com auditoria e outbox reais, 50 numerações
// simultâneas no mesmo (escopo, ano) sem repetição nem lacuna, rollback que não consome número,
// virada de ano no fuso do tenant, prévia que não disputa o bloqueio da sequência e RLS de
// `number_sequences`. Perfis por uma porta de teste sobre a `MembershipPort` real.
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { problemDetailsSchema } from '@contrataflow/validation';
import type { NumberingPreviewResult } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { TOKEN_VERIFIER, MEMBERSHIP_PORT } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';
import { newId } from '#shared/database/ids.js';

import {
  CATALOG_CLOCK,
  CATALOG_TRANSACTIONS,
} from '../../src/modules/catalog/application/catalog-ports.js';
import type { CatalogTransactions } from '../../src/modules/catalog/application/catalog-ports.js';
import { NumberingFacade } from '../../src/modules/catalog/application/numbering.facade.js';
import type { AssignedNumber } from '../../src/modules/catalog/application/numbering.facade.js';
import { asTenant, startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';
import {
  createTestApi,
  TEST_ISSUER,
  TEST_SIGNING_KEY,
  testConfig,
} from '../support/api-test-app.js';
import type { TestApi } from '../support/api-test-app.js';

const A = '0192c000-0000-7000-8000-00000000105a';
const B = '0192c000-0000-7000-8000-00000000105b';
const PMSJ = '0192c000-0000-7000-8000-0000000105a1';
const SEMED = '0192c000-0000-7000-8000-0000000105a2';
const ORG_B = '0192c000-0000-7000-8000-0000000105b1';
const MARTA = '0192c000-0000-7000-8000-0000000105c1';
const BRUNO = '0192c000-0000-7000-8000-0000000105c2';
const BETO = '0192c000-0000-7000-8000-0000000105c3';
const MFA = ['pwd', 'otp'];
const MASK = 'numbering.process.mask';

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [MARTA]: ['ADMIN_ORGAO'],
  [BRUNO]: ['SOMENTE_LEITURA'],
  [BETO]: ['ADMIN_ORGAO'],
};

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code) VALUES
  ('${A}', 'prefeitura-sao-jose-num', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC'),
  ('${B}', 'prefeitura-b-num', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${PMSJ}', '${A}', 'Prefeitura Municipal', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${SEMED}', '${A}', 'Secretaria de Educação', 'SEMED', '45997418000153', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura B LEAK-B', 'PMB', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${PMSJ}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${MARTA}', 'sub-marta-num', 'marta@a.test', true, 'Marta Ribeiro'),
  ('${BRUNO}', 'sub-bruno-num', 'bruno@a.test', true, 'Bruno Leitão'),
  ('${BETO}', 'sub-beto-num', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('0192c000-0000-7000-8000-0000000105d1', '${A}', '${MARTA}', 'INTERNAL', 'ACTIVE'),
  ('0192c000-0000-7000-8000-0000000105d2', '${A}', '${BRUNO}', 'INTERNAL', 'ACTIVE'),
  ('0192c000-0000-7000-8000-0000000105d3', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO tenant_settings (id, tenant_id, key, value, version) VALUES
  ('0192c000-0000-7000-8000-0000000105e1', '${A}', '${MASK}', '"{seq:4}/{year}"', 1),
  ('0192c000-0000-7000-8000-0000000105e2', '${B}', '${MASK}', '"B-{seq:6}/{year}"', 3);
INSERT INTO number_sequences (id, tenant_id, sequence_key, last_value) VALUES
  ('0192c000-0000-7000-8000-0000000105f1', '${A}', 'PROCESS:*:2026', 11),
  ('0192c000-0000-7000-8000-0000000105f2', '${B}', 'PROCESS:*:2026', 900);
`;

/** Perfis do vínculo por usuário, sobre a `MembershipPort` real. */
class RoleInjectingMembershipPort implements MembershipPort {
  inner!: MembershipPort;

  async findByUserAndTenant(userId: string, tenantId: string): Promise<MembershipRecord | null> {
    const membership = await this.inner.findByUserAndTenant(userId, tenantId);
    return membership ? { ...membership, roleKeys: ROLES[userId] ?? [] } : null;
  }
}

/** Promessa resolvida por fora (segura uma transação aberta no meio do teste). */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type Row = Readonly<Record<string, unknown>>;

describe('Feature: Configurar numeração de processos e documentos sobre PostgreSQL (US-105)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let numbering: NumberingFacade;
  let transactions: CatalogTransactions;
  let dbStopped = false;
  const clock = { now: new Date('2026-10-15T12:00:00.000Z') };

  const as = (subject: string, amr: readonly string[] = MFA) => api.bearer(subject, { amr });
  const lastValueOf = async (tenantId: string, key: string) => {
    const [row] = await db.admin<{ last_value: number }>(
      'SELECT last_value FROM number_sequences WHERE tenant_id = $1 AND sequence_key = $2',
      [tenantId, key],
    );
    return row?.last_value ?? null;
  };
  const sequencesOf = (tenantId: string) =>
    db.admin<Row>(
      'SELECT sequence_key, last_value FROM number_sequences WHERE tenant_id = $1 ORDER BY sequence_key',
      [tenantId],
    );
  const settingOf = async (tenantId: string, key: string) =>
    (
      await db.admin<Row>(
        'SELECT value, version FROM tenant_settings WHERE tenant_id = $1 AND key = $2',
        [tenantId, key],
      )
    )[0];
  const events = (tenantId: string) =>
    db.admin<Row>(
      `SELECT routing_key, status, payload FROM outbox_events
        WHERE tenant_id = $1 AND event_type = 'TenantSettingsChanged' ORDER BY occurred_at`,
      [tenantId],
    );
  const audits = (tenantId: string, action = 'settings.update') =>
    db.admin<Row>(
      `SELECT action, category, result, reason_code, actor_user_id, changes, metadata
         FROM audit_logs WHERE tenant_id = $1 AND action = $2 ORDER BY occurred_at`,
      [tenantId, action],
    );

  const preview = (subject: string, tenant: string, body: Record<string, unknown>) =>
    request(api.server)
      .post('/api/v1/numbering/preview')
      .set('Authorization', as(subject))
      .set('X-Tenant-Id', tenant)
      .send(body);
  const patch = (
    subject: string,
    tenant: string,
    values: Record<string, unknown>,
    expectedVersions: Record<string, number>,
  ) =>
    request(api.server)
      .patch('/api/v1/settings')
      .set('Authorization', as(subject))
      .set('X-Tenant-Id', tenant)
      .send({ values, expectedVersions });
  /** Numera um processo numa transação do tenant (o que a criação de processo fará — US-001). */
  const assignProcess = (tenantId: string, organizationId = PMSJ): Promise<AssignedNumber> =>
    asTenant(tenantId, () =>
      transactions.run((tx) => numbering.assignProcessNumber(tx, { organizationId })),
    );

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
      DATABASE_POOL_SIZE: '20',
    });
    api = await createTestApi({
      config,
      providers: [
        { token: MEMBERSHIP_PORT, value: membership },
        { token: CATALOG_CLOCK, value: () => clock.now },
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
    numbering = api.app.get(NumberingFacade, { strict: false });
    transactions = api.app.get<CatalogTransactions>(CATALOG_TRANSACTIONS, { strict: false });
  });

  afterAll(async () => {
    await api.close();
    if (!dbStopped) await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso] prévia "{seq:4}/{year}" mostra "0012/2026" sem alterar a sequência; salvar audita e publica o evento', async () => {
    const response = await preview('sub-marta-num', A, { mask: '{seq:4}/{year}' });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((response.body as { data: NumberingPreviewResult }).data).toEqual({
      example: '0012/2026',
      nextValue: '12',
    });
    expect(await lastValueOf(A, 'PROCESS:*:2026')).toBe(11);

    const organization = await preview('sub-marta-num', A, {
      mask: '{org}-{seq:4}/{year}',
      scope: 'ORGANIZATION',
    });
    expect((organization.body as { data: NumberingPreviewResult }).data.example).toBe(
      'PMSJ-0001/2026',
    );

    const saved = await patch('sub-marta-num', A, { [MASK]: 'P-{seq:4}/{year}' }, { [MASK]: 1 });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(await settingOf(A, MASK)).toEqual({ value: 'P-{seq:4}/{year}', version: 2 });
    expect(await audits(A)).toEqual([
      expect.objectContaining({
        category: 'CONFIGURATION',
        result: 'SUCCESS',
        actor_user_id: MARTA,
        changes: [{ path: MASK, old: '{seq:4}/{year}', new: 'P-{seq:4}/{year}' }],
      }),
    ]);
    // [Falha de integração] sem relay no teste, o evento fica PENDING no outbox.
    expect(await events(A)).toEqual([
      expect.objectContaining({
        routing_key: 'tenant.settings_changed',
        status: 'PENDING',
        payload: { keys: [MASK] },
      }),
    ]);

    // A máscara salva vale para o próximo número, na sequência do ano.
    expect(await assignProcess(A)).toMatchObject({ number: 12, code: 'P-0012/2026' });
  });

  it('[Validação] máscara "{seq:4}" sem {year}: 422 NUMBERING_MASK_INVALID e nenhuma configuração alterada', async () => {
    const before = await settingOf(A, MASK);
    const totalEvents = (await events(A)).length;

    const response = await patch('sub-marta-num', A, { [MASK]: '{seq:4}' }, { [MASK]: 2 });

    expect(response.status).toBe(422);
    expect(problemDetailsSchema.parse(response.body).code).toBe('NUMBERING_MASK_INVALID');
    expect(await settingOf(A, MASK)).toEqual(before);
    expect(await events(A)).toHaveLength(totalEvents);
    const invalid = await preview('sub-marta-num', A, { mask: '{seq:4}' });
    expect(problemDetailsSchema.parse(invalid.body).code).toBe('NUMBERING_MASK_INVALID');
  });

  it('[Permissão] Bruno (SOMENTE_LEITURA) alterando a máscara ou pedindo a prévia: 403 PERMISSION_DENIED', async () => {
    const before = await settingOf(A, MASK);

    const denied = await patch('sub-bruno-num', A, { [MASK]: 'X{seq:4}/{year}' }, { [MASK]: 2 });
    expect(denied.status).toBe(403);
    expect(problemDetailsSchema.parse(denied.body).code).toBe('PERMISSION_DENIED');
    const deniedPreview = await preview('sub-bruno-num', A, { mask: '{seq:4}/{year}' });
    expect(problemDetailsSchema.parse(deniedPreview.body).code).toBe('PERMISSION_DENIED');

    expect(await audits(A, 'access.denied')).toEqual([
      expect.objectContaining({ reason_code: 'SETTINGS_MANAGE', actor_user_id: BRUNO }),
      expect.objectContaining({ reason_code: 'SETTINGS_MANAGE', actor_user_id: BRUNO }),
    ]);
    expect(await settingOf(A, MASK)).toEqual(before);
  });

  it('[Tenant incorreto] X-Tenant-Id de tenant sem vínculo: 403 MEMBERSHIP_INACTIVE; nada de B é lido nem alterado', async () => {
    const before = await settingOf(B, MASK);

    const crossPatch = await patch(
      'sub-marta-num',
      B,
      { [MASK]: 'H{seq:4}/{year}' },
      { [MASK]: 3 },
    );
    const crossPreview = await preview('sub-marta-num', B, { mask: '{seq:4}/{year}' });

    for (const response of [crossPatch, crossPreview]) {
      expect(response.status).toBe(403);
      expect(problemDetailsSchema.parse(response.body).code).toBe('MEMBERSHIP_INACTIVE');
      // Sem o `correlationId`: o hex aleatório do UUIDv7 pode conter '901' por acaso.
      const { correlationId: _correlationId, ...rest } = response.body as Record<string, unknown>;
      expect(JSON.stringify(rest)).not.toContain('901');
    }
    expect(await settingOf(B, MASK)).toEqual(before);

    // O administrador de B vê a própria sequência; a de A não interfere.
    const ownPreview = await preview('sub-beto-num', B, { mask: '{seq:4}/{year}' });
    expect((ownPreview.body as { data: NumberingPreviewResult }).data.nextValue).toBe('901');
    expect(await assignProcess(B, ORG_B)).toMatchObject({ number: 901, code: 'B-000901/2026' });
    expect(await lastValueOf(A, 'PROCESS:*:2026')).toBe(12);

    // RLS: com `app.tenant_id = A` só as sequências de A existem.
    const app = db.client('cf_app');
    const visible = await asTenant(A, () =>
      app.$tenantTransaction((tx) => tx.numberSequence.findMany({ select: { tenantId: true } })),
    );
    expect(new Set(visible.map((row) => row.tenantId))).toEqual(new Set([A]));
  });

  it('[Duplicidade] reenvio com a mesma Idempotency-Key: 200 com o mesmo resultado e Idempotent-Replayed', async () => {
    const key = newId();
    const send = () =>
      request(api.server)
        .patch('/api/v1/settings')
        .set('Authorization', as('sub-marta-num'))
        .set('X-Tenant-Id', A)
        .set('Idempotency-Key', key)
        .send({ values: { [MASK]: '{seq:4}/{year}' }, expectedVersions: { [MASK]: 2 } });

    const first = await send();
    const again = await send();

    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(again.status).toBe(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body).toEqual(first.body);
    expect(await settingOf(A, MASK)).toEqual({ value: '{seq:4}/{year}', version: 3 });
    expect(
      (await audits(A)).filter((entry) => (entry.metadata as { key: string }).key === MASK),
    ).toHaveLength(2);
  });

  it('[Concorrência] 50 numerações simultâneas no mesmo (escopo, ano) a partir de 0: números 1 a 50, sem repetição nem lacuna', async () => {
    clock.now = new Date('2028-03-10T12:00:00.000Z');
    try {
      const results = await Promise.all(Array.from({ length: 50 }, () => assignProcess(A)));

      const numbers = results.map((result) => result.number).sort((x, y) => x - y);
      expect(numbers).toEqual(Array.from({ length: 50 }, (_, index) => index + 1));
      expect(new Set(results.map((result) => result.code)).size).toBe(50);
      expect(results.every((result) => result.sequenceKey === 'PROCESS:*:2028')).toBe(true);
      expect(await lastValueOf(A, 'PROCESS:*:2028')).toBe(50);
    } finally {
      clock.now = new Date('2026-10-15T12:00:00.000Z');
    }
  });

  it('[Concorrência] FA-03: rollback da transação numerada não consome número', async () => {
    const before = await lastValueOf(A, 'PROCESS:*:2026');

    await expect(
      asTenant(A, () =>
        transactions.run(async (tx) => {
          const assigned = await numbering.assignProcessNumber(tx, { organizationId: PMSJ });
          expect(assigned.number).toBe((before ?? 0) + 1);
          throw new Error('falha ao gravar o processo');
        }),
      ),
    ).rejects.toThrow('falha ao gravar o processo');

    expect(await lastValueOf(A, 'PROCESS:*:2026')).toBe(before);
    expect((await assignProcess(A)).number).toBe((before ?? 0) + 1);
  });

  it('[Concorrência] a prévia não disputa o bloqueio: responde com o valor confirmado enquanto outra numeração está aberta', async () => {
    const committed = (await lastValueOf(A, 'PROCESS:*:2026')) ?? 0;
    const hold = deferred();
    const assigned = deferred();
    const open = asTenant(A, () =>
      transactions.run(async (tx) => {
        await numbering.assignProcessNumber(tx, { organizationId: PMSJ });
        assigned.resolve();
        await hold.promise;
      }),
    );
    await assigned.promise;
    try {
      const response = await preview('sub-marta-num', A, { mask: '{seq:4}/{year}' });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect((response.body as { data: NumberingPreviewResult }).data.nextValue).toBe(
        String(committed + 1),
      );
    } finally {
      hold.resolve();
      await open;
    }
    expect(await lastValueOf(A, 'PROCESS:*:2026')).toBe(committed + 1);
  });

  it('[Sucesso] FA-01 e RN-TEN-68: virada de ano no fuso do tenant e escopo novo só no próximo exercício', async () => {
    // Escopo por órgão salvo no meio de 2026: o ano corrente continua na sequência do tenant.
    const saved = await patch(
      'sub-marta-num',
      A,
      { [MASK]: '{org}-{seq:4}/{year}', 'numbering.process.scope': 'ORGANIZATION' },
      { [MASK]: 3, 'numbering.process.scope': 0 },
    );
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const current = (await lastValueOf(A, 'PROCESS:*:2026')) ?? 0;
    expect(await assignProcess(A, SEMED)).toMatchObject({
      sequenceKey: 'PROCESS:*:2026',
      number: current + 1,
      code: `SEMED-${String(current + 1).padStart(4, '0')}/2026`,
    });

    // 31/12/2026 23:59 em São Paulo ainda é 2026; 00:00 de 01/01/2027 abre a sequência do ano novo.
    clock.now = new Date('2027-01-01T02:59:00.000Z');
    try {
      expect((await assignProcess(A, SEMED)).year).toBe(2026);
      clock.now = new Date('2027-01-01T03:00:00.000Z');
      expect(await assignProcess(A, SEMED)).toMatchObject({
        sequenceKey: `PROCESS:${SEMED}:2027`,
        number: 1,
        year: 2027,
        code: 'SEMED-0001/2027',
      });
      expect(await assignProcess(A, PMSJ)).toMatchObject({
        sequenceKey: `PROCESS:${PMSJ}:2027`,
        code: 'PMSJ-0001/2027',
      });
    } finally {
      clock.now = new Date('2026-10-15T12:00:00.000Z');
    }
    expect(await lastValueOf(A, 'PROCESS:*:2026')).toBe(current + 2);
  });

  it('[Sucesso] documentos numeram por tipo e ano no tenant, com a máscara do tipo ou a padrão', async () => {
    const assign = (documentTypeCode: string, typeMask: string | null) =>
      asTenant(A, () =>
        transactions.run((tx) =>
          numbering.assignDocumentNumber(tx, { documentTypeCode, typeMask, organizationId: PMSJ }),
        ),
      );

    expect(await assign('RISK_MAP', 'MR {seq:4}/{year}')).toMatchObject({
      sequenceKey: 'DOCUMENT:RISK_MAP:*:2026',
      code: 'MR 0001/2026',
    });
    expect((await assign('DFD', null)).code).toBe('DFD 0001/2026');
    expect((await assign('DFD', null)).code).toBe('DFD 0002/2026');
    const docPreview = await preview('sub-marta-num', A, {
      mask: '{type} {seq:4}/{year}',
      documentTypeCode: 'DFD',
    });
    expect((docPreview.body as { data: NumberingPreviewResult }).data.example).toBe(
      'DFD 0003/2026',
    );
  });

  it('[Banco] formato da chave, unicidade, valor que não diminui, imutabilidade e ausência de DELETE', async () => {
    await expect(
      db.admin(
        `INSERT INTO number_sequences (id, tenant_id, sequence_key) VALUES ('${newId()}', '${A}', 'PROCESSO-2026')`,
      ),
    ).rejects.toThrow(/number_sequences_key_format/);
    await expect(
      db.admin(
        `INSERT INTO number_sequences (id, tenant_id, sequence_key) VALUES ('${newId()}', '${A}', 'PROCESS:*:2026')`,
      ),
    ).rejects.toThrow(/number_sequences_tenant_id_sequence_key_key/);
    await expect(
      db.admin(
        `UPDATE number_sequences SET last_value = 1 WHERE tenant_id = '${A}' AND sequence_key = 'PROCESS:*:2026'`,
      ),
    ).rejects.toThrow(/não pode diminuir/);
    await expect(
      db.admin(
        `UPDATE number_sequences SET tenant_id = '${B}' WHERE tenant_id = '${A}' AND sequence_key = 'PROCESS:*:2026'`,
      ),
    ).rejects.toThrow(/imutáveis/);

    const app = db.client('cf_app');
    await expect(
      asTenant(A, () => app.$tenantTransaction((tx) => tx.numberSequence.deleteMany({}))),
    ).rejects.toSatisfy((error: unknown) => /permission denied/i.test(String(error)));
    expect((await sequencesOf(A)).length).toBeGreaterThan(0);
  });

  it('[Falha de banco] banco indisponível ao salvar a máscara: 503 com Retry-After', async () => {
    dbStopped = true;
    await db.container.stop();
    const response = await patch('sub-marta-num', A, { [MASK]: 'Z{seq:4}/{year}' }, { [MASK]: 4 });
    expect(response.status).toBe(503);
    expect(problemDetailsSchema.parse(response.body).code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(response.headers['retry-after']).toBeDefined();
  });
});
