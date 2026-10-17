// Itens da contratação sobre PostgreSQL real (US-006 · Sucesso, Tenant incorreto, Concorrência,
// Falha de banco, Falha de integração): a API inteira como `cf_app` (RLS) com os seeders reais do
// provisionamento, o processo criado pelo PRC-02 e os itens pelos PRC-13..17. Prova a trava do
// processo serializando inclusões paralelas (números 1..n sem repetição, inclusive de duas pessoas
// com custódia pela fila da unidade), a renumeração em duas fases sem violar o índice único parcial,
// o incremento da versão do processo, a transação única por falha induzida DEPOIS de gravar o item
// (nada persiste: item, versão, timeline, auditoria e outbox), o evento `PENDING` e a RLS (item e
// unidade de medida de outro tenant). `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type { ProcessDto, ProcessItemDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { MEMBERSHIP_PORT, TOKEN_VERIFIER } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';

import { CATALOG_CLOCK } from '../../src/modules/catalog/application/catalog-ports.js';
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

const A = '0192c006-0000-7000-8000-00000000010a';
const B = '0192c006-0000-7000-8000-00000000010b';
const ORG_A = '0192c006-0000-7000-8000-0000000010a0';
const ORG_B = '0192c006-0000-7000-8000-0000000010b0';
const OBRAS = '0192c006-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c006-0000-7000-8000-0000000010a2';
const OBRAS_B = '0192c006-0000-7000-8000-0000000010b1';
const ANA = '0192c006-0000-7000-8000-0000000010c1';
const CARLA = '0192c006-0000-7000-8000-0000000010c2';
const BETO = '0192c006-0000-7000-8000-0000000010c3';
const ANA_M = '0192c006-0000-7000-8000-0000000010d1';
const CARLA_M = '0192c006-0000-7000-8000-0000000010d2';
const NOW = new Date('2026-10-05T15:00:00.000Z');
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [CARLA]: ['REQUISITANTE'],
  [BETO]: ['GESTOR_CONTRATACOES'],
};

