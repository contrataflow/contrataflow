// Fontes de pesquisa e cotações sobre PostgreSQL real (US-026 · Sucesso, Tenant incorreto,
// Concorrência, Falha de banco): a API inteira como `cf_app` (RLS) com os seeders reais, o processo
// criado pelo PRC-02 e levado (SQL) à etapa PESQUISA_PRECOS com o Rui (COMPRAS) responsável, a
// pesquisa pelo PRS-02 e os fornecedores por SQL. Prova a fonte e a grade numa transação só (falha
// induzida no meio da grade não deixa cotação, versão nova, auditoria nem evento), a trava da linha
// da pesquisa sob dois PRS-13 com o mesmo `If-Match` (200 + 412), o fornecedor de outro tenant
// (422 sem revelar), o 404 do tenant B em PRS-09..15, o uso do fornecedor (SUP-05 → 409) e a
// RLS/checks/FKs compostas/índice único/cascatas de `price_sources` e `quotations`.
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type {
  PriceItemDto,
  PriceResearchDto,
  PriceSourceDto,
  ProcessDto,
  QuotationDto,
} from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';

import { CATALOG_CLOCK } from '../../src/modules/catalog/application/catalog-ports.js';
import { PRICE_RESEARCH_CLOCK } from '../../src/modules/price-research/application/ports.js';
import { PROCESS_CLOCK } from '../../src/modules/process/application/ports.js';
import { asTenant, startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';
import {
  createTestApi,
  TEST_ISSUER,
  TEST_SIGNING_KEY,
  testConfig,
} from '../support/api-test-app.js';
import type { TestApi } from '../support/api-test-app.js';
import { runTenantSeeders } from '../support/process-fixtures.js';

const A = '0192c026-0000-7000-8000-00000000010a';
const B = '0192c026-0000-7000-8000-00000000010b';
const ORG_A = '0192c026-0000-7000-8000-0000000010a0';
const ORG_B = '0192c026-0000-7000-8000-0000000010b0';
const OBRAS = '0192c026-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c026-0000-7000-8000-0000000010a2';
const OBRAS_B = '0192c026-0000-7000-8000-0000000010b1';
const ANA = '0192c026-0000-7000-8000-0000000010c1';
const RUI = '0192c026-0000-7000-8000-0000000010c2';
const BETO = '0192c026-0000-7000-8000-0000000010c3';
const ANA_M = '0192c026-0000-7000-8000-0000000010d1';
const SUPPLIER_A = '0192c026-0000-7000-8000-0000000010f1';
const SUPPLIER_B = '0192c026-0000-7000-8000-0000000010f2';
const NOW = new Date('2026-10-06T15:00:00.000Z');
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [RUI]: ['COMPRAS'],
  [BETO]: ['COMPRAS'],
};

const SUBJECTS = { ana: 'sub-ana-us026', rui: 'sub-rui-us026', beto: 'sub-beto-us026' } as const;

