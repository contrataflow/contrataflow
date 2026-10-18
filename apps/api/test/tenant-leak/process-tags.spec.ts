// Etiquetas do processo sobre PostgreSQL real (US-007 · Sucesso, Duplicidade, Concorrência, Falha de
// banco, Falha de integração, Tenant incorreto): a API inteira como `cf_app` (RLS) com os seeders
// reais do provisionamento, o processo criado pelo PRC-02 e as etiquetas pelos TAG-01..03 e PRC-18.
// Prova o filtro `tagId` da lista no SQL (`process_tags_tag_idx`), a versão do processo e o evento
// `PENDING` só quando há diferença, o cadastro sem mexer nos processos (RN-PROC-90), o índice único
// `lower(name)` sob criação paralela, a trava do processo em dois PUT simultâneos com o mesmo
// `If-Match`, a transação única por falha induzida DEPOIS de gravar `process_tags` (nada persiste) e
// o isolamento: etiqueta de B nunca aplicada, PATCH/RLS/FKs compostas entre tenants e sem DELETE
// para a aplicação. `pnpm --filter @contrataflow/api test:tenant-leak`.
import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type { ProcessDto, ProcessListItemDto, TagDto } from '@contrataflow/validation';
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

const A = '0192c007-0000-7000-8000-00000000010a';
const B = '0192c007-0000-7000-8000-00000000010b';
const ORG_A = '0192c007-0000-7000-8000-0000000010a0';
const ORG_B = '0192c007-0000-7000-8000-0000000010b0';
const OBRAS = '0192c007-0000-7000-8000-0000000010a1';
const MANUTENCAO = '0192c007-0000-7000-8000-0000000010a2';
const OBRAS_B = '0192c007-0000-7000-8000-0000000010b1';
const ANA = '0192c007-0000-7000-8000-0000000010c1';
const PATRICIA = '0192c007-0000-7000-8000-0000000010c2';
const BETO = '0192c007-0000-7000-8000-0000000010c3';
const ANA_M = '0192c007-0000-7000-8000-0000000010d1';
const PATRICIA_M = '0192c007-0000-7000-8000-0000000010d2';
const NOW = new Date('2026-10-05T15:00:00.000Z');
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [ANA]: ['REQUISITANTE'],
  [PATRICIA]: ['GESTOR_CONTRATACOES'],
  [BETO]: ['GESTOR_CONTRATACOES'],
};

const SUBJECTS = {
  ana: 'sub-ana-us007',
  patricia: 'sub-patricia-us007',
  beto: 'sub-beto-us007',
} as const;