const SUBJECTS = {
  ana: 'sub-ana-us006',
  carla: 'sub-carla-us006',
  beto: 'sub-beto-us006',
} as const;

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us006', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us006', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
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
  ('${ANA}', '${SUBJECTS.ana}', 'ana@a.test', true, 'Ana Souza'),
  ('${CARLA}', '${SUBJECTS.carla}', 'carla@a.test', true, 'Carla Dias'),
  ('${BETO}', '${SUBJECTS.beto}', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('${CARLA_M}', '${A}', '${CARLA}', 'INTERNAL', 'ACTIVE'),
  ('0192c006-0000-7000-8000-0000000010d3', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c006-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true),
  ('0192c006-0000-7000-8000-0000000010e2', '${A}', '${CARLA_M}', '${MANUTENCAO}', true);
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

describe('Feature: Gerenciar itens da contratação sobre PostgreSQL (US-006)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let catalog: { contractingType: string; origin: string; un: string; m3: string; unB: string };

  const tenantOf = (subject: string): string => (subject === SUBJECTS.beto ? B : A);
  const call = (test: request.Test, subject: string = SUBJECTS.ana) =>
    test
      .set('Authorization', api.bearer(subject, { amr: MFA }))
      .set('X-Tenant-Id', tenantOf(subject));
  const create = async (): Promise<ProcessDto> => {
    const response = await call(request(api.server).post('/api/v1/processes'))
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Compra ${words(2)}`,
        object: `Objeto ${words(3)}`,
        contractingTypeId: catalog.contractingType,
        requestingSecretariatId: OBRAS,
        requestingDepartmentId: MANUTENCAO,
        originId: catalog.origin,
        pcaStatus: 'NOT_APPLICABLE',
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return (response.body as { data: ProcessDto }).data;
  };
  const add = (
    processId: string,
    body: Record<string, unknown> = {},
    subject: string = SUBJECTS.ana,
  ) =>
    call(request(api.server).post(`/api/v1/processes/${processId}/items`), subject)
      .set('Idempotency-Key', randomUUID())
      .send({
        description: `Item ${words(1)}`,
        kind: 'GOOD',
        unitOfMeasureId: catalog.un,
        ...body,
      });
  const list = async (processId: string) => {
    const response = await call(request(api.server).get(`/api/v1/processes/${processId}/items`));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return {
      items: (response.body as { data: ProcessItemDto[] }).data,
      etag: response.headers.etag ?? '',
    };
  };
  const catalogId = async (tenantId: string, type: string, code: string) => {
    const [row] = await db.admin<{ id: string }>(
      'SELECT id FROM catalog_items WHERE tenant_id = $1 AND catalog_type = $2 AND code = $3',
      [tenantId, type, code],
    );
    if (!row) throw new Error(`${type}/${code} ausente`);
    return row.id;
  };
  /** Tudo que os itens gravam do processo (para provar o rollback). */
  const effects = async (processId: string) => ({
    items: await db.admin<Row>(
      `SELECT id, sequence, description, deleted_at IS NOT NULL AS deleted, version
         FROM process_items WHERE process_id = $1 ORDER BY sequence, id`,
      [processId],
    ),
    process: (await db.admin<Row>('SELECT version FROM processes WHERE id = $1', [processId]))[0],
    timeline: await db.admin<Row>(
      "SELECT params FROM process_timeline_entries WHERE process_id = $1 AND type = 'ITEMS_CHANGED' ORDER BY occurred_at, id",
      [processId],
    ),
    audit: await db.admin<Row>(
      "SELECT metadata FROM audit_logs WHERE entity_id = $1 AND action = 'process.items_update' ORDER BY occurred_at, id",
      [processId],
    ),
    events: await db.admin<Row>(
      "SELECT payload, status::text FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'ProcessItemsChanged' ORDER BY occurred_at, id",
      [processId],
    ),
  });

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
      DATABASE_POOL_SIZE: '10',
    });
    api = await createTestApi({
      config,
      providers: [
        { token: MEMBERSHIP_PORT, value: membership },
        { token: PROCESS_CLOCK, value: () => NOW },
        { token: CATALOG_CLOCK, value: () => NOW },
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
    await runTenantSeeders(api, A);
    await runTenantSeeders(api, B);
    catalog = {
      contractingType: await catalogId(A, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
      origin: await catalogId(A, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
      un: await catalogId(A, 'UNIT_OF_MEASURE', 'UN'),
      m3: await catalogId(A, 'UNIT_OF_MEASURE', 'M3'),
      unB: await catalogId(B, 'UNIT_OF_MEASURE', 'UN'),
    };
  });

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso] inclusões com lote, exclusão sem renumerar e renumeração em duas fases: versão do processo, timeline, auditoria e eventos PENDING', async () => {
    const created = await create();
    const one = await add(created.id, { lotNumber: 1, lotName: 'Materiais de construção' });
    expect(one.status, JSON.stringify(one.body)).toBe(201);
    const two = await add(created.id, { unitOfMeasureId: catalog.m3, lotNumber: 1 });
    const three = await add(created.id);
    const ids = [one, two, three].map(
      (response) => (response.body as { data: ProcessItemDto }).data.id,
    );
    expect((two.body as { data: ProcessItemDto }).data).toMatchObject({
      sequence: 2,
      lotName: 'Materiais de construção',
      unitOfMeasure: { id: catalog.m3, label: 'Metro cúbico' },
    });

    const removed = await call(
      request(api.server).delete(`/api/v1/process-items/${ids[1] ?? ''}`),
    ).set('If-Match', '"1"');
    expect(removed.status, JSON.stringify(removed.body)).toBe(204);
    const before = await list(created.id);
    expect(before.items.map((entry) => entry.sequence)).toEqual([1, 3]);
    // Criação (1) + 3 inclusões + 1 exclusão = versão 5.
    expect(before.etag).toBe('"5"');

    // Inverte a ordem: 3→1 e 1→2 exigem as duas fases (o 1 ainda ocupado na primeira escrita).
    const reordered = await call(
      request(api.server).post(`/api/v1/processes/${created.id}/items/reorder`),
    )
      .set('If-Match', before.etag)
      .send({ itemIds: [ids[2], ids[0]] });
    expect(reordered.status, JSON.stringify(reordered.body)).toBe(200);
    expect(reordered.headers.etag).toBe('"6"');

    const after = await effects(created.id);
    expect(after.process).toEqual({ version: 6 });
    expect(
      after.items.filter((row) => row.deleted !== true).map((row) => [row.id, row.sequence]),
    ).toEqual([
      [ids[2], 1],
      [ids[0], 2],
    ]);
    expect(after.items.find((row) => row.id === ids[1])).toMatchObject({
      deleted: true,
      version: 2,
    });
    expect(after.timeline).toHaveLength(5);
    expect(after.audit.map((row) => (row.metadata as { operation: string }).operation)).toEqual([
      'ADD',
      'ADD',
      'ADD',
      'REMOVE',
      'REORDER',
    ]);
    // [Falha de integração] relay fora: os eventos ficam PENDING, só com ids e o total.
    expect(after.events.at(-1)).toEqual({
      payload: { added: [], updated: [ids[2], ids[0]], removed: [], itemsCount: 2 },
      status: 'PENDING',
    });
    expect(after.events.every((row) => row.status === 'PENDING')).toBe(true);
  });

  it('[Concorrência] 20 inclusões paralelas de duas pessoas com custódia pela fila da unidade: números 1..20 sem repetição', async () => {
    const created = await create();
    // Sem responsável: a custódia é da unidade atual (Ana e Carla lotadas em Manutenção — POL-01).
    await db.admin('UPDATE processes SET current_responsible_id = NULL WHERE id = $1', [
      created.id,
    ]);
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        add(created.id, {}, index % 2 === 0 ? SUBJECTS.ana : SUBJECTS.carla),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual(Array(20).fill(201));
    const sequences = (await effects(created.id)).items.map((row) => row.sequence);
    expect(sequences).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect((await effects(created.id)).process).toEqual({ version: 21 });
  });

  it('[Concorrência] ordem com If-Match desatualizado depois de outra inclusão: 412 VERSION_CONFLICT sem alterar nada', async () => {
    const created = await create();
    await add(created.id);
    const loaded = await list(created.id);
    await add(created.id);
    const current = await list(created.id);
    const stale = await call(
      request(api.server).post(`/api/v1/processes/${created.id}/items/reorder`),
    )
      .set('If-Match', loaded.etag)
      .send({ itemIds: current.items.map((entry) => entry.id).reverse() });
    expect(stale.status).toBe(412);
    expect(problemDetailsSchema.parse(stale.body).code).toBe('VERSION_CONFLICT');
    expect((await list(created.id)).items.map((entry) => entry.id)).toEqual(
      current.items.map((entry) => entry.id),
    );
  });

  it('[Falha de banco] falha induzida DEPOIS de gravar o item desfaz item, versão do processo, timeline, auditoria e evento', async () => {
    const created = await create();
    await db.admin(`
      CREATE FUNCTION test_fail_items_timeline() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.type = 'ITEMS_CHANGED' THEN
          RAISE EXCEPTION 'falha induzida no teste';
        END IF;
        RETURN NEW;
      END $fn$;
      CREATE TRIGGER test_fail_items_timeline BEFORE INSERT ON process_timeline_entries
        FOR EACH ROW EXECUTE FUNCTION test_fail_items_timeline();`);
    try {
      const before = await effects(created.id);
      const failed = await add(created.id);
      expect(failed.status).toBe(500);
      expect(await effects(created.id)).toEqual(before);
    } finally {
      await db.admin(
        'DROP TRIGGER test_fail_items_timeline ON process_timeline_entries; DROP FUNCTION test_fail_items_timeline();',
      );
    }
  });

  it('[Tenant incorreto] item de A pelo tenant B: 404 NOT_FOUND sem alterar; unidade de B: 422; RLS esconde os itens de A', async () => {
    const created = await create();
    const added = await add(created.id);
    const itemId = (added.body as { data: ProcessItemDto }).data.id;
    const before = await effects(created.id);

    const patched = await call(
      request(api.server).patch(`/api/v1/process-items/${itemId}`),
      SUBJECTS.beto,
    )
      .set('If-Match', '"1"')
      .send({ description: 'Alterado por B' });
    expect(patched.status).toBe(404);
    expect(problemDetailsSchema.parse(patched.body).code).toBe('NOT_FOUND');
    const deleted = await call(
      request(api.server).delete(`/api/v1/process-items/${itemId}`),
      SUBJECTS.beto,
    ).set('If-Match', '"1"');
    expect(deleted.status).toBe(404);
    const listed = await call(
      request(api.server).get(`/api/v1/processes/${created.id}/items`),
      SUBJECTS.beto,
    );
    expect(listed.status).toBe(404);
    expect(problemDetailsSchema.parse(listed.body).code).toBe('PROCESS_NOT_FOUND');
    expect(await effects(created.id)).toEqual(before);

    const foreign = await add(created.id, { unitOfMeasureId: catalog.unB });
    expect(foreign.status).toBe(422);
    expect(
      problemDetailsSchema.parse(foreign.body).errors.map((error) => [error.field, error.code]),
    ).toEqual([['unitOfMeasureId', 'REFERENCE_NOT_FOUND']]);

    // RLS: com `app.tenant_id` de B, nenhum item de A é visível nem alterável.
    const client = db.client('cf_app');
    try {
      const visible = await asTenant(B, () =>
        client.$tenantTransaction(
          (tx) => tx.$queryRaw<{ count: number }[]>`
            SELECT count(*)::int AS count FROM process_items WHERE id = ${itemId}::uuid`,
        ),
      );
      expect(visible).toEqual([{ count: 0 }]);
      const updated = await asTenant(B, () =>
        client.$tenantTransaction(
          (tx) => tx.$executeRaw`
            UPDATE process_items SET description = 'LEAK-B' WHERE id = ${itemId}::uuid`,
        ),
      );
      expect(updated).toBe(0);
    } finally {
      await client.$disconnect();
    }
    // FK composta: item de A com unidade de B é recusado pelo banco.
    await expect(
      db.admin(
        `INSERT INTO process_items (id, tenant_id, process_id, sequence, kind, description, unit_of_measure_id)
         VALUES ($1, $2, $3, 99, 'GOOD', 'Item com unidade de B', $4)`,
        [randomUUID(), A, created.id, catalog.unB],
      ),
    ).rejects.toThrow();
  });
});
