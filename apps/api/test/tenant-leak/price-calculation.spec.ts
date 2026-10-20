// Cálculo da pesquisa de preços sobre PostgreSQL real (US-029 · Sucesso, Concorrência, Falha de
// banco, Falha de integração, Permissão, Tenant incorreto): a API inteira como `cf_app` (RLS) com os
// seeders reais, o processo levado (SQL) à etapa PESQUISA_PRECOS com o Rui (COMPRAS) responsável, a
// pesquisa pelo PRS-02 e três fontes/grades pelo PRS-10/13. Prova as estatísticas gravadas nas
// colunas numeric(18,4)/(9,4)/(18,2), o recálculo pelo PRS-04/07/20 numa transação só (auditoria e
// `PriceResearchRecalculated` `PENDING` com o relay fora; falha induzida no evento não deixa nada), a
// trava sob edições simultâneas do item, o 404 do tenant B e a RLS/CHECK do método manual.
// `pnpm --filter @contrataflow/api test:tenant-leak`.
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

const A = '0192c029-0000-7000-8000-00000000010a';
const B = '0192c029-0000-7000-8000-00000000010b';
const ORG_A = '0192c029-0000-7000-8000-0000000010a0';
const ORG_B = '0192c029-0000-7000-8000-0000000010b0';
const OBRAS = '0192c029-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c029-0000-7000-8000-0000000010a2';
const OBRAS_B = '0192c029-0000-7000-8000-0000000010b1';
const ANA = '0192c029-0000-7000-8000-0000000010c1';
const RUI = '0192c029-0000-7000-8000-0000000010c2';
const BETO = '0192c029-0000-7000-8000-0000000010c3';
const ANA_M = '0192c029-0000-7000-8000-0000000010d1';
const SUPPLIER_A = '0192c029-0000-7000-8000-0000000010f1';
const JUSTIFICATION = 'Valor de ata vigente do consórcio regional de saúde';
const NOW = new Date('2026-10-06T15:00:00.000Z');
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [RUI]: ['COMPRAS'],
  [BETO]: ['COMPRAS'],
};

const SUBJECTS = { ana: 'sub-ana-us029', rui: 'sub-rui-us029', beto: 'sub-beto-us029' } as const;

