// Pesquisa de preços sobre PostgreSQL real (US-024 · Sucesso, Tenant incorreto, Concorrência,
// Falha de banco, Falha de integração): a API inteira como `cf_app` (RLS) com os seeders reais do
// provisionamento, o processo criado pelo PRC-02 e levado (SQL) à etapa PESQUISA_PRECOS com o Rui
// (COMPRAS) responsável, e a pesquisa pelo PRS-02. Prova a criação numa transação só — falha induzida
// DEPOIS de numerar não deixa documento, cabeçalho, itens, timeline, auditoria, evento nem número —,
// o índice único do tipo singular sob 20 criações paralelas (1 × 201, 19 × 409), o `If-Match` do
// PRS-04, a cascata `price_research → price_items`, o `ITEM_IN_USE` do item do processo, os eventos
// `PENDING` e a RLS/checks/FKs compostas de `price_research` e `price_items`.
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type {
  PriceItemDto,
  PriceResearchDto,
  ProcessDto,
  ProcessItemDto,
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

const A = '0192c024-0000-7000-8000-00000000010a';
const B = '0192c024-0000-7000-8000-00000000010b';
const ORG_A = '0192c024-0000-7000-8000-0000000010a0';
const ORG_B = '0192c024-0000-7000-8000-0000000010b0';
const OBRAS = '0192c024-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c024-0000-7000-8000-0000000010a2';
const OBRAS_B = '0192c024-0000-7000-8000-0000000010b1';
const ANA = '0192c024-0000-7000-8000-0000000010c1';
const RUI = '0192c024-0000-7000-8000-0000000010c2';
const BETO = '0192c024-0000-7000-8000-0000000010c3';
const ANA_M = '0192c024-0000-7000-8000-0000000010d1';
const NOW = new Date('2026-10-06T15:00:00.000Z');
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [RUI]: ['COMPRAS'],
  [BETO]: ['COMPRAS'],
};