const path = (...ids: string[]) => `/${ids.join('/')}/`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code, timezone) VALUES
  ('${A}', 'sao-jose-us007', 'Prefeitura de São José', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo'),
  ('${B}', 'prefeitura-b-us007', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC', 'America/Sao_Paulo');
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
  ('${PATRICIA}', '${SUBJECTS.patricia}', 'patricia@a.test', true, 'Patrícia Gomes'),
  ('${BETO}', '${SUBJECTS.beto}', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('${ANA_M}', '${A}', '${ANA}', 'INTERNAL', 'ACTIVE'),
  ('${PATRICIA_M}', '${A}', '${PATRICIA}', 'INTERNAL', 'ACTIVE'),
  ('0192c007-0000-7000-8000-0000000010d3', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO membership_departments (id, tenant_id, membership_id, department_id, is_primary) VALUES
  ('0192c007-0000-7000-8000-0000000010e1', '${A}', '${ANA_M}', '${MANUTENCAO}', true);
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

describe('Feature: Etiquetas do processo sobre PostgreSQL (US-007)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let catalog: { contractingType: string; origin: string };

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
  const createTag = (name: string, subject: string = SUBJECTS.patricia, color?: string) =>
    call(request(api.server).post('/api/v1/tags'), subject)
      .set('Idempotency-Key', randomUUID())
      .send({ name, ...(color === undefined ? {} : { color }) });
  const tagOk = async (name: string, subject: string = SUBJECTS.patricia, color?: string) => {
    const response = await createTag(name, subject, color);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return (response.body as { data: TagDto }).data;
  };
  const putTags = (
    processId: string,
    tagIds: readonly string[],
    ifMatch: string,
    subject: string = SUBJECTS.ana,
  ) =>
    call(request(api.server).put(`/api/v1/processes/${processId}/tags`), subject)
      .set('If-Match', ifMatch)
      .send({ tagIds });
  const codeOf = (response: request.Response) => problemDetailsSchema.parse(response.body).code;
  /** Tudo que as etiquetas gravam do processo (para provar o rollback). */
  const effects = async (processId: string) => ({
    links: await db.admin<Row>(
      'SELECT tag_id FROM process_tags WHERE process_id = $1 ORDER BY tag_id',
      [processId],
    ),
    process: (await db.admin<Row>('SELECT version FROM processes WHERE id = $1', [processId]))[0],
    timeline: await db.admin<Row>(
      "SELECT params FROM process_timeline_entries WHERE process_id = $1 AND type = 'PROCESS_UPDATED' ORDER BY occurred_at, id",
      [processId],
    ),
    audit: await db.admin<Row>(
      "SELECT metadata FROM audit_logs WHERE entity_id = $1 AND action = 'process.tags_update' ORDER BY occurred_at, id",
      [processId],
    ),
    events: await db.admin<Row>(
      "SELECT payload, status::text FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'ProcessUpdated' ORDER BY occurred_at, id",
      [processId],
    ),
  });
  const catalogId = async (tenantId: string, type: string, code: string) => {
    const [row] = await db.admin<{ id: string }>(
      'SELECT id FROM catalog_items WHERE tenant_id = $1 AND catalog_type = $2 AND code = $3',
      [tenantId, type, code],
    );
    if (!row) throw new Error(`${type}/${code} ausente`);
    return row.id;
  };

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
    };
  });

  afterAll(async () => {
    await api.close();
    await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso] cadastro, aplicação com diferença, filtro da lista no SQL, painel, e renomear/desativar sem mexer nos processos', async () => {
    const created = await create();
    const obras = await tagOk(`Obras ${words(1)}`, SUBJECTS.patricia, '#B45309');
    const federal = await tagOk(`Federal ${words(1)}`);
    expect(federal.color).toBe('#64748B');

    const applied = await putTags(created.id, [obras.id, federal.id], '"1"');
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.headers.etag).toBe('"2"');
    const after = await effects(created.id);
    expect(after.process).toEqual({ version: 2 });
    expect(after.links).toHaveLength(2);
    expect(after.timeline.at(-1)).toMatchObject({ params: { fields: ['tags'] } });
    expect(after.audit).toHaveLength(1);
    // [Falha de integração] relay fora: o evento fica PENDING, só com os nomes dos campos.
    expect(after.events).toEqual([
      { payload: { changedFields: ['tags'], version: 2 }, status: 'PENDING' },
    ]);

    // Filtro `tagId` (OU), etiquetas na linha e no painel.
    const filtered = await call(request(api.server).get(`/api/v1/processes?tagId=${obras.id}`));
    expect(filtered.status, JSON.stringify(filtered.body)).toBe(200);
    const rows = (filtered.body as { data: ProcessListItemDto[] }).data;
    expect(rows.map((row) => row.id)).toEqual([created.id]);
    expect(rows[0]?.tags.map((tag) => tag.id).sort()).toEqual([obras.id, federal.id].sort());
    const other = await tagOk(`Outra ${words(1)}`);
    const none = await call(request(api.server).get(`/api/v1/processes?tagId=${other.id}`));
    expect((none.body as { data: unknown[] }).data).toEqual([]);
    const summary = await call(request(api.server).get(`/api/v1/processes/${created.id}/summary`));
    expect(
      (summary.body as { data: { header: { tags: { id: string }[] } } }).data.header.tags,
    ).toHaveLength(2);

    // RN-PROC-90: renomear e desativar não mexem na versão do processo nem geram evento dele.
    const renamed = await call(
      request(api.server).patch(`/api/v1/tags/${obras.id}`),
      SUBJECTS.patricia,
    )
      .set('If-Match', '"1"')
      .send({ name: `Obras renomeada ${words(1)}` });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    const off = await call(
      request(api.server).patch(`/api/v1/tags/${federal.id}`),
      SUBJECTS.patricia,
    )
      .set('If-Match', '"1"')
      .send({ isActive: false });
    expect(off.status).toBe(200);
    expect((await effects(created.id)).process).toEqual({ version: 2 });
    expect((await effects(created.id)).events).toHaveLength(1);
    const listed = await call(request(api.server).get(`/api/v1/processes?tagId=${federal.id}`));
    expect((listed.body as { data: ProcessListItemDto[] }).data[0]?.tags).toContainEqual(
      expect.objectContaining({ id: federal.id, isActive: false }),
    );

    // Conjunto idêntico: 200 sem versão, evento nem auditoria.
    const again = await putTags(created.id, [obras.id, federal.id], '"2"');
    expect(again.status).toBe(200);
    expect(again.headers.etag).toBe('"2"');
    expect((await effects(created.id)).events).toHaveLength(1);
    expect((await effects(created.id)).audit).toHaveLength(1);
    expect((await effects(created.id)).timeline).toHaveLength(1);
  });

  it('[Duplicidade] nome repetido sem diferenciar maiúsculas: índice lower(name) sob criação paralela', async () => {
    const name = `Paralela ${words(1)}`;
    const responses = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        createTag(index % 2 === 0 ? name : name.toUpperCase()),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409, 409, 409, 409]);
    const rows = await db.admin<Row>(
      'SELECT id FROM tags WHERE tenant_id = $1 AND lower(name) = $2',
      [A, name.toLowerCase()],
    );
    expect(rows).toHaveLength(1);
    // O mesmo nome em outro tenant é permitido (o índice é por tenant).
    expect((await createTag(name, SUBJECTS.beto)).status).toBe(201);
  });

  it('[Concorrência] dois PUT simultâneos com o mesmo If-Match: um vence, o outro 412 e o conjunto é o do vencedor', async () => {
    const created = await create();
    const first = await tagOk(`Disputa ${words(1)}`);
    const second = await tagOk(`Disputa ${words(1)}`);
    const [one, two] = await Promise.all([
      putTags(created.id, [first.id], '"1"'),
      putTags(created.id, [second.id], '"1"'),
    ]);
    expect([one.status, two.status].sort()).toEqual([200, 412]);
    expect(codeOf(one.status === 412 ? one : two)).toBe('VERSION_CONFLICT');
    const after = await effects(created.id);
    expect(after.process).toEqual({ version: 2 });
    expect(after.links).toHaveLength(1);
    expect(after.audit).toHaveLength(1);
  });

  it('[Falha de banco] falha induzida DEPOIS de gravar process_tags desfaz etiquetas, versão, timeline, auditoria e evento', async () => {
    const created = await create();
    const tag = await tagOk(`Rollback ${words(1)}`);
    await db.admin(`
      CREATE FUNCTION test_fail_tags_timeline() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.type = 'PROCESS_UPDATED' THEN
          RAISE EXCEPTION 'falha induzida no teste';
        END IF;
        RETURN NEW;
      END $fn$;
      CREATE TRIGGER test_fail_tags_timeline BEFORE INSERT ON process_timeline_entries
        FOR EACH ROW EXECUTE FUNCTION test_fail_tags_timeline();`);
    try {
      const before = await effects(created.id);
      const failed = await putTags(created.id, [tag.id], '"1"');
      expect(failed.status).toBe(500);
      expect(await effects(created.id)).toEqual(before);
    } finally {
      await db.admin(
        'DROP TRIGGER test_fail_tags_timeline ON process_timeline_entries; DROP FUNCTION test_fail_tags_timeline();',
      );
    }
  });

  it('[Tenant incorreto] etiqueta de B: PUT 422, PATCH 404; RLS e FKs compostas isolam; a aplicação nunca exclui', async () => {
    const created = await create();
    const foreign = await tagOk(`Tag de B ${words(1)}`, SUBJECTS.beto);
    const before = await effects(created.id);

    const refused = await putTags(created.id, [foreign.id], '"1"');
    expect(refused.status).toBe(422);
    expect(
      problemDetailsSchema.parse(refused.body).errors.map((error) => [error.field, error.code]),
    ).toEqual([['tagIds', 'REFERENCE_NOT_FOUND']]);
    const patched = await call(
      request(api.server).patch(`/api/v1/tags/${foreign.id}`),
      SUBJECTS.patricia,
    )
      .set('If-Match', '"1"')
      .send({ name: 'Invadida' });
    expect(patched.status).toBe(404);
    expect(codeOf(patched)).toBe('NOT_FOUND');
    // Processo de A pelo tenant B: 404 e nada muda.
    const crossProcess = await putTags(created.id, [], '"1"', SUBJECTS.beto);
    expect(crossProcess.status).toBe(404);
    expect(codeOf(crossProcess)).toBe('PROCESS_NOT_FOUND');
    expect(await effects(created.id)).toEqual(before);
    const names = (
      (await call(request(api.server).get('/api/v1/tags?includeInactive=true'), SUBJECTS.patricia))
        .body as { data: TagDto[] }
    ).data.map((tag) => tag.id);
    expect(names).not.toContain(foreign.id);

    const client = db.client('cf_app');
    try {
      // RLS: com `app.tenant_id` de B, as etiquetas e associações de A não existem.
      const own = await tagOk(`Tag de A ${words(1)}`);
      await putTags(created.id, [own.id], '"1"');
      const visible = await asTenant(B, () =>
        client.$tenantTransaction(
          (tx) => tx.$queryRaw<{ tags: number; links: number }[]>`
            SELECT (SELECT count(*)::int FROM tags WHERE id = ${own.id}::uuid) AS tags,
                   (SELECT count(*)::int FROM process_tags WHERE tag_id = ${own.id}::uuid) AS links`,
        ),
      );
      expect(visible).toEqual([{ tags: 0, links: 0 }]);
      const updated = await asTenant(B, () =>
        client.$tenantTransaction(
          (tx) => tx.$executeRaw`UPDATE tags SET name = 'LEAK-B' WHERE id = ${own.id}::uuid`,
        ),
      );
      expect(updated).toBe(0);
      // Etiquetas nunca são excluídas: a aplicação não tem DELETE em `tags` (RN-PROC-86).
      await expect(
        asTenant(A, () =>
          client.$tenantTransaction(
            (tx) => tx.$executeRaw`DELETE FROM tags WHERE id = ${own.id}::uuid`,
          ),
        ),
      ).rejects.toThrow();
    } finally {
      await client.$disconnect();
    }
    // FK composta: associação de A com etiqueta de B é recusada pelo banco.
    await expect(
      db.admin('INSERT INTO process_tags (tenant_id, process_id, tag_id) VALUES ($1, $2, $3)', [
        A,
        created.id,
        foreign.id,
      ]),
    ).rejects.toThrow();
    // Checks de nome e cor.
    await expect(
      db.admin("INSERT INTO tags (id, tenant_id, name, color) VALUES ($1, $2, 'a', '#64748B')", [
        randomUUID(),
        A,
      ]),
    ).rejects.toThrow();
    await expect(
      db.admin(
        "INSERT INTO tags (id, tenant_id, name, color) VALUES ($1, $2, 'Cor ruim', 'azul')",
        [randomUUID(), A],
      ),
    ).rejects.toThrow();
  });
});
