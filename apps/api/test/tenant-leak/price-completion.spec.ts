// Conclusão da pesquisa de preços sobre PostgreSQL real (US-032 · Sucesso, Concorrência, Falha de
// banco, Falha de integração, Permissão, Tenant incorreto): a API inteira como `cf_app` (RLS) com os
// seeders reais, o processo levado (SQL) à etapa PESQUISA_PRECOS com o Rui (COMPRAS) responsável, a
// pesquisa pelo PRS-02, três fontes/grades pelo PRS-10/13 e as seções narrativas pelo DOC-05. Prova
// a conclusão (PRS-23) numa transação só — documento FINALIZED + versão FINALIZATION, cabeçalho
// concluído, `process_items.reference_unit_price`, `processes.estimated_value`, auditoria e
// `DocumentFinalized`/`DocumentVersionCreated` PENDING com o relay fora —, a falha induzida DEPOIS da
// finalização do documento (nada fica), duas conclusões simultâneas (200 + 412), o 404 do tenant B e
// a RLS das tabelas propagadas. `pnpm --filter @contrataflow/api test:tenant-leak`.
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

const A = '0192c032-0000-7000-8000-00000000010a';
const B = '0192c032-0000-7000-8000-00000000010b';
const ORG_A = '0192c032-0000-7000-8000-0000000010a0';
const ORG_B = '0192c032-0000-7000-8000-0000000010b0';
const OBRAS = '0192c032-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c032-0000-7000-8000-0000000010a2';
const OBRAS_B = '0192c032-0000-7000-8000-0000000010b1';
const ANA = '0192c032-0000-7000-8000-0000000010c1';
const RUI = '0192c032-0000-7000-8000-0000000010c2';
const BETO = '0192c032-0000-7000-8000-0000000010c3';
const ANA_M = '0192c032-0000-7000-8000-0000000010d1';
const SUPPLIER_A = '0192c032-0000-7000-8000-0000000010f1';
const NOW = new Date('2026-10-06T15:00:00.000Z');
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [RUI]: ['COMPRAS'],
  [BETO]: ['COMPRAS'],
};

const SUBJECTS = { ana: 'sub-ana-us032', rui: 'sub-rui-us032', beto: 'sub-beto-us032' } as const;