const path = (...ids: string[]) => `/${ids.join('/')}/`;
const hash = (seed: string) => seed.repeat(64).slice(0, 64);

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us026', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'santa-luzia-us026', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal de São José', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura B LEAK-B', 'PMB', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Obras', '${path(OBRAS)}', 0),
  ('${MANUTENCAO}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Manutenção', '${path(OBRAS, MANUTENCAO)}', 1),
  ('${OBRAS_B}', '${B}', '${ORG_B}', NULL, 'SECRETARIAT', 'Obras LEAK-B', '${path(OBRAS_B)}', 0);
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${ANA}', '${SUBJECTS.ana}', 'ana26@a.test', true, 'Ana Souza'),
  ('${RUI}', '${SUBJECTS.rui}', 'rui26@a.test', true, 'Rui Costa'),
  ('${BETO}', '${SUBJECTS.beto}', 'beto26@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('0192c026-0000-7000-8000-0000000010d2', '${A}', '${RUI}', 'INTERNAL', 'ACTIVE'),
  ('0192c026-0000-7000-8000-0000000010d3', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c026-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true);
INSERT INTO suppliers (id, tenant_id, document_type, document_number, document_number_hash, legal_name) VALUES
  ('${SUPPLIER_A}', '${A}', 'CNPJ', '11222333000181', '${hash('a')}', 'Construtora XYZ Ltda.'),
  ('${SUPPLIER_B}', '${B}', 'CNPJ', '60746948000112', '${hash('b')}', 'Fornecedor X LEAK-B');
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

const words = (count: number) =>
  Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

describe('Feature: Registrar fontes de pesquisa e cotações sobre PostgreSQL (US-026)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let catalog: {
    contractingType: string;
    origin: string;
    un: string;
    m3: string;
    direct: string;
    directB: string;
  };

  const tenantOf = (subject: string): string => (subject === SUBJECTS.beto ? B : A);
  const call = (test: request.Test, subject: string = SUBJECTS.rui) =>
    test
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenantOf(subject));

  const catalogId = async (tenantId: string, type: string, code: string) => {
    const [row] = await db.admin<{ id: string }>(
      'SELECT id FROM catalog_items WHERE tenant_id = $1 AND catalog_type = $2 AND code = $3',
      [tenantId, type, code],
    );
    if (!row) throw new Error(`${type}/${code} ausente`);
    return row.id;
  };

  /** Processo na PESQUISA_PRECOS com 2 itens e a pesquisa de preços criada pelo PRS-02. */
  const background = async () => {
    const response = await call(request(api.server).post('/api/v1/processes'), SUBJECTS.ana)
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Aquisição de materiais ${words(2)}`,
        object: `Aquisição de materiais para a reforma da escola ${words(2)}`,
        contractingTypeId: catalog.contractingType,
        requestingSecretariatId: OBRAS,
        requestingDepartmentId: MANUTENCAO,
        originId: catalog.origin,
        pcaStatus: 'NOT_APPLICABLE',
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const process = (response.body as { data: ProcessDto }).data;
    for (const [description, unit] of [
      ['Cimento CP II 50 kg', catalog.un],
      ['Areia média', catalog.m3],
    ] as const) {
      const item = await call(
        request(api.server).post(`/api/v1/processes/${process.id}/items`),
        SUBJECTS.ana,
      )
        .set('Idempotency-Key', randomUUID())
        .send({ kind: 'GOOD', description, unitOfMeasureId: unit });
      expect(item.status, JSON.stringify(item.body)).toBe(201);
    }
    await db.admin('UPDATE process_items SET reference_quantity = 10 WHERE process_id = $1', [
      process.id,
    ]);
    await db.admin(
      `UPDATE processes p SET status = 'IN_PROGRESS', current_workflow_stage_id = ws.id,
              current_responsible_id = $2
         FROM workflow_stages ws
        WHERE p.id = $1 AND ws.workflow_version_id = p.workflow_version_id
          AND ws.key = 'PESQUISA_PRECOS'`,
      [process.id, RUI],
    );
    const created = await call(
      request(api.server).post(`/api/v1/processes/${process.id}/price-research`),
    )
      .set('Idempotency-Key', randomUUID())
      .send({ referenceDate: '2026-10-06' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const research = (created.body as { data: PriceResearchDto }).data;
    const listed = await call(
      request(api.server).get(`/api/v1/price-research/${research.id}/items`),
    );
    const items = (listed.body as { data: PriceItemDto[] }).data;
    return { process, research, items };
  };

  const createSource = (researchId: string, body: Record<string, unknown> = {}) =>
    call(request(api.server).post(`/api/v1/price-research/${researchId}/sources`))
      .set('Idempotency-Key', randomUUID())
      .send({
        sourceTypeId: catalog.direct,
        description: 'Orçamento Construtora XYZ',
        supplierId: SUPPLIER_A,
        quoteDate: '2026-09-30',
        supplierChoiceJustification: 'Fornecedor do ramo com atuação comprovada na região.',
        ...body,
      });
  const sourceOk = async (researchId: string) => {
    const response = await createSource(researchId);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return (response.body as { data: PriceSourceDto }).data;
  };
  const putGrid = (
    sourceId: string,
    lines: readonly Record<string, unknown>[],
    ifMatch: string,
    subject: string = SUBJECTS.rui,
  ) =>
    call(request(api.server).put(`/api/v1/price-sources/${sourceId}/quotations`), subject)
      .set('If-Match', ifMatch)
      .send({ items: lines });

  /** Tudo o que fontes e cotações gravam na pesquisa (para provar o rollback e o 404). */
  const effects = async (researchId: string, processId: string) => ({
    sources: await db.admin<Row>(
      'SELECT id, supplier_id, quote_date::text, version FROM price_sources WHERE price_research_id = $1 ORDER BY sort_order',
      [researchId],
    ),
    quotations: await db.admin<Row>(
      `SELECT price_item_id, unit_price::text, status::text, is_expired, version
         FROM quotations WHERE price_research_id = $1 ORDER BY created_at, id`,
      [researchId],
    ),
    items: await db.admin<Row>(
      'SELECT valid_quotations_count, alerts FROM price_items WHERE price_research_id = $1 ORDER BY sort_order',
      [researchId],
    ),
    audit: await db.admin<Row>(
      "SELECT action FROM audit_logs WHERE process_id = $1 AND action LIKE 'price_research.%' ORDER BY occurred_at, id",
      [processId],
    ),
    events: await db.admin<Row>(
      "SELECT routing_key, status::text FROM outbox_events WHERE process_id = $1 AND event_type = 'PriceResearchRecalculated' ORDER BY occurred_at, id",
      [processId],
    ),
  });

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    db = await startTestDatabase();
    await db.admin(FIXTURE_SQL);
    const membership = new RoleInjectingMembershipPort();
    const config = testConfig({
      OIDC_FAKE_SIGNING_KEY: '',
      DATABASE_URL: db.url('cf_app'),
      DATABASE_URL_PLATFORM: db.url('cf_platform'),
      DATABASE_POOL_SIZE: '10',
    });
    api = await createTestApi({
      config,
      providers: [
        { token: MEMBERSHIP_PORT, value: membership },
        { token: PROCESS_CLOCK, value: () => NOW },
        { token: CATALOG_CLOCK, value: () => NOW },
        { token: PRICE_RESEARCH_CLOCK, value: () => NOW },
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
    const seeders = [
      'catalog.items',
      'access.defaultRoles',
      'document.systemTypes',
      'document.templateLibrary',
      'workflow.seedWorkflows',
    ];
    await runTenantSeeders(api, A, seeders);
    await runTenantSeeders(api, B, seeders);
    catalog = {
      contractingType: await catalogId(A, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
      origin: await catalogId(A, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
      un: await catalogId(A, 'UNIT_OF_MEASURE', 'UN'),
      m3: await catalogId(A, 'UNIT_OF_MEASURE', 'M3'),
      direct: await catalogId(A, 'PRICE_SOURCE_TYPE', 'PESQUISA_DIRETA_FORNECEDOR'),
      directB: await catalogId(B, 'PRICE_SOURCE_TYPE', 'PESQUISA_DIRETA_FORNECEDOR'),
    };
  });

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso] PRS-10 + PRS-13 na mesma transação: fonte, cotações, contadores, auditoria e PriceResearchRecalculated PENDING; fornecedor em uso', async () => {
    const { process, research, items } = await background();
    const source = await sourceOk(research.id);
    const grid = await putGrid(
      source.id,
      [
        { priceItemId: items[0]?.id, unitPrice: '150.00' },
        { priceItemId: items[1]?.id, unitPrice: '80.00' },
      ],
      '"1"',
    );
    expect(grid.status, JSON.stringify(grid.body)).toBe(200);
    expect(grid.headers.etag).toBe('"2"');
    expect((grid.body as { data: QuotationDto[] }).data).toHaveLength(2);

    const after = await effects(research.id, process.id);
    expect(after.sources).toEqual([
      { id: source.id, supplier_id: SUPPLIER_A, quote_date: '2026-09-30', version: 2 },
    ]);
    expect(after.quotations).toEqual([
      {
        price_item_id: items[0]?.id,
        unit_price: '150.0000',
        status: 'VALID',
        is_expired: false,
        version: 1,
      },
      {
        price_item_id: items[1]?.id,
        unit_price: '80.0000',
        status: 'VALID',
        is_expired: false,
        version: 1,
      },
    ]);
    expect(after.items.map((row) => row.valid_quotations_count)).toEqual([1, 1]);
    // US-029: o motor de recálculo audita `price_research.recalculate` em cada commit.
    expect(after.audit.map((row) => row.action)).toEqual([
      'price_research.source_create',
      'price_research.recalculate',
      'price_research.quotation_create',
      'price_research.quotation_create',
      'price_research.recalculate',
    ]);
    expect(after.events).toEqual([
      { routing_key: 'price_research.recalculated', status: 'PENDING' },
      { routing_key: 'price_research.recalculated', status: 'PENDING' },
    ]);

    // PRS-09 pela API (RLS) e o uso do fornecedor (SUP-05 → 409 SUPPLIER_IN_USE — RN-PRICE-19).
    const listed = await call(
      request(api.server).get(`/api/v1/price-research/${research.id}/sources`),
    );
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect((listed.body as { data: PriceSourceDto[] }).data[0]?.supplier?.legalName).toBe(
      'Construtora XYZ Ltda.',
    );
    const deleteSupplier = await call(
      request(api.server).delete(`/api/v1/suppliers/${SUPPLIER_A}`),
    ).set('If-Match', '"1"');
    expect(deleteSupplier.status, JSON.stringify(deleteSupplier.body)).toBe(409);
    expect(problemDetailsSchema.parse(deleteSupplier.body).code).toBe('SUPPLIER_IN_USE');
  });

  it('[Concorrência] dois PRS-13 com o mesmo If-Match: um 200 (versão 2) e o outro 412 VERSION_CONFLICT', async () => {
    const { research, items } = await background();
    const source = await sourceOk(research.id);
    const responses = await Promise.all([
      putGrid(source.id, [{ priceItemId: items[0]?.id, unitPrice: '150.00' }], '"1"'),
      putGrid(source.id, [{ priceItemId: items[0]?.id, unitPrice: '151.00' }], '"1"'),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 412]);
    const loser = responses.find((response) => response.status === 412);
    expect(problemDetailsSchema.parse(loser?.body).code).toBe('VERSION_CONFLICT');
    const [row] = await db.admin<Row>('SELECT version FROM price_sources WHERE id = $1', [
      source.id,
    ]);
    expect(row).toEqual({ version: 2 });
    expect(
      await db.admin<Row>(
        'SELECT count(*)::int AS count FROM quotations WHERE price_source_id = $1',
        [source.id],
      ),
    ).toEqual([{ count: 1 }]);
  });

  it('[Falha de banco] falha induzida no meio da grade desfaz tudo: nenhuma cotação, versão, auditoria nem evento', async () => {
    const { process, research, items } = await background();
    const source = await sourceOk(research.id);
    const before = await effects(research.id, process.id);
    await db.admin(`
      CREATE FUNCTION test_fail_quotations_insert() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        RAISE EXCEPTION 'falha induzida no teste';
      END $fn$;
      CREATE TRIGGER test_fail_quotations_insert BEFORE INSERT ON quotations
        FOR EACH ROW EXECUTE FUNCTION test_fail_quotations_insert();`);
    try {
      const failed = await putGrid(
        source.id,
        [
          { priceItemId: items[0]?.id, unitPrice: '150.00' },
          { priceItemId: items[1]?.id, unitPrice: '80.00' },
        ],
        '"1"',
      );
      expect(failed.status).toBe(500);
      expect(await effects(research.id, process.id)).toEqual(before);
    } finally {
      await db.admin(
        'DROP TRIGGER test_fail_quotations_insert ON quotations; DROP FUNCTION test_fail_quotations_insert();',
      );
    }
    const retried = await putGrid(
      source.id,
      [{ priceItemId: items[0]?.id, unitPrice: '150.00' }],
      '"1"',
    );
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
  });

  it('[Tenant incorreto] fonte e cotação de A pelo tenant B: 404 sem alterar; fornecedor de B → 422; RLS, checks, FKs compostas, unicidade e cascatas', async () => {
    const { process, research, items } = await background();
    const foreign = await createSource(research.id, { supplierId: SUPPLIER_B });
    expect(foreign.status, JSON.stringify(foreign.body)).toBe(422);
    expect(
      problemDetailsSchema.parse(foreign.body).errors.map((error) => [error.field, error.code]),
    ).toEqual([['supplierId', 'REFERENCE_NOT_FOUND']]);
    const foreignType = await createSource(research.id, { sourceTypeId: catalog.directB });
    expect(
      problemDetailsSchema.parse(foreignType.body).errors.map((error) => [error.field, error.code]),
    ).toEqual([['sourceTypeId', 'REFERENCE_NOT_FOUND']]);

    const source = await sourceOk(research.id);
    const grid = await putGrid(
      source.id,
      [{ priceItemId: items[0]?.id, unitPrice: '10.00' }],
      '"1"',
    );
    const quotationId = (grid.body as { data: QuotationDto[] }).data[0]?.id ?? '';
    const before = await effects(research.id, process.id);

    const asBeto = (test: request.Test) => call(test, SUBJECTS.beto);
    for (const response of [
      await asBeto(request(api.server).get(`/api/v1/price-research/${research.id}/sources`)),
      await asBeto(request(api.server).post(`/api/v1/price-research/${research.id}/sources`))
        .set('Idempotency-Key', randomUUID())
        .send({ sourceTypeId: catalog.directB, description: 'x' }),
      await asBeto(request(api.server).patch(`/api/v1/price-sources/${source.id}`))
        .set('If-Match', '"2"')
        .send({ notes: 'x' }),
      await asBeto(request(api.server).delete(`/api/v1/price-sources/${source.id}`)).set(
        'If-Match',
        '"2"',
      ),
      await putGrid(
        source.id,
        [{ priceItemId: items[0]?.id, unitPrice: '1' }],
        '"2"',
        SUBJECTS.beto,
      ),
      await asBeto(request(api.server).patch(`/api/v1/quotations/${quotationId}`))
        .set('If-Match', '"1"')
        .send({ unitPrice: '1' }),
      await asBeto(request(api.server).delete(`/api/v1/quotations/${quotationId}`)).set(
        'If-Match',
        '"1"',
      ),
    ]) {
      expect(response.status, JSON.stringify(response.body)).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain('Construtora');
    }
    expect(await effects(research.id, process.id)).toEqual(before);

    // RLS: com `app.tenant_id` de B, nenhuma fonte nem cotação de A é visível nem alterável.
    const client = db.client('cf_app');
    try {
      const visible = await asTenant(B, () =>
        client.$tenantTransaction(
          (tx) => tx.$queryRaw<{ count: number }[]>`
            SELECT (SELECT count(*) FROM price_sources WHERE id = ${source.id}::uuid)::int
                 + (SELECT count(*) FROM quotations WHERE price_source_id = ${source.id}::uuid)::int
                   AS count`,
        ),
      );
      expect(visible).toEqual([{ count: 0 }]);
      const updated = await asTenant(B, () =>
        client.$tenantTransaction(
          (tx) => tx.$executeRaw`
            UPDATE quotations SET unit_price = 1 WHERE price_source_id = ${source.id}::uuid`,
        ),
      );
      expect(updated).toBe(0);
    } finally {
      await client.$disconnect();
    }

    const insertQuotation = (overrides: Record<string, string | null> = {}) => {
      const row = {
        tenant_id: A,
        price_item_id: items[0]?.id ?? '',
        unit_price: '1',
        status: 'VALID',
        exclusion_reason: null,
        exclusion_justification: null,
        ...overrides,
      };
      return db.admin(
        `INSERT INTO quotations (id, tenant_id, price_research_id, price_item_id, price_source_id,
                                 unit_price, status, exclusion_reason, exclusion_justification)
         VALUES ($1, $2, $3, $4, $5, $6::numeric, $7::quotation_status, $8::exclusion_reason, $9)`,
        [
          randomUUID(),
          row.tenant_id,
          research.id,
          row.price_item_id,
          source.id,
          row.unit_price,
          row.status,
          row.exclusion_reason,
          row.exclusion_justification,
        ],
      );
    };
    // RN-PRICE-25: única por (item, fonte); CHECKs de preço > 0 e de motivo da exclusão.
    await expect(insertQuotation()).rejects.toThrow();
    await expect(
      insertQuotation({ price_item_id: items[1]?.id ?? '', unit_price: '0' }),
    ).rejects.toThrow();
    await expect(
      insertQuotation({ price_item_id: items[1]?.id ?? '', status: 'EXCLUDED' }),
    ).rejects.toThrow();
    // FK composta: cotação de fonte de A no tenant B é recusada pelo banco.
    await expect(
      insertQuotation({ tenant_id: B, price_item_id: items[1]?.id ?? '' }),
    ).rejects.toThrow();
    // FK composta da fonte: fornecedor de B numa fonte de A; URL sem https.
    await expect(
      db.admin('UPDATE price_sources SET supplier_id = $2 WHERE id = $1', [source.id, SUPPLIER_B]),
    ).rejects.toThrow();
    await expect(
      db.admin("UPDATE price_sources SET url = 'http://exemplo.gov.br' WHERE id = $1", [source.id]),
    ).rejects.toThrow();
    await expect(
      db.admin('UPDATE price_sources SET price_research_id = $2 WHERE id = $1', [
        source.id,
        randomUUID(),
      ]),
    ).rejects.toThrow();

    // Cascatas: remover o item leva a cotação dele; remover a fonte leva as demais (RN-PRICE-29).
    await db.admin(
      `INSERT INTO quotations (id, tenant_id, price_research_id, price_item_id, price_source_id, unit_price)
       VALUES ($1, $2, $3, $4, $5, 5)`,
      [randomUUID(), A, research.id, items[1]?.id, source.id],
    );
    await db.admin('DELETE FROM price_items WHERE id = $1', [items[0]?.id]);
    expect(
      await db.admin<Row>('SELECT price_item_id FROM quotations WHERE price_source_id = $1', [
        source.id,
      ]),
    ).toEqual([{ price_item_id: items[1]?.id }]);
    await db.admin('DELETE FROM price_sources WHERE id = $1', [source.id]);
    expect(
      await db.admin<Row>(
        'SELECT count(*)::int AS count FROM quotations WHERE price_source_id = $1',
        [source.id],
      ),
    ).toEqual([{ count: 0 }]);
  });
});
