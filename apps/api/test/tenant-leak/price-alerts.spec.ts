// Alertas e destaques da pesquisa de preços sobre PostgreSQL real (US-030 · Sucesso, FA-01,
// Concorrência, Falha de banco, Falha de integração, Tenant incorreto): a API inteira como `cf_app`
// (RLS) com os seeders reais, o processo levado (SQL) à etapa PESQUISA_PRECOS com o Rui (COMPRAS)
// responsável, a pesquisa pelo PRS-02 e as fontes/grades pelo PRS-10/13. Prova `outlier_flag`/
// `is_expired` nas cotações (sem versão nova — campos do sistema), `alerts` (jsonb) e
// `items_with_alerts_count` gravados na transação do recálculo, `PriceResearchRecalculated` `PENDING`
// com o relay fora, a falha induzida no evento que não deixa nada, a exclusão concorrente com o
// recálculo, o 404 do tenant B e a RLS. `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type {
  PriceItemDto,
  PriceResearchDto,
  PriceSourceDto,
  ProcessDto,
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

const A = '0192c030-0000-7000-8000-00000000010a';
const B = '0192c030-0000-7000-8000-00000000010b';
const ORG_A = '0192c030-0000-7000-8000-0000000010a0';
const ORG_B = '0192c030-0000-7000-8000-0000000010b0';
const OBRAS = '0192c030-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c030-0000-7000-8000-0000000010a2';
const OBRAS_B = '0192c030-0000-7000-8000-0000000010b1';
const ANA = '0192c030-0000-7000-8000-0000000010c1';
const RUI = '0192c030-0000-7000-8000-0000000010c2';
const BETO = '0192c030-0000-7000-8000-0000000010c3';
const ANA_M = '0192c030-0000-7000-8000-0000000010d1';
const SUPPLIER_A = '0192c030-0000-7000-8000-0000000010f1';
const JUSTIFICATION = 'Valor de ata vigente do consórcio regional de saúde';
const NOW = new Date('2026-10-06T15:00:00.000Z');
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [RUI]: ['COMPRAS'],
  [BETO]: ['COMPRAS'],
};

const SUBJECTS = { ana: 'sub-ana-us030', rui: 'sub-rui-us030', beto: 'sub-beto-us030' } as const;