const SUBJECTS = { ana: 'sub-ana-us024', rui: 'sub-rui-us024', beto: 'sub-beto-us024' } as const;

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us024', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'santa-luzia-us024', 'Prefeitura de Santa Luzia LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal de São José', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura de Santa Luzia LEAK-B', 'PMSL', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Obras', '${path(OBRAS)}', 0),
  ('${MANUTENCAO}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Manutenção', '${path(OBRAS, MANUTENCAO)}', 1),
  ('${OBRAS_B}', '${B}', '${ORG_B}', NULL, 'SECRETARIAT', 'Obras LEAK-B', '${path(OBRAS_B)}', 0);
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${ANA}', '${SUBJECTS.ana}', 'ana@a.test', true, 'Ana Souza'),
  ('${RUI}', '${SUBJECTS.rui}', 'rui@a.test', true, 'Rui Costa'),
  ('${BETO}', '${SUBJECTS.beto}', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('0192c024-0000-7000-8000-0000000010d2', '${A}', '${RUI}', 'INTERNAL', 'ACTIVE'),
  ('0192c024-0000-7000-8000-0000000010d3', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c024-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true);
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

describe('Feature: Criar pesquisa de preços sobre PostgreSQL (US-024)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let catalog: { contractingType: string; origin: string; un: string; m3: string };

  const tenantOf = (subject: string): string => (subject === SUBJECTS.beto ? B : A);
  const call = (test: request.Test, subject: string = SUBJECTS.rui) =>
    test
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenantOf(subject));

  /** Processo pelo PRC-02 (Ana) com dois itens, levado à PESQUISA_PRECOS com o Rui responsável. */
  const createProcess = async (): Promise<{ process: ProcessDto; items: ProcessItemDto[] }> => {
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
    const items: ProcessItemDto[] = [];
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
      items.push((item.body as { data: ProcessItemDto }).data);
    }
    // DEC-019: a quantidade de referência só é gravada pelos documentos/pesquisa — aqui por SQL.
    await db.admin('UPDATE process_items SET reference_quantity = 100 WHERE id = $1', [
      items[0]?.id,
    ]);
    await db.admin('UPDATE process_items SET reference_quantity = 12 WHERE id = $1', [
      items[1]?.id,
    ]);
    await db.admin(
      `UPDATE processes p SET status = 'IN_PROGRESS', current_workflow_stage_id = ws.id,
              current_responsible_id = $2
         FROM workflow_stages ws
        WHERE p.id = $1 AND ws.workflow_version_id = p.workflow_version_id
          AND ws.key = 'PESQUISA_PRECOS'`,
      [process.id, RUI],
    );
    return { process, items };
  };
  const createResearch = (processId: string, key: string = randomUUID()) =>
    call(request(api.server).post(`/api/v1/processes/${processId}/price-research`))
      .set('Idempotency-Key', key)
      .send({ referenceDate: '2026-10-06' });
  const catalogId = async (tenantId: string, type: string, code: string) => {
    const [row] = await db.admin<{ id: string }>(
      'SELECT id FROM catalog_items WHERE tenant_id = $1 AND catalog_type = $2 AND code = $3',
      [tenantId, type, code],
    );
    if (!row) throw new Error(`${type}/${code} ausente`);
    return row.id;
  };
  const lastNumber = async () => {
    const [row] = await db.admin<{ last_value: number }>(
      "SELECT last_value FROM number_sequences WHERE tenant_id = $1 AND sequence_key = 'DOCUMENT:PRICE_RESEARCH:*:2026'",
      [A],
    );
    return row?.last_value ?? 0;
  };
  /** Tudo o que a criação da pesquisa grava no processo (para provar o rollback). */
  const effects = async (processId: string) => ({
    documents: await db.admin<Row>(
      'SELECT id, code, status::text, confidentiality::text, version FROM documents WHERE process_id = $1 ORDER BY created_at, id',
      [processId],
    ),
    researches: await db.admin<Row>(
      `SELECT id, document_id, reference_date::text, default_method::text,
              cv_threshold_percent::text, min_quotations, items_count, items_with_alerts_count, version
         FROM price_research WHERE process_id = $1`,
      [processId],
    ),
    items: await db.admin<Row>(
      `SELECT i.quantity::text, i.sort_order, i.alerts
         FROM price_items i JOIN price_research r ON r.id = i.price_research_id
        WHERE r.process_id = $1 ORDER BY i.sort_order`,
      [processId],
    ),
    timeline: await db.admin<Row>(
      "SELECT type::text FROM process_timeline_entries WHERE process_id = $1 AND type::text = 'DOCUMENT_CREATED'",
      [processId],
    ),
    audit: await db.admin<Row>(
      "SELECT action FROM audit_logs WHERE process_id = $1 AND action LIKE 'document.%' ORDER BY occurred_at, id",
      [processId],
    ),
    events: await db.admin<Row>(
      "SELECT event_type, routing_key, status::text FROM outbox_events WHERE process_id = $1 AND (event_type LIKE 'Document%' OR event_type LIKE 'PriceResearch%') ORDER BY occurred_at, id",
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
    };
  });

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso] PRS-02 numa transação: documento + cabeçalho (id = documento) com snapshot, itens em lote, número, timeline, auditoria e DocumentCreated PENDING', async () => {
    const { process, items } = await createProcess();
    const before = await lastNumber();
    const created = await createResearch(process.id);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const research = (created.body as { data: PriceResearchDto }).data;
    const code = `PP ${String(before + 1).padStart(4, '0')}/2026`;
    expect(research).toMatchObject({ code, status: 'DRAFT', documentId: research.id });
    expect(await lastNumber()).toBe(before + 1);

    const after = await effects(process.id);
    expect(after.documents).toEqual([
      { id: research.id, code, status: 'DRAFT', confidentiality: 'INTERNAL', version: 1 },
    ]);
    expect(after.researches).toEqual([
      {
        id: research.id,
        document_id: research.id,
        reference_date: '2026-10-06',
        default_method: 'AUTO_CV',
        cv_threshold_percent: '25.0000',
        min_quotations: 3,
        items_count: 2,
        items_with_alerts_count: 2,
        version: 1,
      },
    ]);
    expect(after.items).toEqual([
      {
        quantity: '100.0000',
        sort_order: 1,
        alerts: [{ code: 'NO_VALID_QUOTES' }, { code: 'BELOW_MINIMUM_QUOTES' }],
      },
      {
        quantity: '12.0000',
        sort_order: 2,
        alerts: [{ code: 'NO_VALID_QUOTES' }, { code: 'BELOW_MINIMUM_QUOTES' }],
      },
    ]);
    expect(after.timeline).toEqual([{ type: 'DOCUMENT_CREATED' }]);
    expect(after.audit.map((row) => row.action)).toEqual(['document.create']);
    // [Falha de integração] relay fora: o evento fica PENDING para publicação.
    expect(after.events).toEqual([
      {
        event_type: 'DocumentCreated',
        routing_key: 'document.created.price_research',
        status: 'PENDING',
      },
    ]);

    // PRS-05 pela API (RLS) e o uso do item (ITEM_IN_USE — US-006).
    const listed = await call(
      request(api.server).get(`/api/v1/price-research/${research.id}/items`),
    );
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect((listed.body as { data: PriceItemDto[] }).data.map((item) => item.quantity)).toEqual([
      '100.0000',
      '12.0000',
    ]);
    await db.admin('UPDATE processes SET current_responsible_id = $2 WHERE id = $1', [
      process.id,
      ANA,
    ]);
    const removal = await call(
      request(api.server).delete(`/api/v1/process-items/${items[0]?.id ?? ''}`),
      SUBJECTS.ana,
    ).set('If-Match', `"${String(items[0]?.version)}"`);
    expect(problemDetailsSchema.parse(removal.body).code).toBe('ITEM_IN_USE');
  });

  it('[Concorrência] 20 criações simultâneas no mesmo processo: 1 × 201 e 19 × 409, numeração sem lacuna', async () => {
    const { process } = await createProcess();
    const before = await lastNumber();
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => createResearch(process.id)),
    );
    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(19);
    for (const response of responses.filter((item) => item.status === 409)) {
      expect(problemDetailsSchema.parse(response.body).code).toBe('DOCUMENT_ALREADY_EXISTS');
    }
    expect((await effects(process.id)).researches).toHaveLength(1);
    expect(await lastNumber()).toBe(before + 1);
  });

  it('[Concorrência] dois PATCH de data-base com o mesmo If-Match: um 200 e o outro 412 VERSION_CONFLICT', async () => {
    const { process } = await createProcess();
    const research = ((await createResearch(process.id)).body as { data: PriceResearchDto }).data;
    const patch = (date: string) =>
      call(request(api.server).patch(`/api/v1/price-research/${research.id}`))
        .set('If-Match', '"1"')
        .send({ referenceDate: date });
    const responses = await Promise.all([patch('2026-10-01'), patch('2026-10-02')]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 412]);
    expect((await effects(process.id)).researches).toMatchObject([{ version: 2 }]);
  });

  it('[Falha de banco] falha induzida DEPOIS de numerar e criar o documento desfaz tudo, inclusive o número', async () => {
    const { process } = await createProcess();
    const before = await lastNumber();
    await db.admin(`
      CREATE FUNCTION test_fail_price_items_insert() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        RAISE EXCEPTION 'falha induzida no teste';
      END $fn$;
      CREATE TRIGGER test_fail_price_items_insert BEFORE INSERT ON price_items
        FOR EACH ROW EXECUTE FUNCTION test_fail_price_items_insert();`);
    try {
      const failed = await createResearch(process.id);
      expect(failed.status).toBe(500);
      expect(await effects(process.id)).toEqual({
        documents: [],
        researches: [],
        items: [],
        timeline: [],
        audit: [],
        events: [],
      });
      expect(await lastNumber()).toBe(before);
    } finally {
      await db.admin(
        'DROP TRIGGER test_fail_price_items_insert ON price_items; DROP FUNCTION test_fail_price_items_insert();',
      );
    }
    // Sem a falha, o mesmo processo recebe o próximo número (nenhum foi consumido).
    const created = await createResearch(process.id);
    expect((created.body as { data: PriceResearchDto }).data.code).toBe(
      `PP ${String(before + 1).padStart(4, '0')}/2026`,
    );
  });

  it('[Tenant incorreto] pesquisa e itens de A pelo tenant B: 404 sem alterar; RLS, checks, FKs compostas e cascata', async () => {
    const { process, items } = await createProcess();
    const research = ((await createResearch(process.id)).body as { data: PriceResearchDto }).data;
    const [line] = (
      (await call(request(api.server).get(`/api/v1/price-research/${research.id}/items`))).body as {
        data: PriceItemDto[];
      }
    ).data;
    const before = await effects(process.id);

    const asBeto = (test: request.Test) => call(test, SUBJECTS.beto);
    for (const response of [
      await asBeto(request(api.server).get(`/api/v1/price-research/${research.id}`)),
      await asBeto(request(api.server).get(`/api/v1/price-research/${research.id}/items`)),
      await asBeto(request(api.server).get(`/api/v1/processes/${process.id}/price-research`)),
      await asBeto(request(api.server).post(`/api/v1/processes/${process.id}/price-research`))
        .set('Idempotency-Key', randomUUID())
        .send({}),
      await asBeto(request(api.server).patch(`/api/v1/price-research/${research.id}`))
        .set('If-Match', '"1"')
        .send({ referenceDate: '2026-10-01' }),
      await asBeto(request(api.server).post(`/api/v1/price-research/${research.id}/items`)).send({
        items: [{ processItemId: items[1]?.id }],
      }),
      await asBeto(request(api.server).delete(`/api/v1/price-items/${line?.id ?? ''}`)).set(
        'If-Match',
        '"1"',
      ),
    ]) {
      expect(response.status, JSON.stringify(response.body)).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain(research.code ?? '#');
    }
    expect(await effects(process.id)).toEqual(before);

    // RLS: com `app.tenant_id` de B, nenhuma pesquisa nem item de A é visível nem alterável.
    const client = db.client('cf_app');
    try {
      const visible = await asTenant(B, () =>
        client.$tenantTransaction(
          (tx) => tx.$queryRaw<{ count: number }[]>`
            SELECT (SELECT count(*) FROM price_research WHERE id = ${research.id}::uuid)::int
                 + (SELECT count(*) FROM price_items WHERE price_research_id = ${research.id}::uuid)::int
                   AS count`,
        ),
      );
      expect(visible).toEqual([{ count: 0 }]);
      const updated = await asTenant(B, () =>
        client.$tenantTransaction(
          (tx) => tx.$executeRaw`
            UPDATE price_research SET items_count = 0 WHERE id = ${research.id}::uuid`,
        ),
      );
      expect(updated).toBe(0);
    } finally {
      await client.$disconnect();
    }

    const insertItem = (tenantId: string, processItemId: string, quantity: string) =>
      db.admin(
        `INSERT INTO price_items (id, tenant_id, price_research_id, process_item_id, quantity)
         VALUES ($1, $2, $3, $4, $5::numeric)`,
        [randomUUID(), tenantId, research.id, processItemId, quantity],
      );
    // Índice único por (pesquisa, item do processo) e CHECK `quantity > 0`.
    await expect(insertItem(A, items[0]?.id ?? '', '5')).rejects.toThrow();
    await db.admin('DELETE FROM price_items WHERE id = $1', [line?.id]);
    await expect(insertItem(A, items[0]?.id ?? '', '0')).rejects.toThrow();
    // FK composta: linha de pesquisa de A no tenant B é recusada pelo banco.
    await expect(insertItem(B, items[0]?.id ?? '', '1')).rejects.toThrow();
    // CHECKs do cabeçalho: mínimo de cotações, casas decimais e documento imutável.
    await expect(
      db.admin('UPDATE price_research SET min_quotations = 0 WHERE id = $1', [research.id]),
    ).rejects.toThrow();
    await expect(
      db.admin('UPDATE price_research SET unit_price_decimals = 3 WHERE id = $1', [research.id]),
    ).rejects.toThrow();
    await expect(
      db.admin('UPDATE price_research SET document_id = $2 WHERE id = $1', [
        research.id,
        randomUUID(),
      ]),
    ).rejects.toThrow();
    // Cascata `price_research → price_items` (RN-PRICE-11): apagar o cabeçalho leva as linhas.
    await db.admin('DELETE FROM price_research WHERE id = $1', [research.id]);
    expect(
      await db.admin<Row>(
        'SELECT count(*)::int AS count FROM price_items WHERE price_research_id = $1',
        [research.id],
      ),
    ).toEqual([{ count: 0 }]);
  });
});
