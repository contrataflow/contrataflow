// DFD sobre PostgreSQL real (US-014 · Sucesso, Tenant incorreto, Concorrência, Falha de banco,
// Falha de integração): a API inteira como `cf_app` (RLS) com os seeders reais do provisionamento
// (inclusive a biblioteca de templates), o processo criado pelo PRC-02 na etapa ABERTURA e o DFD
// pelo DFD-02, os itens pelo DOC-07. Prova a criação numa transação só — falha induzida DEPOIS de
// numerar não deixa documento, DFD, timeline, auditoria, evento nem número consumido —, o índice
// único do tipo singular sob 20 criações paralelas (1 × 201, 19 × 409, numeração sem lacuna), o
// `If-Match` dos itens concorrentes, os eventos `PENDING` e a RLS/checks/FKs de `dfds` e
// `document_items`. `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type { DfdDto, ProcessDto, ProcessItemDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';

import { CATALOG_CLOCK } from '../../src/modules/catalog/application/catalog-ports.js';
import { DFD_CLOCK } from '../../src/modules/dfd/application/ports.js';
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

const A = '0192c014-0000-7000-8000-00000000010a';
const B = '0192c014-0000-7000-8000-00000000010b';
const ORG_A = '0192c014-0000-7000-8000-0000000010a0';
const ORG_B = '0192c014-0000-7000-8000-0000000010b0';
const OBRAS = '0192c014-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c014-0000-7000-8000-0000000010a2';
const OBRAS_B = '0192c014-0000-7000-8000-0000000010b1';
const ANA = '0192c014-0000-7000-8000-0000000010c1';
const BETO = '0192c014-0000-7000-8000-0000000010c3';
const ANA_M = '0192c014-0000-7000-8000-0000000010d1';
const NOW = new Date('2026-10-17T15:00:00.000Z');
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [BETO]: ['GESTOR_CONTRATACOES'],
};

const SUBJECTS = { ana: 'sub-ana-us014', beto: 'sub-beto-us014' } as const;

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us014', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'santa-luzia-us014', 'Prefeitura de Santa Luzia LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
INSERT INTO organizations (id, tenant_id, name, short_name, cnpj, type, is_active) VALUES
  ('${ORG_A}', '${A}', 'Prefeitura Municipal de São José', 'PMSJ', '11222333000181', 'DIRECT_ADMINISTRATION', true),
  ('${ORG_B}', '${B}', 'Prefeitura de Santa Luzia LEAK-B', 'PMSL', '60746948000112', 'DIRECT_ADMINISTRATION', true);
