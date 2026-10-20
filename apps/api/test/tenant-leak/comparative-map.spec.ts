// Mapa comparativo sobre PostgreSQL real (US-031 · Sucesso, Validação, Permissão, Concorrência,
// Tenant incorreto): a API inteira como `cf_app` (RLS) com os seeders reais, o processo levado (SQL)
// à etapa PESQUISA_PRECOS com o Rui (COMPRAS) responsável, a pesquisa pelo PRS-02 e as fontes/grades
// pelo PRS-10/13. Prova a matriz lida das colunas decimais, a auditoria `price_research.export`
// (categoria EXPORT) gravada no banco, o teto de 500 × 50 nos dois lados (linhas clonadas por SQL),
// a POL-09 no mapa e no XLSX da Ana (vê o processo, sem orçamento sigiloso nem custódia), a leitura
// numa única transação durante exclusões concorrentes (nunca estado parcial) e o 404 do tenant B.
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { comparativeMapSchema, problemDetailsSchema } from '@contrataflow/validation';
import type {
  ComparativeMapDto,
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
import { readXlsx } from '#shared/spreadsheet/xlsx.js';

import { CATALOG_CLOCK } from '../../src/modules/catalog/application/catalog-ports.js';
import { PRICE_RESEARCH_CLOCK } from '../../src/modules/price-research/application/ports.js';
import { PROCESS_CLOCK } from '../../src/modules/process/application/ports.js';
import { startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';
import {
  createTestApi,
  TEST_ISSUER,
  TEST_SIGNING_KEY,
  testConfig,
} from '../support/api-test-app.js';
import type { TestApi } from '../support/api-test-app.js';
import { runTenantSeeders } from '../support/process-fixtures.js';

const A = '0192c031-0000-7000-8000-00000000010a';
const B = '0192c031-0000-7000-8000-00000000010b';
const ORG_A = '0192c031-0000-7000-8000-0000000010a0';
const ORG_B = '0192c031-0000-7000-8000-0000000010b0';
const OBRAS = '0192c031-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c031-0000-7000-8000-0000000010a2';
const OBRAS_B = '0192c031-0000-7000-8000-0000000010b1';
const ANA = '0192c031-0000-7000-8000-0000000010c1';
const RUI = '0192c031-0000-7000-8000-0000000010c2';
const BETO = '0192c031-0000-7000-8000-0000000010c3';
const ANA_M = '0192c031-0000-7000-8000-0000000010d1';
const SUPPLIER_A = '0192c031-0000-7000-8000-0000000010f1';
const JUSTIFICATION = 'Preço incompatível com o praticado no mercado regional.';
const NOW = new Date('2026-10-06T15:00:00.000Z');
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [RUI]: ['COMPRAS'],
  [BETO]: ['COMPRAS'],
};

const SUBJECTS = { ana: 'sub-ana-us031', rui: 'sub-rui-us031', beto: 'sub-beto-us031' } as const;

const path = (...ids: string[]) => `/${ids.join('/')}/`;
const hash = (seed: string) => seed.repeat(64).slice(0, 64);

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us031', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'santa-luzia-us031', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
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
  ('${ANA}', '${SUBJECTS.ana}', 'ana31@a.test', true, 'Ana Souza'),
  ('${RUI}', '${SUBJECTS.rui}', 'rui31@a.test', true, 'Rui Costa'),
  ('${BETO}', '${SUBJECTS.beto}', 'beto31@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('0192c031-0000-7000-8000-0000000010d2', '${A}', '${RUI}', 'INTERNAL', 'ACTIVE'),
  ('0192c031-0000-7000-8000-0000000010d3', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c031-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true);
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

const words = (count: number) =>
  Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

/** Corpo binário (XLSX) ou JSON (problema). */
function binary(
  response: request.Response,
  callback: (error: Error | null, body: unknown) => void,
) {
  const chunks: Buffer[] = [];
  response.on('data', (chunk: Buffer) => chunks.push(chunk));
  response.on('end', () => {
    const buffer = Buffer.concat(chunks);
    const type = response.headers['content-type'] ?? '';
    callback(
      null,
      type.includes('json') ? (JSON.parse(buffer.toString('utf8')) as unknown) : buffer,
    );
  });
}

function sheet(buffer: Buffer): string[][] {
  return readXlsx(buffer, { maxRows: 10_000, maxColumns: 200 }).map((row) => {
    const width = Math.max(-1, ...row.cells.keys()) + 1;
    return Array.from({ length: width }, (_, index) => row.cells.get(index)?.text ?? '');
  });
}

describe('Feature: Visualizar e exportar o mapa comparativo sobre PostgreSQL (US-031)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let catalog: { contractingType: string; origin: string; un: string; m3: string; direct: string };

  const tenantOf = (subject: string): string => (subject === SUBJECTS.beto ? B : A);
  const call = (test: request.Test, subject: string = SUBJECTS.rui) =>
    test
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenantOf(subject));
  const getMap = (researchId: string, subject: string = SUBJECTS.rui) =>
    call(request(api.server).get(`/api/v1/price-research/${researchId}/comparative-map`), subject);
  const exportMap = (researchId: string, subject: string = SUBJECTS.rui) =>
    call(
      request(api.server).get(
        `/api/v1/price-research/${researchId}/comparative-map/export?format=xlsx`,
      ),
      subject,
    )
      .buffer(true)
      .parse(binary);
  const mapOf = async (researchId: string, subject: string = SUBJECTS.rui) => {
    const response = await getMap(researchId, subject);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return comparativeMapSchema.parse((response.body as { data: ComparativeMapDto }).data);
  };
  const exportAudit = (processId: string) =>
    db.admin<{ category: string; result: string; metadata: Record<string, unknown> }>(
      `SELECT category::text, result::text, metadata FROM audit_logs
        WHERE process_id = $1 AND action = 'price_research.export' ORDER BY occurred_at, id`,
      [processId],
    );

  const catalogId = async (tenantId: string, type: string, code: string) => {
    const [row] = await db.admin<{ id: string }>(
      'SELECT id FROM catalog_items WHERE tenant_id = $1 AND catalog_type = $2 AND code = $3',
      [tenantId, type, code],
    );
    if (!row) throw new Error(`${type}/${code} ausente`);
    return row.id;
  };

  /** Processo na PESQUISA_PRECOS com 2 itens, a pesquisa e 2 fontes com preços dos 2 itens. */
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
    const sources: PriceSourceDto[] = [];
    for (const [index, prices] of [
      ['100.00', '50.00'],
      ['120.00', '55.00'],
      ['110.00', '52.00'],
    ].entries()) {
      const source = await call(
        request(api.server).post(`/api/v1/price-research/${research.id}/sources`),
      )
        .set('Idempotency-Key', randomUUID())
        .send({
          sourceTypeId: catalog.direct,
          description: `Orçamento ${String(index + 1)}`,
          supplierId: SUPPLIER_A,
          quoteDate: '2026-09-30',
          supplierChoiceJustification: 'Fornecedor do ramo com atuação comprovada na região.',
        });
      expect(source.status, JSON.stringify(source.body)).toBe(201);
      const created = (source.body as { data: PriceSourceDto }).data;
      const grid = await call(
        request(api.server).put(`/api/v1/price-sources/${created.id}/quotations`),
      )
        .set('If-Match', '"1"')
        .send({
          items: items.map((item, row) => ({ priceItemId: item.id, unitPrice: prices[row] })),
        });
      expect(grid.status, JSON.stringify(grid.body)).toBe(200);
      sources.push(created);
    }
    return { process, research, items, sources };
  };

  /** Clona linhas por SQL até `totalItems` itens e `totalSources` fontes (sem cotações novas). */
  const inflate = async (researchId: string, totalItems: number, totalSources: number) => {
    const [counts] = await db.admin<{ items: number; sources: number }>(
      `SELECT (SELECT count(*)::int FROM price_items WHERE price_research_id = $1) AS items,
              (SELECT count(*)::int FROM price_sources WHERE price_research_id = $1) AS sources`,
      [researchId],
    );
    const extraItems = totalItems - (counts?.items ?? 0);
    const extraSources = totalSources - (counts?.sources ?? 0);
    const [base] = await db.admin<{ id: string; process_item_id: string; process_id: string }>(
      `SELECT p.id, p.process_item_id, pi.process_id
         FROM price_items p JOIN process_items pi ON pi.id = p.process_item_id
        WHERE p.price_research_id = $1 ORDER BY p.sort_order LIMIT 1`,
      [researchId],
    );
    if (!base) throw new Error('item ausente');
    if (extraItems > 0) {
      await db.admin(
        `INSERT INTO process_items
         SELECT (jsonb_populate_record(NULL::process_items, to_jsonb(pi) || jsonb_build_object(
                   'id', gen_random_uuid(), 'sequence', top.v + g))).*
           FROM process_items pi,
                (SELECT max(sequence) AS v FROM process_items WHERE process_id = $1) top,
                generate_series(1, $3::int) g
          WHERE pi.id = $2`,
        [base.process_id, base.process_item_id, extraItems],
      );
      await db.admin(
        `INSERT INTO price_items
         SELECT (jsonb_populate_record(NULL::price_items, to_jsonb(p) || jsonb_build_object(
                   'id', gen_random_uuid(), 'process_item_id', pi.id, 'sort_order', pi.sequence))).*
           FROM price_items p, process_items pi
          WHERE p.id = $1 AND pi.process_id = $2
            AND NOT EXISTS (SELECT 1 FROM price_items x
                             WHERE x.price_research_id = $3 AND x.process_item_id = pi.id)`,
        [base.id, base.process_id, researchId],
      );
    }
    if (extraSources > 0) {
      await db.admin(
        `INSERT INTO price_sources
         SELECT (jsonb_populate_record(NULL::price_sources, to_jsonb(s) || jsonb_build_object(
                   'id', gen_random_uuid(), 'description', 'Fonte clonada ' || g,
                   'sort_order', s.sort_order + g))).*
           FROM (SELECT * FROM price_sources WHERE price_research_id = $1
                  ORDER BY sort_order DESC LIMIT 1) s, generate_series(1, $2::int) g`,
        [researchId, extraSources],
      );
    }
  };

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

  it('[Sucesso] matriz das colunas decimais e XLSX com price_research.export (EXPORT) no banco', async () => {
    const { process, research, items, sources } = await background();
    const map = await mapOf(research.id);
    expect(map.items.map((item) => item.id)).toEqual(items.map((item) => item.id));
    expect(map.sources.map((source) => source.id)).toEqual(sources.map((source) => source.id));
    expect(map.cells.map((cell) => cell.unitPrice)).toEqual([
      '100.0000',
      '120.0000',
      '110.0000',
      '50.0000',
      '55.0000',
      '52.0000',
    ]);
    expect(map.items[0]).toMatchObject({
      validQuotationsCount: 3,
      lowestPrice: '100.0000',
      highestPrice: '120.0000',
      medianPrice: '110.0000',
    });

    const response = await exportMap(research.id);
    expect(response.status).toBe(200);
    const rows = sheet(response.body as Buffer);
    expect(rows[1]?.slice(4, 7)).toEqual(['100.0000', '120.0000', '110.0000']);
    expect(await exportAudit(process.id)).toEqual([
      {
        category: 'EXPORT',
        result: 'SUCCESS',
        metadata: expect.objectContaining({
          format: 'xlsx',
          itemsCount: 2,
          sourcesCount: 3,
          masked: false,
        }) as unknown,
      },
    ]);
  });

  it('[Validação] teto nos dois lados: 500 × 50 exporta; 501 itens ou 51 fontes → 422 EXPORT_TOO_LARGE', async () => {
    const { process, research } = await background();
    await inflate(research.id, 500, 50);
    const ok = await exportMap(research.id);
    expect(ok.status).toBe(200);
    const rows = sheet(ok.body as Buffer);
    expect(rows[0]).toHaveLength(4 + 50 + 12);
    expect(rows.slice(1, 501).every((row) => /^\d+$/.test(row[0] ?? ''))).toBe(true);

    await inflate(research.id, 501, 50);
    const items = await exportMap(research.id);
    expect(items.status, JSON.stringify(items.body)).toBe(422);
    expect(problemDetailsSchema.parse(items.body).code).toBe('EXPORT_TOO_LARGE');

    const other = await background();
    await inflate(other.research.id, 2, 51);
    const sources = await exportMap(other.research.id);
    expect(problemDetailsSchema.parse(sources.body).code).toBe('EXPORT_TOO_LARGE');
    // Só a exportação concluída é auditada.
    expect(await exportAudit(process.id)).toHaveLength(1);
    expect(await exportAudit(other.process.id)).toEqual([]);
  });

  it('[Permissão] orçamento sigiloso: a Ana (sem POL-09 nem custódia) vê tudo mascarado, inclusive no XLSX', async () => {
    const { process, research } = await background();
    await db.admin('UPDATE processes SET is_budget_confidential = true WHERE id = $1', [
      process.id,
    ]);
    const map = await mapOf(research.id, SUBJECTS.ana);
    expect(map.masked).toBe(true);
    expect(map.cells.every((cell) => cell.unitPrice === null && cell.unitPriceMasked)).toBe(true);
    expect(map.items.every((item) => item.valuesMasked && item.medianPrice === null)).toBe(true);
    const response = await exportMap(research.id, SUBJECTS.ana);
    expect(response.status).toBe(200);
    const flat = sheet(response.body as Buffer)
      .flat()
      .join('|');
    expect(flat).toContain('Sigiloso');
    expect(flat).not.toMatch(/100\.0000|120\.0000|55\.0000/);
    expect((await exportAudit(process.id)).at(-1)?.metadata).toMatchObject({ masked: true });
    // Rui (responsável) segue com os valores.
    expect((await mapOf(research.id)).masked).toBe(false);
  });

  it('[Concorrência] leituras durante exclusões concorrentes: cada resposta é um estado consolidado', async () => {
    const { research } = await background();
    const quotations = await db.admin<{ id: string; version: number; price_item_id: string }>(
      `SELECT id, version, price_item_id FROM quotations
        WHERE price_research_id = $1 AND unit_price IN (100, 50) ORDER BY unit_price DESC`,
      [research.id],
    );
    const responses = await Promise.all([
      ...quotations.map((quotation) =>
        call(request(api.server).post(`/api/v1/quotations/${quotation.id}/exclude`))
          .set('If-Match', `"${String(quotation.version)}"`)
          .send({ exclusionReason: 'INCONSISTENT', exclusionJustification: JUSTIFICATION }),
      ),
      ...Array.from({ length: 6 }, () => getMap(research.id)),
    ]);
    for (const response of responses.slice(0, quotations.length)) {
      expect(response.status, JSON.stringify(response.body)).toBe(200);
    }
    for (const response of responses.slice(quotations.length)) {
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const map = comparativeMapSchema.parse((response.body as { data: ComparativeMapDto }).data);
      // A contagem de válidas do item bate com as células VALID do mesmo item na mesma leitura.
      for (const item of map.items) {
        const valid = map.cells.filter(
          (cell) => cell.priceItemId === item.id && cell.status === 'VALID',
        ).length;
        expect(item.validQuotationsCount).toBe(valid);
      }
    }
    const after = await mapOf(research.id);
    expect(after.cells.filter((cell) => cell.status === 'EXCLUDED')).toHaveLength(2);
  });

  it('[Tenant incorreto] mapa e exportação de A pelo tenant B: 404 PRICE_RESEARCH_NOT_FOUND, sem auditoria', async () => {
    const { process, research } = await background();
    for (const response of [
      await getMap(research.id, SUBJECTS.beto),
      await exportMap(research.id, SUBJECTS.beto),
    ]) {
      expect(response.status, JSON.stringify(response.body)).toBe(404);
      expect(problemDetailsSchema.parse(response.body).code).toBe('PRICE_RESEARCH_NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toMatch(/Orçamento|Cimento|100\.0000/);
    }
    expect(await exportAudit(process.id)).toEqual([]);
  });
});
