import { randomUUID } from 'node:crypto';

import {
  documentAiReviewResultSchema,
  documentRenditionSchema,
  documentValidationSchema,
  problemDetailsSchema,
} from '@contrataflow/validation';
import type { DocumentDto, DraftSection, RichTextNode } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { InMemoryObjectStorage } from '#shared/storage/in-memory-object-storage.js';
import { OBJECT_STORAGE } from '#shared/storage/storage.service.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import {
  buildDocument,
  buildDocumentType,
  createDocumentAs,
  documentRepositoryOf,
  documentTypeRepositoryOf,
  filledSection,
  openStageForAnyType,
  runAsUser,
} from '../../../../test/support/document-fixtures.js';
import type { FixtureActor } from '../../../../test/support/document-fixtures.js';
import {
  CATALOG_CLOCK,
  catalogItemId,
  runTenantSeeders,
  seedProcessStructure,
  timelineRowsOf,
} from '../../../../test/support/process-fixtures.js';
import { FakePdfRenderer, runRender } from '../../../../test/support/rendition-fixtures.js';
import {
  assignDepartment,
  roleRepositoryOf,
  seedDefaultRolesOf,
} from '../../../../test/support/structure-fixtures.js';
import { DOCUMENT_CLOCK, DOCUMENT_TRANSACTIONS } from '../application/ports.js';
import type { DocumentTransactions } from '../application/ports.js';
import { PDF_RENDERER } from '../application/rendition.ports.js';

