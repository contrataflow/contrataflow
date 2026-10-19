// Desconsiderar e restaurar cotação sobre PostgreSQL real (US-027 · Sucesso, Concorrência, Falha de
// banco, Permissão, Tenant incorreto): a API inteira como `cf_app` (RLS) com os seeders reais, o
// processo levado (SQL) à etapa PESQUISA_PRECOS com o Rui (COMPRAS) responsável, a pesquisa pelo
// PRS-02, a fonte e a grade pelo PRS-10/13. Prova a exclusão/restauração numa transação só (estado,
// recálculo, auditoria, timeline e eventos `PENDING` com o relay fora; falha induzida no evento não
// deixa nada), a justificativa fora da auditoria/outbox/timeline, a trava da pesquisa sob exclusão e
// restauração simultâneas, o 404 do tenant B em PRS-16/17 e a RLS/CHECK da exclusão em `quotations`.
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
const JUSTIFICATION = 'Preço muito acima das demais cotações do mesmo item';
const NOW = new Date('2026-10-06T15:00:00.000Z');
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [RUI]: ['COMPRAS'],
  [BETO]: ['COMPRAS'],
};

const SUBJECTS = { ana: 'sub-ana-us027', rui: 'sub-rui-us027', beto: 'sub-beto-us027' } as const;

const path = (...ids: string[]) => `/${ids.join('/')}/`;
const hash = (seed: string) => seed.repeat(64).slice(0, 64);

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us027', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'santa-luzia-us027', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
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

