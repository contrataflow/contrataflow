import { problemDetailsSchema } from '@contrataflow/validation';
import type { CatalogItemDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import { FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import { CATALOG_CLOCK, CATALOG_TRANSACTIONS } from '../application/catalog-ports.js';
import type { CatalogTransactions } from '../application/catalog-ports.js';
import type { CatalogItem } from '../domain/catalog-item.js';
import { CATALOG_SEED } from '../domain/catalog-seed.js';
import { InMemoryCatalogItemRepository } from '../infrastructure/in-memory-catalog-item.repository.js';

/*
 * US-104 — CAT-01..06 pelo pipeline HTTP completo (autenticação, tenant, vínculo, If-Match,
 * validação Zod, filtro RFC 9457) com a identidade fake, a auditoria real do `AuditService` e o
 * outbox em memória. Os mesmos casos contra o PostgreSQL (RLS, índice único, gatilho, concorrência
 * real) estão em `test/tenant-leak/catalog.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const MARTA = FAKE_USERS.marta;
const OTAVIO = FAKE_USERS.otavio;
const LUCIA = FAKE_USERS.lucia;
const ANA = FAKE_USERS.ana;
const HEITOR = FAKE_USERS.heitor;
const MFA = ['pwd', 'otp'];
const NOW = new Date('2026-10-15T12:00:00.000Z');

const ITEM_B = newId();

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- o chamador informa o tipo do corpo
function dataOf<T = unknown>(response: request.Response): T {
  return (response.body as { data: T }).data;
}

function expectProblem(response: request.Response, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  const body = problemDetailsSchema.parse(response.body);
  expect(body.code).toBe(code);
  return body;
}

describe('Feature: Gerenciar catálogos parametrizáveis (US-104)', () => {
  let api: TestApi;
  let repository: InMemoryCatalogItemRepository;

  const rows = (tenantId: string, catalogType?: string) =>
    repository
      .snapshot()
      .filter((row) => row.tenantId === tenantId)
      .filter((row) => catalogType === undefined || row.catalogType === catalogType)
      .sort((a, b) => a.sortOrder - b.sortOrder);
  const itemOf = (tenantId: string, code: string, catalogType?: string): CatalogItem => {
    const found = rows(tenantId, catalogType).find((row) => row.code === code);
    if (!found) throw new Error(`Item ${code} não semeado`);
    return found;
  };

  beforeAll(async () => {
    api = await createTestApi({ providers: [{ token: CATALOG_CLOCK, value: () => NOW }] });
    repository = api.app.get(InMemoryCatalogItemRepository, { strict: false });
    // Background: tenant A com o catálogo-base (itens de sistema); tenant B com um item próprio.
    for (const [catalogType, seeds] of Object.entries(CATALOG_SEED)) {
      seeds.forEach((seed, index) => {
        repository.seed({
          id: newId(),
          tenantId: A,
          catalogType: catalogType as CatalogItem['catalogType'],
          code: seed.code,
          label: seed.label,
          description: null,
          isSystem: true,
          isActive: true,
          sortOrder: index + 1,
          parentId: null,
          metadata: seed.metadata,
          createdAt: NOW,
          updatedAt: NOW,
          createdById: null,
          updatedById: null,
          version: 1,
        });
      });
    }
    repository.seed({
      id: ITEM_B,
      tenantId: B,
      catalogType: 'RISK_CATEGORY',
      code: 'RISCO_LEAK_B',
      label: 'Risco LEAK-B',
      description: null,
      isSystem: false,
      isActive: true,
      sortOrder: 1,
      parentId: null,
      metadata: {},
      createdAt: NOW,
      updatedAt: NOW,
      createdById: null,
      updatedById: null,
      version: 1,
    });
  });
  afterAll(async () => {
    await api.close();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    vi.restoreAllMocks();
  });

  const silence = () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  };

  const withAuth = (
    test: request.Test,
    user: { subject: string },
    options: { amr?: readonly string[]; tenant?: string } = {},
  ) =>
    test
      .set('Authorization', api.bearer(user.subject, { amr: options.amr ?? MFA }))
      .set('X-Tenant-Id', options.tenant ?? A);

  const list = (
    catalogType: string,
    query = '',
    user: { subject: string } = MARTA,
    tenant: string = A,
  ) =>
    withAuth(request(api.server).get(`/api/v1/catalogs/${catalogType}/items?${query}`), user, {
      tenant,
    });

  const create = (
    catalogType: string,
    body: Record<string, unknown>,
    options: { user?: { subject: string }; amr?: readonly string[]; tenant?: string } = {},
  ) =>
    withAuth(
      request(api.server).post(`/api/v1/catalogs/${catalogType}/items`),
      options.user ?? MARTA,
      options,
    ).send(body);

  const patch = (
    id: string,
    body: Record<string, unknown>,
    version: number | string | null,
    user: { subject: string } = MARTA,
  ) => {
    const test = withAuth(request(api.server).patch(`/api/v1/catalog-items/${id}`), user);
    if (version !== null) test.set('If-Match', `"${version}"`);
    return test.send(body);
  };

  const toggle = (
    action: 'activate' | 'deactivate',
    id: string,
    version: number | null,
    user: { subject: string } = MARTA,
  ) => {
    const test = withAuth(request(api.server).post(`/api/v1/catalog-items/${id}/${action}`), user);
    if (version !== null) test.set('If-Match', `"${version}"`);
    return test.send({});
  };

  const reorder = (
    catalogType: string,
    orderedIds: readonly string[],
    user: { subject: string } = MARTA,
    tenant: string = A,
  ) =>
    withAuth(request(api.server).put(`/api/v1/catalogs/${catalogType}/order`), user, {
      tenant,
    }).send({ orderedIds });

  const auditOf = (action: string) => api.auditRecords().filter((r) => r.action === action);
  const eventsOf = () => api.outboxRows().filter((row) => row.eventType === 'CatalogItemChanged');

  describe('[Sucesso]', () => {
    it('CAT-01: lista o catálogo por sortOrder com selo de sistema e envelope paginado', async () => {
      const response = await list('MODALITY');

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const items = dataOf<CatalogItemDto[]>(response);
      expect(items.map((item) => item.code)).toEqual(CATALOG_SEED.MODALITY.map((s) => s.code));
      expect(items[0]).toMatchObject({
        catalogType: 'MODALITY',
        code: 'PREGAO',
        isSystem: true,
        isActive: true,
        sortOrder: 1,
        version: 1,
      });
      expect((response.body as { meta: object }).meta).toMatchObject({ page: 1, totalItems: 7 });
    });

    it('CAT-01: filtros isActive e q (código ou rótulo, sem acento)', async () => {
      const byText = dataOf<CatalogItemDto[]>(await list('MODALITY', 'q=dialogo'));
      expect(byText.map((item) => item.code)).toEqual(['DIALOGO_COMPETITIVO']);

      const inactive = dataOf<CatalogItemDto[]>(await list('MODALITY', 'isActive=false'));
      expect(inactive).toEqual([]);
    });

    it('CAT-01: qualquer vínculo ativo lista (leitura implícita), mesmo sem CATALOG_MANAGE', async () => {
      const response = await list('UNIT_OF_MEASURE', '', ANA);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect((response.body as { meta: { totalItems: number } }).meta.totalItems).toBe(26);
    });

    it('CAT-02: criar item "OUTRO_SERVICO" em ATTACHMENT_CATEGORY → 201, ativo, auditoria e evento CREATED', async () => {
      silence();
      const audits = auditOf('catalog.create').length;
      const events = eventsOf().length;

      const response = await create('ATTACHMENT_CATEGORY', {
        code: 'OUTRO_SERVICO',
        label: 'Outro',
        description: 'Documento diverso',
      });

      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const created = dataOf<CatalogItemDto>(response);
      expect(created).toMatchObject({
        catalogType: 'ATTACHMENT_CATEGORY',
        code: 'OUTRO_SERVICO',
        label: 'Outro',
        description: 'Documento diverso',
        isSystem: false,
        isActive: true,
        sortOrder: 11,
        parentId: null,
        metadata: {},
        version: 1,
      });
      expect(response.headers.location).toBe(`/api/v1/catalog-items/${created.id}`);
      expect(response.headers.etag).toBe('"1"');
      expect(rows(A, 'ATTACHMENT_CATEGORY').map((row) => row.code)).toContain('OUTRO_SERVICO');

      const records = auditOf('catalog.create');
      expect(records).toHaveLength(audits + 1);
      expect(records.at(-1)).toMatchObject({
        tenantId: A,
        category: 'CONFIGURATION',
        result: 'SUCCESS',
        actorUserId: MARTA.id,
        entityType: 'CatalogItem',
        entityId: created.id,
      });
      expect(records.at(-1)?.changes).toEqual([
        { path: 'code', old: null, new: 'OUTRO_SERVICO' },
        { path: 'label', old: null, new: 'Outro' },
        { path: 'metadata', old: null, new: {} },
      ]);
      expect(eventsOf()).toHaveLength(events + 1);
      expect(eventsOf().at(-1)).toMatchObject({
        tenantId: A,
        routingKey: 'catalog.item_changed',
        aggregateType: 'CatalogItem',
        aggregateId: created.id,
        payload: {
          catalogType: 'ATTACHMENT_CATEGORY',
          catalogItemId: created.id,
          code: 'OUTRO_SERVICO',
          change: 'CREATED',
        },
      });
    });

    it('CAT-02: metadata específica do tipo (MODALITY) é validada e gravada', async () => {
      silence();
      const response = await create('MODALITY', {
        code: 'REGISTRO_PRECOS',
        label: 'Registro de preços',
        metadata: { legalBasis: 'Lei 14.133/2021, art. 82', isDirectContracting: false },
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(dataOf<CatalogItemDto>(response).metadata).toEqual({
        legalBasis: 'Lei 14.133/2021, art. 82',
        isDirectContracting: false,
      });
    });

    it('CAT-02: parentId do mesmo catálogo e tenant é aceito', async () => {
      silence();
      const parent = itemOf(A, 'PLANEJAMENTO', 'RISK_CATEGORY');
      const response = await create('RISK_CATEGORY', {
        code: 'PLANEJAMENTO_SUBCATEGORIA',
        label: 'Subcategoria',
        parentId: parent.id,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(dataOf<CatalogItemDto>(response).parentId).toBe(parent.id);
    });

    it('CAT-03: edita rótulo, descrição, ordem e metadata de item de sistema; versão +1, ETag, auditoria e UPDATED', async () => {
      silence();
      const pregao = itemOf(A, 'PREGAO', 'MODALITY');
      const audits = auditOf('catalog.update').length;
      const events = eventsOf().length;

      const response = await patch(
        pregao.id,
        { label: 'Pregão eletrônico', description: 'Menor preço ou maior desconto', sortOrder: 9 },
        pregao.version,
      );

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(dataOf<CatalogItemDto>(response)).toMatchObject({
        code: 'PREGAO',
        label: 'Pregão eletrônico',
        description: 'Menor preço ou maior desconto',
        sortOrder: 9,
        isSystem: true,
        version: pregao.version + 1,
      });
      expect(response.headers.etag).toBe(`"${pregao.version + 1}"`);
      const records = auditOf('catalog.update');
      expect(records).toHaveLength(audits + 1);
      expect(records.at(-1)?.changes).toEqual([
        { path: 'label', old: 'Pregão', new: 'Pregão eletrônico' },
        { path: 'description', old: null, new: 'Menor preço ou maior desconto' },
        { path: 'sortOrder', old: 1, new: 9 },
      ]);
      expect(eventsOf().at(-1)).toMatchObject({
        payload: { code: 'PREGAO', change: 'UPDATED' },
      });
      expect(eventsOf()).toHaveLength(events + 1);
    });

    it('CAT-03: nada alterado → 200 sem nova versão, auditoria nem evento', async () => {
      silence();
      const item = itemOf(A, 'CONCORRENCIA', 'MODALITY');
      const audits = auditOf('catalog.update').length;
      const events = eventsOf().length;

      const response = await patch(item.id, { label: item.label }, item.version);

      expect(response.status).toBe(200);
      expect(dataOf<CatalogItemDto>(response).version).toBe(item.version);
      expect(auditOf('catalog.update')).toHaveLength(audits);
      expect(eventsOf()).toHaveLength(events);
    });

    it('CAT-05/CAT-04: desativar (catalog.deactivate, DEACTIVATED) e reativar (catalog.update, ACTIVATED)', async () => {
      silence();
      const item = itemOf(A, 'FOTO', 'ATTACHMENT_CATEGORY');
      const deactivations = auditOf('catalog.deactivate').length;
      const updates = auditOf('catalog.update').length;
      const events = eventsOf().length;

      const off = await toggle('deactivate', item.id, item.version);
      expect(off.status, JSON.stringify(off.body)).toBe(200);
      expect(dataOf<CatalogItemDto>(off)).toMatchObject({
        isActive: false,
        version: item.version + 1,
      });
      expect(auditOf('catalog.deactivate')).toHaveLength(deactivations + 1);
      expect(auditOf('catalog.deactivate').at(-1)?.metadata).toMatchObject({
        catalogItemId: item.id,
      });
      expect(eventsOf().at(-1)).toMatchObject({ payload: { code: 'FOTO', change: 'DEACTIVATED' } });

      // Desativado: some da lista de ativos, mas continua na lista completa (RN-TEN-61).
      const actives = dataOf<CatalogItemDto[]>(await list('ATTACHMENT_CATEGORY', 'isActive=true'));
      expect(actives.map((entry) => entry.code)).not.toContain('FOTO');
      const all = dataOf<CatalogItemDto[]>(await list('ATTACHMENT_CATEGORY'));
      expect(all.map((entry) => entry.code)).toContain('FOTO');

      const on = await toggle('activate', item.id, item.version + 1);
      expect(on.status, JSON.stringify(on.body)).toBe(200);
      expect(dataOf<CatalogItemDto>(on)).toMatchObject({
        isActive: true,
        version: item.version + 2,
      });
      expect(auditOf('catalog.update')).toHaveLength(updates + 1);
      expect(eventsOf().at(-1)).toMatchObject({ payload: { code: 'FOTO', change: 'ACTIVATED' } });
      expect(eventsOf()).toHaveLength(events + 2);
    });

    it('CAT-05: desativar item já inativo → 200 sem efeitos', async () => {
      silence();
      const item = itemOf(A, 'PROJETO', 'ATTACHMENT_CATEGORY');
      expect((await toggle('deactivate', item.id, item.version)).status).toBe(200);
      const events = eventsOf().length;
      const again = await toggle('deactivate', item.id, item.version + 1);
      expect(again.status).toBe(200);
      expect(dataOf<CatalogItemDto>(again).version).toBe(item.version + 1);
      expect(eventsOf()).toHaveLength(events);
    });

    it('CAT-06: reordena o catálogo; sortOrder sequencial, um catalog.update e um UPDATED por item movido', async () => {
      silence();
      const before = rows(A, 'JUDGMENT_CRITERION');
      const ids = before.map((row) => row.id);
      const newOrder = [ids[1], ids[0], ...ids.slice(2)] as string[];
      const audits = auditOf('catalog.update').length;
      const events = eventsOf().length;

      const response = await reorder('JUDGMENT_CRITERION', newOrder);

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const data = dataOf<CatalogItemDto[]>(response);
      expect(data.map((item) => item.id)).toEqual(newOrder);
      expect(data.map((item) => item.sortOrder)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(rows(A, 'JUDGMENT_CRITERION').map((row) => row.id)).toEqual(newOrder);
      expect(auditOf('catalog.update')).toHaveLength(audits + 1);
      expect(eventsOf()).toHaveLength(events + 2);
      expect(
        eventsOf()
          .slice(-2)
          .map((event) => event.payload),
      ).toEqual([
        expect.objectContaining({ code: 'MAIOR_DESCONTO', change: 'UPDATED' }),
        expect.objectContaining({ code: 'MENOR_PRECO', change: 'UPDATED' }),
      ]);
    });

    it('CAT-06: mesma ordem → 200 sem efeitos', async () => {
      silence();
      const ids = rows(A, 'PROCESS_ORIGIN').map((row) => row.id);
      const events = eventsOf().length;
      const response = await reorder('PROCESS_ORIGIN', ids);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(eventsOf()).toHaveLength(events);
    });
  });

  describe('[Validação]', () => {
    it.each(['servico novo', 'Servico_Novo', '1_INICIO', 'DUPLO__SUBLINHADO', 'COM-HIFEN', ''])(
      'code "%s" fora do padrão: 422 VALIDATION_ERROR no campo code e nenhum item criado',
      async (code) => {
        silence();
        const total = rows(A, 'ATTACHMENT_CATEGORY').length;
        const response = await create('ATTACHMENT_CATEGORY', { code, label: 'Novo' });
        const problem = expectProblem(response, 422, 'VALIDATION_ERROR');
        expect(problem.errors.map((error) => error.field)).toContain('code');
        expect(rows(A, 'ATTACHMENT_CATEGORY')).toHaveLength(total);
      },
    );

    it('campos obrigatórios ausentes: REQUIRED em code e label', async () => {
      silence();
      const problem = expectProblem(
        await create('ATTACHMENT_CATEGORY', {}),
        422,
        'VALIDATION_ERROR',
      );
      expect(problem.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'code', code: 'REQUIRED' }),
          expect.objectContaining({ field: 'label', code: 'REQUIRED' }),
        ]),
      );
    });

    it('rótulo com mais de 150 e descrição com mais de 1.000 caracteres', async () => {
      silence();
      const problem = expectProblem(
        await create('ATTACHMENT_CATEGORY', {
          code: 'LONGO',
          label: 'x'.repeat(151),
          description: 'y'.repeat(1001),
        }),
        422,
        'VALIDATION_ERROR',
      );
      expect(problem.errors.map((error) => error.field).sort()).toEqual(['description', 'label']);
    });

    it('metadata fora do schema do tipo (V-03/FA-03): 422 e nada gravado', async () => {
      silence();
      const events = eventsOf().length;
      const total = rows(A, 'MODALITY').length;

      const missing = await create('MODALITY', { code: 'SEM_BASE', label: 'Sem base legal' });
      const problem = expectProblem(missing, 422, 'VALIDATION_ERROR');
      expect(problem.errors.map((error) => error.field)).toEqual(
        expect.arrayContaining(['metadata.legalBasis', 'metadata.isDirectContracting']),
      );

      const extra = await create('ATTACHMENT_CATEGORY', {
        code: 'COM_EXTRA',
        label: 'Com extra',
        metadata: { qualquer: 1 },
      });
      const extraProblem = expectProblem(extra, 422, 'VALIDATION_ERROR');
      expect(extraProblem.errors).toEqual([
        expect.objectContaining({ field: 'metadata.qualquer', code: 'NOT_ALLOWED' }),
      ]);

      expect(rows(A, 'MODALITY')).toHaveLength(total);
      expect(eventsOf()).toHaveLength(events);
    });

    it('PATCH com metadata inválida: 422 e item inalterado', async () => {
      silence();
      const item = itemOf(A, 'DISPENSA', 'MODALITY');
      const response = await patch(item.id, { metadata: { legalBasis: 'x' } }, item.version);
      expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(itemOf(A, 'DISPENSA', 'MODALITY').version).toBe(item.version);
    });

    it('catalogType desconhecido na rota: 422', async () => {
      silence();
      expectProblem(await list('INEXISTENTE'), 422, 'VALIDATION_ERROR');
      expectProblem(
        await create('INEXISTENTE', { code: 'X', label: 'X' }),
        422,
        'VALIDATION_ERROR',
      );
    });

    it('PATCH sem If-Match: 428 PRECONDITION_REQUIRED', async () => {
      silence();
      const item = itemOf(A, 'CONCURSO', 'MODALITY');
      expectProblem(await patch(item.id, { label: 'Novo' }, null), 428, 'PRECONDITION_REQUIRED');
      expectProblem(await toggle('deactivate', item.id, null), 428, 'PRECONDITION_REQUIRED');
    });

    it('parentId inexistente ou o próprio item (RN-TEN-63): 422 REFERENCE_NOT_FOUND em parentId', async () => {
      silence();
      const missing = await create('RISK_CATEGORY', {
        code: 'ORFAO',
        label: 'Órfão',
        parentId: newId(),
      });
      const problem = expectProblem(missing, 422, 'VALIDATION_ERROR');
      expect(problem.errors).toEqual([
        expect.objectContaining({ field: 'parentId', code: 'REFERENCE_NOT_FOUND' }),
      ]);

      const item = itemOf(A, 'PRAZO', 'RISK_CATEGORY');
      const self = await patch(item.id, { parentId: item.id }, item.version);
      expectProblem(self, 422, 'VALIDATION_ERROR');
    });

    it('parentId de outro catálogo (mesmo tenant): 422 REFERENCE_NOT_FOUND', async () => {
      silence();
      const other = itemOf(A, 'PREGAO', 'MODALITY');
      const response = await create('RISK_CATEGORY', {
        code: 'PAI_DE_OUTRO_CATALOGO',
        label: 'Pai de outro catálogo',
        parentId: other.id,
      });
      const problem = expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(problem.errors[0]).toMatchObject({ field: 'parentId', code: 'REFERENCE_NOT_FOUND' });
    });

    it('parentId que cria ciclo (A → B → A): 422', async () => {
      silence();
      const a = itemOf(A, 'AMBIENTAL', 'RISK_CATEGORY');
      const b = itemOf(A, 'REPUTACIONAL', 'RISK_CATEGORY');
      expect((await patch(b.id, { parentId: a.id }, b.version)).status).toBe(200);
      expectProblem(await patch(a.id, { parentId: b.id }, a.version), 422, 'VALIDATION_ERROR');
    });

    it('reordenação com ID de outro catálogo ou lista incompleta: 422 e ordem intacta', async () => {
      silence();
      const before = rows(A, 'PROCESS_ORIGIN').map((row) => row.id);
      const foreign = itemOf(A, 'PREGAO', 'MODALITY').id;

      const unknown = await reorder('PROCESS_ORIGIN', [foreign, ...before.slice(1)]);
      const problem = expectProblem(unknown, 422, 'VALIDATION_ERROR');
      expect(problem.errors[0]).toMatchObject({ field: 'orderedIds', code: 'REFERENCE_NOT_FOUND' });

      expectProblem(await reorder('PROCESS_ORIGIN', before.slice(1)), 422, 'VALIDATION_ERROR');
      expectProblem(
        await reorder('PROCESS_ORIGIN', [before[0] ?? '', before[0] ?? '']),
        422,
        'VALIDATION_ERROR',
      );
      expect(rows(A, 'PROCESS_ORIGIN').map((row) => row.id)).toEqual(before);
    });
  });

  describe('[Item de sistema]', () => {
    it('alterar o code de item de sistema: 409 CATALOG_ITEM_SYSTEM e item inalterado (FA-01/V-05)', async () => {
      silence();
      const item = itemOf(A, 'LEILAO', 'MODALITY');
      const events = eventsOf().length;

      const response = await patch(item.id, { code: 'LEILAO_RENOMEADO' }, item.version);

      expectProblem(response, 409, 'CATALOG_ITEM_SYSTEM');
      expect(itemOf(A, 'LEILAO', 'MODALITY')).toMatchObject({
        code: 'LEILAO',
        version: item.version,
      });
      expect(eventsOf()).toHaveLength(events);
    });

    it('alterar o code de item não-sistema: 422 NOT_ALLOWED (RN-TEN-59)', async () => {
      silence();
      const created = dataOf<CatalogItemDto>(
        await create('ATTACHMENT_CATEGORY', { code: 'TEMPORARIO', label: 'Temporário' }),
      );
      const problem = expectProblem(
        await patch(created.id, { code: 'OUTRO_CODIGO' }, created.version),
        422,
        'VALIDATION_ERROR',
      );
      expect(problem.errors[0]).toMatchObject({ field: 'code', code: 'NOT_ALLOWED' });
    });

    it('não existe rota de exclusão (RN-TEN-64): DELETE → 404/405 e o item permanece', async () => {
      silence();
      const item = itemOf(A, 'OBRA', 'CONTRACTING_TYPE');
      const response = await withAuth(
        request(api.server).delete(`/api/v1/catalog-items/${item.id}`),
        MARTA,
      );
      expect([404, 405]).toContain(response.status);
      expect(itemOf(A, 'OBRA', 'CONTRACTING_TYPE').isActive).toBe(true);
    });

    it('item de sistema pode ser desativado e editado, sem perder code nem isSystem', async () => {
      silence();
      const item = itemOf(A, 'LOCACAO_IMOVEL', 'CONTRACTING_TYPE');
      const response = await toggle('deactivate', item.id, item.version);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(dataOf<CatalogItemDto>(response)).toMatchObject({
        code: 'LOCACAO_IMOVEL',
        isSystem: true,
        isActive: false,
      });
    });
  });

  describe('[Permissão]', () => {
    it('usuário sem CATALOG_MANAGE (REQUISITANTE): 403 PERMISSION_DENIED e access.denied em CAT-02..06; leitura liberada', async () => {
      silence();
      const denials = auditOf('access.denied').length;
      const events = eventsOf().length;
      const item = itemOf(A, 'ORCAMENTO', 'ATTACHMENT_CATEGORY');

      const denied = [
        await create('ATTACHMENT_CATEGORY', { code: 'NEGADO', label: 'Negado' }, { user: ANA }),
        await patch(item.id, { label: 'Hack' }, item.version, ANA),
        await toggle('deactivate', item.id, item.version, ANA),
        await toggle('activate', item.id, item.version, ANA),
        await reorder(
          'ATTACHMENT_CATEGORY',
          rows(A, 'ATTACHMENT_CATEGORY').map((row) => row.id),
          ANA,
        ),
      ];

      for (const response of denied) expectProblem(response, 403, 'PERMISSION_DENIED');
      const records = auditOf('access.denied');
      expect(records).toHaveLength(denials + 5);
      expect(records.at(-1)).toMatchObject({
        tenantId: A,
        actorUserId: ANA.id,
        reasonCode: 'CATALOG_MANAGE',
        result: 'DENIED',
      });
      expect(eventsOf()).toHaveLength(events);
      expect(itemOf(A, 'ORCAMENTO', 'ATTACHMENT_CATEGORY').label).toBe('Orçamento');
      expect(rows(A, 'ATTACHMENT_CATEGORY').map((row) => row.code)).not.toContain('NEGADO');
      expect((await list('ATTACHMENT_CATEGORY', '', ANA)).status).toBe(200);
    });

    it('GESTOR_CONTRATACOES também gerencia catálogos (permissions.md) e a sessão sem MFA basta (CATALOG_MANAGE é risco M)', async () => {
      silence();
      const response = await create(
        'ATTACHMENT_CATEGORY',
        { code: 'CRIADO_PELA_GESTORA', label: 'Criado pela gestora' },
        { user: LUCIA, amr: ['pwd'] },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(201);
    });
  });

  describe('[Tenant incorreto]', () => {
    it('parentId de item do tenant B: 422 REFERENCE_NOT_FOUND e a resposta não revela o item', async () => {
      silence();
      const response = await create('RISK_CATEGORY', {
        code: 'FILHO_DE_B',
        label: 'Filho de B',
        parentId: ITEM_B,
      });

      const problem = expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(problem.errors).toEqual([
        expect.objectContaining({ field: 'parentId', code: 'REFERENCE_NOT_FOUND' }),
      ]);
      expect(JSON.stringify(response.body)).not.toContain('LEAK-B');
      expect(rows(A, 'RISK_CATEGORY').map((row) => row.code)).not.toContain('FILHO_DE_B');
    });

    it('item do tenant B em CAT-03/04/05 → 404 sem revelar nada', async () => {
      silence();
      for (const response of [
        await patch(ITEM_B, { label: 'Invasão' }, 1),
        await toggle('deactivate', ITEM_B, 1),
        await toggle('activate', ITEM_B, 1),
      ]) {
        expectProblem(response, 404, 'NOT_FOUND');
        expect(JSON.stringify(response.body)).not.toContain('LEAK-B');
      }
      expect(repository.snapshot().find((row) => row.id === ITEM_B)).toMatchObject({
        label: 'Risco LEAK-B',
        isActive: true,
        version: 1,
      });
    });

    it('ID do tenant B em orderedIds bloqueia a operação inteira; a lista de A não traz itens de B', async () => {
      silence();
      const ids = rows(A, 'RISK_CATEGORY').map((row) => row.id);
      expectProblem(await reorder('RISK_CATEGORY', [...ids, ITEM_B]), 422, 'VALIDATION_ERROR');

      const response = await list('RISK_CATEGORY');
      expect(JSON.stringify(response.body)).not.toContain('LEAK-B');

      const mine = await list('RISK_CATEGORY', '', HEITOR, B);
      expect(dataOf<CatalogItemDto[]>(mine).map((item) => item.code)).toEqual(['RISCO_LEAK_B']);
    });

    it('administradora de A não opera no tenant B (cabeçalho divergente do vínculo)', async () => {
      const response = await list('RISK_CATEGORY', '', MARTA, B);
      expect(response.status).toBe(403);
      expect(JSON.stringify(response.body)).not.toContain('LEAK-B');
    });
  });

  describe('[Duplicidade]', () => {
    it('código já usado no mesmo catálogo: 422 VALIDATION_ERROR no campo code', async () => {
      silence();
      const total = rows(A, 'MODALITY').length;
      const response = await create('MODALITY', {
        code: 'PREGAO',
        label: 'Outro pregão',
        metadata: { legalBasis: 'x', isDirectContracting: false },
      });
      const problem = expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(problem.errors).toEqual([
        expect.objectContaining({
          field: 'code',
          message: 'Já existe um item com este código neste catálogo.',
        }),
      ]);
      expect(rows(A, 'MODALITY')).toHaveLength(total);
    });

    it('o mesmo código pode existir em outro catálogo do mesmo tenant', async () => {
      silence();
      // "OUTRO" existe em CONTRACTING_TYPE, RISK_CATEGORY e ATTACHMENT_CATEGORY; não em JUDGMENT_CRITERION.
      const response = await create('JUDGMENT_CRITERION', {
        code: 'OUTRO',
        label: 'Outro critério',
        metadata: { legalBasis: 'Lei 14.133/2021, art. 33' },
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
    });
  });

  describe('[Concorrência]', () => {
    it('duas edições simultâneas com o mesmo If-Match: uma 200 (versão +1), a outra 412 com currentVersion', async () => {
      silence();
      const item = itemOf(A, 'AQUISICAO_BENS', 'CONTRACTING_TYPE');
      const version = item.version;

      const [one, two] = await Promise.all([
        patch(item.id, { label: 'Aquisição (A)' }, version, MARTA),
        patch(item.id, { label: 'Aquisição (B)' }, version, OTAVIO),
      ]);

      expect([one.status, two.status].sort()).toEqual([200, 412]);
      const winner = one.status === 200 ? one : two;
      const loser = one.status === 412 ? one : two;
      expect(dataOf<CatalogItemDto>(winner).version).toBe(version + 1);
      const problem = expectProblem(loser, 412, 'VERSION_CONFLICT');
      expect((problem as Record<string, unknown>).currentVersion).toBe(version + 1);
      expect(itemOf(A, 'AQUISICAO_BENS', 'CONTRACTING_TYPE').version).toBe(version + 1);
    });

    it('If-Match desatualizado em ativar/desativar: 412 VERSION_CONFLICT', async () => {
      silence();
      const item = itemOf(A, 'SERVICO_COMUM', 'CONTRACTING_TYPE');
      expectProblem(await toggle('deactivate', item.id, item.version + 7), 412, 'VERSION_CONFLICT');
      expect(itemOf(A, 'SERVICO_COMUM', 'CONTRACTING_TYPE').isActive).toBe(true);
    });
  });

  describe('[Falha de banco]', () => {
    it('banco indisponível ao criar: 503 DEPENDENCY_UNAVAILABLE com Retry-After e nada persistido', async () => {
      silence();
      const down = new DatabaseUnavailableError(new Error('ECONNREFUSED'));
      const failing: CatalogTransactions = {
        run: () => Promise.reject(down),
        read: () => Promise.reject(down),
      };
      const broken = await createTestApi({
        providers: [
          { token: CATALOG_TRANSACTIONS, value: failing },
          { token: CATALOG_CLOCK, value: () => NOW },
        ],
      });
      try {
        const response = await request(broken.server)
          .post('/api/v1/catalogs/ATTACHMENT_CATEGORY/items')
          .set('Authorization', broken.bearer(MARTA.subject, { amr: MFA }))
          .set('X-Tenant-Id', A)
          .send({ code: 'SEM_BANCO', label: 'Sem banco' });
        expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
        expect(response.headers['retry-after']).toBeDefined();
        expect(broken.auditRecords().filter((r) => r.action === 'catalog.create')).toHaveLength(0);
        expect(broken.outboxRows()).toHaveLength(0);
      } finally {
        await broken.close();
      }
    });
  });

  describe('[Falha de integração]', () => {
    it('relay do outbox fora do ar: item criado (201) e evento gravado no outbox sem publicação', async () => {
      silence();
      const events = eventsOf().length;
      const response = await create('ATTACHMENT_CATEGORY', {
        code: 'COM_RELAY_FORA',
        label: 'Relay',
      });
      // Sem relay no teste, o evento fica no outbox sem publicação; o status `PENDING` no banco é
      // conferido em `test/tenant-leak/catalog.spec.ts`.
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(eventsOf()).toHaveLength(events + 1);
    });
  });
});
