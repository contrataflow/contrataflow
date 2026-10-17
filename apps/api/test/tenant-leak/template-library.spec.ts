// Biblioteca padrão de templates sobre PostgreSQL real (US-110 · Sucesso, Tenant incorreto,
// Duplicidade, Falha de banco, Concorrência): seeders reais `document.systemTypes` e
// `document.templateLibrary` em `TenantTransaction` dos tenants A e B (RLS), publicação pela rotina
// do editor (contentHash reprodutível a partir das colunas gravadas), queda do banco a meio da
// etapa sem template parcial (rollback por tipo), reexecução só dos tipos pendentes e corrida de
// duas execuções decidida pelo índice `(tenant_id, document_type_id, lower(name))`.
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import type { TemplateDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { templateContentHash } from '#modules/document/domain/document-template.js';
import { PrismaTemplateRepository } from '#modules/document/infrastructure/prisma-template.repository.js';
import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';
import { runAsSystem } from '#shared/context/request-context.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { TenantSeederRegistry } from '#shared/tenancy/tenant-seeding.js';
import type { TenantSeedResult, TenantSeedStatus } from '#shared/tenancy/tenant-seeding.js';

import { startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';
import {
  createTestApi,
  TEST_ISSUER,
  TEST_SIGNING_KEY,
  testConfig,
} from '../support/api-test-app.js';
import type { TestApi } from '../support/api-test-app.js';

const A = '0192c000-0000-7000-8000-00000001100a';
const B = '0192c000-0000-7000-8000-00000001100b';
const MARTA = '0192c000-0000-7000-8000-0000001100a1';
const BETO = '0192c000-0000-7000-8000-0000001100b1';
const MFA = ['pwd', 'otp'];
const STEP = 'document.templateLibrary';

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [MARTA]: ['ADMIN_ORGAO'],
  [BETO]: ['ADMIN_ORGAO'],
};

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-tpl110', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-tpl110', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${MARTA}', 'sub-marta', 'marta@a.test', true, 'Marta Ribeiro'),
  ('${BETO}', 'sub-beto', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('0192c000-0000-7000-8000-0000001101a1', '${A}', '${MARTA}', 'INTERNAL', 'ACTIVE'),
  ('0192c000-0000-7000-8000-0000001101b1', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
`;

/** Perfis do vínculo por usuário, sobre a `MembershipPort` real (atribuições: US-096). */
class RoleInjectingMembershipPort implements MembershipPort {
  inner!: MembershipPort;

  async findByUserAndTenant(userId: string, tenantId: string): Promise<MembershipRecord | null> {
    const membership = await this.inner.findByUserAndTenant(userId, tenantId);
    return membership ? { ...membership, roleKeys: ROLES[userId] ?? [] } : null;
  }
}

type Row = Readonly<Record<string, unknown>>;

describe('Feature: biblioteca padrão de templates isolada por tenant no PostgreSQL (US-110)', () => {
  let db: TestDatabase;
  let api: TestApi;

  const tenantOf = (subject: string) => (subject === 'sub-beto' ? B : A);
  const as = (test: request.Test, subject: string) =>
    test
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenantOf(subject));

  const seederOf = (key: string) => {
    const seeder = api.app
      .get(TenantSeederRegistry)
      .all()
      .find((candidate) => candidate.key === key);
    if (!seeder) throw new Error(`Seeder ${key} não registrado.`);
    return seeder;
  };
  const ctxOf = (tenantId: string) => ({ tenantId, slug: 'teste', now: new Date(), request: null });
  const seedStep = (tenantId: string, key = STEP): Promise<TenantSeedResult> =>
    runAsSystem({ name: 'Provisionamento de tenant', tenantId }, () =>
      seederOf(key).seed(ctxOf(tenantId)),
    );
  const verifyStep = (tenantId: string): Promise<TenantSeedStatus> =>
    runAsSystem({ name: 'Provisionamento de tenant', tenantId }, () =>
      seederOf(STEP).verify(ctxOf(tenantId)),
    );
  const templateRows = (tenantId: string) =>
    db.admin<Row>(
      `SELECT t.id, t.tenant_id, t.name, t.is_system, t.current_published_version_id, dt.code,
              dt.default_template_id
         FROM document_templates t JOIN document_types dt ON dt.id = t.document_type_id
        WHERE t.tenant_id = $1 ORDER BY dt.sort_order`,
      [tenantId],
    );
  const versionRows = (tenantId: string) =>
    db.admin<Row>(
      `SELECT id, template_id, version_number, status, sections, layout, field_config,
              import_mappings, content_hash
         FROM document_template_versions WHERE tenant_id = $1`,
      [tenantId],
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
    // Background: tenants com os tipos de documento semeados (US-061).
    for (const tenantId of [A, B]) await seedStep(tenantId, 'document.systemTypes');
  });

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Falha de banco] queda a meio da etapa: nenhum template parcial e a etapa fica PENDING', async () => {
    const repository = api.app.get(PrismaTemplateRepository);
    const original = repository.publishVersion.bind(repository);
    let calls = 0;
    // O 7º tipo chega a gravar template e versão antes de a conexão "cair" na publicação.
    const failing = vi.spyOn(repository, 'publishVersion').mockImplementation(async (tx, v, e) => {
      calls += 1;
      await original(tx, v, e);
      if (calls === 7) throw new DatabaseUnavailableError(new Error('conexão perdida'));
    });
    try {
      await expect(seedStep(A)).rejects.toBeInstanceOf(DatabaseUnavailableError);
    } finally {
      failing.mockRestore();
    }

    const rows = await templateRows(A);
    expect(rows).toHaveLength(6);
    expect(rows.every((row) => row.current_published_version_id !== null)).toBe(true);
    // Cada versão gravada pertence a um template que existe (nada do 7º tipo sobrou).
    const versions = await versionRows(A);
    expect(versions).toHaveLength(6);
    expect(await verifyStep(A)).toEqual({ status: 'PENDING', details: { templates: 6 } });
  });

  it('[Duplicidade] a reexecução semeia só os 4 tipos pendentes e não duplica', async () => {
    const before = (await templateRows(A)).map((row) => row.id);

    expect(await seedStep(A)).toEqual({ created: 4, skipped: 6 });
    expect(await seedStep(A)).toEqual({ created: 0, skipped: 10 });

    const rows = await templateRows(A);
    expect(rows).toHaveLength(10);
    expect(rows.map((row) => row.id)).toEqual(expect.arrayContaining(before));
    expect(new Set(rows.map((row) => row.code)).size).toBe(10);
    expect(await verifyStep(A)).toEqual({ status: 'DONE', details: { templates: 10 } });
  });

  it('[Sucesso] 10 templates de sistema com a v1 PUBLISHED, hash reprodutível e padrão do tipo', async () => {
    const rows = await templateRows(A);
    expect(rows.map((row) => row.code)).toEqual([
      'DFD',
      'ETP',
      'TR',
      'RISK_MAP',
      'PRICE_RESEARCH',
      'DESPACHO',
      'OFICIO',
      'NOTA_TECNICA',
      'AUTORIZACAO',
      'DECLARACAO',
    ]);
    for (const row of rows) {
      expect(row.is_system, String(row.code)).toBe(true);
      expect(row.default_template_id, String(row.code)).toBe(row.id);
    }
    const versions = await versionRows(A);
    for (const version of versions) {
      expect(version).toMatchObject({ version_number: 1, status: 'PUBLISHED' });
      expect(
        templateContentHash({
          sections: version.sections as never,
          layout: version.layout as never,
          fieldConfig: version.field_config as never,
          importMappings: version.import_mappings as never,
        }),
      ).toBe(version.content_hash);
    }
    const [external] = await db.admin<Row>(
      "SELECT default_template_id FROM document_types WHERE tenant_id = $1 AND code = 'DOCUMENTO_EXTERNO'",
      [A],
    );
    expect(external?.default_template_id).toBeNull();
    const [events] = await db.admin<{ count: string }>(
      'SELECT count(*) FROM outbox_events WHERE tenant_id = $1',
      [A],
    );
    expect(Number(events?.count)).toBe(0);
  });

  it('[Concorrência] duas execuções simultâneas em B: o índice único decide, sem duplicata', async () => {
    const [first, second] = await Promise.all([seedStep(B), seedStep(B)]);
    expect(first.created + second.created).toBe(10);
    const rows = await templateRows(B);
    expect(rows).toHaveLength(10);
    expect(new Set(rows.map((row) => row.code)).size).toBe(10);
    expect(await versionRows(B)).toHaveLength(10);
  });

  it('[Tenant incorreto] o ETP padrão de B por id → 404 para A; ids e tenantId independentes', async () => {
    const etpOf = async (tenantId: string) =>
      (await templateRows(tenantId)).find((row) => row.code === 'ETP');
    const etpOfA = await etpOf(A);
    const etpOfB = await etpOf(B);
    expect(etpOfA?.id).not.toBe(etpOfB?.id);
    expect([etpOfA?.tenant_id, etpOfB?.tenant_id]).toEqual([A, B]);

    const crossed = await as(
      request(api.server).get(`/api/v1/templates/${String(etpOfB?.id)}`),
      'sub-marta',
    );
    expect(crossed.status).toBe(404);

    const listed = await as(request(api.server).get('/api/v1/templates?pageSize=100'), 'sub-marta');
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    const data = (listed.body as { data: TemplateDto[] }).data;
    expect(data.filter((template) => template.isSystem)).toHaveLength(10);
    expect(data.some((template) => template.id === etpOfB?.id)).toBe(false);
  });
});
