import { randomUUID } from 'node:crypto';

import {
  actionEntrySchema,
  problemDetailsSchema,
  processListItemSchema,
  processSummarySchema,
  processTagsSchema,
  tagSchema,
} from '@contrataflow/validation';
import type {
  ActionEntry,
  ProcessDto,
  ProcessListItemDto,
  ProcessSummaryDto,
  ProcessTagsDto,
  TagDto,
} from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import {
  CATALOG_CLOCK,
  catalogItemId,
  processRepositoryOf,
  runTenantSeeders,
  seedProcessStructure,
  timelineRowsOf,
} from '../../../../test/support/process-fixtures.js';
import {
  assignDepartment,
  assignRole,
  seedDefaultRolesOf,
} from '../../../../test/support/structure-fixtures.js';
import { PROCESS_CLOCK, PROCESS_TRANSACTIONS } from '../application/ports.js';
import type { ProcessTransactions } from '../application/ports.js';
import { ProcessRuntimeLoader } from '../application/process-runtime.loader.js';
import type { Process } from '../domain/process.js';
import type { Tag } from '../domain/tag.js';
import { InMemoryTagRepository } from '../infrastructure/tag.repositories.js';

/*
 * US-007 — TAG-01..03 e PRC-18 (etiquetas do processo) pelo pipeline HTTP completo (autenticação,
 * tenant, vínculo, autorização, `If-Match`, `Idempotency-Key`, filtro RFC 9457) com a identidade
 * fake, os seeders reais e o processo criado pelo PRC-02, com auditoria, outbox e timeline em
 * memória. As 8 categorias do Gherkin. Papéis do Gherkin → fake: Patrícia (GESTOR_CONTRATACOES, com
 * `TAG_MANAGE`) = Lúcia; Ana (REQUISITANTE) é a responsável; Juliana (COMPRAS, sem custódia) =
 * Fábio; Otávio = só SOMENTE_LEITURA (sem PROCESS_UPDATE nem TAG_MANAGE). Índices únicos, RLS,
 * `process_tags` e rollback no PostgreSQL: `test/tenant-leak/process-tags.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-05T15:00:00.000Z');

const UNITS_A = {
  organizationId: '0192d007-0000-7000-8000-0000000000a0',
  obras: '0192d007-0000-7000-8000-0000000000a1',
  manutencao: '0192d007-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d007-0000-7000-8000-0000000000a3',
  saude: '0192d007-0000-7000-8000-0000000000a4',
  posto: '0192d007-0000-7000-8000-0000000000a5',
};
const UNITS_B = {
  organizationId: '0192d007-0000-7000-8000-0000000000b0',
  obras: '0192d007-0000-7000-8000-0000000000b1',
  manutencao: '0192d007-0000-7000-8000-0000000000b2',
  pavimentacao: '0192d007-0000-7000-8000-0000000000b3',
  saude: '0192d007-0000-7000-8000-0000000000b4',
  posto: '0192d007-0000-7000-8000-0000000000b5',
};

const membershipOf = (userId: string, tenantId = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

/** Transações que podem simular o banco fora do ar (Falha de banco). */
class FlakyTransactions implements ProcessTransactions {
  down = false;

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    if (this.down) return Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED')));
    return runSimulatedTransaction(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.run(work);
  }

  snapshot<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.run(work);
  }

  longRead<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.read(work);
  }
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- o chamador informa o tipo do corpo
function data<T>(response: request.Response): T {
  return (response.body as { data: T }).data;
}

function expectProblem(response: request.Response, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  const body = problemDetailsSchema.parse(response.body);
  expect(body.code).toBe(code);
  return body;
}

const fieldErrors = (response: request.Response) =>
  problemDetailsSchema.parse(response.body).errors.map((error) => [error.field, error.code]);

