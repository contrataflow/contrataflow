import { randomUUID } from 'node:crypto';

import {
  commentBodyFromText,
  commentListMetaSchema,
  commentSchema,
  commentThreadSchema,
  problemDetailsSchema,
} from '@contrataflow/validation';
import type {
  CommentDto,
  CommentListMetaDto,
  CommentThreadDto,
  ProcessDto,
} from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { z } from 'zod';

import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import {
  buildDocument,
  buildTemplateVersion,
  documentRepositoryOf,
  documentTypeRepositoryOf,
  sectionDefinition,
  seedTemplateVersions,
} from '../../../../test/support/document-fixtures.js';
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
import { COMMENT_CLOCK, COMMENT_TRANSACTIONS } from '../application/ports.js';
import type { CommentTransactions } from '../application/ports.js';
import { createComment } from '../domain/comment.js';
import { InMemoryCommentRepository } from '../infrastructure/in-memory-comment.repository.js';

/*
 * US-071 — CMT-01..04 (comentar no processo e em documentos) pelo pipeline HTTP completo
 * (autenticação, tenant, vínculo, autorização, `If-Match`, `Idempotency-Key`, filtro RFC 9457) com
 * a identidade fake, os seeders reais e o processo criado pelo PRC-02. As 8 categorias do Gherkin.
 * Personas: "Marcos" = Ana (REQUISITANTE, responsável pelo processo); "Cláudia" = Lúcia
 * (LICITACOES com escopo TENANT — comenta, sem PROCESS_VIEW_CONFIDENTIAL_BUDGET nem custódia);
 * "Tatiane" = Otávio (SOMENTE_LEITURA); "Patrícia" = Marta (GESTOR_CONTRATACOES, COMMENT_MODERATE
 * com escopo TENANT). RLS, FKs compostas e rollback no PostgreSQL: `test/tenant-leak/comments.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-17T15:00:00.000Z');
const MARCOS = 'sub-ana';
const CLAUDIA = 'sub-lucia';
const TATIANE = 'sub-otavio';
const PATRICIA = 'sub-marta';
/** `{ hash, length }` da auditoria (DEC-138): o hash SHA-256 em hexadecimal. */
const HASH: unknown = expect.stringMatching(/^[0-9a-f]{64}$/);
const SUCCESS_KEY = '0192d071-0000-7000-8000-0000000000c1';
const K7 = '0192d071-0000-7000-8000-0000000000c7';

const UNITS_A = {
  organizationId: '0192d071-0000-7000-8000-0000000000a0',
  obras: '0192d071-0000-7000-8000-0000000000a1',
  manutencao: '0192d071-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d071-0000-7000-8000-0000000000a3',
  saude: '0192d071-0000-7000-8000-0000000000a4',
  posto: '0192d071-0000-7000-8000-0000000000a5',
};
const UNITS_B = {
  organizationId: '0192d071-0000-7000-8000-0000000000b0',
  obras: '0192d071-0000-7000-8000-0000000000b1',
  manutencao: '0192d071-0000-7000-8000-0000000000b2',
  pavimentacao: '0192d071-0000-7000-8000-0000000000b3',
  saude: '0192d071-0000-7000-8000-0000000000b4',
  posto: '0192d071-0000-7000-8000-0000000000b5',
};

type Process = Parameters<ReturnType<typeof processRepositoryOf>['replace']>[0];

