// Importação de cotações por planilha sobre PostgreSQL real (US-028 · Sucesso, Falha de banco,
// Concorrência, Permissão, Tenant incorreto): a API inteira como `cf_app` (RLS) com os seeders reais,
// o processo levado (SQL) à etapa PESQUISA_PRECOS com o Rui (COMPRAS) responsável, a pesquisa pelo
// PRS-02 e as fontes pelo PRS-10. Prova a aplicação numa transação só (cotações, versão das fontes,
// auditoria `price_research.import` sem preços e um único `PriceResearchRecalculated` PENDING com o
// relay fora; falha induzida não deixa nada e o token continua valendo), a edição manual entre a
// prévia e a aplicação, o 404 do tenant B em PRS-18/19/24 e a RLS de `quotations`.
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type {
  PriceItemDto,
  PriceResearchDto,
  PriceSourceDto,
  ProcessDto,
  QuotationImportPreview,
} from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';
import { writeXlsx } from '#shared/spreadsheet/xlsx.js';
import type { XlsxCellValue } from '#shared/spreadsheet/xlsx.js';

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

const A = '0192c028-0000-7000-8000-00000000010a';
const B = '0192c028-0000-7000-8000-00000000010b';
const ORG_A = '0192c028-0000-7000-8000-0000000010a0';
const ORG_B = '0192c028-0000-7000-8000-0000000010b0';
const OBRAS = '0192c028-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c028-0000-7000-8000-0000000010a2';
const OBRAS_B = '0192c028-0000-7000-8000-0000000010b1';
const ANA = '0192c028-0000-7000-8000-0000000010c1';
const RUI = '0192c028-0000-7000-8000-0000000010c2';
const BETO = '0192c028-0000-7000-8000-0000000010c3';
const ANA_M = '0192c028-0000-7000-8000-0000000010d1';
const SUPPLIER_A = '0192c028-0000-7000-8000-0000000010f1';
const NOW = new Date('2026-10-06T15:00:00.000Z');
const MFA = ['pwd', 'otp'];
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PAINEL = 'Painel de Preços';
const XYZ = 'Orçamento Construtora XYZ';

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [RUI]: ['COMPRAS'],
  [BETO]: ['COMPRAS'],
};

const SUBJECTS = { ana: 'sub-ana-us028', rui: 'sub-rui-us028', beto: 'sub-beto-us028' } as const;