describe('Feature: Etiquetas do processo (US-007)', () => {
  let api: TestApi;
  const transactions = new FlakyTransactions();
  let catalog: { contractingType: string; origin: string };
  const words = (count: number) =>
    Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

  const auth = (call: request.Test, subject = 'sub-lucia', tenant: string = A) =>
    call
      .set('Authorization', api.bearer(subject, { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', tenant);
  const listTags = (query = '', subject = 'sub-ana') =>
    auth(request(api.server).get(`/api/v1/tags${query}`), subject);
  const createTag = (
    payload: Record<string, unknown>,
    options: { subject?: string; key?: string } = {},
  ) =>
    auth(request(api.server).post('/api/v1/tags'), options.subject)
      .set('Idempotency-Key', options.key ?? randomUUID())
      .send(payload);
  const patchTag = (
    tagId: string,
    payload: Record<string, unknown>,
    ifMatch: string | null = '"1"',
    subject = 'sub-lucia',
  ) => {
    const call = auth(request(api.server).patch(`/api/v1/tags/${tagId}`), subject);
    if (ifMatch !== null) call.set('If-Match', ifMatch);
    return call.send(payload);
  };
  const putTags = (
    processId: string,
    tagIds: readonly string[],
    ifMatch: string | null,
    subject = 'sub-ana',
  ) => {
    const call = auth(request(api.server).put(`/api/v1/processes/${processId}/tags`), subject);
    if (ifMatch !== null) call.set('If-Match', ifMatch);
    return call.send({ tagIds });
  };

  const repository = () => processRepositoryOf(api);
  const tagStore = () => api.app.get(InMemoryTagRepository);
  const stored = (id: string): Process => {
    const process = repository()
      .allProcesses()
      .find((candidate) => candidate.id === id);
    if (!process) throw new Error(`processo ${id} ausente`);
    return process;
  };
  const eventsOf = (processId: string) =>
    api.outboxRows().filter((row) => row.aggregateId === processId);
  const tagsAudit = (processId: string) =>
    api
      .auditRecords()
      .filter((row) => row.action === 'process.tags_update' && row.entityId === processId);
  const configAudit = () =>
    api
      .auditRecords()
      .filter((row) => ['tag.create', 'tag.update', 'tag.deactivate'].includes(row.action));
  const updatedOnTimeline = (processId: string) =>
    timelineRowsOf(api).filter(
      (row) => row.processId === processId && row.type === 'PROCESS_UPDATED',
    );

  async function tagOk(name: string, color?: string): Promise<TagDto> {
    const response = await createTag({ name, ...(color === undefined ? {} : { color }) });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return tagSchema.parse(data<TagDto>(response));
  }

  /** Processo criado pelo PRC-02 (Ana responsável), na versão 9, no estado do cenário. */
  async function processWith(fields: Partial<Process> = {}): Promise<Process> {
    const response = await auth(request(api.server).post('/api/v1/processes'), 'sub-ana')
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Aquisição ${words(2)}`,
        object: `Objeto da contratação ${words(3)}`,
        contractingTypeId: catalog.contractingType,
        requestingSecretariatId: UNITS_A.obras,
        requestingDepartmentId: UNITS_A.manutencao,
        originId: catalog.origin,
        pcaStatus: 'NOT_APPLICABLE',
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const created = stored(data<ProcessDto>(response).id);
    const process: Process = { ...created, status: 'IN_PROGRESS', version: 9, ...fields };
    repository().replace(process);
    return process;
  }

  const foreignTag = (name: string): Tag => ({
    id: newId(),
    tenantId: B,
    name,
    color: '#64748B',
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
    createdById: null,
    updatedById: null,
    version: 1,
  });

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    api = await createTestApi({
      providers: [
        { token: PROCESS_TRANSACTIONS, value: transactions },
        { token: PROCESS_CLOCK, value: () => NOW },
        { token: CATALOG_CLOCK, value: () => NOW },
      ],
    });
    await runTenantSeeders(api, A);
    await runTenantSeeders(api, B, ['catalog.items', 'access.defaultRoles']);
    seedProcessStructure(api, A, { ...UNITS_A, shortName: 'PMSJ', cnpj: '11222333000181' });
    seedProcessStructure(api, B, { ...UNITS_B, shortName: 'PMB', cnpj: '60746948000112' });
    assignDepartment(api, membershipOf(FAKE_USERS.ana.id), UNITS_A.manutencao);
    assignRole(api, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.otavio.id),
      roleId: seedDefaultRolesOf(api, A).get('SOMENTE_LEITURA')?.id ?? '',
    });
    catalog = {
      contractingType: catalogItemId(api, A, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
      origin: catalogItemId(api, A, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
    };
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await api.close();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    transactions.down = false;
  });

  describe('[Sucesso]', () => {
    it('Cadastrar etiqueta e aplicá-la: 201 com tag.create; PUT com If-Match 9 → ETag 10, ProcessUpdated, timeline, auditoria e filtro da lista', async () => {
      const process = await processWith();
      const created = await createTag({ name: '  Obras emergenciais ', color: '#b45309' });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const emergenciais = tagSchema.parse(data<TagDto>(created));
      expect(emergenciais).toMatchObject({
        name: 'Obras emergenciais',
        color: '#B45309',
        isActive: true,
        version: 1,
      });
      expect(created.headers.location).toBe(`/api/v1/tags/${emergenciais.id}`);
      expect(created.headers.etag).toBe('"1"');
      expect(configAudit().at(-1)).toMatchObject({
        action: 'tag.create',
        category: 'CONFIGURATION',
        entityId: emergenciais.id,
        changes: [
          { path: 'name', old: null, new: 'Obras emergenciais' },
          { path: 'color', old: null, new: '#B45309' },
        ],
      });
      // Sem cor, a etiqueta nasce com o padrão `#64748B`.
      const federal = await tagOk('Recurso federal');
      expect(federal.color).toBe('#64748B');

      const response = await putTags(process.id, [federal.id, emergenciais.id], '"9"');
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers.etag).toBe('"10"');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(
        processTagsSchema.parse(data<ProcessTagsDto>(response)).tags.map((tag) => tag.name),
      ).toEqual(['Obras emergenciais', 'Recurso federal']);
      expect(stored(process.id).version).toBe(10);

      const [event] = eventsOf(process.id).filter((row) => row.eventType === 'ProcessUpdated');
      expect(event).toMatchObject({
        routingKey: 'process.updated',
        payload: { changedFields: ['tags'], version: 10 },
      });
      expect(updatedOnTimeline(process.id).at(-1)).toMatchObject({
        params: expect.objectContaining({ fields: ['tags'] }) as unknown,
      });
      const [audit] = tagsAudit(process.id);
      expect(audit).toMatchObject({
        category: 'DATA_CHANGE',
        changes: [{ path: 'tags', old: [], new: ['Obras emergenciais', 'Recurso federal'] }],
        metadata: {
          processCode: process.code,
          version: 10,
          added: expect.arrayContaining(['Obras emergenciais', 'Recurso federal']) as unknown,
          removed: [],
        },
      });

      // Lista (FA-05): o filtro por etiqueta, OU entre as etiquetas, e as etiquetas na linha.
      const filtered = await auth(
        request(api.server).get(`/api/v1/processes?tagId=${emergenciais.id}`),
        'sub-ana',
      );
      expect(filtered.status, JSON.stringify(filtered.body)).toBe(200);
      const rows = z.array(processListItemSchema).parse(data<ProcessListItemDto[]>(filtered));
      expect(rows.map((row) => row.id)).toEqual([process.id]);
      expect(rows[0]?.tags.map((tag) => [tag.name, tag.color, tag.isActive])).toEqual([
        ['Obras emergenciais', '#B45309', true],
        ['Recurso federal', '#64748B', true],
      ]);
      const none = await auth(
        request(api.server).get(`/api/v1/processes?tagId=${newId()}`),
        'sub-ana',
      );
      expect(data<ProcessListItemDto[]>(none)).toEqual([]);

      // Cabeçalho do painel (PRC-07).
      const summary = await auth(
        request(api.server).get(`/api/v1/processes/${process.id}/summary`),
        'sub-ana',
      );
      expect(summary.status, JSON.stringify(summary.body)).toBe(200);
      expect(
        processSummarySchema
          .parse(data<ProcessSummaryDto>(summary))
          .header.tags.map((tag) => tag.name),
      ).toEqual(['Obras emergenciais', 'Recurso federal']);
    });

    it('Substituir o conjunto grava só a diferença; conjunto vazio remove tudo', async () => {
      const process = await processWith();
      const a = await tagOk('Prioridade do gabinete');
      const b = await tagOk('Obras');
      const c = await tagOk('Convênio');
      expect((await putTags(process.id, [a.id, b.id], '"9"')).headers.etag).toBe('"10"');
      const swapped = await putTags(process.id, [b.id, c.id], '"10"');
      expect(swapped.status, JSON.stringify(swapped.body)).toBe(200);
      expect(tagsAudit(process.id).at(-1)).toMatchObject({
        metadata: expect.objectContaining({
          added: ['Convênio'],
          removed: ['Prioridade do gabinete'],
        }) as unknown,
      });
      expect(tagStore().tagIdsOf(process.id).sort()).toEqual([b.id, c.id].sort());
      const cleared = await putTags(process.id, [], '"11"');
      expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
      expect(data<ProcessTagsDto>(cleared).tags).toEqual([]);
      expect(cleared.headers.etag).toBe('"12"');
      expect(tagStore().tagIdsOf(process.id)).toEqual([]);
    });

    it('TAG-01: lista as etiquetas ativas por nome com Cache-Control no-store', async () => {
      await tagOk('Zeta lista');
      await tagOk('Alfa lista');
      const response = await listTags();
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const names = z
        .array(tagSchema)
        .parse(data<TagDto[]>(response))
        .map((tag) => tag.name);
      expect(names.indexOf('Alfa lista')).toBeLessThan(names.indexOf('Zeta lista'));
    });

    it('RuleContext.process.tags (RN-PROC-92): nomes das etiquetas aplicadas, ativas e inativas', async () => {
      const process = await processWith();
      const ativa = await tagOk('Regra ativa');
      const inativa = await tagOk('Regra inativa');
      await putTags(process.id, [ativa.id, inativa.id], '"9"');
      await patchTag(inativa.id, { isActive: false });
      const runtime = await runWithRequestContext(
        { correlationId: 'c-rule-context', ip: '', userAgent: '' },
        () => {
          updateRequestContext({ tenantId: A });
          return runSimulatedTransaction((tx) =>
            api.app.get(ProcessRuntimeLoader).load(tx, process.id),
          );
        },
      );
      expect(runtime?.ruleProcess.tags).toEqual(['Regra ativa', 'Regra inativa']);
    });
  });

  describe('[Validação]', () => {
    it('11 etiquetas: 422 OUT_OF_RANGE em tagIds; repetida: DUPLICATE_IN_LIST; id malformado', async () => {
      const process = await processWith();
      const ids = Array.from({ length: 11 }, () => newId());
      const response = await putTags(process.id, ids, '"9"');
      expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(fieldErrors(response)).toContainEqual(['tagIds', 'OUT_OF_RANGE']);
      const tag = await tagOk('Repetida');
      const duplicate = await putTags(process.id, [tag.id, tag.id], '"9"');
      expect(fieldErrors(duplicate)).toEqual([['tagIds', 'DUPLICATE_IN_LIST']]);
      const malformed = await putTags(process.id, ['x'], '"9"');
      expectProblem(malformed, 422, 'VALIDATION_ERROR');
      expect(stored(process.id).version).toBe(9);
    });

    it('Cor fora da paleta: INVALID_ENUM; fora do formato: INVALID_FORMAT; nome curto e longo', async () => {
      const yellow = await createTag({ name: 'Amarela', color: '#FFFF00' });
      expectProblem(yellow, 422, 'VALIDATION_ERROR');
      expect(fieldErrors(yellow)).toEqual([['color', 'INVALID_ENUM']]);
      expect(fieldErrors(await createTag({ name: 'Azul', color: 'azul' }))).toEqual([
        ['color', 'INVALID_FORMAT'],
      ]);
      expect(fieldErrors(await createTag({ name: 'a' }))).toEqual([['name', 'TOO_SHORT']]);
      expect(fieldErrors(await createTag({ name: 'x'.repeat(41) }))).toEqual([
        ['name', 'TOO_LONG'],
      ]);
      expect(fieldErrors(await createTag({}))).toEqual([['name', 'REQUIRED']]);
      expect(fieldErrors(await createTag({ name: 'Extra', isActive: false }))).toEqual([
        ['isActive', 'NOT_ALLOWED'],
      ]);
    });

    it('PATCH com cor fora da paleta e If-Match ausente (428)', async () => {
      const tag = await tagOk('Para validar');
      expect(fieldErrors(await patchTag(tag.id, { color: '#FFFF00' }))).toEqual([
        ['color', 'INVALID_ENUM'],
      ]);
      expectProblem(
        await patchTag(tag.id, { color: '#0F766E' }, null),
        428,
        'PRECONDITION_REQUIRED',
      );
      const process = await processWith();
      expectProblem(await putTags(process.id, [], null), 428, 'PRECONDITION_REQUIRED');
    });

    it('Etiqueta inativa: nova aplicação = REFERENCE_INACTIVE; já aplicada continua e pode ser removida', async () => {
      const process = await processWith();
      const velha = await tagOk('Velha');
      const nova = await tagOk('Nova');
      await putTags(process.id, [velha.id], '"9"');
      const off = await patchTag(velha.id, { isActive: false });
      expect(off.status, JSON.stringify(off.body)).toBe(200);
      expect(configAudit().at(-1)).toMatchObject({ action: 'tag.deactivate' });
      // RN-PROC-90: nenhuma versão de processo, evento ou timeline por mudança de cadastro.
      expect(stored(process.id).version).toBe(10);

      const kept = await putTags(process.id, [velha.id, nova.id], '"10"');
      expect(kept.status, JSON.stringify(kept.body)).toBe(200);
      expect(data<ProcessTagsDto>(kept).tags.map((tag) => [tag.name, tag.isActive])).toEqual([
        ['Nova', true],
        ['Velha', false],
      ]);
      const reapply = await processWith();
      const refused = await putTags(reapply.id, [velha.id], '"9"');
      expectProblem(refused, 422, 'VALIDATION_ERROR');
      expect(fieldErrors(refused)).toEqual([['tagIds', 'REFERENCE_INACTIVE']]);
      const removed = await putTags(process.id, [nova.id], '"11"');
      expect(data<ProcessTagsDto>(removed).tags.map((tag) => tag.name)).toEqual(['Nova']);
    });

    it('Status não editável: 409 INVALID_PROCESS_STATUS com a mensagem das etiquetas', async () => {
      const awaiting = await processWith({ status: 'AWAITING_APPROVAL' });
      const problem = expectProblem(
        await putTags(awaiting.id, [], '"9"'),
        409,
        'INVALID_PROCESS_STATUS',
      );
      expect(problem.detail).toBe(
        'Etiquetas não podem ser alteradas com o processo aguardando aprovação.',
      );
      const canceled = await processWith({ status: 'CANCELED' });
      expect(
        expectProblem(await putTags(canceled.id, [], '"9"'), 409, 'INVALID_PROCESS_STATUS').detail,
      ).toBe('Etiquetas não podem ser alteradas com o processo cancelado.');
    });
  });

  describe('[Permissão]', () => {
    it('Cadastro sem TAG_MANAGE: 403 PERMISSION_DENIED e access.denied; PATCH também', async () => {
      const denied = await createTag({ name: 'Sem permissão' }, { subject: 'sub-ana' });
      expectProblem(denied, 403, 'PERMISSION_DENIED');
      expect(api.auditRecords().at(-1)).toMatchObject({
        action: 'access.denied',
        reasonCode: 'TAG_MANAGE',
      });
      const tag = await tagOk('Só da gestora');
      expectProblem(
        await patchTag(tag.id, { isActive: false }, '"1"', 'sub-ana'),
        403,
        'PERMISSION_DENIED',
      );
      expect(
        tagStore()
          .snapshot()
          .find((row) => row.id === tag.id)?.isActive,
      ).toBe(true);
    });

    it('Sem custódia: 403 NOT_PROCESS_CUSTODIAN e access.denied; sem PROCESS_UPDATE: 403 no guard', async () => {
      const process = await processWith();
      const tag = await tagOk('Sem custódia');
      expectProblem(
        await putTags(process.id, [tag.id], '"9"', 'sub-fabio'),
        403,
        'NOT_PROCESS_CUSTODIAN',
      );
      expect(api.auditRecords().at(-1)).toMatchObject({
        action: 'access.denied',
        reasonCode: 'NOT_PROCESS_CUSTODIAN',
      });
      expectProblem(
        await putTags(process.id, [tag.id], '"9"', 'sub-otavio'),
        403,
        'PERMISSION_DENIED',
      );
      expect(tagsAudit(process.id)).toEqual([]);
      expect(tagStore().tagIdsOf(process.id)).toEqual([]);
    });

    it('TAG-01: includeInactive só vale com TAG_MANAGE; leitura exige PROCESS_VIEW', async () => {
      const tag = await tagOk('Desativada para listar');
      await patchTag(tag.id, { isActive: false });
      const names = (response: request.Response) => data<TagDto[]>(response).map((row) => row.name);
      expect(names(await listTags('?includeInactive=true', 'sub-ana'))).not.toContain(
        'Desativada para listar',
      );
      expect(names(await listTags('?includeInactive=true', 'sub-lucia'))).toContain(
        'Desativada para listar',
      );
      expect(names(await listTags('', 'sub-lucia'))).not.toContain('Desativada para listar');
      expect((await listTags('', 'sub-otavio')).status).toBe(200);
    });

    it('PRC-08: "Etiquetas" habilitada para a responsável, desabilitada sem custódia e ausente sem PROCESS_UPDATE', async () => {
      const process = await processWith();
      const actionOf = async (subject: string) =>
        z
          .array(actionEntrySchema)
          .parse(
            data<ActionEntry[]>(
              await auth(
                request(api.server).get(`/api/v1/processes/${process.id}/available-actions`),
                subject,
              ),
            ),
          )
          .find((entry) => entry.action === 'MANAGE_TAGS');
      expect(await actionOf('sub-ana')).toMatchObject({ enabled: true, reasons: [] });
      expect(await actionOf('sub-fabio')).toMatchObject({
        enabled: false,
        reasons: [
          {
            code: 'NOT_PROCESS_CUSTODIAN',
            message: 'Somente quem está com o processo pode alterar as etiquetas.',
          },
        ],
      });
      expect(await actionOf('sub-otavio')).toBeUndefined();
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Etiqueta de outro tenant: PUT 422 REFERENCE_NOT_FOUND; PATCH 404 NOT_FOUND; fora da lista', async () => {
      const process = await processWith();
      const outsider = foreignTag('T-B');
      tagStore().seed(outsider);
      const response = await putTags(process.id, [outsider.id], '"9"');
      expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(fieldErrors(response)).toEqual([['tagIds', 'REFERENCE_NOT_FOUND']]);
      expectProblem(await patchTag(outsider.id, { name: 'Invadida' }), 404, 'NOT_FOUND');
      expect(
        tagStore()
          .snapshot()
          .find((row) => row.id === outsider.id)?.name,
      ).toBe('T-B');
      const names = data<TagDto[]>(await listTags('?includeInactive=true', 'sub-lucia')).map(
        (row) => row.name,
      );
      expect(names).not.toContain('T-B');
    });

    it('Etiqueta com o mesmo nome em outro tenant não conflita; processo de outro tenant = 404', async () => {
      tagStore().seed(foreignTag('Nome compartilhado'));
      await tagOk('Nome compartilhado');
      const foreignProcess = newId();
      expectProblem(await putTags(foreignProcess, [], '"1"'), 404, 'PROCESS_NOT_FOUND');
    });
  });

  describe('[Duplicidade]', () => {
    it('Nome repetido sem diferenciar maiúsculas: 409 CONFLICT, no cadastro e na renomeação', async () => {
      await tagOk('Obras duplicadas');
      expectProblem(await createTag({ name: 'obras DUPLICADAS' }), 409, 'CONFLICT');
      const other = await tagOk('Outra duplicada');
      const problem = expectProblem(
        await patchTag(other.id, { name: ' Obras Duplicadas ' }),
        409,
        'CONFLICT',
      );
      expect(problem.detail).toBe('Já existe uma etiqueta com este nome.');
    });

    it('Reenvio da criação com a mesma Idempotency-Key devolve a mesma etiqueta', async () => {
      const key = randomUUID();
      const first = await createTag({ name: 'Idempotente' }, { key });
      const second = await createTag({ name: 'Idempotente' }, { key });
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(data<TagDto>(second).id).toBe(data<TagDto>(first).id);
    });

    it('Conjunto idêntico: 200 sem nova versão, sem evento, sem timeline e sem auditoria', async () => {
      const process = await processWith();
      const tag = await tagOk('Idêntica');
      await putTags(process.id, [tag.id], '"9"');
      const events = eventsOf(process.id).length;
      const timeline = updatedOnTimeline(process.id).length;
      const audits = tagsAudit(process.id).length;
      // Mesmo com o If-Match desatualizado, o no-op não grava nada (RN-PROC-89).
      const again = await putTags(process.id, [tag.id], '"9"');
      expect(again.status, JSON.stringify(again.body)).toBe(200);
      expect(again.headers.etag).toBe('"10"');
      expect(data<ProcessTagsDto>(again).tags.map((row) => row.name)).toEqual(['Idêntica']);
      expect(stored(process.id).version).toBe(10);
      expect(eventsOf(process.id)).toHaveLength(events);
      expect(updatedOnTimeline(process.id)).toHaveLength(timeline);
      expect(tagsAudit(process.id)).toHaveLength(audits);
    });

    it('PATCH sem diferença: 200 com a etiqueta atual, sem versão nem auditoria', async () => {
      const tag = await tagOk('Sem mudança');
      const audits = configAudit().length;
      const response = await patchTag(tag.id, { name: 'Sem mudança', color: tag.color });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers.etag).toBe('"1"');
      expect(configAudit()).toHaveLength(audits);
    });
  });

  describe('[Concorrência]', () => {
    it('If-Match desatualizado no PUT: 412 VERSION_CONFLICT sem alterar o conjunto', async () => {
      const process = await processWith({ version: 10 });
      const tag = await tagOk('Concorrente');
      // Um item foi incluído em seguida (versão 11); a Ana ainda confirma com a 10.
      repository().replace({ ...stored(process.id), version: 11 });
      const response = await putTags(process.id, [tag.id], '"10"');
      expectProblem(response, 412, 'VERSION_CONFLICT');
      expect(tagStore().tagIdsOf(process.id)).toEqual([]);
      expect(eventsOf(process.id).filter((row) => row.eventType === 'ProcessUpdated')).toEqual([]);
      // Recarregada, a mesma seleção é aceita com a versão nova.
      expect((await putTags(process.id, [tag.id], '"11"')).headers.etag).toBe('"12"');
    });

    it('PATCH com If-Match divergente: 412 VERSION_CONFLICT', async () => {
      const tag = await tagOk('Versão da etiqueta');
      expect((await patchTag(tag.id, { color: '#0F766E' }, '"1"')).headers.etag).toBe('"2"');
      expectProblem(await patchTag(tag.id, { color: '#0369A1' }, '"1"'), 412, 'VERSION_CONFLICT');
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível: 503 DEPENDENCY_UNAVAILABLE e nada persistido', async () => {
      const process = await processWith();
      const tag = await tagOk('Banco fora');
      transactions.down = true;
      expectProblem(await putTags(process.id, [tag.id], '"9"'), 503, 'DEPENDENCY_UNAVAILABLE');
      expectProblem(await createTag({ name: 'Não grava' }), 503, 'DEPENDENCY_UNAVAILABLE');
      transactions.down = false;
      expect(tagStore().tagIdsOf(process.id)).toEqual([]);
      expect(tagsAudit(process.id)).toEqual([]);
      expect(eventsOf(process.id).filter((row) => row.eventType === 'ProcessUpdated')).toEqual([]);
      expect(
        tagStore()
          .snapshot()
          .some((row) => row.name === 'Não grava'),
      ).toBe(false);
    });
  });

  describe('[Falha de integração]', () => {
    it('Relay do outbox indisponível: PUT responde 200 e o evento fica no outbox para publicação', async () => {
      // Sem relay no teste: a linha permanece para publicar (PENDING no PostgreSQL — tenant-leak).
      const process = await processWith();
      const tag = await tagOk('Relay fora');
      const response = await putTags(process.id, [tag.id], '"9"');
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(eventsOf(process.id).filter((row) => row.eventType === 'ProcessUpdated')).toHaveLength(
        1,
      );
    });
  });
});