UPDATE tenants SET primary_organization_id = '${ORG_A}' WHERE id = '${A}';
UPDATE tenants SET primary_organization_id = '${ORG_B}' WHERE id = '${B}';
INSERT INTO departments (id, tenant_id, organization_id, parent_id, type, name, path, depth) VALUES
  ('${OBRAS}', '${A}', '${ORG_A}', NULL, 'SECRETARIAT', 'Secretaria de Saúde', '${path(OBRAS)}', 0),
  ('${MANUTENCAO}', '${A}', '${ORG_A}', '${OBRAS}', 'SECTOR', 'Setor de Atenção Básica', '${path(OBRAS, MANUTENCAO)}', 1),
  ('${OBRAS_B}', '${B}', '${ORG_B}', NULL, 'SECRETARIAT', 'Saúde LEAK-B', '${path(OBRAS_B)}', 0);
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${ANA}', '${SUBJECTS.ana}', 'claudia@a.test', true, 'Cláudia Ferreira'),
  ('${BETO}', '${SUBJECTS.beto}', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('0192c014-0000-7000-8000-0000000010d3', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c014-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true);
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

describe('Feature: Elaborar DFD sobre PostgreSQL (US-014)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let catalog: { contractingType: string; origin: string; cx: string; un: string };

  const tenantOf = (subject: string): string => (subject === SUBJECTS.beto ? B : A);
  const call = (test: request.Test, subject: string = SUBJECTS.ana) =>
    test
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenantOf(subject));

  /** Processo pelo PRC-02 (Ana responsável), em rascunho na etapa ABERTURA. */
  const createProcess = async (): Promise<ProcessDto> => {
    const response = await call(request(api.server).post('/api/v1/processes'))
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Aquisição de insumos ${words(2)}`,
        object: `Aquisição de insumos para a UBS Centro ${words(2)}`,
        contractingTypeId: catalog.contractingType,
        requestingSecretariatId: OBRAS,
        requestingDepartmentId: MANUTENCAO,
        originId: catalog.origin,
        pcaStatus: 'NOT_APPLICABLE',
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return (response.body as { data: ProcessDto }).data;
  };
  const createDfd = (processId: string, key: string = randomUUID()) =>
    call(request(api.server).post(`/api/v1/processes/${processId}/dfds`))
      .set('Idempotency-Key', key)
      .send({});
  const createItem = async (processId: string, description: string, unitOfMeasureId: string) => {
    const response = await call(request(api.server).post(`/api/v1/processes/${processId}/items`))
      .set('Idempotency-Key', randomUUID())
      .send({ kind: 'GOOD', description, unitOfMeasureId });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return (response.body as { data: ProcessItemDto }).data;
  };
  const putItems = (documentId: string, items: unknown[], ifMatch: string, subject?: string) =>
    call(request(api.server).put(`/api/v1/documents/${documentId}/items`), subject)
      .set('If-Match', ifMatch)
      .send({ items });
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
      "SELECT last_value FROM number_sequences WHERE tenant_id = $1 AND sequence_key = 'DOCUMENT:DFD:*:2026'",
      [A],
    );
    return row?.last_value ?? 0;
  };
  /** Tudo o que a criação do DFD grava no processo (para provar o rollback). */
  const effects = async (processId: string) => ({
    documents: await db.admin<Row>(
      'SELECT id, code, status::text, version FROM documents WHERE process_id = $1 ORDER BY created_at, id',
      [processId],
    ),
    dfds: await db.admin<Row>(
      'SELECT id, document_id, request_date::text, priority::text, wizard_step::text FROM dfds WHERE process_id = $1',
      [processId],
    ),
    timeline: await db.admin<Row>(
      "SELECT type::text FROM process_timeline_entries WHERE process_id = $1 AND type::text = 'DOCUMENT_CREATED'",
      [processId],
    ),
    audit: await db.admin<Row>(
      "SELECT action, metadata FROM audit_logs WHERE process_id = $1 AND action LIKE 'document.%' ORDER BY occurred_at, id",
      [processId],
    ),
    events: await db.admin<Row>(
      "SELECT event_type, routing_key, status::text FROM outbox_events WHERE process_id = $1 AND event_type LIKE 'Document%' ORDER BY occurred_at, id",
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
        { token: DFD_CLOCK, value: () => NOW },
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
      cx: await catalogId(A, 'UNIT_OF_MEASURE', 'CX'),
      un: await catalogId(A, 'UNIT_OF_MEASURE', 'UN'),
    };
  });

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso] DFD-02 numa transação: documento + DFD (id = documento), número, timeline, auditoria e DocumentCreated PENDING; DOC-07 grava os itens', async () => {
    const process = await createProcess();
    const before = await lastNumber();
    const created = await createDfd(process.id);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const dfd = (created.body as { data: DfdDto }).data;
    const code = `DFD ${String(before + 1).padStart(4, '0')}/2026`;
    expect(dfd).toMatchObject({
      code,
      status: 'DRAFT',
      documentId: dfd.id,
      requestDate: '2026-10-17',
    });
    expect(await lastNumber()).toBe(before + 1);

    const after = await effects(process.id);
    expect(after.documents).toEqual([{ id: dfd.id, code, status: 'DRAFT', version: 1 }]);
    expect(after.dfds).toEqual([
      {
        id: dfd.id,
        document_id: dfd.id,
        request_date: '2026-10-17',
        priority: 'MEDIUM',
        wizard_step: 'IDENTIFICATION',
      },
    ]);
    expect(after.timeline).toEqual([{ type: 'DOCUMENT_CREATED' }]);
    expect(after.audit.map((row) => row.action)).toEqual(['document.create']);
    // [Falha de integração] relay fora: o evento fica PENDING para publicação.
    expect(after.events).toEqual([
      { event_type: 'DocumentCreated', routing_key: 'document.created.dfd', status: 'PENDING' },
    ]);

    const gloves = await createItem(process.id, 'Luva de procedimento, tamanho M', catalog.cx);
    const syringes = await createItem(process.id, 'Seringa descartável 5 ml', catalog.un);
    const saved = await putItems(
      dfd.documentId,
      [
        { processItemId: gloves.id, quantity: '120' },
        { processItemId: syringes.id, quantity: '5000' },
      ],
      '"1"',
    );
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.headers.etag).toBe('"2"');
    expect(
      await db.admin<Row>(
        'SELECT quantity::text FROM document_items WHERE document_id = $1 ORDER BY sort_order',
        [dfd.documentId],
      ),
    ).toEqual([{ quantity: '120.0000' }, { quantity: '5000.0000' }]);
    expect((await effects(process.id)).documents).toMatchObject([{ version: 2 }]);
    // O item referenciado não pode ser excluído do processo (ITEM_IN_USE — US-006).
    const removal = await call(
      request(api.server).delete(`/api/v1/process-items/${gloves.id}`),
    ).set('If-Match', `"${String(gloves.version)}"`);
    expect(problemDetailsSchema.parse(removal.body).code).toBe('ITEM_IN_USE');
  });

  it('[Concorrência] 20 criações simultâneas no mesmo processo: 1 × 201 e 19 × 409, e o próximo número sem lacuna', async () => {
    const process = await createProcess();
    const before = await lastNumber();
    const responses = await Promise.all(Array.from({ length: 20 }, () => createDfd(process.id)));
    const statuses = responses.map((response) => response.status);
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(19);
    for (const response of responses.filter((item) => item.status === 409)) {
      expect(problemDetailsSchema.parse(response.body).code).toBe('DOCUMENT_ALREADY_EXISTS');
    }
    expect((await effects(process.id)).dfds).toHaveLength(1);
    expect(await lastNumber()).toBe(before + 1);
    const next = await createDfd((await createProcess()).id);
    expect((next.body as { data: DfdDto }).data.code).toBe(
      `DFD ${String(before + 2).padStart(4, '0')}/2026`,
    );
  });

  it('[Concorrência] duas gravações de itens com o mesmo If-Match: uma 200 e a outra 412 VERSION_CONFLICT', async () => {
    const process = await createProcess();
    const dfd = ((await createDfd(process.id)).body as { data: DfdDto }).data;
    const gloves = await createItem(process.id, 'Luva de procedimento, tamanho M', catalog.cx);
    const responses = await Promise.all([
      putItems(dfd.documentId, [{ processItemId: gloves.id, quantity: '1' }], '"1"'),
      putItems(dfd.documentId, [{ processItemId: gloves.id, quantity: '2' }], '"1"'),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 412]);
    expect((await effects(process.id)).documents).toMatchObject([{ version: 2 }]);
  });

  it('[Falha de banco] falha induzida DEPOIS de numerar e criar o documento desfaz tudo, inclusive o número', async () => {
    const process = await createProcess();
    const before = await lastNumber();
    await db.admin(`
      CREATE FUNCTION test_fail_dfd_insert() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        RAISE EXCEPTION 'falha induzida no teste';
      END $fn$;
      CREATE TRIGGER test_fail_dfd_insert BEFORE INSERT ON dfds
        FOR EACH ROW EXECUTE FUNCTION test_fail_dfd_insert();`);
    try {
      const failed = await createDfd(process.id);
      expect(failed.status).toBe(500);
      expect(await effects(process.id)).toEqual({
        documents: [],
        dfds: [],
        timeline: [],
        audit: [],
        events: [],
      });
      expect(await lastNumber()).toBe(before);
    } finally {
      await db.admin(
        'DROP TRIGGER test_fail_dfd_insert ON dfds; DROP FUNCTION test_fail_dfd_insert();',
      );
    }
    // Sem a falha, o mesmo processo recebe o próximo número (nenhum foi consumido).
    const created = await createDfd(process.id);
    expect((created.body as { data: DfdDto }).data.code).toBe(
      `DFD ${String(before + 1).padStart(4, '0')}/2026`,
    );
  });

  it('[Tenant incorreto] DFD e itens de A pelo tenant B: 404 sem alterar; RLS, checks e índice único de dfds/document_items', async () => {
    const process = await createProcess();
    const dfd = ((await createDfd(process.id)).body as { data: DfdDto }).data;
    const gloves = await createItem(process.id, 'Luva de procedimento, tamanho M', catalog.cx);
    const before = await effects(process.id);

    const asBeto = (test: request.Test) => call(test, SUBJECTS.beto);
    const notFound = await asBeto(request(api.server).get(`/api/v1/dfds/${dfd.id}`));
    expect(notFound.status).toBe(404);
    expect(problemDetailsSchema.parse(notFound.body).code).toBe('DFD_NOT_FOUND');
    expect(JSON.stringify(notFound.body)).not.toContain(dfd.code ?? '#');
    for (const response of [
      await asBeto(request(api.server).get(`/api/v1/documents/${dfd.documentId}/items`)),
      await asBeto(request(api.server).put(`/api/v1/documents/${dfd.documentId}/items`))
        .set('If-Match', '"1"')
        .send({ items: [] }),
      await asBeto(request(api.server).get(`/api/v1/processes/${process.id}/dfds`)),
      await asBeto(request(api.server).post(`/api/v1/processes/${process.id}/dfds`))
        .set('Idempotency-Key', randomUUID())
        .send({}),
    ]) {
      expect(response.status).toBe(404);
    }
    expect(await effects(process.id)).toEqual(before);

    // RLS: com `app.tenant_id` de B, nenhum DFD nem item de A é visível nem alterável.
    const client = db.client('cf_app');
    try {
      const visible = await asTenant(B, () =>
        client.$tenantTransaction(
          (tx) => tx.$queryRaw<{ count: number }[]>`
            SELECT (SELECT count(*) FROM dfds WHERE id = ${dfd.id}::uuid)::int
                 + (SELECT count(*) FROM document_items WHERE document_id = ${dfd.documentId}::uuid)::int
                   AS count`,
        ),
      );
      expect(visible).toEqual([{ count: 0 }]);
      const updated = await asTenant(B, () =>
        client.$tenantTransaction(
          (tx) => tx.$executeRaw`
            UPDATE dfds SET object_summary = 'Alterado por LEAK-B' WHERE id = ${dfd.id}::uuid`,
        ),
      );
      expect(updated).toBe(0);
    } finally {
      await client.$disconnect();
    }

    const insertItem = (quantity: string) =>
      db.admin(
        `INSERT INTO document_items (id, tenant_id, document_id, process_item_id, quantity)
         VALUES ($1, $2, $3, $4, $5::numeric)`,
        [randomUUID(), A, dfd.documentId, gloves.id, quantity],
      );
    // CHECK `quantity > 0` e índice único por (documento, item do processo).
    await expect(insertItem('0')).rejects.toThrow();
    await insertItem('1');
    await expect(insertItem('2')).rejects.toThrow();
    // FK composta: item de documento de A no tenant B é recusado pelo banco.
    await expect(
      db.admin(
        `INSERT INTO document_items (id, tenant_id, document_id, process_item_id, quantity)
         VALUES ($1, $2, $3, $4, 1)`,
        [randomUUID(), B, dfd.documentId, gloves.id],
      ),
    ).rejects.toThrow();
    // CHECKs do cabeçalho: previsão antes da data e documento imutável.
    await expect(
      db.admin('UPDATE dfds SET expected_date = request_date - 1 WHERE id = $1', [dfd.id]),
    ).rejects.toThrow();
    await expect(
      db.admin('UPDATE dfds SET document_id = $2 WHERE id = $1', [dfd.id, randomUUID()]),
    ).rejects.toThrow();
  });
});