const path = (...ids: string[]) => `/${ids.join('/')}/`;
const hash = (seed: string) => seed.repeat(64).slice(0, 64);

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us028', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'santa-luzia-us028', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
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
  ('${ANA}', '${SUBJECTS.ana}', 'ana28@a.test', true, 'Ana Souza'),
  ('${RUI}', '${SUBJECTS.rui}', 'rui28@a.test', true, 'Rui Costa'),
  ('${BETO}', '${SUBJECTS.beto}', 'beto28@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('0192c028-0000-7000-8000-0000000010d2', '${A}', '${RUI}', 'INTERNAL', 'ACTIVE'),
  ('0192c028-0000-7000-8000-0000000010d3', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c028-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true);
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

function sheet(rows: readonly (readonly (string | number | null)[])[]): Buffer {
  return writeXlsx({
    name: 'Cotações',
    rows: rows.map((row) =>
      row.map((value): XlsxCellValue => {
        if (value === null) return null;
        return typeof value === 'number'
          ? { kind: 'number', value: String(value) }
          : { kind: 'text', value };
      }),
    ),
  });
}

const FULL = sheet([
  ['Item', 'Descrição do item', 'Unidade', PAINEL, XYZ],
  [1, 'Cimento CP II 50 kg', 'UN', 150, 148.9],
  [2, 'Areia média', 'M3', 80, 79.5],
  [3, 'Brita 1', 'M3', 45.5, 44.99],
]);

describe('Feature: Importar cotações por planilha sobre PostgreSQL (US-028)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let catalog: {
    contractingType: string;
    origin: string;
    un: string;
    m3: string;
    direct: string;
    site: string;
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

  /** Processo na PESQUISA_PRECOS com 3 itens, a pesquisa de preços (PRS-02) e as 2 fontes. */
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
      ['Brita 1', catalog.m3],
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
    const sources: PriceSourceDto[] = [];
    for (const body of [
      {
        sourceTypeId: catalog.site,
        description: PAINEL,
        url: 'https://paineldeprecos.planejamento.gov.br',
        accessedAt: '2026-09-12T14:32:00Z',
      },
      {
        sourceTypeId: catalog.direct,
        description: XYZ,
        supplierId: SUPPLIER_A,
        quoteDate: '2026-09-30',
        supplierChoiceJustification: 'Fornecedor do ramo com atuação comprovada na região.',
      },
    ]) {
      const source = await call(
        request(api.server).post(`/api/v1/price-research/${research.id}/sources`),
      )
        .set('Idempotency-Key', randomUUID())
        .send(body);
      expect(source.status, JSON.stringify(source.body)).toBe(201);
      sources.push((source.body as { data: PriceSourceDto }).data);
    }
    return { process, research, items, sources };
  };

  const preview = (researchId: string, file: Buffer, subject: string = SUBJECTS.rui) =>
    call(
      request(api.server).post(`/api/v1/price-research/${researchId}/import-preview`),
      subject,
    ).attach('file', file, { filename: 'cotacoes.xlsx', contentType: XLSX });
  const previewOk = async (researchId: string, file: Buffer = FULL) => {
    const response = await preview(researchId, file);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return (response.body as { data: QuotationImportPreview }).data;
  };
  const apply = (researchId: string, previewToken: string, subject: string = SUBJECTS.rui) =>
    call(request(api.server).post(`/api/v1/price-research/${researchId}/import`), subject)
      .set('Idempotency-Key', randomUUID())
      .send({ previewToken });

  /** Tudo o que a aplicação grava (para provar o rollback e o 404). */
  const effects = async (researchId: string, processId: string) => ({
    quotations: await db.admin<Row>(
      `SELECT q.unit_price::text AS unit_price, q.status::text, q.version
         FROM quotations q JOIN price_items i ON i.id = q.price_item_id
         JOIN price_sources s ON s.id = q.price_source_id
        WHERE q.price_research_id = $1 ORDER BY i.sort_order, s.sort_order`,
      [researchId],
    ),
    sources: await db.admin<Row>(
      'SELECT version FROM price_sources WHERE price_research_id = $1 ORDER BY sort_order',
      [researchId],
    ),
    items: await db.admin<Row>(
      'SELECT valid_quotations_count FROM price_items WHERE price_research_id = $1 ORDER BY sort_order',
      [researchId],
    ),
    audit: await db.admin<Row>(
      "SELECT metadata FROM audit_logs WHERE process_id = $1 AND action = 'price_research.import' ORDER BY occurred_at, id",
      [processId],
    ),
    recalculated: await db.admin<Row>(
      "SELECT status::text FROM outbox_events WHERE process_id = $1 AND event_type = 'PriceResearchRecalculated' ORDER BY occurred_at, id",
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
      site: await catalogId(A, 'PRICE_SOURCE_TYPE', 'SITIO_ELETRONICO'),
    };
  });

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso] PRS-18 não grava nada; PRS-19 grava as 6 cotações, a versão das fontes, a auditoria e um único recálculo PENDING', async () => {
    const { process, research } = await background();
    const before = await effects(research.id, process.id);
    const result = await previewOk(research.id);
    expect(result.summary).toMatchObject({ total: 6, valid: 6, errors: 0 });
    expect(await effects(research.id, process.id)).toEqual(before);

    const response = await apply(research.id, result.previewToken);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((response.body as { data: unknown }).data).toEqual({ appliedCount: 6, skippedCount: 0 });
    const after = await effects(research.id, process.id);
    expect(after.quotations).toEqual(
      ['150.0000', '148.9000', '80.0000', '79.5000', '45.5000', '44.9900'].map((price) => ({
        unit_price: price,
        status: 'VALID',
        version: 1,
      })),
    );
    expect(after.sources).toEqual([{ version: 2 }, { version: 2 }]);
    expect(after.items).toEqual([
      { valid_quotations_count: 2 },
      { valid_quotations_count: 2 },
      { valid_quotations_count: 2 },
    ]);
    expect(after.audit).toEqual([
      {
        metadata: expect.objectContaining({
          appliedCount: 6,
          skippedCount: 0,
          fileName: 'cotacoes.xlsx',
        }) as unknown,
      },
    ]);
    // Preço nenhum na auditoria nem no outbox.
    const leaked = await db.admin<Row>(
      `SELECT 'audit' AS origin FROM audit_logs WHERE process_id = $1 AND action = 'price_research.import' AND metadata::text LIKE '%148.9%'
       UNION ALL SELECT 'outbox' FROM outbox_events WHERE process_id = $1 AND payload::text LIKE '%148.9%'`,
      [process.id],
    );
    expect(leaked).toEqual([]);
    expect(after.recalculated).toHaveLength(before.recalculated.length + 1);
    expect(after.recalculated.every((row) => row.status === 'PENDING')).toBe(true);
  });

  it('[Falha de banco] falha induzida ao gravar a auditoria desfaz tudo; o mesmo token aplica depois', async () => {
    const { process, research } = await background();
    const result = await previewOk(research.id);
    const before = await effects(research.id, process.id);
    await db.admin(`
      CREATE FUNCTION test_fail_import_audit() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.action = 'price_research.import' THEN
          RAISE EXCEPTION 'falha induzida no teste';
        END IF;
        RETURN NEW;
      END $fn$;
      CREATE TRIGGER test_fail_import_audit BEFORE INSERT ON audit_logs
        FOR EACH ROW EXECUTE FUNCTION test_fail_import_audit();`);
    try {
      const failed = await apply(research.id, result.previewToken);
      expect(failed.status).toBe(500);
      expect(await effects(research.id, process.id)).toEqual(before);
      expect(before.quotations).toEqual([]);
    } finally {
      await db.admin(
        'DROP TRIGGER test_fail_import_audit ON audit_logs; DROP FUNCTION test_fail_import_audit();',
      );
    }
    const retried = await apply(research.id, result.previewToken);
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect((await effects(research.id, process.id)).quotations).toHaveLength(6);
  });

  it('[Concorrência] edição manual entre a prévia e a aplicação: vale o valor importado; grade e importação simultâneas serializam', async () => {
    const { process, research, items, sources } = await background();
    const [painel] = sources;
    const result = await previewOk(research.id);
    const grid = await call(
      request(api.server).put(`/api/v1/price-sources/${painel?.id ?? ''}/quotations`),
    )
      .set('If-Match', '"1"')
      .send({ items: [{ priceItemId: items[0]?.id, unitPrice: '155.00' }] });
    expect(grid.status, JSON.stringify(grid.body)).toBe(200);
    const before = await effects(research.id, process.id);
    const applied = await apply(research.id, result.previewToken);
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    const after = await effects(research.id, process.id);
    expect(after.quotations[0]).toEqual({ unit_price: '150.0000', status: 'VALID', version: 2 });
    expect(after.recalculated).toHaveLength(before.recalculated.length + 1);

    // Grade (If-Match da fonte) e importação ao mesmo tempo: a trava da pesquisa serializa; se a
    // importação vier antes, a grade recebe 412 (a fonte ganhou versão nova).
    const other = await background();
    const second = await previewOk(other.research.id);
    const [gridResponse, importResponse] = await Promise.all([
      call(
        request(api.server).put(`/api/v1/price-sources/${other.sources[0]?.id ?? ''}/quotations`),
      )
        .set('If-Match', '"1"')
        .send({ items: [{ priceItemId: other.items[0]?.id, unitPrice: '155.00' }] }),
      apply(other.research.id, second.previewToken),
    ]);
    expect(importResponse.status, JSON.stringify(importResponse.body)).toBe(200);
    expect([200, 412]).toContain(gridResponse.status);
    expect((await effects(other.research.id, other.process.id)).quotations).toHaveLength(6);
  });

  it('[Permissão] REQUISITANTE → 403 em PRS-18/19/24 e nada muda', async () => {
    const { process, research } = await background();
    const result = await previewOk(research.id);
    const before = await effects(research.id, process.id);
    for (const response of [
      await preview(research.id, FULL, SUBJECTS.ana),
      await apply(research.id, result.previewToken, SUBJECTS.ana),
      await call(
        request(api.server).get(`/api/v1/price-research/${research.id}/import-template`),
        SUBJECTS.ana,
      ),
    ]) {
      expect(response.status, JSON.stringify(response.body)).toBe(403);
      expect(problemDetailsSchema.parse(response.body).code).toBe('PERMISSION_DENIED');
    }
    expect(await effects(research.id, process.id)).toEqual(before);
  });

  it('[Tenant incorreto] pesquisa e token de A pelo tenant B: 404 sem alterar; RLS de quotations', async () => {
    const { process, research } = await background();
    const result = await previewOk(research.id);
    const before = await effects(research.id, process.id);
    for (const response of [
      await preview(research.id, FULL, SUBJECTS.beto),
      await apply(research.id, result.previewToken, SUBJECTS.beto),
      await call(
        request(api.server).get(`/api/v1/price-research/${research.id}/import-template`),
        SUBJECTS.beto,
      ),
    ]) {
      expect(response.status, JSON.stringify(response.body)).toBe(404);
      expect(problemDetailsSchema.parse(response.body).code).toBe('NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toContain('Construtora');
    }
    expect(await effects(research.id, process.id)).toEqual(before);
    expect((await apply(research.id, result.previewToken)).status).toBe(200);

    // RLS: com `app.tenant_id` de B as cotações importadas em A não são visíveis.
    const client = db.client('cf_app');
    try {
      const visible = await asTenant(B, () =>
        client.$tenantTransaction(
          (tx) =>
            tx.$queryRaw<{ count: bigint }[]>`
              SELECT count(*) AS count FROM quotations WHERE price_research_id = ${research.id}::uuid`,
        ),
      );
      expect(Number(visible[0]?.count)).toBe(0);
    } finally {
      await client.$disconnect();
    }
  });
});
