// Catálogos parametrizáveis na API inteira sobre PostgreSQL real (US-104 · Tenant incorreto,
// Permissão, Duplicidade, Concorrência, Falha de banco, Falha de integração): administradores nos
// tenants A e B, auditoria e outbox reais na mesma transação, RLS de `catalog_items`, índice único,
// gatilho de imutabilidade, FK composta do pai, concorrência real (edição e reordenação) e o seeder
// `catalog.items` reaplicado a tenant existente. Perfis ainda não existem como registro (US-096): o
// vínculo ganha `roleKeys` por uma porta de teste sobre a `MembershipPort` real.
// `pnpm --filter @contrataflow/api test:tenant-leak`.
import { problemDetailsSchema } from '@contrataflow/validation';
import type { CatalogItemDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { FakeJwksProvider } from '#modules/identity/infrastructure/fake-jwks.provider.js';
import { PrismaIdentityRepository } from '#modules/identity/infrastructure/prisma-identity.repository.js';
import { TOKEN_VERIFIER, MEMBERSHIP_PORT } from '#shared/auth/ports.js';
import type { MembershipPort, MembershipRecord } from '#shared/auth/ports.js';

import { ApplyTenantSeedersCommand } from '../../src/modules/tenancy/application/apply-tenant-seeders.command.js';
import { asTenant, startTestDatabase } from '../database/support/postgres.js';
import type { TestDatabase } from '../database/support/postgres.js';
import {
  createTestApi,
  TEST_ISSUER,
  TEST_SIGNING_KEY,
  testConfig,
} from '../support/api-test-app.js';
import type { TestApi } from '../support/api-test-app.js';

const A = '0192c000-0000-7000-8000-00000000104a';
const B = '0192c000-0000-7000-8000-00000000104b';
const MARTA = '0192c000-0000-7000-8000-0000000104a1';
const OTAVIO = '0192c000-0000-7000-8000-0000000104a2';
const LUCIA = '0192c000-0000-7000-8000-0000000104a3';
const BETO = '0192c000-0000-7000-8000-0000000104b1';
const MFA = ['pwd', 'otp'];

const ROLES: Readonly<Record<string, readonly string[]>> = {
  [MARTA]: ['ADMIN_ORGAO'],
  [OTAVIO]: ['ADMIN_ORGAO'],
  // Sem CATALOG_MANAGE (GESTOR_CONTRATACOES tem — permissions.md).
  [LUCIA]: ['REQUISITANTE'],
  [BETO]: ['ADMIN_ORGAO'],
};

const MODALITY_A = {
  pregao: '0192c000-0000-7000-8000-0000000124a1',
  dispensa: '0192c000-0000-7000-8000-0000000124a2',
  leilao: '0192c000-0000-7000-8000-0000000124a3',
};
const RISK_A = Array.from(
  { length: 6 },
  (_, index) => `0192c000-0000-7000-8000-0000000134a${index + 1}`,
);
const CONTRACTING_A = '0192c000-0000-7000-8000-0000000144a1';
const RISK_B = '0192c000-0000-7000-8000-0000000134b1';
const MODALITY_B = '0192c000-0000-7000-8000-0000000124b1';

const MODALITY_METADATA = `'{"legalBasis":"Lei 14.133/2021, art. 28, I","isDirectContracting":false}'`;

const FIXTURE_SQL = `
INSERT INTO tenants (id, slug, name, type, status, state_code) VALUES
  ('${A}', 'prefeitura-a-cat', 'Prefeitura A', 'MUNICIPALITY', 'ACTIVE', 'SC'),
  ('${B}', 'prefeitura-b-cat', 'Prefeitura B LEAK-B', 'MUNICIPALITY', 'ACTIVE', 'SC');
INSERT INTO users (id, external_subject, email, email_verified, name) VALUES
  ('${MARTA}', 'sub-marta', 'marta@a.test', true, 'Marta Ribeiro'),
  ('${OTAVIO}', 'sub-otavio', 'otavio@a.test', true, 'Otávio Campos'),
  ('${LUCIA}', 'sub-lucia', 'lucia@a.test', true, 'Lúcia Matos'),
  ('${BETO}', 'sub-beto', 'beto@b.test', true, 'Beto LEAK-B');
INSERT INTO tenant_memberships (id, tenant_id, user_id, type, status) VALUES
  ('0192c000-0000-7000-8000-0000000114a1', '${A}', '${MARTA}', 'INTERNAL', 'ACTIVE'),
  ('0192c000-0000-7000-8000-0000000114a2', '${A}', '${OTAVIO}', 'INTERNAL', 'ACTIVE'),
  ('0192c000-0000-7000-8000-0000000114a3', '${A}', '${LUCIA}', 'INTERNAL', 'ACTIVE'),
  ('0192c000-0000-7000-8000-0000000114b1', '${B}', '${BETO}', 'INTERNAL', 'ACTIVE');
INSERT INTO catalog_items
  (id, tenant_id, catalog_type, code, label, is_system, is_active, sort_order, metadata, version) VALUES
  ('${MODALITY_A.pregao}', '${A}', 'MODALITY', 'PREGAO', 'Pregão', true, true, 1, ${MODALITY_METADATA}, 3),
  ('${MODALITY_A.dispensa}', '${A}', 'MODALITY', 'DISPENSA', 'Dispensa', true, true, 2, ${MODALITY_METADATA}, 1),
  ('${MODALITY_A.leilao}', '${A}', 'MODALITY', 'LEILAO', 'Leilão', true, true, 3, ${MODALITY_METADATA}, 1),
  ('${CONTRACTING_A}', '${A}', 'CONTRACTING_TYPE', 'AQUISICAO_BENS', 'Aquisição de bens', true, true, 1, '{"itemKinds":["GOOD"]}', 1),
  ('${RISK_B}', '${B}', 'RISK_CATEGORY', 'RISCO_LEAK_B', 'Risco LEAK-B', false, true, 1, '{}', 4),
  ('${MODALITY_B}', '${B}', 'MODALITY', 'PREGAO', 'Pregão LEAK-B', true, true, 1, ${MODALITY_METADATA}, 1);
${RISK_A.map(
  (id, index) =>
    `INSERT INTO catalog_items (id, tenant_id, catalog_type, code, label, is_system, sort_order, metadata)
     VALUES ('${id}', '${A}', 'RISK_CATEGORY', 'RISCO_${index + 1}', 'Risco ${index + 1}', false, ${(index + 1) * 10}, '{}');`,
).join('\n')}
`;

/** Perfis do vínculo por usuário, sobre a `MembershipPort` real (perfis como registro: US-096). */
class RoleInjectingMembershipPort implements MembershipPort {
  inner!: MembershipPort;

  async findByUserAndTenant(userId: string, tenantId: string): Promise<MembershipRecord | null> {
    const membership = await this.inner.findByUserAndTenant(userId, tenantId);
    return membership ? { ...membership, roleKeys: ROLES[userId] ?? [] } : null;
  }
}

type Row = Readonly<Record<string, unknown>>;

describe('Feature: catálogos isolados por tenant sobre PostgreSQL (US-104)', () => {
  let db: TestDatabase;
  let api: TestApi;
  let dbStopped = false;

  const as = (subject: string, amr: readonly string[] = MFA) => api.bearer(subject, { amr });
  const itemsOf = (tenantId: string, catalogType?: string) =>
    db.admin<Row>(
      `SELECT id, catalog_type, code, label, description, is_system, is_active, sort_order,
              parent_id, metadata, version, created_by_id, updated_by_id
         FROM catalog_items
        WHERE tenant_id = $1 AND ($2::text IS NULL OR catalog_type::text = $2)
        ORDER BY catalog_type, sort_order, code`,
      [tenantId, catalogType ?? null],
    );
  const itemOf = async (tenantId: string, catalogType: string, code: string) =>
    (await itemsOf(tenantId, catalogType)).find((row) => row.code === code);
  const digestOf = async (tenantId: string) => {
    const [row] = await db.admin<{ digest: string }>(
      `SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS digest
         FROM catalog_items t WHERE tenant_id = $1`,
      [tenantId],
    );
    return row?.digest;
  };
  const events = (tenantId: string) =>
    db.admin<Row>(
      `SELECT tenant_id, event_type, routing_key, status, payload FROM outbox_events
        WHERE tenant_id = $1 AND event_type = 'CatalogItemChanged' ORDER BY occurred_at, id`,
      [tenantId],
    );
  const audits = (tenantId: string, action: string) =>
    db.admin<Row>(
      `SELECT tenant_id, action, category, result, reason_code, actor_user_id, entity_id, changes, metadata
         FROM audit_logs WHERE tenant_id = $1 AND action = $2 ORDER BY occurred_at`,
      [tenantId, action],
    );

  const create = (subject: string, tenant: string, catalogType: string, body: object) =>
    request(api.server)
      .post(`/api/v1/catalogs/${catalogType}/items`)
      .set('Authorization', as(subject))
      .set('X-Tenant-Id', tenant)
      .send(body);
  const patch = (subject: string, tenant: string, id: string, body: object, version: number) =>
    request(api.server)
      .patch(`/api/v1/catalog-items/${id}`)
      .set('Authorization', as(subject))
      .set('X-Tenant-Id', tenant)
      .set('If-Match', `"${version}"`)
      .send(body);
  const toggle = (
    subject: string,
    tenant: string,
    action: 'activate' | 'deactivate',
    id: string,
    version: number,
  ) =>
    request(api.server)
      .post(`/api/v1/catalog-items/${id}/${action}`)
      .set('Authorization', as(subject))
      .set('X-Tenant-Id', tenant)
      .set('If-Match', `"${version}"`)
      .send({});
  const reorder = (subject: string, tenant: string, catalogType: string, orderedIds: string[]) =>
    request(api.server)
      .put(`/api/v1/catalogs/${catalogType}/order`)
      .set('Authorization', as(subject))
      .set('X-Tenant-Id', tenant)
      .send({ orderedIds });
  const list = (subject: string, tenant: string, catalogType: string, query = '') =>
    request(api.server)
      .get(`/api/v1/catalogs/${catalogType}/items?${query}`)
      .set('Authorization', as(subject))
      .set('X-Tenant-Id', tenant);

  const problemCode = (response: request.Response) =>
    problemDetailsSchema.parse(response.body).code;

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
    });
    api = await createTestApi({
      config,
      providers: [
        { token: MEMBERSHIP_PORT, value: membership },
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
  });

  afterAll(async () => {
    await api.close();
    if (!dbStopped) await db.stop();
    vi.restoreAllMocks();
  });

  it('[Sucesso] Marta cria o item OUTRO_SERVICO: ativo, no fim da lista, auditoria catalog.create e evento CREATED PENDING, só em A', async () => {
    const digestOfB = await digestOf(B);

    const response = await create('sub-marta', A, 'ATTACHMENT_CATEGORY', {
      code: 'OUTRO_SERVICO',
      label: 'Outro',
    });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const created = (response.body as { data: CatalogItemDto }).data;
    expect(created).toMatchObject({
      catalogType: 'ATTACHMENT_CATEGORY',
      code: 'OUTRO_SERVICO',
      isSystem: false,
      isActive: true,
      sortOrder: 1,
      version: 1,
    });
    expect(await itemOf(A, 'ATTACHMENT_CATEGORY', 'OUTRO_SERVICO')).toMatchObject({
      label: 'Outro',
      is_system: false,
      created_by_id: MARTA,
      updated_by_id: MARTA,
    });
    expect(await audits(A, 'catalog.create')).toEqual([
      expect.objectContaining({
        tenant_id: A,
        category: 'CONFIGURATION',
        result: 'SUCCESS',
        actor_user_id: MARTA,
        entity_id: created.id,
        changes: [
          { path: 'code', old: null, new: 'OUTRO_SERVICO' },
          { path: 'label', old: null, new: 'Outro' },
          { path: 'metadata', old: null, new: {} },
        ],
      }),
    ]);
    // [Falha de integração] o relay não roda aqui: o evento fica PENDING até ele voltar.
    expect(await events(A)).toEqual([
      expect.objectContaining({
        tenant_id: A,
        routing_key: 'catalog.item_changed',
        status: 'PENDING',
        payload: {
          catalogType: 'ATTACHMENT_CATEGORY',
          catalogItemId: created.id,
          code: 'OUTRO_SERVICO',
          change: 'CREATED',
        },
      }),
    ]);
    expect(await digestOf(B)).toBe(digestOfB);
    expect(await audits(B, 'catalog.create')).toHaveLength(0);
  });

  it('[Sucesso] edição, desativação e reativação: versões +1, auditoria e eventos corretos e itens de sistema preservados', async () => {
    const edited = await patch(
      'sub-marta',
      A,
      MODALITY_A.pregao,
      { label: 'Pregão eletrônico', description: 'Menor preço' },
      3,
    );
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.headers.etag).toBe('"4"');
    expect(await itemOf(A, 'MODALITY', 'PREGAO')).toMatchObject({
      label: 'Pregão eletrônico',
      description: 'Menor preço',
      is_system: true,
      version: 4,
      updated_by_id: MARTA,
    });

    const off = await toggle('sub-marta', A, 'deactivate', MODALITY_A.dispensa, 1);
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(await itemOf(A, 'MODALITY', 'DISPENSA')).toMatchObject({ is_active: false, version: 2 });
    const on = await toggle('sub-marta', A, 'activate', MODALITY_A.dispensa, 2);
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(await itemOf(A, 'MODALITY', 'DISPENSA')).toMatchObject({ is_active: true, version: 3 });

    expect((await audits(A, 'catalog.update')).map((row) => row.changes)).toEqual([
      [
        { path: 'label', old: 'Pregão', new: 'Pregão eletrônico' },
        { path: 'description', old: null, new: 'Menor preço' },
      ],
      [{ path: 'isActive', old: false, new: true }],
    ]);
    expect(await audits(A, 'catalog.deactivate')).toEqual([
      expect.objectContaining({
        metadata: { catalogType: 'MODALITY', catalogItemId: MODALITY_A.dispensa },
      }),
    ]);
    expect((await events(A)).map((row) => (row.payload as { change: string }).change)).toEqual([
      'CREATED',
      'UPDATED',
      'DEACTIVATED',
      'ACTIVATED',
    ]);
  });

  it('[Validação] code fora do padrão e metadata inválida: 422 e nada gravado nem publicado', async () => {
    const digestOfA = await digestOf(A);
    const totalEvents = (await events(A)).length;

    const code = await create('sub-marta', A, 'ATTACHMENT_CATEGORY', {
      code: 'servico novo',
      label: 'Novo',
    });
    expect(code.status).toBe(422);
    expect(problemDetailsSchema.parse(code.body).errors.map((error) => error.field)).toContain(
      'code',
    );

    const metadata = await create('sub-marta', A, 'MODALITY', { code: 'SEM_BASE', label: 'Sem' });
    expect(metadata.status).toBe(422);
    expect(problemDetailsSchema.parse(metadata.body).errors.map((error) => error.field)).toEqual(
      expect.arrayContaining(['metadata.legalBasis']),
    );

    const noIfMatch = await request(api.server)
      .patch(`/api/v1/catalog-items/${MODALITY_A.leilao}`)
      .set('Authorization', as('sub-marta'))
      .set('X-Tenant-Id', A)
      .send({ label: 'X' });
    expect(noIfMatch.status).toBe(428);

    expect(await digestOf(A)).toBe(digestOfA);
    expect(await events(A)).toHaveLength(totalEvents);
  });

  it('[Item de sistema] alterar o code responde 409 CATALOG_ITEM_SYSTEM; não existe DELETE; o banco recusa a troca', async () => {
    const before = await itemOf(A, 'MODALITY', 'LEILAO');

    const renamed = await patch('sub-marta', A, MODALITY_A.leilao, { code: 'LEILAO_NOVO' }, 1);
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(409);
    expect(problemCode(renamed)).toBe('CATALOG_ITEM_SYSTEM');
    expect(await itemOf(A, 'MODALITY', 'LEILAO')).toEqual(before);

    const deleted = await request(api.server)
      .delete(`/api/v1/catalog-items/${MODALITY_A.leilao}`)
      .set('Authorization', as('sub-marta'))
      .set('X-Tenant-Id', A);
    expect([404, 405]).toContain(deleted.status);
    expect(await itemOf(A, 'MODALITY', 'LEILAO')).toEqual(before);
  });

  it('[Permissão] Lúcia sem CATALOG_MANAGE: 403 com access.denied em CAT-02..06; a lista continua liberada', async () => {
    const digestOfA = await digestOf(A);

    const responses = [
      await create('sub-lucia', A, 'ATTACHMENT_CATEGORY', { code: 'NEGADO', label: 'Negado' }),
      await patch('sub-lucia', A, MODALITY_A.leilao, { label: 'Hack' }, 1),
      await toggle('sub-lucia', A, 'deactivate', MODALITY_A.leilao, 1),
      await toggle('sub-lucia', A, 'activate', MODALITY_A.leilao, 1),
      await reorder('sub-lucia', A, 'MODALITY', [
        MODALITY_A.leilao,
        MODALITY_A.pregao,
        MODALITY_A.dispensa,
      ]),
    ];
    for (const response of responses) {
      expect(response.status, JSON.stringify(response.body)).toBe(403);
      expect(problemCode(response)).toBe('PERMISSION_DENIED');
    }
    const denied = await audits(A, 'access.denied');
    expect(denied).toHaveLength(5);
    expect(denied.at(-1)).toMatchObject({
      result: 'DENIED',
      reason_code: 'CATALOG_MANAGE',
      actor_user_id: LUCIA,
    });
    expect(await digestOf(A)).toBe(digestOfA);

    const read = await list('sub-lucia', A, 'MODALITY');
    expect(read.status, JSON.stringify(read.body)).toBe(200);
  });

  it('[Tenant incorreto] item, parentId e orderedIds de B: 404/422 sem revelar nada; a RLS esconde as linhas de B', async () => {
    const digestOfB = await digestOf(B);

    const parent = await create('sub-marta', A, 'RISK_CATEGORY', {
      code: 'FILHO_DE_B',
      label: 'Filho de B',
      parentId: RISK_B,
    });
    expect(parent.status, JSON.stringify(parent.body)).toBe(422);
    expect(problemDetailsSchema.parse(parent.body).errors).toEqual([
      expect.objectContaining({ field: 'parentId', code: 'REFERENCE_NOT_FOUND' }),
    ]);
    expect(JSON.stringify(parent.body)).not.toContain('LEAK-B');

    for (const response of [
      await patch('sub-marta', A, RISK_B, { label: 'Invasão' }, 4),
      await toggle('sub-marta', A, 'deactivate', RISK_B, 4),
      await toggle('sub-marta', A, 'activate', RISK_B, 4),
    ]) {
      expect(response.status).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain('LEAK-B');
    }

    const order = await reorder('sub-marta', A, 'RISK_CATEGORY', [...RISK_A, RISK_B]);
    expect(order.status).toBe(422);
    expect(JSON.stringify(order.body)).not.toContain('LEAK-B');

    const listed = await list('sub-marta', A, 'RISK_CATEGORY');
    expect(JSON.stringify(listed.body)).not.toContain('LEAK-B');
    const own = await list('sub-beto', B, 'RISK_CATEGORY');
    expect((own.body as { data: CatalogItemDto[] }).data.map((item) => item.code)).toEqual([
      'RISCO_LEAK_B',
    ]);

    // RLS: sem filtro de aplicação, a sessão do tenant A só enxerga as linhas de A.
    const app = db.client('cf_app');
    const visible = await asTenant(A, () =>
      app.$tenantTransaction(
        (tx) => tx.$queryRaw<{ tenant_id: string }[]>`
        SELECT DISTINCT tenant_id FROM catalog_items`,
      ),
    );
    expect(visible.map((row) => row.tenant_id)).toEqual([A]);
    expect(await digestOf(B)).toBe(digestOfB);
  });

  it('[Duplicidade] código repetido no catálogo: 422 em code; o mesmo código vale em outro tenant', async () => {
    const duplicate = await create('sub-marta', A, 'MODALITY', {
      code: 'PREGAO',
      label: 'Outro pregão',
      metadata: { legalBasis: 'x', isDirectContracting: false },
    });
    expect(duplicate.status, JSON.stringify(duplicate.body)).toBe(422);
    expect(problemDetailsSchema.parse(duplicate.body).errors).toEqual([
      expect.objectContaining({ field: 'code' }),
    ]);

    // B já tem PREGAO (fixture): a unicidade é por tenant e catálogo.
    expect(await itemOf(B, 'MODALITY', 'PREGAO')).toBeDefined();
    await expect(
      db.admin(
        `INSERT INTO catalog_items (id, tenant_id, catalog_type, code, label)
         VALUES ('0192c000-0000-7000-8000-0000000154a1', '${A}', 'MODALITY', 'PREGAO', 'Duplicado')`,
      ),
    ).rejects.toThrow(/catalog_items_tenant_id_catalog_type_code_key/);
  });

  it('[Concorrência] dois PATCH com o mesmo If-Match: um 200 (versão +1), o outro 412 VERSION_CONFLICT com currentVersion', async () => {
    const version = Number((await itemOf(A, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'))?.version);
    const results = await Promise.all([
      patch('sub-marta', A, CONTRACTING_A, { label: 'Aquisição (Marta)' }, version),
      patch('sub-otavio', A, CONTRACTING_A, { label: 'Aquisição (Otávio)' }, version),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([200, 412]);
    const loser = results.find((result) => result.status === 412);
    expect(problemDetailsSchema.parse(loser?.body)).toMatchObject({
      code: 'VERSION_CONFLICT',
      currentVersion: version + 1,
    });
    expect((await itemOf(A, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'))?.version).toBe(version + 1);
    // A edição perdedora não deixou auditoria própria (a transação foi desfeita).
    expect(
      (await audits(A, 'catalog.update')).filter((row) => row.entity_id === CONTRACTING_A),
    ).toHaveLength(1);
  });

  it('[Concorrência] duas criações do mesmo código: uma 201 e a outra 422 (o índice único decide)', async () => {
    const results = await Promise.all([
      create('sub-marta', A, 'ATTACHMENT_CATEGORY', { code: 'CORRIDA', label: 'Corrida 1' }),
      create('sub-otavio', A, 'ATTACHMENT_CATEGORY', { code: 'CORRIDA', label: 'Corrida 2' }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 422]);
    expect(
      (await itemsOf(A, 'ATTACHMENT_CATEGORY')).filter((row) => row.code === 'CORRIDA'),
    ).toHaveLength(1);
  });

  it('[Concorrência] reordenações simultâneas serializam: sortOrder segue 1..n sem repetição e o resultado é de uma das duas', async () => {
    const original = [...RISK_A];
    const reversed = [...RISK_A].reverse();
    const rotated = [...RISK_A.slice(2), ...RISK_A.slice(0, 2)];

    const results = await Promise.all([
      reorder('sub-marta', A, 'RISK_CATEGORY', reversed),
      reorder('sub-otavio', A, 'RISK_CATEGORY', rotated),
      reorder('sub-marta', A, 'RISK_CATEGORY', original),
    ]);

    for (const result of results) expect(result.status, JSON.stringify(result.body)).toBe(200);
    const final = await itemsOf(A, 'RISK_CATEGORY');
    expect(final.map((row) => row.sort_order)).toEqual([1, 2, 3, 4, 5, 6]);
    expect([original, reversed, rotated].map((order) => order.join())).toContain(
      final.map((row) => row.id).join(),
    );
  });

  it('[Sucesso] reordenação sequencial grava sortOrder 1..n, um catalog.update e um evento UPDATED por item movido', async () => {
    const before = (await events(A)).length;
    const auditsBefore = (await audits(A, 'catalog.update')).length;
    const newOrder = [RISK_A[1], RISK_A[0], ...RISK_A.slice(2)] as string[];
    // Estado conhecido: ordem original.
    await reorder('sub-marta', A, 'RISK_CATEGORY', [...RISK_A]);
    const base = (await events(A)).length;

    const response = await reorder('sub-marta', A, 'RISK_CATEGORY', newOrder);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((response.body as { data: CatalogItemDto[] }).data.map((item) => item.id)).toEqual(
      newOrder,
    );
    expect((await itemsOf(A, 'RISK_CATEGORY')).map((row) => row.id)).toEqual(newOrder);
    expect((await events(A)).length - base).toBe(2);
    expect((await events(A)).length).toBeGreaterThan(before);
    expect((await audits(A, 'catalog.update')).length).toBeGreaterThan(auditsBefore);
  });

  it('[Sucesso] seeder catalog.items reaplicado a tenant existente: repõe só o que falta e preserva as edições', async () => {
    const digestOfB = await digestOf(B);
    const apply = api.app.get(ApplyTenantSeedersCommand, { strict: false });
    const edited = await itemOf(A, 'MODALITY', 'PREGAO');

    const first = await apply.execute({
      slug: 'prefeitura-a-cat',
      seederKey: 'catalog.items',
      dryRun: false,
    });

    expect(first).toEqual([expect.objectContaining({ key: 'catalog.items', result: 'APPLIED' })]);
    const systemItems = (await itemsOf(A)).filter((row) => row.is_system);
    expect(systemItems).toHaveLength(84);
    expect(await itemOf(A, 'MODALITY', 'PREGAO')).toEqual(edited);
    expect(await itemOf(A, 'MODALITY', 'INEXIGIBILIDADE')).toMatchObject({
      is_system: true,
      is_active: true,
      metadata: { legalBasis: 'Lei 14.133/2021, art. 74', isDirectContracting: true },
    });

    const second = await apply.execute({
      slug: 'prefeitura-a-cat',
      seederKey: 'catalog.items',
      dryRun: false,
    });
    expect(second).toEqual([expect.objectContaining({ result: 'UP_TO_DATE' })]);
    expect((await itemsOf(A)).filter((row) => row.is_system)).toHaveLength(84);
    expect(await digestOf(B)).toBe(digestOfB);
  });

  it('[Banco] checks, imutabilidade, FK composta do pai e ausência de DELETE para a aplicação', async () => {
    await expect(
      db.admin(
        `INSERT INTO catalog_items (id, tenant_id, catalog_type, code, label)
         VALUES ('0192c000-0000-7000-8000-0000000154a2', '${A}', 'MODALITY', 'minusculo', 'X')`,
      ),
    ).rejects.toThrow(/catalog_items_code_format/);
    await expect(
      db.admin(`UPDATE catalog_items SET code = 'OUTRO' WHERE id = '${MODALITY_A.leilao}'`),
    ).rejects.toThrow(/imutáveis|code/);
    await expect(
      db.admin(`UPDATE catalog_items SET is_system = false WHERE id = '${MODALITY_A.leilao}'`),
    ).rejects.toThrow(/imutáveis|is_system/);
    await expect(
      db.admin(`UPDATE catalog_items SET tenant_id = '${B}' WHERE id = '${MODALITY_A.leilao}'`),
    ).rejects.toThrow(/imutáveis|tenant_id/);
    // Pai de outro tenant, de outro catálogo ou o próprio item.
    await expect(
      db.admin(`UPDATE catalog_items SET parent_id = '${RISK_B}' WHERE id = '${RISK_A[0]}'`),
    ).rejects.toThrow(/catalog_items_parent_fkey/);
    await expect(
      db.admin(`UPDATE catalog_items SET parent_id = '${CONTRACTING_A}' WHERE id = '${RISK_A[0]}'`),
    ).rejects.toThrow(/catalog_items_parent_fkey/);
    await expect(
      db.admin(`UPDATE catalog_items SET parent_id = id WHERE id = '${RISK_A[0]}'`),
    ).rejects.toThrow(/catalog_items_parent_not_self/);

    const app = db.client('cf_app');
    await expect(
      asTenant(A, () => app.$tenantTransaction((tx) => tx.catalogItem.deleteMany({}))),
    ).rejects.toSatisfy((error: unknown) => /permission denied/i.test(String(error)));
    expect((await itemsOf(A)).length).toBeGreaterThan(0);
  });

  it('[Falha de banco] banco indisponível ao criar → 503 com Retry-After e nenhum item persistido', async () => {
    dbStopped = true;
    await db.container.stop();
    const response = await create('sub-marta', A, 'ATTACHMENT_CATEGORY', {
      code: 'SEM_BANCO',
      label: 'Sem banco',
    });
    expect(response.status).toBe(503);
    expect(problemDetailsSchema.parse(response.body).code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(response.headers['retry-after']).toBeDefined();
  });
});