const membershipOf = (userId: string, tenantId = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

/** Transações em fila (como as do módulo) que podem simular o banco fora do ar. */
class FlakyTransactions implements CommentTransactions {
  down = false;
  private queue: Promise<unknown> = Promise.resolve();

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    if (this.down) return Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED')));
    const next = this.queue.then(() => runSimulatedTransaction(work));
    this.queue = next.catch(() => undefined);
    return next;
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    if (this.down) return Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED')));
    return runSimulatedTransaction(work);
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

describe('Feature: Comentar no processo e em documentos (US-071)', () => {
  let api: TestApi;
  let log: MockInstance<Logger['log']>;
  let warn: MockInstance<Logger['warn']>;
  const transactions = new FlakyTransactions();
  const clock = { now: NOW };
  let catalog: { contractingType: string; origin: string };
  const words = (count: number) =>
    Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

  const auth = (call: request.Test, subject = MARCOS, tenant: string = A) =>
    call
      .set('Authorization', api.bearer(subject, { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', tenant);
  const list = (processId: string, subject = MARCOS, query = '') =>
    auth(request(api.server).get(`/api/v1/processes/${processId}/comments${query}`), subject);
  const post = (
    processId: string,
    payload: Record<string, unknown>,
    options: { subject?: string; key?: string } = {},
  ) =>
    auth(request(api.server).post(`/api/v1/processes/${processId}/comments`), options.subject)
      .set('Idempotency-Key', options.key ?? randomUUID())
      .send(payload);
  const patch = (commentId: string, payload: unknown, ifMatch = '"1"', subject = MARCOS) =>
    auth(request(api.server).patch(`/api/v1/comments/${commentId}`), subject)
      .set('If-Match', ifMatch)
      .send(payload as object);
  const remove = (commentId: string, ifMatch = '"1"', subject = MARCOS, payload?: object) => {
    const call = auth(request(api.server).delete(`/api/v1/comments/${commentId}`), subject).set(
      'If-Match',
      ifMatch,
    );
    return payload === undefined ? call : call.send(payload);
  };

  const store = () => api.app.get(InMemoryCommentRepository, { strict: false });
  const commentsOf = (processId: string) =>
    store()
      .snapshot()
      .filter((comment) => comment.processId === processId);
  const eventsOf = (processId: string, eventType?: string) =>
    api
      .outboxRows()
      .filter(
        (row) =>
          row.processId === processId &&
          row.eventType.startsWith('Comment') &&
          (eventType === undefined || row.eventType === eventType),
      );
  const auditOf = (processId: string, action?: string) =>
    api
      .auditRecords()
      .filter(
        (row) =>
          row.processId === processId &&
          row.action.startsWith('comment.') &&
          (action === undefined || row.action === action),
      );
  const timelineOf = (processId: string) =>
    timelineRowsOf(api).filter(
      (row) => row.processId === processId && row.type.startsWith('COMMENT_'),
    );
  const said = (text: string) => ({ body: commentBodyFromText(text), targetType: 'PROCESS' });
  const threadsOf = (response: request.Response) =>
    z.array(commentThreadSchema).parse(data<CommentThreadDto[]>(response));
  const metaOf = (response: request.Response): CommentListMetaDto =>
    commentListMetaSchema.parse((response.body as { meta: unknown }).meta);

  /** Processo criado pelo PRC-02 (Ana responsável), em `IN_PROGRESS`. */
  async function processWith(fields: Partial<Process> = {}): Promise<Process> {
    const response = await auth(request(api.server).post('/api/v1/processes'))
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
    const created = processRepositoryOf(api)
      .allProcesses()
      .find((candidate) => candidate.id === data<ProcessDto>(response).id);
    if (!created) throw new Error('processo ausente');
    const process: Process = { ...created, status: 'IN_PROGRESS', ...fields };
    processRepositoryOf(api).replace(process);
    return process;
  }

  /** Documento do processo (ETP com a seção REQUIREMENTS no template, por padrão). */
  function seedDocument(
    process: Process,
    options: {
      systemModule?: string;
      status?: 'DRAFT' | 'CANCELED';
      confidentiality?: 'INTERNAL' | 'RESTRICTED';
      uploaded?: boolean;
      tenantId?: string;
      code?: string;
    } = {},
  ) {
    const tenantId = options.tenantId ?? A;
    const type = documentTypeRepositoryOf(api)
      .snapshot()
      .find(
        (candidate) =>
          candidate.tenantId === tenantId &&
          candidate.systemModule === (options.systemModule ?? 'ETP'),
      );
    if (!type) throw new Error('tipo de documento ausente');
    const template = buildTemplateVersion({
      tenantId,
      sections: [sectionDefinition('REQUIREMENTS'), sectionDefinition('JUSTIFICATION')],
    });
    seedTemplateVersions(api, template);
    const document = buildDocument({
      tenantId,
      processId: process.id,
      documentTypeId: type.id,
      templateVersionId: options.uploaded ? null : template.id,
      code: options.code ?? 'ETP 0003/2026',
      title: 'Estudo técnico preliminar',
      status: options.status ?? 'DRAFT',
      confidentiality: options.confidentiality ?? 'INTERNAL',
    });
    documentRepositoryOf(api).seed(document);
    return document;
  }

  async function createOk(processId: string, payload: Record<string, unknown>, subject = MARCOS) {
    const response = await post(processId, payload, { subject });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return commentSchema.parse(data<CommentDto>(response));
  }

  beforeAll(async () => {
    log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    api = await createTestApi({
      providers: [
        { token: COMMENT_TRANSACTIONS, value: transactions },
        { token: COMMENT_CLOCK, value: () => clock.now },
        { token: CATALOG_CLOCK, value: () => NOW },
      ],
    });
    await runTenantSeeders(api, A);
    await runTenantSeeders(api, B);
    seedProcessStructure(api, A, { ...UNITS_A, shortName: 'PMSJ', cnpj: '11222333000181' });
    seedProcessStructure(api, B, { ...UNITS_B, shortName: 'PMB', cnpj: '60746948000112' });
    assignDepartment(api, membershipOf(FAKE_USERS.ana.id), UNITS_A.manutencao);
    assignDepartment(api, membershipOf(FAKE_USERS.lucia.id), UNITS_A.saude);
    const roles = seedDefaultRolesOf(api, A);
    const grant = (userId: string, key: string) => {
      assignRole(api, {
        tenantId: A,
        membershipId: membershipOf(userId),
        roleId: roles.get(key)?.id ?? '',
      });
    };
    grant(FAKE_USERS.lucia.id, 'LICITACOES');
    grant(FAKE_USERS.otavio.id, 'SOMENTE_LEITURA');
    grant(FAKE_USERS.marta.id, 'GESTOR_CONTRATACOES');
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
    clock.now = NOW;
  });

  describe('[Sucesso]', () => {
    it('Comentar no processo: 201 com ETag "1", topo da aba, COMMENT_ADDED, comment.create e CommentCreated', async () => {
      const process = await processWith();
      await createOk(process.id, said('Comentário mais antigo.'));
      clock.now = new Date(NOW.getTime() + 60_000);
      const response = await post(process.id, said('Precisamos rever as quantidades do item 2.'), {
        key: SUCCESS_KEY,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.headers.etag).toBe('"1"');
      const created = commentSchema.parse(data<CommentDto>(response));
      expect(response.headers.location).toBe(`/api/v1/comments/${created.id}`);
      expect(created).toMatchObject({
        processId: process.id,
        targetType: 'PROCESS',
        document: null,
        sectionKey: null,
        parentId: null,
        author: { id: FAKE_USERS.ana.id, name: 'Ana Souza' },
        bodyMasked: false,
        isDeleted: false,
        canEdit: true,
        editableUntil: '2026-10-17T15:16:00.000Z',
        canDelete: true,
        canModerate: false,
        version: 1,
      });
      expect(created.author.departmentName).not.toBeNull();

      const listed = await list(process.id);
      expect(listed.status, JSON.stringify(listed.body)).toBe(200);
      expect(listed.headers['cache-control']).toBe('no-store');
      const [top, older] = threadsOf(listed);
      expect(top).toMatchObject({
        id: created.id,
        author: { name: 'Ana Souza' },
        replies: [],
        replyCount: 0,
      });
      expect(older?.id).not.toBe(created.id);
      expect(metaOf(listed)).toMatchObject({
        canComment: true,
        readOnly: false,
        isBudgetConfidential: false,
        hasMore: false,
        nextCursor: null,
      });

      expect(timelineOf(process.id).at(-1)).toMatchObject({
        type: 'COMMENT_ADDED',
        visibility: 'STANDARD',
        entityId: created.id,
        params: { excerpt: 'Precisamos rever as quantidades do item 2.', targetType: 'PROCESS' },
      });
      const audit = auditOf(process.id, 'comment.create').at(-1);
      expect(audit).toMatchObject({
        category: 'DATA_CHANGE',
        entityType: 'Comment',
        entityId: created.id,
        metadata: { targetType: 'PROCESS', idempotencyKey: SUCCESS_KEY },
      });
      expect(audit?.changes).toEqual([
        { path: 'body', old: null, new: { hash: HASH, length: 42 } },
      ]);
      expect(eventsOf(process.id, 'CommentCreated').at(-1)).toMatchObject({
        routingKey: 'comment.created',
        aggregateId: created.id,
        payload: {
          commentId: created.id,
          targetType: 'PROCESS',
          documentId: null,
          sectionKey: null,
          parentId: null,
          parentAuthorId: null,
        },
      });
      // Logs sem o texto do comentário (story · "Logs").
      const logged = JSON.stringify(log.mock.calls);
      expect(logged).toContain('comment.created');
      expect(logged).not.toContain('rever as quantidades');
      expect(JSON.stringify(audit)).not.toContain('rever as quantidades');
    });

    it('Responder a comentário ancorado em seção do ETP: herda documento e seção; COMMENT_REPLY a Cláudia', async () => {
      const process = await processWith();
      const etp = seedDocument(process);
      const root = await createOk(
        process.id,
        {
          body: commentBodyFromText('Requisito 3 está vago.'),
          targetType: 'DOCUMENT',
          documentId: etp.id,
          sectionKey: 'REQUIREMENTS',
        },
        CLAUDIA,
      );
      expect(root).toMatchObject({
        document: { id: etp.id, code: 'ETP 0003/2026', title: 'Estudo técnico preliminar' },
        sectionKey: 'REQUIREMENTS',
        author: { id: FAKE_USERS.lucia.id },
      });
      const reply = await createOk(process.id, {
        body: commentBodyFromText('Ajustado na versão 2.'),
        targetType: 'DOCUMENT',
        parentId: root.id,
      });
      expect(reply).toMatchObject({
        parentId: root.id,
        targetType: 'DOCUMENT',
        document: { id: etp.id },
        sectionKey: 'REQUIREMENTS',
      });
      // Notificação: o `NotificationDispatcher` entrega `COMMENT_REPLY` ao `parentAuthorId` e exclui
      // o ator (RN-NTF-02) — Marcos não é notificado pela própria resposta.
      const [event] = eventsOf(process.id, 'CommentCreated').filter(
        (row) => row.aggregateId === reply.id,
      );
      expect(event?.payload).toEqual({
        commentId: reply.id,
        targetType: 'DOCUMENT',
        documentId: etp.id,
        sectionKey: 'REQUIREMENTS',
        parentId: root.id,
        parentAuthorId: FAKE_USERS.lucia.id,
      });
      expect(event?.metadata.actor.userId).toBe(FAKE_USERS.ana.id);
      expect(timelineOf(process.id).at(-1)?.params).toMatchObject({
        documentId: etp.id,
        documentCode: 'ETP 0003/2026',
      });

      const [thread] = threadsOf(await list(process.id, MARCOS, '?targetType=DOCUMENT'));
      expect(thread).toMatchObject({ id: root.id, replyCount: 1, replies: [{ id: reply.id }] });
      const bySection = threadsOf(
        await list(process.id, MARCOS, `?documentId=${etp.id}&sectionKey=JUSTIFICATION`),
      );
      expect(bySection).toEqual([]);
      expect(threadsOf(await list(process.id, MARCOS, '?targetType=PROCESS'))).toEqual([]);
    });

    it('Editar dentro de 15 minutos e excluir o próprio comentário', async () => {
      const process = await processWith();
      const created = await createOk(process.id, said('Texto original.'));
      clock.now = new Date(NOW.getTime() + 5 * 60_000);
      const edited = await patch(created.id, { body: commentBodyFromText('Texto corrigido.') });
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      expect(edited.headers.etag).toBe('"2"');
      expect(data<CommentDto>(edited)).toMatchObject({
        editedAt: '2026-10-17T15:05:00.000Z',
        version: 2,
        body: commentBodyFromText('Texto corrigido.'),
      });
      const [audit] = auditOf(process.id, 'comment.update');
      expect(audit?.changes).toEqual([
        {
          path: 'body',
          old: { hash: HASH, length: 15 },
          new: { hash: HASH, length: 16 },
        },
      ]);
      expect(eventsOf(process.id, 'CommentUpdated').map((row) => row.payload)).toEqual([
        { commentId: created.id },
      ]);

      const removed = await remove(created.id, '"2"');
      expect(removed.status, JSON.stringify(removed.body)).toBe(204);
      const [thread] = threadsOf(await list(process.id));
      expect(thread).toMatchObject({
        id: created.id,
        isDeleted: true,
        deletedByModerator: false,
        deletionReason: null,
        body: null,
        canEdit: false,
        canDelete: false,
      });
      expect(JSON.stringify(thread)).not.toContain('Texto corrigido');
      expect(auditOf(process.id, 'comment.delete').at(-1)?.metadata).toMatchObject({
        hadReplies: false,
      });
      expect(eventsOf(process.id, 'CommentDeleted').map((row) => row.payload)).toEqual([
        { commentId: created.id, byModerator: false },
      ]);
      // Exclusão pelo autor não gera entrada; o trecho já projetado é suprimido na leitura.
      expect(timelineOf(process.id).map((row) => row.type)).toEqual(['COMMENT_ADDED']);
      const timeline = await auth(
        request(api.server).get(`/api/v1/processes/${process.id}/timeline`),
      );
      expect(timeline.status).toBe(200);
      const entry = data<{ type: string; params: Record<string, unknown> }[]>(timeline).find(
        (row) => row.type === 'COMMENT_ADDED',
      );
      expect(entry?.params).toMatchObject({ excerpt: null, commentDeleted: true });
    });

    it('FA-10: thread com mais de 20 respostas — 20 embutidas, replyCount e ?parentId= com cursor', async () => {
      const process = await processWith();
      const root = await createOk(process.id, said('Raiz.'));
      for (let index = 0; index < 22; index += 1) {
        clock.now = new Date(NOW.getTime() + (index + 1) * 1000);
        await createOk(process.id, { ...said(`Resposta ${String(index + 1)}`), parentId: root.id });
      }
      const [thread] = threadsOf(await list(process.id));
      expect(thread?.replyCount).toBe(22);
      expect(thread?.replies).toHaveLength(20);
      expect(thread?.replies[0]?.body).toEqual(commentBodyFromText('Resposta 1'));
      const first = await list(process.id, MARCOS, `?parentId=${root.id}&limit=15`);
      expect(threadsOf(first)).toHaveLength(15);
      const { nextCursor, hasMore } = metaOf(first);
      expect(hasMore).toBe(true);
      const second = await list(
        process.id,
        MARCOS,
        `?parentId=${root.id}&limit=15&cursor=${nextCursor ?? ''}`,
      );
      expect(threadsOf(second).map((row) => row.body)).toEqual(
        Array.from({ length: 7 }, (_, i) => commentBodyFromText(`Resposta ${String(16 + i)}`)),
      );
      expect(metaOf(second).hasMore).toBe(false);
    });

    it('Paginação das raízes por cursor (limit) e cursor inválido → 422', async () => {
      const process = await processWith();
      for (let index = 0; index < 3; index += 1) {
        clock.now = new Date(NOW.getTime() + index * 1000);
        await createOk(process.id, said(`Raiz ${String(index + 1)}`));
      }
      const first = await list(process.id, MARCOS, '?limit=2');
      expect(threadsOf(first).map((row) => row.body)).toEqual([
        commentBodyFromText('Raiz 3'),
        commentBodyFromText('Raiz 2'),
      ]);
      const cursor = metaOf(first).nextCursor ?? '';
      const second = await list(process.id, MARCOS, `?limit=2&cursor=${cursor}`);
      expect(threadsOf(second).map((row) => row.body)).toEqual([commentBodyFromText('Raiz 1')]);
      expectProblem(await list(process.id, MARCOS, '?cursor=bad'), 422, 'VALIDATION_ERROR');
      expectProblem(await list(process.id, MARCOS, '?limit=101'), 422, 'VALIDATION_ERROR');
    });
  });

  describe('[Validação]', () => {
    it('Formatação não permitida: nó image ou link javascript: → 422 RICH_TEXT_INVALID e nada criado', async () => {
      const process = await processWith();
      const image = await post(process.id, {
        targetType: 'PROCESS',
        body: { type: 'doc', content: [{ type: 'image', attrs: { src: 'https://x/y.png' } }] },
      });
      const problem = expectProblem(image, 422, 'RICH_TEXT_INVALID');
      expect(problem.detail).toBe('O comentário contém formatação não permitida.');
      const script = await post(process.id, {
        targetType: 'PROCESS',
        body: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'clique',
                  marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
                },
              ],
            },
          ],
        },
      });
      expect(expectProblem(script, 422, 'RICH_TEXT_INVALID').detail).toBe(
        'Use apenas links http, https ou mailto.',
      );
      expect(commentsOf(process.id)).toEqual([]);
      expect(eventsOf(process.id)).toEqual([]);
      // `warn comment.rich_text_rejected` só com o nome do nó (nunca o conteúdo).
      const warned = JSON.stringify(warn.mock.calls);
      expect(warned).toContain('comment.rich_text_rejected');
      expect(warned).toContain('"element":"image"');
      expect(warned).not.toContain('javascript:alert');

      const empty = await post(process.id, {
        targetType: 'PROCESS',
        body: commentBodyFromText('   '),
      });
      expectProblem(empty, 422, 'VALIDATION_ERROR');
      expect(fieldErrors(empty)).toEqual([['body', 'REQUIRED']]);
      const tooLong = await post(process.id, said('a'.repeat(10_001)));
      expect(fieldErrors(tooLong)).toEqual([['body', 'TOO_LONG']]);
      expect(
        fieldErrors(
          await post(process.id, { targetType: 'DOCUMENT', body: commentBodyFromText('x') }),
        ),
      ).toEqual([['documentId', 'CONDITIONAL_REQUIRED']]);
    });

    it('Edição após o prazo (16 min) → 409 COMMENT_EDIT_WINDOW_EXPIRED; seção inexistente → 422 SECTION_NOT_IN_TEMPLATE', async () => {
      const process = await processWith();
      const created = await createOk(process.id, said('Comentário antigo.'));
      clock.now = new Date(NOW.getTime() + 16 * 60_000);
      const late = await patch(created.id, { body: commentBodyFromText('Tarde demais.') });
      expect(expectProblem(late, 409, 'COMMENT_EDIT_WINDOW_EXPIRED').detail).toBe(
        'O prazo de 15 minutos para editar terminou.',
      );
      const [thread] = threadsOf(await list(process.id));
      expect(thread).toMatchObject({ canEdit: false, editableUntil: null, canDelete: true });

      const etp = seedDocument(process);
      const section = await post(process.id, {
        body: commentBodyFromText('Seção?'),
        targetType: 'DOCUMENT',
        documentId: etp.id,
        sectionKey: 'SECAO_INEXISTENTE',
      });
      expectProblem(section, 422, 'SECTION_NOT_IN_TEMPLATE');
      const external = seedDocument(process, { uploaded: true, code: 'EXT 0001/2026' });
      expectProblem(
        await post(process.id, {
          body: commentBodyFromText('Seção?'),
          targetType: 'DOCUMENT',
          documentId: external.id,
          sectionKey: 'REQUIREMENTS',
        }),
        422,
        'SECTION_NOT_IN_TEMPLATE',
      );
      // Documento externo aceita comentário sem seção.
      await createOk(process.id, {
        body: commentBodyFromText('Documento externo ok.'),
        targetType: 'DOCUMENT',
        documentId: external.id,
      });
    });

    it('Documento cancelado → 409 INVALID_STATE; resposta a resposta ou com alvo divergente → 422', async () => {
      const process = await processWith();
      const canceled = seedDocument(process, { status: 'CANCELED' });
      expectProblem(
        await post(process.id, {
          body: commentBodyFromText('x'),
          targetType: 'DOCUMENT',
          documentId: canceled.id,
        }),
        409,
        'INVALID_STATE',
      );
      const root = await createOk(process.id, said('Raiz.'));
      const reply = await createOk(process.id, { ...said('Resposta.'), parentId: root.id });
      const nested = await post(process.id, {
        ...said('Resposta da resposta.'),
        parentId: reply.id,
      });
      expectProblem(nested, 422, 'VALIDATION_ERROR');
      expect(fieldErrors(nested)).toEqual([['parentId', 'REFERENCE_NOT_FOUND']]);
      const etp = seedDocument(process);
      const mismatch = await post(process.id, {
        body: commentBodyFromText('Alvo errado.'),
        targetType: 'DOCUMENT',
        documentId: etp.id,
        parentId: root.id,
      });
      expect(fieldErrors(mismatch)).toEqual([['targetType', 'NOT_ALLOWED']]);
      expect(
        fieldErrors(await post(process.id, { ...said('Pai inexistente.'), parentId: newId() })),
      ).toEqual([['parentId', 'REFERENCE_NOT_FOUND']]);
    });

    it('Processo encerrado é somente leitura (exceto moderação)', async () => {
      const process = await processWith();
      const created = await createOk(process.id, said('Antes de concluir.'));
      processRepositoryOf(api).replace({ ...process, status: 'COMPLETED' });
      const response = await post(process.id, said('Depois de concluir.'));
      expect(expectProblem(response, 409, 'INVALID_PROCESS_STATUS').detail).toBe(
        'Este processo está encerrado; os comentários estão disponíveis apenas para leitura.',
      );
      expectProblem(
        await patch(created.id, { body: commentBodyFromText('Editar?') }),
        409,
        'INVALID_PROCESS_STATUS',
      );
      expectProblem(await remove(created.id), 409, 'INVALID_PROCESS_STATUS');
      const listed = await list(process.id);
      expect(metaOf(listed)).toMatchObject({ readOnly: true, canComment: false });
      expect(threadsOf(listed)[0]).toMatchObject({ canEdit: false, canDelete: false });
      // A moderação continua permitida (RN-CMT-11).
      const moderated = await remove(created.id, '"1"', PATRICIA, {
        reason: 'Contém dados pessoais de terceiro.',
      });
      expect(moderated.status, JSON.stringify(moderated.body)).toBe(204);
    });
  });

  describe('[Permissão]', () => {
    it('Usuário sem COMMENT_CREATE lê sem compositor e recebe 403 com access.denied; edição por terceiro → 403', async () => {
      const process = await processWith();
      const created = await createOk(process.id, said('Comentário do Marcos.'));
      const listed = await list(process.id, TATIANE);
      expect(listed.status, JSON.stringify(listed.body)).toBe(200);
      expect(metaOf(listed)).toMatchObject({ canComment: false, readOnly: false });
      expect(threadsOf(listed)[0]).toMatchObject({
        canEdit: false,
        canDelete: false,
        canModerate: false,
      });

      const denied = await post(process.id, said('Tentativa.'), { subject: TATIANE });
      expectProblem(denied, 403, 'PERMISSION_DENIED');
      expect(api.auditRecords().at(-1)).toMatchObject({
        action: 'access.denied',
        reasonCode: 'COMMENT_CREATE',
      });
      const foreign = await patch(
        created.id,
        { body: commentBodyFromText('Editado por outra.') },
        '"1"',
        CLAUDIA,
      );
      expectProblem(foreign, 403, 'PERMISSION_DENIED');
      // Sem COMMENT_MODERATE, excluir comentário de outra pessoa também é 403 (auditado).
      expectProblem(
        await remove(created.id, '"1"', CLAUDIA, { reason: 'Não gostei do comentário.' }),
        403,
        'PERMISSION_DENIED',
      );
      expect(api.auditRecords().at(-1)).toMatchObject({
        action: 'access.denied',
        reasonCode: 'COMMENT_MODERATE',
      });
      expect(commentsOf(process.id).map((row) => row.bodyText)).toEqual(['Comentário do Marcos.']);
    });

    it('Moderação com motivo: "removido por moderação", COMMENT_REMOVED, comment.moderate e byModerator', async () => {
      const process = await processWith();
      const created = await createOk(
        process.id,
        said('Contato do fornecedor: 9999-0000.'),
        CLAUDIA,
      );
      const forModerator = threadsOf(await list(process.id, PATRICIA))[0];
      expect(forModerator).toMatchObject({ canModerate: true, canEdit: false });

      const missing = await remove(created.id, '"1"', PATRICIA);
      expectProblem(missing, 422, 'VALIDATION_ERROR');
      expect(fieldErrors(missing)).toEqual([['reason', 'REQUIRED']]);
      expectProblem(
        await remove(created.id, '"1"', PATRICIA, { reason: 'curto' }),
        422,
        'VALIDATION_ERROR',
      );

      const moderated = await remove(created.id, '"1"', PATRICIA, {
        reason: 'Contém dados pessoais de terceiro.',
      });
      expect(moderated.status, JSON.stringify(moderated.body)).toBe(204);
      const [asModerator] = threadsOf(await list(process.id, PATRICIA));
      expect(asModerator).toMatchObject({
        isDeleted: true,
        deletedByModerator: true,
        deletionReason: 'Contém dados pessoais de terceiro.',
        body: null,
        canModerate: false,
      });
      // RN-CMT-12: o motivo é exibido ao autor e a moderadores, não aos demais.
      expect(threadsOf(await list(process.id, CLAUDIA))[0]?.deletionReason).toBe(
        'Contém dados pessoais de terceiro.',
      );
      expect(threadsOf(await list(process.id, MARCOS))[0]?.deletionReason).toBeNull();
      expect(timelineOf(process.id).map((row) => row.type)).toEqual([
        'COMMENT_ADDED',
        'COMMENT_REMOVED',
      ]);
      expect(auditOf(process.id, 'comment.moderate')[0]?.metadata).toMatchObject({
        authorId: FAKE_USERS.lucia.id,
        reason: 'Contém dados pessoais de terceiro.',
      });
      expect(eventsOf(process.id, 'CommentDeleted').map((row) => row.payload)).toEqual([
        { commentId: created.id, byModerator: true },
      ]);
      expect(JSON.stringify(log.mock.calls)).not.toContain('Contém dados pessoais de terceiro.');
      expect(JSON.stringify(log.mock.calls)).not.toContain('9999-0000');
    });

    it('Comentário em documento com orçamento sigiloso: body nulo e bodyMasked para quem não atende POL-09', async () => {
      const process = await processWith({ isBudgetConfidential: true });
      const research = seedDocument(process, {
        systemModule: 'PRICE_RESEARCH',
        confidentiality: 'RESTRICTED',
        code: 'PP 0001/2026',
      });
      const created = await createOk(process.id, {
        body: commentBodyFromText('Cotação B está 30% acima.'),
        targetType: 'DOCUMENT',
        documentId: research.id,
      });
      expect(created.body).not.toBeNull();
      const listed = await list(process.id, CLAUDIA);
      expect(metaOf(listed).isBudgetConfidential).toBe(true);
      const [thread] = threadsOf(listed);
      expect(thread).toMatchObject({
        id: created.id,
        body: null,
        bodyMasked: true,
        author: { name: 'Ana Souza' },
      });
      expect(JSON.stringify(listed.body)).not.toContain('30% acima');
      // Quem atende POL-09 (custódia — Marcos; ou a permissão — Patrícia) vê o conteúdo.
      expect(threadsOf(await list(process.id, PATRICIA))[0]?.bodyMasked).toBe(false);
      // Timeline: a entrada do comentário fica BUDGET_RESTRICTED (DEC-030).
      expect(timelineOf(process.id)[0]).toMatchObject({
        type: 'COMMENT_ADDED',
        visibility: 'BUDGET_RESTRICTED',
      });
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Comentário e documento de outro tenant → 404 COMMENT_NOT_FOUND e 422 REFERENCE_NOT_FOUND', async () => {
      const process = await processWith();
      const foreignProcessId = newId();
      const c9 = createComment({
        id: newId(),
        tenantId: B,
        processId: foreignProcessId,
        target: { targetType: 'PROCESS', documentId: null, sectionKey: null },
        parentId: null,
        authorId: FAKE_USERS.heitor.id,
        body: commentBodyFromText('Comentário da Prefeitura B.'),
        bodyText: 'Comentário da Prefeitura B.',
        now: NOW,
      });
      store().seed(c9);
      expectProblem(await remove(c9.id), 404, 'COMMENT_NOT_FOUND');
      expectProblem(
        await patch(c9.id, { body: commentBodyFromText('x') }),
        404,
        'COMMENT_NOT_FOUND',
      );
      expect(
        store()
          .snapshot()
          .find((row) => row.id === c9.id)?.deletedAt,
      ).toBeNull();

      const foreignDocument = seedDocument(process, { tenantId: B });
      const response = await post(process.id, {
        body: commentBodyFromText('Doc de outro tenant.'),
        targetType: 'DOCUMENT',
        documentId: foreignDocument.id,
      });
      expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(fieldErrors(response)).toEqual([['documentId', 'REFERENCE_NOT_FOUND']]);
      expectProblem(await list(foreignProcessId), 404, 'PROCESS_NOT_FOUND');
      expectProblem(await post(foreignProcessId, said('x')), 404, 'PROCESS_NOT_FOUND');
    });
  });

  describe('[Duplicidade]', () => {
    it('Reenvio com a mesma chave de idempotência: mesmo comentário e Idempotent-Replayed', async () => {
      const process = await processWith();
      const payload = said('Comentário com chave.');
      const first = await post(process.id, payload, { key: K7 });
      const replay = await post(process.id, payload, { key: K7 });
      expect(first.status).toBe(201);
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(data<CommentDto>(replay).id).toBe(data<CommentDto>(first).id);
      expect(commentsOf(process.id)).toHaveLength(1);
      expect(timelineOf(process.id)).toHaveLength(1);
      expect(eventsOf(process.id, 'CommentCreated')).toHaveLength(1);
      expectProblem(
        await post(process.id, said('Outro texto.'), { key: K7 }),
        422,
        'IDEMPOTENCY_KEY_REUSED',
      );
    });
  });

  describe('[Concorrência]', () => {
    it('Edição do autor concorrente com moderação: 412 VERSION_CONFLICT e o comentário permanece removido', async () => {
      const process = await processWith();
      const created = await createOk(process.id, said('Versão 1.'));
      const moderated = await remove(created.id, '"1"', PATRICIA, {
        reason: 'Remoção por moderação de teste.',
      });
      expect(moderated.status).toBe(204);
      const conflict = await patch(
        created.id,
        { body: commentBodyFromText('Edição atrasada.') },
        '"1"',
      );
      const problem = expectProblem(conflict, 412, 'VERSION_CONFLICT');
      expect(problem.detail).toBe('O comentário foi alterado por outra pessoa. Recarregue.');
      const row = commentsOf(process.id)[0];
      expect(row).toMatchObject({
        bodyText: 'Versão 1.',
        deletionReason: 'Remoção por moderação de teste.',
      });
      expect(row?.deletedAt).not.toBeNull();
      // Na versão atual, o comentário excluído não aceita edição (409 INVALID_STATE).
      expectProblem(
        await patch(created.id, { body: commentBodyFromText('x') }, '"2"'),
        409,
        'INVALID_STATE',
      );
      expectProblem(
        await patch(created.id, { body: commentBodyFromText('x') }, ''),
        428,
        'PRECONDITION_REQUIRED',
      );
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível ao comentar: 503 DEPENDENCY_UNAVAILABLE com Retry-After e nada persistido', async () => {
      const process = await processWith();
      transactions.down = true;
      const response = await post(process.id, said('Sem banco.'));
      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      expect(response.headers['retry-after']).toBeDefined();
      expect(problemDetailsSchema.parse(response.body).correlationId).toBeTruthy();
      transactions.down = false;
      expect(commentsOf(process.id)).toEqual([]);
      expect(eventsOf(process.id)).toEqual([]);
      expect(auditOf(process.id)).toEqual([]);
      expect(timelineOf(process.id)).toEqual([]);
    });
  });

  describe('[Falha de integração]', () => {
    it('Fila de notificações indisponível: a resposta é criada (201) e CommentCreated fica PENDING no outbox', async () => {
      const process = await processWith();
      const root = await createOk(process.id, said('Pergunta da Cláudia.'), CLAUDIA);
      // Sem relay no modo em memória: o evento gravado no outbox espera o relay/fila voltar; a
      // entrega única do `COMMENT_REPLY` é do `NotificationDispatcher` (idempotente por evento).
      const response = await post(process.id, {
        ...said('Resposta do Marcos.'),
        parentId: root.id,
      });
      expect(response.status).toBe(201);
      const pending = eventsOf(process.id, 'CommentCreated').filter(
        (row) => row.payload.parentId === root.id,
      );
      expect(pending).toHaveLength(1);
      expect(pending[0]?.payload.parentAuthorId).toBe(FAKE_USERS.lucia.id);
      expect(pending[0]).not.toHaveProperty('publishedAt', expect.anything());
    });
  });
});