const path = (...ids: string[]) => `/${ids.join('/')}/`;
const hash = (seed: string) => seed.repeat(64).slice(0, 64);

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us029', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'santa-luzia-us029', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
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
  ('${ANA}', '${SUBJECTS.ana}', 'ana29@a.test', true, 'Ana Souza'),
  ('${RUI}', '${SUBJECTS.rui}', 'rui29@a.test', true, 'Rui Costa'),
  ('${BETO}', '${SUBJECTS.beto}', 'beto29@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('0192c029-0000-7000-8000-0000000010d2', '${A}', '${RUI}', 'INTERNAL', 'ACTIVE'),
  ('0192c029-0000-7000-8000-0000000010d3', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c029-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true);
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

describe('Feature: Calcular estatísticas e valor estimado sobre PostgreSQL (US-029)', () => {
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

  const patchItem = (
    itemId: string,
    body: Record<string, unknown>,
    ifMatch: string,
    subject: string = SUBJECTS.rui,
  ) =>
    call(request(api.server).patch(`/api/v1/price-items/${itemId}`), subject)
      .set('If-Match', ifMatch)
      .send(body);
  const recalculate = (researchId: string, subject: string = SUBJECTS.rui) =>
    call(
      request(api.server).post(`/api/v1/price-research/${researchId}/recalculate`),
      subject,
    ).send({});

  /** Pesquisa com três fontes: item 1 = 100, 110, 90 (CV 10); item 2 = 100, 200, 90 (CV > 25). */
  const withQuotations = async () => {
    const context = await background();
    for (const [first, second] of [
      ['100.00', '100.00'],
      ['110.00', '200.00'],
      ['90.00', '90.00'],
    ]) {
      const source = await createSource(context.research.id, {
        description: `Orçamento ${words(1)}`,
      });
      expect(source.status, JSON.stringify(source.body)).toBe(201);
      const grid = await putGrid(
        (source.body as { data: PriceSourceDto }).data.id,
        [
          { priceItemId: context.items[0]?.id, unitPrice: first },
          { priceItemId: context.items[1]?.id, unitPrice: second },
        ],
        '"1"',
      );
      expect(grid.status, JSON.stringify(grid.body)).toBe(200);
    }
    const [first, second] = context.items;
    if (!first || !second) throw new Error('itens ausentes');
    return { ...context, first, second };
  };

  /** O que o cálculo grava (para provar o rollback e o 404). */
  const effects = async (researchId: string, processId: string) => ({
    items: await db.admin<Row>(
      `SELECT valid_quotations_count, mean_price::text, median_price::text, lowest_price::text,
              highest_price::text, std_deviation::text, coefficient_of_variation::text,
              effective_method::text, method_override::text, manual_unit_price::text,
              recommended_unit_price::text, total_price::text, quantity::text, version
         FROM price_items WHERE price_research_id = $1 ORDER BY sort_order`,
      [researchId],
    ),
    research: await db.admin<Row>(
      `SELECT items_count, items_with_alerts_count, total_estimated_value::text,
              default_method::text, unit_price_decimals, version
         FROM price_research WHERE id = $1`,
      [researchId],
    ),
    audit: await db.admin<Row>(
      `SELECT action, metadata->>'trigger' AS trigger FROM audit_logs
        WHERE process_id = $1 AND action IN ('price_research.recalculate', 'price_research.method_change')
        ORDER BY occurred_at, id`,
      [processId],
    ),
    events: await db.admin<Row>(
      `SELECT status::text FROM outbox_events
        WHERE process_id = $1 AND event_type = 'PriceResearchRecalculated' ORDER BY occurred_at, id`,
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
    };
  });

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso] estatísticas nas colunas decimais, PRS-07/04/20 com auditoria e evento PENDING (relay fora)', async () => {
    const { process, research, first } = await withQuotations();
    const stats = await effects(research.id, process.id);
    expect(stats.items).toEqual([
      {
        valid_quotations_count: 3,
        mean_price: '100.0000',
        median_price: '100.0000',
        lowest_price: '90.0000',
        highest_price: '110.0000',
        std_deviation: '10.0000',
        coefficient_of_variation: '10.0000',
        effective_method: 'MEAN',
        method_override: null,
        manual_unit_price: null,
        recommended_unit_price: '100.0000',
        total_price: '1000.00',
        quantity: '10.0000',
        version: expect.any(Number) as number,
      },
      expect.objectContaining({
        effective_method: 'MEDIAN',
        median_price: '100.0000',
        recommended_unit_price: '100.0000',
        total_price: '1000.00',
      }),
    ]);
    expect(stats.research[0]).toMatchObject({ items_count: 2, total_estimated_value: '2000.00' });
    expect(stats.audit.every((row) => row.action === 'price_research.recalculate')).toBe(true);
    expect(stats.events.length).toBeGreaterThan(0);
    expect(stats.events.every((row) => row.status === 'PENDING')).toBe(true);

    // PRS-07: valor manual numa transação (item, auditoria do método, recálculo e evento).
    const version = Number(stats.items[0]?.version);
    const manual = await patchItem(
      first.id,
      { methodOverride: 'MANUAL', manualUnitPrice: '95.50', manualJustification: JUSTIFICATION },
      `"${String(version)}"`,
    );
    expect(manual.status, JSON.stringify(manual.body)).toBe(200);
    expect(manual.headers.etag).toBe(`"${String(version + 1)}"`);
    const afterManual = await effects(research.id, process.id);
    expect(afterManual.items[0]).toMatchObject({
      method_override: 'MANUAL',
      manual_unit_price: '95.5000',
      recommended_unit_price: '95.5000',
      total_price: '955.00',
      version: version + 1,
    });
    expect(afterManual.audit.slice(-2)).toEqual([
      { action: 'price_research.method_change', trigger: null },
      { action: 'price_research.recalculate', trigger: 'ITEM_UPDATE' },
    ]);
    const leaked = await db.admin<Row>(
      `SELECT 'audit' AS origin FROM audit_logs WHERE process_id = $1 AND (changes::text LIKE $2 OR metadata::text LIKE $2)
       UNION ALL SELECT 'outbox' FROM outbox_events WHERE process_id = $1 AND payload::text LIKE $2`,
      [process.id, `%${JUSTIFICATION}%`],
    );
    expect(leaked).toEqual([]);

    // PRS-04: parâmetros de cálculo gravados no cabeçalho e itens recalculados (o manual não muda).
    const header = afterManual.research[0];
    const params = await call(request(api.server).patch(`/api/v1/price-research/${research.id}`))
      .set('If-Match', `"${String(header?.version)}"`)
      .send({ defaultMethod: 'LOWEST', unitPriceDecimals: 4 });
    expect(params.status, JSON.stringify(params.body)).toBe(200);
    const afterParams = await effects(research.id, process.id);
    expect(afterParams.research[0]).toMatchObject({
      default_method: 'LOWEST',
      unit_price_decimals: 4,
      version: Number(header?.version) + 1,
      total_estimated_value: '1855.00',
    });
    expect(afterParams.items.map((row) => row.recommended_unit_price)).toEqual([
      '95.5000',
      '90.0000',
    ]);

    // PRS-20: recálculo sob demanda idempotente (sem mudança nas linhas dos itens).
    const recalculated = await recalculate(research.id);
    expect(recalculated.status, JSON.stringify(recalculated.body)).toBe(200);
    const afterManualRecalc = await effects(research.id, process.id);
    expect(afterManualRecalc.items).toEqual(afterParams.items);
    expect(afterManualRecalc.audit.at(-1)).toEqual({
      action: 'price_research.recalculate',
      trigger: 'MANUAL',
    });
  });

  it('[Concorrência] duas edições simultâneas do item com o mesmo If-Match: uma 200 (versão + 1) e a outra 412', async () => {
    const { process, research, first } = await withQuotations();
    const version = Number((await effects(research.id, process.id)).items[0]?.version);
    const pair = await Promise.all([
      patchItem(first.id, { methodOverride: 'LOWEST' }, `"${String(version)}"`),
      patchItem(first.id, { methodOverride: 'MEDIAN' }, `"${String(version)}"`),
    ]);
    expect(pair.map((response) => response.status).sort()).toEqual([200, 412]);
    const rejected = pair.find((response) => response.status === 412);
    expect(problemDetailsSchema.parse(rejected?.body)).toMatchObject({
      code: 'VERSION_CONFLICT',
      currentVersion: version + 1,
    });
    expect((await effects(research.id, process.id)).items[0]?.version).toBe(version + 1);
  });

  it('[Falha de banco] falha induzida ao gravar o evento do recálculo desfaz tudo: estatísticas anteriores ficam', async () => {
    const { process, research, first } = await withQuotations();
    const before = await effects(research.id, process.id);
    await db.admin(`
      CREATE FUNCTION test_fail_recalculated_event() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.event_type = 'PriceResearchRecalculated' THEN
          RAISE EXCEPTION 'falha induzida no teste';
        END IF;
        RETURN NEW;
      END $fn$;
      CREATE TRIGGER test_fail_recalculated_event BEFORE INSERT ON outbox_events
        FOR EACH ROW EXECUTE FUNCTION test_fail_recalculated_event();`);
    try {
      const failed = await patchItem(
        first.id,
        { quantity: '20' },
        `"${String(before.items[0]?.version)}"`,
      );
      expect(failed.status).toBe(500);
      expect((await recalculate(research.id)).status).toBe(500);
      expect(await effects(research.id, process.id)).toEqual(before);
    } finally {
      await db.admin(
        'DROP TRIGGER test_fail_recalculated_event ON outbox_events; DROP FUNCTION test_fail_recalculated_event();',
      );
    }
  });

  it('[Permissão] REQUISITANTE (só leitura) → 403 em PRS-07 e PRS-20 e nada muda', async () => {
    const { process, research, first } = await withQuotations();
    const before = await effects(research.id, process.id);
    const denied = await patchItem(
      first.id,
      { methodOverride: 'LOWEST' },
      `"${String(before.items[0]?.version)}"`,
      SUBJECTS.ana,
    );
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    expect(problemDetailsSchema.parse(denied.body).code).toBe('PERMISSION_DENIED');
    expect((await recalculate(research.id, SUBJECTS.ana)).status).toBe(403);
    expect(await effects(research.id, process.id)).toEqual(before);
  });

  it('[Tenant incorreto] item de A pelo tenant B: 404 sem ler nem alterar; RLS e CHECK do método manual', async () => {
    const { process, research, first } = await withQuotations();
    const before = await effects(research.id, process.id);
    for (const response of [
      await patchItem(first.id, { methodOverride: 'LOWEST' }, '"1"', SUBJECTS.beto),
      await recalculate(research.id, SUBJECTS.beto),
    ]) {
      expect(response.status, JSON.stringify(response.body)).toBe(404);
      expect(problemDetailsSchema.parse(response.body).code).toBe('NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toContain('100.0000');
    }
    expect(await effects(research.id, process.id)).toEqual(before);

    // RLS: com `app.tenant_id` de B o item de A não é visível nem alterável.
    const client = db.client('cf_app');
    try {
      const updated = await asTenant(B, () =>
        client.$tenantTransaction(
          (tx) => tx.$executeRaw`
            UPDATE price_items SET recommended_unit_price = 1 WHERE id = ${first.id}::uuid`,
        ),
      );
      expect(updated).toBe(0);
    } finally {
      await client.$disconnect();
    }

    // CHECK `price_items_manual`: MANUAL exige valor e justificativa.
    await expect(
      db.admin("UPDATE price_items SET method_override = 'MANUAL' WHERE id = $1", [first.id]),
    ).rejects.toThrow();
  });
});