const path = (...ids: string[]) => `/${ids.join('/')}/`;
const hash = (seed: string) => seed.repeat(64).slice(0, 64);

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us032', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'santa-luzia-us032', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
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
  ('${ANA}', '${SUBJECTS.ana}', 'ana32@a.test', true, 'Ana Souza'),
  ('${RUI}', '${SUBJECTS.rui}', 'rui32@a.test', true, 'Rui Costa'),
  ('${BETO}', '${SUBJECTS.beto}', 'beto32@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('0192c032-0000-7000-8000-0000000010d2', '${A}', '${RUI}', 'INTERNAL', 'ACTIVE'),
  ('0192c032-0000-7000-8000-0000000010d3', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c032-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true);
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

const paragraph = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

describe('Feature: Concluir a pesquisa de preços sobre PostgreSQL (US-032)', () => {
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

  /**
   * Processo na PESQUISA_PRECOS com "Item 1" (50 un a 100,00) e "Item 2" (100 m³ a 40,00), três
   * fontes, as seções narrativas preenchidas e a pesquisa pronta para concluir.
   */
  const ready = async () => {
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
    await db.admin(
      `UPDATE process_items SET reference_quantity = CASE sequence WHEN 1 THEN 50 ELSE 100 END
        WHERE process_id = $1`,
      [process.id],
    );
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
    const [first, second] = (listed.body as { data: PriceItemDto[] }).data;
    if (!first || !second) throw new Error('itens ausentes');
    for (let index = 0; index < 3; index += 1) {
      const source = await call(
        request(api.server).post(`/api/v1/price-research/${research.id}/sources`),
      )
        .set('Idempotency-Key', randomUUID())
        .send({
          sourceTypeId: catalog.direct,
          description: `Orçamento ${words(1)}`,
          supplierId: SUPPLIER_A,
          quoteDate: '2026-09-30',
          supplierChoiceJustification: 'Fornecedor do ramo com atuação comprovada na região.',
        });
      expect(source.status, JSON.stringify(source.body)).toBe(201);
      const grid = await call(
        request(api.server).put(
          `/api/v1/price-sources/${(source.body as { data: PriceSourceDto }).data.id}/quotations`,
        ),
      )
        .set('If-Match', '"1"')
        .send({
          items: [
            { priceItemId: first.id, unitPrice: '100.00' },
            { priceItemId: second.id, unitPrice: '40.00' },
          ],
        });
      expect(grid.status, JSON.stringify(grid.body)).toBe(200);
    }
    for (const key of ['METHODOLOGY', 'CONCLUSION']) {
      const [row] = await db.admin<{ revision: string | null }>(
        `SELECT draft_content -> 'sections' -> $2::text ->> 'revision' AS revision
           FROM documents WHERE id = $1`,
        [research.documentId, key],
      );
      const saved = await call(
        request(api.server).put(`/api/v1/documents/${research.documentId}/sections/${key}`),
      )
        .set('If-Match', `"s${row?.revision ?? '0'}"`)
        .send({
          content: paragraph(`Texto da seção ${key} da pesquisa de preços.`),
          notApplicable: false,
          justification: null,
        });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    }
    const [header] = await db.admin<{ version: number }>(
      'SELECT version FROM price_research WHERE id = $1',
      [research.id],
    );
    return { process, research, ifMatch: `"${String(header?.version)}"` };
  };

  const complete = (researchId: string, ifMatch: string, subject: string = SUBJECTS.rui) =>
    call(request(api.server).post(`/api/v1/price-research/${researchId}/complete`), subject)
      .set('If-Match', ifMatch)
      .set('Idempotency-Key', randomUUID())
      .send({});

  /** Tudo o que a conclusão grava (para provar o rollback e o 404). */
  const effects = async (researchId: string, processId: string) => ({
    document: await db.admin<Row>(
      'SELECT status::text, finalized_at IS NOT NULL AS finalized, version FROM documents WHERE id = $1',
      [researchId],
    ),
    versions: await db.admin<Row>(
      `SELECT reason::text, length(content_hash) AS hash_length FROM document_versions
        WHERE document_id = $1 ORDER BY version_number`,
      [researchId],
    ),
    research: await db.admin<Row>(
      `SELECT completed_at IS NOT NULL AS completed, completed_by_id, total_estimated_value::text,
              version
         FROM price_research WHERE id = $1`,
      [researchId],
    ),
    items: await db.admin<Row>(
      `SELECT reference_unit_price::text, reference_unit_price_source_document_id
         FROM process_items WHERE process_id = $1 ORDER BY sequence`,
      [processId],
    ),
    process: await db.admin<Row>(
      `SELECT estimated_value::text, estimated_value_source::text FROM processes WHERE id = $1`,
      [processId],
    ),
    audit: await db.admin<Row>(
      `SELECT action FROM audit_logs
        WHERE process_id = $1
          AND action IN ('price_research.complete', 'document.finalize', 'document.version_create')
        ORDER BY occurred_at, id`,
      [processId],
    ),
    events: await db.admin<Row>(
      `SELECT event_type, routing_key, status::text FROM outbox_events
        WHERE process_id = $1 AND event_type IN ('DocumentFinalized', 'DocumentVersionCreated')
        ORDER BY occurred_at, id`,
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

  it('[Sucesso] conclusão numa transação: documento, versão, cabeçalho, itens, processo, auditoria e eventos PENDING', async () => {
    const { process, research, ifMatch } = await ready();
    const response = await complete(research.id, ifMatch);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const after = await effects(research.id, process.id);
    expect(after.document[0]).toMatchObject({ status: 'FINALIZED', finalized: true });
    expect(after.versions).toEqual([{ reason: 'FINALIZATION', hash_length: 64 }]);
    expect(after.research[0]).toMatchObject({
      completed: true,
      completed_by_id: RUI,
      total_estimated_value: '9000.00',
    });
    expect(after.items).toEqual([
      { reference_unit_price: '100.0000', reference_unit_price_source_document_id: research.id },
      { reference_unit_price: '40.0000', reference_unit_price_source_document_id: research.id },
    ]);
    expect(after.process).toEqual([
      { estimated_value: '9000.00', estimated_value_source: 'PRICE_RESEARCH' },
    ]);
    expect(after.audit.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        'document.version_create',
        'document.finalize',
        'price_research.complete',
      ]),
    );
    // Falha de integração: sem relay, os dois eventos ficam PENDING no outbox até ele voltar.
    expect(after.events).toEqual(
      expect.arrayContaining([
        {
          event_type: 'DocumentVersionCreated',
          routing_key: 'document.version_created.price_research',
          status: 'PENDING',
        },
        {
          event_type: 'DocumentFinalized',
          routing_key: 'document.finalized.price_research',
          status: 'PENDING',
        },
      ]),
    );
    const leaked = await db.admin<Row>(
      `SELECT 'outbox' AS origin FROM outbox_events WHERE process_id = $1 AND payload::text LIKE '%9000%'`,
      [process.id],
    );
    expect(leaked).toEqual([]);
  });

  it('[Falha de banco] falha induzida DEPOIS de finalizar o documento desfaz tudo: documento, itens e processo como antes', async () => {
    const { process, research, ifMatch } = await ready();
    const before = await effects(research.id, process.id);
    await db.admin(`
      CREATE FUNCTION test_fail_price_completion() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.action = 'price_research.complete' THEN
          RAISE EXCEPTION 'falha induzida no teste';
        END IF;
        RETURN NEW;
      END $fn$;
      CREATE TRIGGER test_fail_price_completion BEFORE INSERT ON audit_logs
        FOR EACH ROW EXECUTE FUNCTION test_fail_price_completion();`);
    try {
      const failed = await complete(research.id, ifMatch);
      expect(failed.status).toBe(500);
      expect(await effects(research.id, process.id)).toEqual(before);
      expect(before.document[0]).toMatchObject({ status: 'DRAFT' });
      expect(before.events).toEqual([]);
    } finally {
      await db.admin(
        'DROP TRIGGER test_fail_price_completion ON audit_logs; DROP FUNCTION test_fail_price_completion();',
      );
    }
    // Sem a falha, a mesma conclusão passa.
    expect((await complete(research.id, ifMatch)).status).toBe(200);
  });

  it('[Concorrência] duas conclusões simultâneas com o mesmo If-Match: uma 200 e a outra 412, uma única versão', async () => {
    const { process, research, ifMatch } = await ready();
    const pair = await Promise.all([
      complete(research.id, ifMatch),
      complete(research.id, ifMatch),
    ]);
    expect(pair.map((response) => response.status).sort()).toEqual([200, 412]);
    const rejected = pair.find((response) => response.status === 412);
    expect(problemDetailsSchema.parse(rejected?.body).code).toBe('VERSION_CONFLICT');
    const after = await effects(research.id, process.id);
    expect(after.versions).toHaveLength(1);
    expect(after.audit.filter((row) => row.action === 'price_research.complete')).toHaveLength(1);
  });

  it('[Permissão] REQUISITANTE (só leitura) → 403 e nada muda', async () => {
    const { process, research, ifMatch } = await ready();
    const before = await effects(research.id, process.id);
    const denied = await complete(research.id, ifMatch, SUBJECTS.ana);
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    expect(problemDetailsSchema.parse(denied.body).code).toBe('PERMISSION_DENIED');
    expect(await effects(research.id, process.id)).toEqual(before);
  });

  it('[Tenant incorreto] pesquisa de A pelo tenant B: 404 sem ler nem alterar; RLS das tabelas propagadas', async () => {
    const { process, research, ifMatch } = await ready();
    const before = await effects(research.id, process.id);
    const response = await complete(research.id, ifMatch, SUBJECTS.beto);
    expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect(problemDetailsSchema.parse(response.body).code).toBe('PRICE_RESEARCH_NOT_FOUND');
    expect(await effects(research.id, process.id)).toEqual(before);

    // RLS: com `app.tenant_id` de B, itens e processo de A não são alteráveis.
    const client = db.client('cf_app');
    try {
      const updated = await asTenant(B, () =>
        client.$tenantTransaction(async (tx) => {
          const items = await tx.$executeRaw`
            UPDATE process_items SET reference_unit_price = 1 WHERE process_id = ${process.id}::uuid`;
          const processes = await tx.$executeRaw`
            UPDATE processes SET estimated_value = 1 WHERE id = ${process.id}::uuid`;
          const researches = await tx.$executeRaw`
            UPDATE price_research SET completed_at = now() WHERE id = ${research.id}::uuid`;
          return items + processes + researches;
        }),
      );
      expect(updated).toBe(0);
    } finally {
      await client.$disconnect();
    }
  });
});