describe('Feature: Desconsiderar e restaurar cotação sobre PostgreSQL (US-027)', () => {
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

  const excludeBody = (overrides: Record<string, unknown> = {}) => ({
    exclusionReason: 'INCONSISTENT',
    exclusionJustification: JUSTIFICATION,
    ...overrides,
  });
  const exclude = (
    quotationId: string,
    ifMatch: string,
    subject: string = SUBJECTS.rui,
    body: Record<string, unknown> = excludeBody(),
  ) =>
    call(request(api.server).post(`/api/v1/quotations/${quotationId}/exclude`), subject)
      .set('If-Match', ifMatch)
      .send(body);
  const restore = (quotationId: string, ifMatch: string, subject: string = SUBJECTS.rui) =>
    call(request(api.server).post(`/api/v1/quotations/${quotationId}/restore`), subject).set(
      'If-Match',
      ifMatch,
    );

  /** Pesquisa com a fonte e as duas cotações lançadas pela grade (PRS-13). */
  const withQuotations = async () => {
    const context = await background();
    const source = await sourceOk(context.research.id);
    const grid = await putGrid(
      source.id,
      [
        { priceItemId: context.items[0]?.id, unitPrice: '150.00' },
        { priceItemId: context.items[1]?.id, unitPrice: '80.00' },
      ],
      '"1"',
    );
    expect(grid.status, JSON.stringify(grid.body)).toBe(200);
    const quotations = (grid.body as { data: QuotationDto[] }).data;
    const q1 = quotations.find((quotation) => quotation.priceItemId === context.items[0]?.id);
    if (!q1) throw new Error('cotação ausente');
    return { ...context, source, q1 };
  };

  /** Tudo o que a desconsideração grava (para provar o rollback e o 404). */
  const effects = async (researchId: string, processId: string, quotationId: string) => ({
    quotation: await db.admin<Row>(
      `SELECT status::text, exclusion_reason::text, exclusion_justification, excluded_by_id,
              excluded_at, version
         FROM quotations WHERE id = $1`,
      [quotationId],
    ),
    items: await db.admin<Row>(
      'SELECT valid_quotations_count, alerts FROM price_items WHERE price_research_id = $1 ORDER BY sort_order',
      [researchId],
    ),
    audit: await db.admin<Row>(
      "SELECT action FROM audit_logs WHERE process_id = $1 AND action LIKE 'price_research.quotation_%' ORDER BY occurred_at, id",
      [processId],
    ),
    events: await db.admin<Row>(
      `SELECT event_type, routing_key, status::text FROM outbox_events
        WHERE process_id = $1 AND event_type IN ('QuotationExcluded', 'QuotationRestored')
        ORDER BY occurred_at, id`,
      [processId],
    ),
    timeline: await db.admin<Row>(
      "SELECT type FROM process_timeline_entries WHERE process_id = $1 AND type LIKE 'QUOTATION_%' ORDER BY occurred_at, id",
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

  it('[Sucesso] PRS-16 e PRS-17 numa transação: estado, recálculo, auditoria, timeline e eventos PENDING (relay fora)', async () => {
    const { process, research, q1 } = await withQuotations();
    const excluded = await exclude(q1.id, '"1"');
    expect(excluded.status, JSON.stringify(excluded.body)).toBe(200);
    expect(excluded.headers.etag).toBe('"2"');

    const afterExclude = await effects(research.id, process.id, q1.id);
    expect(afterExclude.quotation).toEqual([
      {
        status: 'EXCLUDED',
        exclusion_reason: 'INCONSISTENT',
        exclusion_justification: JUSTIFICATION,
        excluded_by_id: RUI,
        excluded_at: NOW,
        version: 2,
      },
    ]);
    expect(afterExclude.items.map((row) => row.valid_quotations_count)).toEqual([0, 1]);
    expect(afterExclude.audit.map((row) => row.action)).toEqual([
      'price_research.quotation_create',
      'price_research.quotation_create',
      'price_research.quotation_exclude',
    ]);
    // A justificativa nunca é gravada em claro na auditoria nem no outbox (só hash e tamanho).
    const leaked = await db.admin<Row>(
      `SELECT 'audit' AS origin FROM audit_logs WHERE process_id = $1 AND (changes::text LIKE $2 OR metadata::text LIKE $2)
       UNION ALL SELECT 'outbox' FROM outbox_events WHERE process_id = $1 AND payload::text LIKE $2
       UNION ALL SELECT 'timeline' FROM process_timeline_entries WHERE process_id = $1 AND params::text LIKE $2`,
      [process.id, `%${JUSTIFICATION}%`],
    );
    expect(leaked).toEqual([]);
    expect(afterExclude.events).toEqual([
      {
        event_type: 'QuotationExcluded',
        routing_key: 'price_research.quotation_excluded',
        status: 'PENDING',
      },
    ]);
    expect(afterExclude.timeline).toEqual([{ type: 'QUOTATION_EXCLUDED' }]);
    const recalculated = await db.admin<Row>(
      "SELECT status::text FROM outbox_events WHERE process_id = $1 AND event_type = 'PriceResearchRecalculated'",
      [process.id],
    );
    expect(recalculated.every((row) => row.status === 'PENDING')).toBe(true);

    // A cotação continua listada (PRS-09) com motivo e justificativa, sob a RLS do tenant.
    const listed = await call(
      request(api.server).get(`/api/v1/price-research/${research.id}/sources`),
    );
    const [listedSource] = (listed.body as { data: PriceSourceDto[] }).data;
    expect(listedSource?.quotations.find((quotation) => quotation.id === q1.id)).toMatchObject({
      status: 'EXCLUDED',
      exclusionReason: 'INCONSISTENT',
      exclusionJustification: JUSTIFICATION,
    });

    const restored = await restore(q1.id, '"2"');
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    const afterRestore = await effects(research.id, process.id, q1.id);
    expect(afterRestore.quotation).toEqual([
      {
        status: 'VALID',
        exclusion_reason: null,
        exclusion_justification: null,
        excluded_by_id: null,
        excluded_at: null,
        version: 3,
      },
    ]);
    expect(afterRestore.items.map((row) => row.valid_quotations_count)).toEqual([1, 1]);
    expect(afterRestore.events.map((row) => row.event_type)).toEqual([
      'QuotationExcluded',
      'QuotationRestored',
    ]);
    expect(afterRestore.timeline).toEqual([
      { type: 'QUOTATION_EXCLUDED' },
      { type: 'QUOTATION_RESTORED' },
    ]);
  });

  it('[Concorrência] exclusão e restauração simultâneas com If-Match 1: uma aplicada, a outra 412/409; versão 2', async () => {
    const { process, research, q1 } = await withQuotations();
    const responses = await Promise.all([exclude(q1.id, '"1"'), restore(q1.id, '"1"')]);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    const loser = responses.find((response) => response.status !== 200);
    expect([409, 412]).toContain(loser?.status);
    const state = await effects(research.id, process.id, q1.id);
    expect(state.quotation[0]?.version).toBe(2);
    expect(state.events).toHaveLength(1);

    // Duas exclusões simultâneas: uma 200 e a outra 412 VERSION_CONFLICT.
    const other = await withQuotations();
    const pair = await Promise.all([exclude(other.q1.id, '"1"'), exclude(other.q1.id, '"1"')]);
    expect(pair.map((response) => response.status).sort()).toEqual([200, 412]);
    const rejected = pair.find((response) => response.status === 412);
    expect(problemDetailsSchema.parse(rejected?.body).code).toBe('VERSION_CONFLICT');
  });

  it('[Falha de banco] falha induzida ao gravar o evento desfaz tudo: a cotação permanece VALID, sem auditoria nem timeline', async () => {
    const { process, research, q1 } = await withQuotations();
    const before = await effects(research.id, process.id, q1.id);
    await db.admin(`
      CREATE FUNCTION test_fail_exclusion_event() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.event_type = 'QuotationExcluded' THEN
          RAISE EXCEPTION 'falha induzida no teste';
        END IF;
        RETURN NEW;
      END $fn$;
      CREATE TRIGGER test_fail_exclusion_event BEFORE INSERT ON outbox_events
        FOR EACH ROW EXECUTE FUNCTION test_fail_exclusion_event();`);
    try {
      const failed = await exclude(q1.id, '"1"');
      expect(failed.status).toBe(500);
      expect(await effects(research.id, process.id, q1.id)).toEqual(before);
      expect(before.quotation[0]).toMatchObject({ status: 'VALID', version: 1 });
    } finally {
      await db.admin(
        'DROP TRIGGER test_fail_exclusion_event ON outbox_events; DROP FUNCTION test_fail_exclusion_event();',
      );
    }
    const retried = await exclude(q1.id, '"1"');
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
  });

  it('[Permissão] REQUISITANTE (só leitura da pesquisa) → 403 e nada muda; justificativa curta → 422', async () => {
    const { process, research, q1 } = await withQuotations();
    const before = await effects(research.id, process.id, q1.id);
    const denied = await exclude(q1.id, '"1"', SUBJECTS.ana);
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    expect(problemDetailsSchema.parse(denied.body).code).toBe('PERMISSION_DENIED');
    expect((await restore(q1.id, '"1"', SUBJECTS.ana)).status).toBe(403);
    const short = await exclude(
      q1.id,
      '"1"',
      SUBJECTS.rui,
      excludeBody({ exclusionJustification: 'Preço alto' }),
    );
    expect(short.status).toBe(422);
    expect(
      problemDetailsSchema.parse(short.body).errors.map((error) => [error.field, error.code]),
    ).toEqual([['exclusionJustification', 'TOO_SHORT']]);
    expect(await effects(research.id, process.id, q1.id)).toEqual(before);
  });

  it('[Tenant incorreto] cotação de A pelo tenant B: 404 sem alterar; RLS e CHECK da exclusão no banco', async () => {
    const { process, research, q1 } = await withQuotations();
    const before = await effects(research.id, process.id, q1.id);
    for (const response of [
      await exclude(q1.id, '"1"', SUBJECTS.beto),
      await restore(q1.id, '"1"', SUBJECTS.beto),
    ]) {
      expect(response.status, JSON.stringify(response.body)).toBe(404);
      expect(problemDetailsSchema.parse(response.body).code).toBe('NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toContain('Construtora');
    }
    expect(await effects(research.id, process.id, q1.id)).toEqual(before);

    // RLS: com `app.tenant_id` de B a cotação de A não é visível nem alterável.
    const client = db.client('cf_app');
    try {
      const updated = await asTenant(B, () =>
        client.$tenantTransaction(
          (tx) => tx.$executeRaw`
            UPDATE quotations
               SET status = 'EXCLUDED', exclusion_reason = 'OTHER', exclusion_justification = 'x'
             WHERE id = ${q1.id}::uuid`,
        ),
      );
      expect(updated).toBe(0);
    } finally {
      await client.$disconnect();
    }

    // CHECK da exclusão (já criado na US-026): EXCLUDED exige motivo e justificativa.
    await expect(
      db.admin("UPDATE quotations SET status = 'EXCLUDED' WHERE id = $1", [q1.id]),
    ).rejects.toThrow();
    await expect(
      db.admin(
        "UPDATE quotations SET status = 'EXCLUDED', exclusion_reason = 'OTHER' WHERE id = $1",
        [q1.id],
      ),
    ).rejects.toThrow();
  });
});