const path = (...ids: string[]) => `/${ids.join('/')}/`;
const hash = (seed: string) => seed.repeat(64).slice(0, 64);

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us030', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'santa-luzia-us030', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
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
  ('${ANA}', '${SUBJECTS.ana}', 'ana30@a.test', true, 'Ana Souza'),
  ('${RUI}', '${SUBJECTS.rui}', 'rui30@a.test', true, 'Rui Costa'),
  ('${BETO}', '${SUBJECTS.beto}', 'beto30@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('0192c030-0000-7000-8000-0000000010d2', '${A}', '${RUI}', 'INTERNAL', 'ACTIVE'),
  ('0192c030-0000-7000-8000-0000000010d3', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c030-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true);
INSERT INTO suppliers (id, tenant_id, document_type, document_number, document_number_hash, legal_name) VALUES
  ('${SUPPLIER_A}', '${A}', 'CNPJ', '11222333000181', '${hash('a')}', 'Construtora XYZ Ltda.');
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

describe('Feature: Sinalizar outliers e alertas de conformidade sobre PostgreSQL (US-030)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let catalog: {
    contractingType: string;
    origin: string;
    un: string;
    m3: string;
    direct: string;
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
  const putGrid = (
    sourceId: string,
    lines: readonly Record<string, unknown>[],
    ifMatch: string,
    subject: string = SUBJECTS.rui,
  ) =>
    call(request(api.server).put(`/api/v1/price-sources/${sourceId}/quotations`), subject)
      .set('If-Match', ifMatch)
      .send({ items: lines });

  const recalculate = (researchId: string, subject: string = SUBJECTS.rui) =>
    call(
      request(api.server).post(`/api/v1/price-research/${researchId}/recalculate`),
      subject,
    ).send({});

  const patchQuotation = (quotationId: string, body: Record<string, unknown>, ifMatch: string) =>
    call(request(api.server).patch(`/api/v1/quotations/${quotationId}`))
      .set('If-Match', ifMatch)
      .send(body);
  const excludeQuotation = (quotationId: string, ifMatch: string) =>
    call(request(api.server).post(`/api/v1/quotations/${quotationId}/exclude`))
      .set('If-Match', ifMatch)
      .send({ exclusionReason: 'INCONSISTENT', exclusionJustification: JUSTIFICATION });

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
    };
  });

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  /** Pesquisa com uma fonte por preço do item 1 (o item 2 fica sem cotação). */
  const withItemPrices = async (
    prices: readonly string[],
    body: (index: number) => Record<string, unknown> = () => ({}),
  ) => {
    const context = await background();
    const [first, second] = context.items;
    if (!first || !second) throw new Error('itens ausentes');
    for (const [index, price] of prices.entries()) {
      const source = await createSource(context.research.id, {
        description: `Orçamento ${words(1)}`,
        ...body(index),
      });
      expect(source.status, JSON.stringify(source.body)).toBe(201);
      const grid = await putGrid(
        (source.body as { data: PriceSourceDto }).data.id,
        [{ priceItemId: first.id, unitPrice: price }],
        '"1"',
      );
      expect(grid.status, JSON.stringify(grid.body)).toBe(200);
    }
    return { ...context, first, second };
  };

  /** O que o recálculo de alertas grava (para provar o rollback e o 404). */
  const effects = async (researchId: string, processId: string) => ({
    quotations: await db.admin<Row>(
      `SELECT unit_price::text, status::text, outlier_flag::text, is_expired, version
         FROM quotations WHERE price_research_id = $1 ORDER BY created_at, id`,
      [researchId],
    ),
    items: await db.admin<Row>(
      `SELECT alerts, valid_quotations_count, version
         FROM price_items WHERE price_research_id = $1 ORDER BY sort_order`,
      [researchId],
    ),
    research: await db.admin<Row>(
      'SELECT items_with_alerts_count, version FROM price_research WHERE id = $1',
      [researchId],
    ),
    audit: await db.admin<Row>(
      `SELECT metadata->>'trigger' AS trigger, metadata->>'alertsChanged' AS alerts_changed
         FROM audit_logs WHERE process_id = $1 AND action = 'price_research.recalculate'
        ORDER BY occurred_at, id`,
      [processId],
    ),
    events: await db.admin<Row>(
      `SELECT status::text FROM outbox_events
        WHERE process_id = $1 AND event_type = 'PriceResearchRecalculated' ORDER BY occurred_at, id`,
      [processId],
    ),
  });

  const codesOf = (row: Row | undefined) =>
    ((row?.alerts ?? []) as { code: string }[]).map((alert) => alert.code);

  it('[Sucesso] destaque e validade nas colunas, alertas no jsonb e o evento PENDING (relay fora)', async () => {
    // A 3ª fonte é um orçamento com mais de 180 dias da data-base (pesquisa direta — RN-PRICE-49).
    const { process, research } = await withItemPrices(['100.00', '100.00', '40.00'], (index) =>
      index === 2 ? { quoteDate: '2026-03-01' } : {},
    );
    const stored = await effects(research.id, process.id);
    expect(
      stored.quotations.map((row) => [row.unit_price, row.outlier_flag, row.is_expired]),
    ).toEqual([
      ['100.0000', 'HIGH', false],
      ['100.0000', 'HIGH', false],
      ['40.0000', 'LOW', true],
    ]);
    // DEC-020: nada é excluído automaticamente.
    expect(stored.quotations.every((row) => row.status === 'VALID')).toBe(true);
    expect(codesOf(stored.items[0])).toEqual(['HIGH_CV', 'HAS_OUTLIERS', 'EXPIRED_QUOTES']);
    expect(codesOf(stored.items[1])).toEqual(['NO_VALID_QUOTES']);
    expect(stored.research[0]).toMatchObject({ items_with_alerts_count: 2 });
    expect(stored.audit.at(-1)).toEqual({ trigger: 'QUOTATION', alerts_changed: 'true' });
    expect(stored.events.length).toBeGreaterThan(0);
    expect(stored.events.every((row) => row.status === 'PENDING')).toBe(true);

    // PRS-20 sem mudança: nada é regravado (versões iguais) e `alertsChanged = false`.
    const recalculated = await recalculate(research.id);
    expect(recalculated.status, JSON.stringify(recalculated.body)).toBe(200);
    const again = await effects(research.id, process.id);
    expect(again.quotations).toEqual(stored.quotations);
    expect(again.items).toEqual(stored.items);
    expect(again.audit.at(-1)).toEqual({ trigger: 'MANUAL', alerts_changed: 'false' });
  });

  it('[Sucesso] FA-01: corrigir a cotação destoante reavalia o destaque das demais sem versão nova delas', async () => {
    const { process, research } = await withItemPrices(['100.00', '100.00', '105.00', '40.00']);
    const before = await effects(research.id, process.id);
    expect(before.quotations.map((row) => row.outlier_flag)).toEqual([
      'NONE',
      'NONE',
      'NONE',
      'LOW',
    ]);
    const [quotation] = await db.admin<{ id: string; version: number }>(
      'SELECT id, version FROM quotations WHERE price_research_id = $1 AND unit_price = 40',
      [research.id],
    );
    if (!quotation) throw new Error('cotação ausente');
    const patched = await patchQuotation(
      quotation.id,
      { unitPrice: '98.00' },
      `"${String(quotation.version)}"`,
    );
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    const after = await effects(research.id, process.id);
    expect(after.quotations.map((row) => row.outlier_flag)).toEqual([
      'NONE',
      'NONE',
      'NONE',
      'NONE',
    ]);
    expect(codesOf(after.items[0])).toEqual([]);
    // Destaque/validade são do sistema: as outras cotações não ganham versão nova.
    expect(after.quotations.slice(0, 3).map((row) => row.version)).toEqual(
      before.quotations.slice(0, 3).map((row) => row.version),
    );
  });

  it('[Concorrência] exclusão concorrente com o recálculo: o estado final considera só as VALID depois da exclusão', async () => {
    const { process, research } = await withItemPrices(['100.00', '100.00', '105.00', '40.00']);
    const [outlier] = await db.admin<{ id: string; version: number }>(
      'SELECT id, version FROM quotations WHERE price_research_id = $1 AND unit_price = 40',
      [research.id],
    );
    if (!outlier) throw new Error('cotação ausente');
    const [recalculated, excluded] = await Promise.all([
      recalculate(research.id),
      excludeQuotation(outlier.id, `"${String(outlier.version)}"`),
    ]);
    expect(recalculated.status, JSON.stringify(recalculated.body)).toBe(200);
    expect(excluded.status, JSON.stringify(excluded.body)).toBe(200);
    const after = await effects(research.id, process.id);
    expect(after.quotations.map((row) => [row.status, row.outlier_flag])).toEqual([
      ['VALID', 'NONE'],
      ['VALID', 'NONE'],
      ['VALID', 'NONE'],
      ['EXCLUDED', 'NONE'],
    ]);
    expect(after.items[0]).toMatchObject({ valid_quotations_count: 3 });
    expect(codesOf(after.items[0])).toEqual([]);
  });

  it('[Falha de banco] falha induzida ao gravar o evento desfaz tudo: destaques e alertas anteriores ficam', async () => {
    const { process, research } = await withItemPrices(['100.00', '100.00', '40.00']);
    const before = await effects(research.id, process.id);
    const [quotation] = await db.admin<{ id: string; version: number }>(
      'SELECT id, version FROM quotations WHERE price_research_id = $1 AND unit_price = 40',
      [research.id],
    );
    if (!quotation) throw new Error('cotação ausente');
    await db.admin(`
      CREATE FUNCTION test_fail_alerts_event() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.event_type = 'PriceResearchRecalculated' THEN
          RAISE EXCEPTION 'falha induzida no teste';
        END IF;
        RETURN NEW;
      END $fn$;
      CREATE TRIGGER test_fail_alerts_event BEFORE INSERT ON outbox_events
        FOR EACH ROW EXECUTE FUNCTION test_fail_alerts_event();`);
    try {
      const failed = await patchQuotation(
        quotation.id,
        { unitPrice: '99.00' },
        `"${String(quotation.version)}"`,
      );
      expect(failed.status).toBe(500);
      expect(await effects(research.id, process.id)).toEqual(before);
    } finally {
      await db.admin(
        'DROP TRIGGER test_fail_alerts_event ON outbox_events; DROP FUNCTION test_fail_alerts_event();',
      );
    }
  });

  it('[Tenant incorreto] pesquisa de A pelo tenant B: 404 sem revelar alertas; RLS nos destaques', async () => {
    const { process, research, first } = await withItemPrices(['100.00', '100.00', '40.00']);
    const before = await effects(research.id, process.id);
    for (const response of [
      await call(
        request(api.server).get(`/api/v1/price-research/${research.id}/items`),
        SUBJECTS.beto,
      ),
      await call(request(api.server).get(`/api/v1/price-research/${research.id}`), SUBJECTS.beto),
      await recalculate(research.id, SUBJECTS.beto),
    ]) {
      expect(response.status, JSON.stringify(response.body)).toBe(404);
      expect(problemDetailsSchema.parse(response.body).code).toBe('NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toMatch(/HAS_OUTLIERS|outlierFlag/);
    }
    expect(await effects(research.id, process.id)).toEqual(before);

    // RLS: com `app.tenant_id` de B as cotações e os itens de A não são alteráveis.
    const client = db.client('cf_app');
    try {
      const [quotations, items] = await asTenant(B, () =>
        client.$tenantTransaction(async (tx) => [
          await tx.$executeRaw`
            UPDATE quotations SET outlier_flag = 'NONE' WHERE price_research_id = ${research.id}::uuid`,
          await tx.$executeRaw`
            UPDATE price_items SET alerts = '[]'::jsonb WHERE id = ${first.id}::uuid`,
        ]),
      );
      expect([quotations, items]).toEqual([0, 0]);
    } finally {
      await client.$disconnect();
    }
    expect(await effects(research.id, process.id)).toEqual(before);
  });
});