/*
 * US-122 — DOC-27 (revisão humana do conteúdo gerado por IA) e as barreiras em DOC-08/09/10 e na
 * prévia DOC-20, pelo pipeline HTTP completo com a identidade fake, os seeders reais e os
 * adaptadores em memória. Os cenários do Gherkin (8 categorias). A proveniência é semeada como a
 * aplicação (DOC-26 — US-117) a gravaria; RLS, outbox `PENDING` e a atomicidade no PostgreSQL:
 * `test/tenant-leak/document-ai-review.spec.ts`.
 *
 * Personas: "Carla" do Gherkin (custodiante com DFD_UPDATE) = Lúcia (GESTOR_CONTRATACOES, cria o
 * processo e é a responsável); "Bruno" sem DFD_UPDATE = Fábio (COMPRAS lotado no setor solicitante:
 * vê o processo, não edita o DFD); "Marta" com DFD_UPDATE e custódia, sem AI_GENERATE = Lúcia com o
 * AI_GENERATE retirado do perfil.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-17T13:00:00.000Z');
const G1 = '0192f122-0000-7000-8000-0000000000e1';
const G2 = '0192f122-0000-7000-8000-0000000000e2';

const ORG_A = '0192d122-0000-7000-8000-0000000000a0';
const UNITS_A = {
  organizationId: ORG_A,
  obras: '0192d122-0000-7000-8000-0000000000a1',
  manutencao: '0192d122-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d122-0000-7000-8000-0000000000a3',
  saude: '0192d122-0000-7000-8000-0000000000a4',
  posto: '0192d122-0000-7000-8000-0000000000a5',
};

const membershipOf = (userId: string, tenantId = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

const LUCIA: FixtureActor = {
  tenantId: A,
  userId: FAKE_USERS.lucia.id,
  membershipId: membershipOf(FAKE_USERS.lucia.id),
};

class FlakyTransactions implements DocumentTransactions {
  down = false;

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    if (this.down) return Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED')));
    return runSimulatedTransaction(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.run(work);
  }
}

const pendingAi = (generationId = G1) => ({
  generationId,
  appliedAt: '2026-10-16T12:00:00.000Z',
  appliedById: FAKE_USERS.lucia.id,
  reviewedAt: null,
  reviewedById: null,
});

const marker = (label: string): RichTextNode => ({
  type: 'toConfirm',
  attrs: { label, category: 'DEADLINE', origin: 'AI' },
});

function sectionWithMarkers(count: number, overrides: Partial<DraftSection> = {}): DraftSection {
  return filledSection('x', {
    content: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Entrega em ' },
            ...Array.from({ length: count }, () => marker('prazo')),
          ],
        },
      ],
    },
    ...overrides,
  });
}

function expectProblem(response: request.Response, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  const body = problemDetailsSchema.parse(response.body);
  expect(body.code).toBe(code);
  return body;
}

function reviewOf(response: request.Response) {
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return documentAiReviewResultSchema.parse((response.body as { data: unknown }).data);
}

describe('Feature: Marcar conteúdo gerado por IA e exigir revisão humana (US-122)', () => {
  let api: TestApi;
  const transactions = new FlakyTransactions();
  const renderer = new FakePdfRenderer();
  let dfdType: string;
  let openStages: Set<string>;

  const words = () => randomUUID().replaceAll('-', '').slice(0, 12);

  async function newProcess(): Promise<string> {
    const response = await request(api.server)
      .post('/api/v1/processes')
      .set('Authorization', api.bearer('sub-lucia', { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', A)
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Compra ${words()} ${words()}`,
        object: `Objeto ${words()} ${words()} ${words()}`,
        contractingTypeId: catalogItemId(api, A, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
        requestingSecretariatId: UNITS_A.obras,
        requestingDepartmentId: UNITS_A.manutencao,
        originId: catalogItemId(api, A, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
        pcaStatus: 'NOT_APPLICABLE',
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const id = (response.body as { data: { id: string } }).data.id;
    openStages.add(id);
    return id;
  }

  /** DFD "DFD 0005/2026" em DRAFT com JUSTIFICATION (G1, revisão 4) e EXPECTED_RESULTS pendentes. */
  async function newDfd(sections?: Record<string, DraftSection>) {
    const created = await createDocumentAs(api, LUCIA, {
      processId: await newProcess(),
      documentTypeId: dfdType,
      title: 'DFD da aquisição de cadeiras',
      templateVersionId: null,
    });
    const document = {
      ...created,
      draftContent: {
        sections: sections ?? {
          JUSTIFICATION: filledSection('Justificativa gerada', { revision: 4, ai: pendingAi() }),
          EXPECTED_RESULTS: filledSection('Resultados gerados', {
            revision: 2,
            ai: pendingAi(G2),
          }),
        },
      },
    };
    documentRepositoryOf(api).seed(document);
    return document;
  }

  const call = (
    method: 'get' | 'post',
    path: string,
    options: { subject?: string; tenant?: string; body?: object; headers?: object } = {},
  ) => {
    const agent = request(api.server);
    let pending = agent[method](`/api/v1${path}`)
      .set('Authorization', api.bearer(options.subject ?? 'sub-lucia', { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', options.tenant ?? A);
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      pending = pending.set(name, String(value));
    }
    return options.body === undefined ? pending : pending.send(options.body);
  };

  const review = (
    id: string,
    body: {
      sectionKeys: string[];
      expectedRevisions: Record<string, number>;
      confirmAll?: boolean;
    },
    subject?: string,
  ) => call('post', `/documents/${id}/ai-review`, { body, ...(subject ? { subject } : {}) });

  const finalize = (id: string) =>
    call('post', `/documents/${id}/finalize`, {
      headers: {
        'If-Match': `"${String(stored(id)?.version ?? 1)}"`,
        'Idempotency-Key': randomUUID(),
      },
    });

  const stored = (id: string) =>
    documentRepositoryOf(api)
      .allDocuments()
      .find((row) => row.id === id);
  const sectionOf = (id: string, key: string) => stored(id)?.draftContent.sections[key];
  const auditOf = (action: string, entityId: string) =>
    api.auditRecords().filter((row) => row.action === action && row.entityId === entityId);
  const reviewedEvents = (aggregateId: string) =>
    api
      .outboxRows()
      .filter((row) => row.aggregateId === aggregateId && row.eventType === 'AiContentReviewed');

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    api = await createTestApi({
      providers: [
        { token: DOCUMENT_TRANSACTIONS, value: transactions },
        { token: DOCUMENT_CLOCK, value: () => NOW },
        { token: CATALOG_CLOCK, value: () => NOW },
        { token: PDF_RENDERER, value: renderer },
        { token: OBJECT_STORAGE, value: new InMemoryObjectStorage() },
      ],
    });
    await runTenantSeeders(api, A);
    await runTenantSeeders(api, B, [
      'catalog.items',
      'access.defaultRoles',
      'document.systemTypes',
    ]);
    seedProcessStructure(api, A, { ...UNITS_A, shortName: 'PMSJ', cnpj: '11222333000181' });
    // Fábio (COMPRAS) lotado no setor solicitante: vê o processo, sem DFD_UPDATE.
    assignDepartment(api, membershipOf(FAKE_USERS.fabio.id), UNITS_A.manutencao);
    seedDefaultRolesOf(api, A);
    openStages = openStageForAnyType(api);
    dfdType =
      documentTypeRepositoryOf(api)
        .snapshot()
        .find((type) => type.tenantId === A && type.code === 'DFD')?.id ?? '';
    expect(dfdType).not.toBe('');
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
    it('Revisar uma seção gerada por IA: 200, reviewedAt/By, revisão 5, auditoria, evento e timeline', async () => {
      const document = await newDfd();
      const result = reviewOf(
        await review(document.id, {
          sectionKeys: ['JUSTIFICATION'],
          expectedRevisions: { JUSTIFICATION: 4 },
        }),
      );
      expect(result.reviewedSectionKeys).toEqual(['JUSTIFICATION']);
      expect(result.document.draftContent.sections.JUSTIFICATION).toMatchObject({
        revision: 5,
        ai: { generationId: G1, reviewedAt: NOW.toISOString(), reviewedById: FAKE_USERS.lucia.id },
      });
      expect(result.document.draftRevision).toBe(document.draftRevision + 1);
      expect(sectionOf(document.id, 'EXPECTED_RESULTS')?.ai?.reviewedAt).toBeNull();

      const [audit] = auditOf('ai.content_review', document.id);
      expect(audit).toMatchObject({
        category: 'DATA_CHANGE',
        metadata: {
          documentId: document.id,
          targetModule: 'DFD',
          sectionKeys: ['JUSTIFICATION'],
          generationIds: [G1],
          confirmAll: false,
        },
      });
      expect(audit?.changes).toEqual([
        { path: 'sections.JUSTIFICATION.ai.reviewedAt', old: null, new: NOW.toISOString() },
      ]);
      expect(JSON.stringify(audit)).not.toContain('Justificativa gerada');

      const [event] = reviewedEvents(document.id);
      expect(event).toMatchObject({
        routingKey: 'document.ai_content_reviewed.dfd',
        payload: {
          documentId: document.id,
          targetModule: 'DFD',
          sectionKeys: ['JUSTIFICATION'],
          riskIds: [],
          generationIds: [G1],
        },
      });
      expect(
        timelineRowsOf(api).find(
          (row) => row.type === 'AI_CONTENT_REVIEWED' && row.entityId === document.id,
        ),
      ).toMatchObject({
        actorId: FAKE_USERS.lucia.id,
        processId: document.processId,
        params: { sectionsCount: 1, risksCount: 0 },
      });
    });

    it('Revisar todas as seções em lote (confirmAll): as duas chaves e um único evento', async () => {
      const document = await newDfd();
      const result = reviewOf(
        await review(document.id, {
          sectionKeys: ['JUSTIFICATION', 'EXPECTED_RESULTS'],
          expectedRevisions: { JUSTIFICATION: 4, EXPECTED_RESULTS: 2 },
          confirmAll: true,
        }),
      );
      expect(result.reviewedSectionKeys).toEqual(['JUSTIFICATION', 'EXPECTED_RESULTS']);
      const events = reviewedEvents(document.id);
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toMatchObject({
        sectionKeys: ['JUSTIFICATION', 'EXPECTED_RESULTS'],
        generationIds: [G1, G2],
      });
      expect(auditOf('ai.content_review', document.id)[0]?.metadata).toMatchObject({
        confirmAll: true,
      });
    });

    it('Prévia mostra as marcas; resolvida a pendência e revisada a seção, o documento finaliza sem marcas', async () => {
      const document = await newDfd({
        EXPECTED_RESULTS: sectionWithMarkers(1, { revision: 2, ai: pendingAi() }),
      });
      const preview = await call('post', `/documents/${document.id}/preview`);
      expect(preview.status, JSON.stringify(preview.body)).toBe(202);
      const rendition = documentRenditionSchema.parse((preview.body as { data: unknown }).data);
      await runRender(api, rendition.id);
      expect(renderer.lastHtml()).toContain(
        '<p class="cf-ai-note">Conteúdo gerado por IA — revisão pendente</p>',
      );
      expect(renderer.lastHtml()).toContain(
        '<mark class="cf-to-confirm" data-category="DEADLINE">[a confirmar: prazo]</mark>',
      );

      // A pessoa substitui o chip pelo dado (como o autosave DOC-05 gravaria: proveniência mantida).
      const current = stored(document.id);
      if (current === undefined) throw new Error('sem documento');
      documentRepositoryOf(api).seed({
        ...current,
        draftContent: {
          sections: {
            EXPECTED_RESULTS: filledSection('Entrega em 30 dias.', {
              revision: 3,
              ai: pendingAi(),
            }),
          },
        },
      });
      reviewOf(
        await review(document.id, {
          sectionKeys: ['EXPECTED_RESULTS'],
          expectedRevisions: { EXPECTED_RESULTS: 3 },
        }),
      );
      const finalized = await finalize(document.id);
      expect(finalized.status, JSON.stringify(finalized.body)).toBe(200);
      const data = (finalized.body as { data: DocumentDto }).data;
      expect(data.status).toBe('FINALIZED');
      const [version] = documentRepositoryOf(api).versionsOf(document.id);
      const snapshot = JSON.stringify(version?.content);
      expect(snapshot).not.toContain('toConfirm');
      // A proveniência (revisada) vai para o snapshot, mas o PDF da versão não a imprime.
      expect(version?.content?.sections.EXPECTED_RESULTS?.ai?.reviewedAt).toBe(NOW.toISOString());
    });
  });

  describe('[Validação]', () => {
    it('Finalizar com pendências: 422 DOCUMENT_INCOMPLETE com as duas violações e o DFD em DRAFT', async () => {
      const document = await newDfd({
        JUSTIFICATION: filledSection('Justificativa gerada', { revision: 4, ai: pendingAi() }),
        EXPECTED_RESULTS: sectionWithMarkers(2, { revision: 2 }),
      });
      const validation = documentValidationSchema.parse(
        ((await call('get', `/documents/${document.id}/validation`)).body as { data: unknown })
          .data,
      );
      expect(validation.isComplete).toBe(false);

      const problem = expectProblem(await finalize(document.id), 422, 'DOCUMENT_INCOMPLETE');
      const violations = problem.violations;
      expect(violations).toContainEqual(
        expect.objectContaining({
          code: 'SECTION_AI_REVIEW_PENDING',
          sectionKey: 'JUSTIFICATION',
          severity: 'BLOCKING',
        }),
      );
      expect(violations).toContainEqual(
        expect.objectContaining({
          code: 'SECTION_PLACEHOLDER_PENDING',
          sectionKey: 'EXPECTED_RESULTS',
          params: { count: 2 },
        }),
      );
      expect(stored(document.id)?.status).toBe('DRAFT');
    });

    it('Submeter (DOC-09) com conteúdo de IA não revisado: 422 DOCUMENT_INCOMPLETE (todo tipo de documento)', async () => {
      const despacho = buildDocumentType({
        tenantId: A,
        code: 'DESPACHO_IA',
        name: 'Despacho com aprovação',
        requiresApproval: true,
        approvalPolicy: {
          approverType: 'USER',
          approverUserId: FAKE_USERS.rafael.id,
          allowDeputy: false,
        },
      });
      documentTypeRepositoryOf(api).seed(despacho);
      const created = await createDocumentAs(api, LUCIA, {
        processId: await newProcess(),
        documentTypeId: despacho.id,
        title: 'Despacho redigido com IA',
        templateVersionId: null,
      });
      documentRepositoryOf(api).seed({
        ...created,
        draftContent: {
          sections: { CORPO: filledSection('Texto gerado', { ai: pendingAi() }) },
        },
      });
      const problem = expectProblem(
        await call('post', `/documents/${created.id}/submit`, {
          headers: { 'If-Match': `"${String(created.version)}"`, 'Idempotency-Key': randomUUID() },
        }),
        422,
        'DOCUMENT_INCOMPLETE',
      );
      expect(problem.violations.map((item) => `${item.code}:${item.sectionKey ?? ''}`)).toEqual([
        'SECTION_AI_REVIEW_PENDING:CORPO',
      ]);
      expect(stored(created.id)?.status).toBe('DRAFT');
    });

    it('Lote sem confirmAll: 422 CONDITIONAL_REQUIRED; chave fora do documento, lista vazia e revisão faltando: 422', async () => {
      const document = await newDfd();
      const batch = expectProblem(
        await review(document.id, {
          sectionKeys: ['JUSTIFICATION', 'EXPECTED_RESULTS'],
          expectedRevisions: { JUSTIFICATION: 4, EXPECTED_RESULTS: 2 },
        }),
        422,
        'VALIDATION_ERROR',
      );
      expect(batch.errors).toContainEqual(
        expect.objectContaining({ field: 'confirmAll', code: 'CONDITIONAL_REQUIRED' }),
      );
      const unknown = expectProblem(
        await review(document.id, { sectionKeys: ['OUTRA'], expectedRevisions: { OUTRA: 1 } }),
        422,
        'VALIDATION_ERROR',
      );
      expect(unknown.errors).toContainEqual(
        expect.objectContaining({ field: 'sectionKeys', code: 'NOT_ALLOWED' }),
      );
      expectProblem(
        await review(document.id, { sectionKeys: [], expectedRevisions: {} }),
        422,
        'VALIDATION_ERROR',
      );
      expectProblem(
        await review(document.id, { sectionKeys: ['JUSTIFICATION'], expectedRevisions: {} }),
        422,
        'VALIDATION_ERROR',
      );
      expect(sectionOf(document.id, 'JUSTIFICATION')?.ai?.reviewedAt).toBeNull();
      expect(reviewedEvents(document.id)).toEqual([]);
    });

    it('Documento fora de DRAFT/RETURNED: 409 DOCUMENT_NOT_EDITABLE (V-06)', async () => {
      const document = await newDfd();
      const current = stored(document.id);
      if (current === undefined) throw new Error('sem documento');
      documentRepositoryOf(api).seed({ ...current, status: 'FINALIZED' });
      expectProblem(
        await review(document.id, {
          sectionKeys: ['JUSTIFICATION'],
          expectedRevisions: { JUSTIFICATION: 4 },
        }),
        409,
        'DOCUMENT_NOT_EDITABLE',
      );
    });
  });

  describe('[Permissão]', () => {
    it('Sem DFD_UPDATE: 403 PERMISSION_DENIED e access.denied; com DFD_UPDATE e custódia, sem AI_GENERATE: 200', async () => {
      const document = await newDfd();
      expectProblem(
        await review(
          document.id,
          { sectionKeys: ['JUSTIFICATION'], expectedRevisions: { JUSTIFICATION: 4 } },
          'sub-fabio',
        ),
        403,
        'PERMISSION_DENIED',
      );
      expect(
        api
          .auditRecords()
          .filter((row) => row.action === 'access.denied')
          .at(-1),
      ).toMatchObject({ reasonCode: 'DFD_UPDATE' });
      expect(sectionOf(document.id, 'JUSTIFICATION')?.ai?.reviewedAt).toBeNull();

      // "Marta": o perfil de Lúcia perde AI_GENERATE (FA-05 — a revisão usa a permissão de edição).
      const roles = roleRepositoryOf(api);
      const gestor = roles.rolesOfTenant(A).find((role) => role.key === 'GESTOR_CONTRATACOES');
      const grant = roles
        .grantsOfTenant(A)
        .find((row) => row.roleId === gestor?.id && row.permissionCode === 'AI_GENERATE');
      expect(grant).toBeDefined();
      await runAsUser(LUCIA, (tx) => roles.removeGrants(tx, gestor?.id ?? '', ['AI_GENERATE']));
      try {
        const result = reviewOf(
          await review(document.id, {
            sectionKeys: ['JUSTIFICATION'],
            expectedRevisions: { JUSTIFICATION: 4 },
          }),
        );
        expect(result.reviewedSectionKeys).toEqual(['JUSTIFICATION']);
      } finally {
        if (grant) await runAsUser(LUCIA, (tx) => roles.insertMissingGrants(tx, [grant]));
      }
    });
  });

  describe('[Tenant incorreto]', () => {
    it('DFD de outro tenant com seção pendente: 404 NOT_FOUND sem revelar nada', async () => {
      const foreign = buildDocument({
        tenantId: B,
        processId: newId(),
        documentTypeId: newId(),
        draftContent: {
          sections: {
            JUSTIFICATION: filledSection('Texto da Prefeitura B', { revision: 4, ai: pendingAi() }),
          },
        },
      });
      documentRepositoryOf(api).seed(foreign);
      const problem = expectProblem(
        await review(foreign.id, {
          sectionKeys: ['JUSTIFICATION'],
          expectedRevisions: { JUSTIFICATION: 4 },
        }),
        404,
        'NOT_FOUND',
      );
      expect(JSON.stringify(problem)).not.toContain('Prefeitura B');
      expect(stored(foreign.id)?.draftContent.sections.JUSTIFICATION?.ai?.reviewedAt).toBeNull();
      expect(reviewedEvents(foreign.id)).toEqual([]);
    });
  });

  describe('[Duplicidade]', () => {
    it('Revisão repetida: 200 com reviewedSectionKeys vazio, sem novo evento nem nova auditoria', async () => {
      const document = await newDfd();
      const body = { sectionKeys: ['JUSTIFICATION'], expectedRevisions: { JUSTIFICATION: 4 } };
      reviewOf(await review(document.id, body));
      const again = reviewOf(await review(document.id, body));
      expect(again.reviewedSectionKeys).toEqual([]);
      expect(again.document.draftContent.sections.JUSTIFICATION?.revision).toBe(5);
      expect(reviewedEvents(document.id)).toHaveLength(1);
      expect(auditOf('ai.content_review', document.id)).toHaveLength(1);
    });
  });

  describe('[Concorrência]', () => {
    it('Seção alterada entre a leitura e a revisão: 412 VERSION_CONFLICT com meta.current e a seção pendente', async () => {
      const document = await newDfd({
        JUSTIFICATION: filledSection('Editado por outra pessoa', { revision: 5, ai: pendingAi() }),
      });
      const problem = expectProblem(
        await review(document.id, {
          sectionKeys: ['JUSTIFICATION'],
          expectedRevisions: { JUSTIFICATION: 4 },
        }),
        412,
        'VERSION_CONFLICT',
      );
      expect(problem.detail).toBe('A seção foi alterada. Leia a versão atual antes de revisar.');
      expect((problem as { meta?: unknown }).meta).toEqual({ current: { JUSTIFICATION: 5 } });
      expect(sectionOf(document.id, 'JUSTIFICATION')?.ai?.reviewedAt).toBeNull();
    });

    it('Duas revisões simultâneas da mesma seção: uma efetiva, a outra ignorada', async () => {
      const document = await newDfd();
      const body = { sectionKeys: ['JUSTIFICATION'], expectedRevisions: { JUSTIFICATION: 4 } };
      const results = (
        await Promise.all([review(document.id, body), review(document.id, body)])
      ).map(reviewOf);
      expect(results.map((result) => result.reviewedSectionKeys.length).sort()).toEqual([0, 1]);
      expect(reviewedEvents(document.id)).toHaveLength(1);
      expect(sectionOf(document.id, 'JUSTIFICATION')?.revision).toBe(5);
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível na transação: 503 DEPENDENCY_UNAVAILABLE, seção pendente e nenhum evento', async () => {
      const document = await newDfd();
      transactions.down = true;
      expectProblem(
        await review(document.id, {
          sectionKeys: ['JUSTIFICATION'],
          expectedRevisions: { JUSTIFICATION: 4 },
        }),
        503,
        'DEPENDENCY_UNAVAILABLE',
      );
      transactions.down = false;
      expect(sectionOf(document.id, 'JUSTIFICATION')?.ai?.reviewedAt).toBeNull();
      expect(reviewedEvents(document.id)).toEqual([]);
      expect(auditOf('ai.content_review', document.id)).toEqual([]);
    });
  });

  describe('[Falha de integração]', () => {
    it('Relay do outbox fora: 200 e o AiContentReviewed fica gravado para publicação posterior', async () => {
      const document = await newDfd();
      reviewOf(
        await review(document.id, {
          sectionKeys: ['JUSTIFICATION'],
          expectedRevisions: { JUSTIFICATION: 4 },
        }),
      );
      // Sem relay no teste: o evento fica no outbox (PENDING no PostgreSQL — tenant-leak).
      expect(reviewedEvents(document.id)).toHaveLength(1);
    });
  });
});
