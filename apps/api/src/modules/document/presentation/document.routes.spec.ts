import { randomUUID } from 'node:crypto';

import {
  documentMetaSchema,
  documentSchema,
  documentValidationSchema,
  problemDetailsSchema,
} from '@contrataflow/validation';
import type { DocumentDto, DocumentMeta, Violation } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import {
  approvalRepositoryOf,
  buildDocument,
  buildDocumentType,
  buildTemplateVersion,
  createDocumentAs,
  documentFacadeOf,
  documentRepositoryOf,
  documentTypeRepositoryOf,
  filledSection,
  openStageForAnyType,
  runAsUser,
  sectionDefinition,
} from '../../../../test/support/document-fixtures.js';
import type { FixtureActor } from '../../../../test/support/document-fixtures.js';
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
import { DocumentValidatorRegistry } from '../application/document.ports.js';
import type { DocumentValidator } from '../application/document.ports.js';
import { DOCUMENT_CLOCK, DOCUMENT_TRANSACTIONS } from '../application/ports.js';
import type { DocumentTransactions } from '../application/ports.js';
import { TEMPLATE_REPOSITORY } from '../application/template.ports.js';
import { snapshotHash } from '../domain/document-snapshot.js';
import type { InMemoryTemplateRepository } from '../infrastructure/in-memory-template.repository.js';

/*
 * US-065 — DOC-03/04/08/09/10/12/13/14 pelo pipeline HTTP completo (autenticação, tenant, vínculo,
 * autorização, `If-Match`, idempotência, filtro RFC 9457) com a identidade fake, os seeders reais
 * (tipos de documento, perfis, workflow padrão), o processo criado pelo PRC-02 e os adaptadores
 * em memória (documentos, aprovações, auditoria, outbox e timeline). Os cenários do Gherkin (8
 * categorias) e as transições de DEC-018 pela API. Atomicidade, RLS, `singletonKey` e
 * finalizações simultâneas no PostgreSQL: `test/tenant-leak/documents.spec.ts`.
 *
 * Personas: "Ana" do Gherkin (custodiante com DOCUMENT_REOPEN) = Lúcia (GESTOR_CONTRATACOES, cria
 * o processo e é a responsável); "Bruno" sem DOCUMENT_REOPEN e "Carla" sem custódia = Ana
 * (REQUISITANTE lotada no setor solicitante: vê o processo, tem DOCUMENT_CANCEL, não é custodiante).
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-16T13:00:00.000Z');
const REASON = 'Ajuste pedido pelo controle interno na revisão.';

const ORG_A = '0192d065-0000-7000-8000-0000000000a0';
const UNITS_A = {
  organizationId: ORG_A,
  obras: '0192d065-0000-7000-8000-0000000000a1',
  manutencao: '0192d065-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d065-0000-7000-8000-0000000000a3',
  saude: '0192d065-0000-7000-8000-0000000000a4',
  posto: '0192d065-0000-7000-8000-0000000000a5',
};

const membershipOf = (userId: string, tenantId = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

const LUCIA: FixtureActor = {
  tenantId: A,
  userId: FAKE_USERS.lucia.id,
  membershipId: membershipOf(FAKE_USERS.lucia.id),
};

/** Transações do módulo que podem simular o banco fora do ar (Falha de banco). */
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

/** Validador simulado do módulo tipado DFD (RN-DOC-51 b · RN-DOC-52). */
class FakeDfdValidator implements DocumentValidator {
  readonly module = 'DFD' as const;
  violations: Violation[] = [];

  validate(): Promise<readonly Violation[]> {
    return Promise.resolve(this.violations);
  }

  typedSummary(): Promise<Readonly<Record<string, unknown>>> {
    return Promise.resolve({ itemsCount: 3 });
  }
}

const violation = (overrides: Partial<Violation>): Violation => ({
  code: 'DFD_ITEMS_REQUIRED',
  severity: 'BLOCKING',
  message: 'Informe ao menos um item com quantidade.',
  ruleId: null,
  sectionKey: null,
  field: null,
  itemId: null,
  params: {},
  ...overrides,
});

interface Body {
  readonly data: DocumentDto;
  readonly meta: DocumentMeta;
}

function bodyOf(response: request.Response): Body {
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  const body = response.body as Body;
  return { data: documentSchema.parse(body.data), meta: documentMetaSchema.parse(body.meta) };
}

function expectProblem(response: request.Response, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  const body = problemDetailsSchema.parse(response.body);
  expect(body.code).toBe(code);
  return body;
}

describe('Feature: Ciclo de vida do documento (US-065)', () => {
  let api: TestApi;
  const transactions = new FlakyTransactions();
  const dfdValidator = new FakeDfdValidator();
  let openStages: Set<string>;
  let types: { despacho: string; dfd: string; etp: string; sigiloso: string };

  const words = () => randomUUID().replaceAll('-', '').slice(0, 12);

  /** Processo novo (PRC-02) criado por Lúcia, que fica responsável (custódia — POL-01). */
  async function newProcess(options: { anyType?: boolean } = {}): Promise<string> {
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
    if (options.anyType !== false) openStages.add(id);
    return id;
  }

  async function newDocument(
    processId: string,
    typeId = types.despacho,
    overrides: { templateVersionId?: string | null; title?: string } = {},
  ) {
    return createDocumentAs(api, LUCIA, {
      processId,
      documentTypeId: typeId,
      title: overrides.title ?? 'Despacho de encaminhamento',
      templateVersionId: overrides.templateVersionId ?? null,
    });
  }

  const call = (
    method: 'get' | 'post' | 'patch' | 'delete',
    path: string,
    options: {
      subject?: string;
      tenant?: string;
      ifMatch?: string | null;
      key?: string | null;
      body?: object;
    } = {},
  ) => {
    const agent = request(api.server);
    let pending = agent[method](`/api/v1${path}`)
      .set('Authorization', api.bearer(options.subject ?? 'sub-lucia', { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', options.tenant ?? A);
    if (options.ifMatch !== undefined && options.ifMatch !== null) {
      pending = pending.set('If-Match', options.ifMatch);
    }
    if (options.key !== undefined && options.key !== null)
      pending = pending.set('Idempotency-Key', options.key);
    return options.body === undefined ? pending : pending.send(options.body);
  };

  const finalize = (
    id: string,
    version = 1,
    options: { key?: string; subject?: string; body?: object } = {},
  ) =>
    call('post', `/documents/${id}/finalize`, {
      ifMatch: `"${version}"`,
      key: options.key ?? randomUUID(),
      ...(options.subject === undefined ? {} : { subject: options.subject }),
      ...(options.body === undefined ? {} : { body: options.body }),
    });

  const stored = (id: string) =>
    documentRepositoryOf(api)
      .allDocuments()
      .find((row) => row.id === id);
  const versionsOf = (id: string) => documentRepositoryOf(api).versionsOf(id);
  const auditOf = (action: string, entityId?: string) =>
    api
      .auditRecords()
      .filter(
        (row) => row.action === action && (entityId === undefined || row.entityId === entityId),
      );
  const eventsOf = (aggregateId: string) =>
    api.outboxRows().filter((row) => row.aggregateId === aggregateId);

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    api = await createTestApi({
      providers: [
        { token: DOCUMENT_TRANSACTIONS, value: transactions },
        { token: DOCUMENT_CLOCK, value: () => NOW },
        { token: CATALOG_CLOCK, value: () => NOW },
      ],
    });
    await runTenantSeeders(api, A);
    await runTenantSeeders(api, B, [
      'catalog.items',
      'access.defaultRoles',
      'document.systemTypes',
    ]);
    seedProcessStructure(api, A, { ...UNITS_A, shortName: 'PMSJ', cnpj: '11222333000181' });
    assignDepartment(api, membershipOf(FAKE_USERS.ana.id), UNITS_A.manutencao);
    const roles = seedDefaultRolesOf(api, A);
    assignRole(api, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.otavio.id),
      roleId: roles.get('CONSULTOR_EXTERNO')?.id ?? '',
    });
    openStages = openStageForAnyType(api);
    api.app.get(DocumentValidatorRegistry).register(dfdValidator);

    const seeded = documentTypeRepositoryOf(api)
      .snapshot()
      .filter((type) => type.tenantId === A);
    const idOf = (code: string) => seeded.find((type) => type.code === code)?.id ?? '';
    const sigiloso = buildDocumentType({
      tenantId: A,
      code: 'DESPACHO_SIGILOSO',
      name: 'Despacho sigiloso',
      requiresApproval: true,
      approvalPolicy: {
        approverType: 'USER',
        approverUserId: FAKE_USERS.rafael.id,
        allowDeputy: false,
      },
    });
    documentTypeRepositoryOf(api).seed(sigiloso);
    types = {
      despacho: idOf('DESPACHO'),
      dfd: idOf('DFD'),
      etp: idOf('ETP'),
      sigiloso: sigiloso.id,
    };
    expect(Object.values(types).every((id) => id !== '')).toBe(true);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await api.close();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    transactions.down = false;
    dfdValidator.violations = [];
  });

  describe('[Sucesso]', () => {
    it('Finalizar um documento completo: FINALIZED, versão FINALIZATION, evento, timeline e auditoria', async () => {
      const processId = await newProcess();
      const document = await newDocument(processId);
      expect(document).toMatchObject({
        status: 'DRAFT',
        version: 1,
        responsibleId: FAKE_USERS.lucia.id,
      });

      const validation = await call('get', `/documents/${document.id}/validation`);
      expect(validation.status, JSON.stringify(validation.body)).toBe(200);
      expect(
        documentValidationSchema.parse((validation.body as { data: unknown }).data),
      ).toMatchObject({
        documentId: document.id,
        isComplete: true,
        summary: { blocking: 0, warnings: 0 },
        violations: [],
      });

      const response = await finalize(document.id);
      const { data, meta } = bodyOf(response);
      expect(response.headers.etag).toBe('"2"');
      expect(data).toMatchObject({
        id: document.id,
        status: 'FINALIZED',
        finalizedById: FAKE_USERS.lucia.id,
        finalizedAt: NOW.toISOString(),
        currentVersionNumber: 1,
        version: 2,
        documentType: { code: 'DESPACHO', kind: 'FREE_TEXT', requiresApproval: false },
      });
      // A edição fica bloqueada; aparece "Reabrir" (DOCUMENT_REOPEN + custódia — POL-11).
      expect(meta.allowedActions).toEqual(['REOPEN']);

      const [version] = versionsOf(document.id);
      expect(versionsOf(document.id)).toHaveLength(1);
      expect(version).toMatchObject({
        id: data.currentVersionId,
        versionNumber: 1,
        reason: 'FINALIZATION',
        statusAtCreation: 'FINALIZED',
        createdById: FAKE_USERS.lucia.id,
      });
      expect(version?.content?.process).toMatchObject({
        id: processId,
        organizationName: expect.any(String) as unknown,
        requestingDepartmentName: 'Setor de Manutenção',
      });
      expect(version?.contentHash).toBe(version?.content ? snapshotHash(version.content) : null);

      expect(eventsOf(document.id).map((row) => `${row.eventType}:${row.routingKey}`)).toEqual([
        'DocumentCreated:document.created.despacho',
        'DocumentVersionCreated:document.version_created.despacho',
        'DocumentFinalized:document.finalized.despacho',
      ]);
      expect(eventsOf(document.id).at(-1)?.payload).toEqual({
        documentId: document.id,
        documentTypeCode: 'DESPACHO',
        documentVersionId: version?.id,
      });
      expect(
        timelineRowsOf(api)
          .filter((row) => row.processId === processId && row.type.startsWith('DOCUMENT_'))
          .map((row) => row.type),
      ).toEqual(['DOCUMENT_CREATED', 'DOCUMENT_VERSION_CREATED', 'DOCUMENT_FINALIZED']);
      const [audit] = auditOf('document.finalize', document.id);
      expect(audit).toMatchObject({
        category: 'DATA_CHANGE',
        processId,
        changes: [{ path: 'status', old: 'DRAFT', new: 'FINALIZED' }],
        metadata: expect.objectContaining({
          documentVersionId: version?.id,
          documentTypeCode: 'DESPACHO',
        }) as unknown,
      });
      expect(auditOf('document.version_create', document.id)).toHaveLength(1);
    });

    it('Submeter avulso um documento com aprovação própria: IN_REVIEW e Approval subjectType DOCUMENT', async () => {
      const processId = await newProcess();
      const document = await newDocument(processId, types.sigiloso, {
        title: 'Despacho sigiloso nº 3',
      });

      // Tipo com aprovação formal: "Finalizar" não está disponível (é "Submeter").
      expectProblem(await finalize(document.id), 409, 'INVALID_STATE');

      const response = await call('post', `/documents/${document.id}/submit`, {
        ifMatch: '"1"',
        key: randomUUID(),
      });
      const { data, meta } = bodyOf(response);
      expect(data).toMatchObject({ status: 'IN_REVIEW', submittedById: FAKE_USERS.lucia.id });
      expect(data.pendingApprovalId).not.toBeNull();
      expect(meta.allowedActions).toEqual([]);

      const approval = approvalRepositoryOf(api)
        .approvals()
        .find((row) => row.id === data.pendingApprovalId);
      expect(approval).toMatchObject({
        subjectType: 'DOCUMENT',
        documentId: document.id,
        processId,
        status: 'PENDING',
        approverType: 'USER',
        approverUserId: FAKE_USERS.rafael.id,
        requestedById: FAKE_USERS.lucia.id,
        dueAt: null,
        title: 'Aprovação avulsa — Despacho sigiloso "Despacho sigiloso nº 3"',
      });
      expect(approvalRepositoryOf(api).coverageOf(approval?.id ?? '')).toEqual([
        expect.objectContaining({
          documentId: document.id,
          documentVersionId: data.currentVersionId,
        }),
      ]);
      expect(versionsOf(document.id).map((version) => version.reason)).toEqual(['SUBMISSION']);
      const submitted = eventsOf(document.id).find((row) => row.eventType === 'DocumentSubmitted');
      expect(submitted).toMatchObject({
        routingKey: 'document.submitted.despacho_sigiloso',
        payload: {
          documentId: document.id,
          approvalId: approval?.id,
          documentVersionId: data.currentVersionId,
        },
      });
      expect(auditOf('document.submit', document.id)).toHaveLength(1);
      expect(auditOf('approval.request', approval?.id)).toHaveLength(1);
    });

    it('Consultar documento (DOC-03): dados, ETag e ações do rascunho', async () => {
      const document = await newDocument(await newProcess());
      const response = await call('get', `/documents/${document.id}`);
      const { data, meta } = bodyOf(response);
      expect(response.headers.etag).toBe('"1"');
      expect(data).toMatchObject({
        id: document.id,
        status: 'DRAFT',
        draftContent: { sections: {} },
      });
      expect(meta.allowedActions).toEqual(['UPDATE', 'FINALIZE', 'CANCEL', 'DELETE']);
    });

    it('Reabrir documento concluído com justificativa (FA-05): DRAFT, sem versão nova, motivo só como hash', async () => {
      const document = await newDocument(await newProcess());
      bodyOf(await finalize(document.id));
      const response = await call('post', `/documents/${document.id}/reopen`, {
        ifMatch: '"2"',
        body: { reopenReason: REASON },
      });
      const { data, meta } = bodyOf(response);
      expect(data).toMatchObject({
        status: 'DRAFT',
        reopenedById: FAKE_USERS.lucia.id,
        reopenReason: REASON,
        draftRevision: 2,
        currentVersionNumber: 1,
      });
      // Já saiu de DRAFT uma vez: pode ser finalizado de novo ou cancelado, nunca excluído.
      expect(meta.allowedActions).toEqual(['UPDATE', 'FINALIZE', 'CANCEL']);
      expect(versionsOf(document.id)).toHaveLength(1);
      expect(eventsOf(document.id).at(-1)).toMatchObject({
        eventType: 'DocumentReopened',
        payload: { fromStatus: 'FINALIZED', baseVersionId: versionsOf(document.id)[0]?.id },
      });
      const [audit] = auditOf('document.reopen', document.id);
      expect(JSON.stringify(audit)).not.toContain(REASON);
      expect(audit?.metadata).toMatchObject({
        reopenReason: {
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
          length: REASON.length,
        },
      });

      // A finalização seguinte cria a versão 2.
      bodyOf(await finalize(document.id, 3));
      expect(versionsOf(document.id).map((version) => version.versionNumber)).toEqual([1, 2]);
    });

    it('Cancelar documento em rascunho (FA-06): CANCELED final', async () => {
      const document = await newDocument(await newProcess());
      const { data, meta } = bodyOf(
        await call('post', `/documents/${document.id}/cancel`, {
          ifMatch: '"1"',
          body: { cancellationReason: REASON },
        }),
      );
      expect(data).toMatchObject({
        status: 'CANCELED',
        cancellationReason: REASON,
        canceledById: FAKE_USERS.lucia.id,
      });
      expect(meta.allowedActions).toEqual([]);
      expect(eventsOf(document.id).at(-1)).toMatchObject({
        eventType: 'DocumentCanceled',
        payload: { fromStatus: 'DRAFT' },
      });
      expect(JSON.stringify(auditOf('document.cancel', document.id))).not.toContain(REASON);
    });

    it('Excluir rascunho nunca submetido (FA-07): 204, exclusão lógica, depois 404', async () => {
      const document = await newDocument(await newProcess());
      const response = await call('delete', `/documents/${document.id}`, { ifMatch: '"1"' });
      expect(response.status, JSON.stringify(response.body)).toBe(204);
      expect(stored(document.id)?.deletedAt).toEqual(NOW);
      expect(auditOf('document.delete', document.id)).toEqual([
        expect.objectContaining({
          metadata: expect.objectContaining({ documentTypeCode: 'DESPACHO' }) as unknown,
        }),
      ]);
      expectProblem(await call('get', `/documents/${document.id}`), 404, 'NOT_FOUND');
    });

    it('Atualizar dados do documento (DOC-04): título e responsável, sem versão, auditoria coalescível', async () => {
      const document = await newDocument(await newProcess());
      const response = await call('patch', `/documents/${document.id}`, {
        ifMatch: '"1"',
        body: {
          title: 'Despacho de encaminhamento à Procuradoria',
          responsibleId: FAKE_USERS.ana.id,
        },
      });
      const { data } = bodyOf(response);
      expect(response.headers.etag).toBe('"2"');
      expect(data).toMatchObject({
        title: 'Despacho de encaminhamento à Procuradoria',
        responsibleId: FAKE_USERS.ana.id,
        version: 2,
      });
      expect(versionsOf(document.id)).toEqual([]);
      const [audit] = auditOf('document.draft_update', document.id);
      expect(audit?.metadata).toMatchObject({ fields: ['title', 'responsibleId'] });
      expect(JSON.stringify(audit)).not.toContain('Procuradoria');
    });

    it('Entrada em etapa de aprovação e decisão (FA-02/FA-03): pendingApprovalId e depois APPROVED', async () => {
      const processId = await newProcess();
      const draft = await newDocument(processId);
      const finalized = await newDocument(processId);
      bodyOf(await finalize(finalized.id));
      const stageApproval = newId();

      const fromDraft = await runAsUser(LUCIA, (tx) =>
        documentFacadeOf(api).enterApprovalStageIn(tx, {
          documentId: draft.id,
          approvalId: stageApproval,
        }),
      );
      expect(fromDraft.document).toMatchObject({
        status: 'IN_REVIEW',
        pendingApprovalId: stageApproval,
      });
      expect(versionsOf(draft.id).map((version) => version.reason)).toEqual(['SUBMISSION']);
      expect(fromDraft.documentVersionId).toBe(versionsOf(draft.id)[0]?.id);

      const otherApproval = newId();
      const fromFinalized = await runAsUser(LUCIA, (tx) =>
        documentFacadeOf(api).enterApprovalStageIn(tx, {
          documentId: finalized.id,
          approvalId: otherApproval,
        }),
      );
      expect(fromFinalized.document).toMatchObject({
        status: 'FINALIZED',
        pendingApprovalId: otherApproval,
      });
      expect(versionsOf(finalized.id)).toHaveLength(1);

      const approved = await runAsUser(LUCIA, (tx) =>
        documentFacadeOf(api).applyApprovalDecisionIn(tx, {
          documentId: finalized.id,
          approvalId: otherApproval,
          outcome: 'APPROVED',
          analyzedVersionId: fromFinalized.documentVersionId,
        }),
      );
      expect(approved).toMatchObject({
        status: 'APPROVED',
        approvedVersionId: fromFinalized.documentVersionId,
        pendingApprovalId: null,
      });
      expect(eventsOf(finalized.id).at(-1)).toMatchObject({
        eventType: 'DocumentApproved',
        routingKey: 'document.approved.despacho',
      });

      const returned = await runAsUser(LUCIA, (tx) =>
        documentFacadeOf(api).applyApprovalDecisionIn(tx, {
          documentId: draft.id,
          approvalId: stageApproval,
          outcome: 'RETURNED',
          analyzedVersionId: fromDraft.documentVersionId,
        }),
      );
      expect(returned).toMatchObject({ status: 'RETURNED', pendingApprovalId: null });
      expect(
        timelineRowsOf(api)
          .filter((row) => row.processId === processId)
          .map((row) => row.type)
          .filter(
            (type) =>
              type === 'DOCUMENT_APPROVED' ||
              type === 'DOCUMENT_RETURNED' ||
              type === 'DOCUMENT_SUBMITTED',
          ),
      ).toEqual(['DOCUMENT_SUBMITTED', 'DOCUMENT_APPROVED', 'DOCUMENT_RETURNED']);
    });
  });

  describe('[Validação]', () => {
    it('Finalizar com pendências bloqueantes: 422 DOCUMENT_INCOMPLETE com violations e status DRAFT', async () => {
      const processId = await newProcess({ anyType: false });
      const document = await newDocument(processId, types.dfd, {
        title: 'DFD da aquisição de cimento',
      });
      dfdValidator.violations = [violation({})];

      const validation = await call('get', `/documents/${document.id}/validation`);
      expect((validation.body as { data: { isComplete: boolean } }).data.isComplete).toBe(false);

      const problem = expectProblem(await finalize(document.id), 422, 'DOCUMENT_INCOMPLETE');
      expect(problem.violations).toEqual([
        expect.objectContaining({
          code: 'DFD_ITEMS_REQUIRED',
          severity: 'BLOCKING',
          message: 'Informe ao menos um item com quantidade.',
        }),
      ]);
      expect(stored(document.id)).toMatchObject({ status: 'DRAFT', version: 1 });
      expect(versionsOf(document.id)).toEqual([]);
    });

    it('Pendências só de aviso: sem reconhecer → WARNINGS_NOT_ACKNOWLEDGED; reconhecendo → 200 (FA-04)', async () => {
      const document = await newDocument(await newProcess({ anyType: false }), types.dfd);
      dfdValidator.violations = [
        violation({
          code: 'DFD_TARGET_DATE_SOON',
          severity: 'WARNING',
          message: 'A data desejada está próxima.',
        }),
      ];
      const pending = expectProblem(await finalize(document.id), 422, 'WARNINGS_NOT_ACKNOWLEDGED');
      expect(pending.violations.map((item) => item.code)).toEqual(['DFD_TARGET_DATE_SOON']);

      const { data } = bodyOf(
        await finalize(document.id, 1, {
          body: { acknowledgedWarnings: ['DFD_TARGET_DATE_SOON'] },
        }),
      );
      expect(data.status).toBe('FINALIZED');
      // RN-DOC-52: o tipo estruturado leva o `typedSummary` no evento e na auditoria.
      expect(eventsOf(document.id).at(-1)).toMatchObject({
        routingKey: 'document.finalized.dfd',
        payload: { typedSummary: { itemsCount: 3 } },
      });
      expect(auditOf('document.finalize', document.id)[0]?.metadata).toMatchObject({
        typedSummary: { itemsCount: 3 },
        warningsAcknowledged: [
          { code: 'DFD_TARGET_DATE_SOON', message: 'A data desejada está próxima.' },
        ],
      });
    });

    it('Validação genérica das seções do template (DOC-08): SECTION_REQUIRED e o estado de cada seção', async () => {
      const template = buildTemplateVersion({
        tenantId: A,
        sections: [
          sectionDefinition('ASSUNTO', { title: 'Assunto', order: 1 }),
          sectionDefinition('FUNDAMENTO', {
            title: 'Fundamento',
            order: 2,
            requirement: 'REQUIRED_OR_JUSTIFY',
          }),
        ],
      });
      api.app
        .get<InMemoryTemplateRepository>(TEMPLATE_REPOSITORY, { strict: false })
        .seed([], [template]);
      const document = await newDocument(await newProcess(), types.despacho, {
        templateVersionId: template.id,
      });
      documentRepositoryOf(api).seed({
        ...document,
        draftContent: { sections: { ASSUNTO: filledSection('Encaminhamento do processo.') } },
      });

      const response = await call('get', `/documents/${document.id}/validation`);
      const validation = documentValidationSchema.parse((response.body as { data: unknown }).data);
      expect(validation).toMatchObject({
        isComplete: false,
        summary: { blocking: 1, warnings: 0 },
        sections: [
          { key: 'ASSUNTO', requirement: 'REQUIRED', state: 'FILLED', complete: true },
          {
            key: 'FUNDAMENTO',
            requirement: 'REQUIRED_OR_JUSTIFY',
            state: 'EMPTY',
            complete: false,
          },
        ],
      });
      expect(validation.violations.map((item) => `${item.code}:${item.sectionKey ?? ''}`)).toEqual([
        'SECTION_REQUIRED:FUNDAMENTO',
      ]);
      expectProblem(await finalize(document.id), 422, 'DOCUMENT_INCOMPLETE');
    });

    it('Reabrir com aprovação pendente: 409 INVALID_STATE e o status permanece FINALIZED (V-04)', async () => {
      const document = await newDocument(await newProcess());
      bodyOf(await finalize(document.id));
      await runAsUser(LUCIA, (tx) =>
        documentFacadeOf(api).enterApprovalStageIn(tx, {
          documentId: document.id,
          approvalId: newId(),
        }),
      );
      const response = await call('get', `/documents/${document.id}`);
      const current = bodyOf(response);
      expect(current.meta.allowedActions).toEqual([]);

      const problem = expectProblem(
        await call('post', `/documents/${document.id}/reopen`, {
          ifMatch: String(response.headers.etag),
          body: { reopenReason: REASON },
        }),
        409,
        'INVALID_STATE',
      );
      expect(problem.detail).toBe(
        'Este documento tem uma aprovação em andamento e não pode ser reaberto.',
      );
      expect(stored(document.id)?.status).toBe('FINALIZED');
    });

    it('Justificativa de reabertura/cancelamento curta: 422 VALIDATION_ERROR TOO_SHORT (V-03)', async () => {
      const document = await newDocument(await newProcess());
      const problem = expectProblem(
        await call('post', `/documents/${document.id}/cancel`, {
          ifMatch: '"1"',
          body: { cancellationReason: 'curto' },
        }),
        422,
        'VALIDATION_ERROR',
      );
      expect(problem.errors).toEqual([
        expect.objectContaining({ field: 'cancellationReason', code: 'TOO_SHORT' }),
      ]);
      bodyOf(await finalize(document.id));
      const reopen = expectProblem(
        await call('post', `/documents/${document.id}/reopen`, {
          ifMatch: '"2"',
          body: { reopenReason: 'x' },
        }),
        422,
        'VALIDATION_ERROR',
      );
      expect(reopen.errors[0]).toMatchObject({ field: 'reopenReason', code: 'TOO_SHORT' });
    });

    it('Transições incompatíveis com o status: 409 INVALID_STATE (V-05/V-07)', async () => {
      const document = await newDocument(await newProcess());
      // Reabrir um rascunho.
      expectProblem(
        await call('post', `/documents/${document.id}/reopen`, {
          ifMatch: '"1"',
          body: { reopenReason: REASON },
        }),
        409,
        'INVALID_STATE',
      );
      bodyOf(await finalize(document.id));
      // Finalizar de novo, cancelar e editar um finalizado.
      expectProblem(await finalize(document.id, 2), 409, 'INVALID_STATE');
      expectProblem(
        await call('post', `/documents/${document.id}/cancel`, {
          ifMatch: '"2"',
          body: { cancellationReason: REASON },
        }),
        409,
        'INVALID_STATE',
      );
      expectProblem(
        await call('patch', `/documents/${document.id}`, {
          ifMatch: '"2"',
          body: { title: 'Outro título' },
        }),
        409,
        'DOCUMENT_NOT_EDITABLE',
      );
      // Excluir o que já foi finalizado (mesmo reaberto): só cancelar.
      bodyOf(
        await call('post', `/documents/${document.id}/reopen`, {
          ifMatch: '"2"',
          body: { reopenReason: REASON },
        }),
      );
      const problem = expectProblem(
        await call('delete', `/documents/${document.id}`, { ifMatch: '"3"' }),
        409,
        'INVALID_STATE',
      );
      expect(problem.detail).toBe('Este documento já foi submetido; só pode ser cancelado.');
    });

    it('Tipo não permitido na etapa atual (POL-02): 422 DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE', async () => {
      // ABERTURA do workflow padrão só admite DFD (DEC-015).
      const document = await newDocument(await newProcess({ anyType: false }));
      expectProblem(await finalize(document.id), 422, 'DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE');
      const response = await call('get', `/documents/${document.id}`);
      // Cancelar não depende da etapa; editar, concluir e excluir dependem.
      expect(bodyOf(response).meta.allowedActions).toEqual(['CANCEL']);
    });

    it('Processo fora de DRAFT/IN_PROGRESS/RETURNED: 409 INVALID_PROCESS_STATUS', async () => {
      const processId = await newProcess();
      const document = await newDocument(processId);
      const repository = processRepositoryOf(api);
      const process = repository.allProcesses().find((row) => row.id === processId);
      if (!process) throw new Error('processo ausente');
      repository.seed({ ...process, status: 'SUSPENDED' });
      expectProblem(await finalize(document.id), 409, 'INVALID_PROCESS_STATUS');
      repository.seed(process);
    });

    it('Responsável sem vínculo ativo no tenant: 422 VALIDATION_ERROR em responsibleId', async () => {
      const document = await newDocument(await newProcess());
      const problem = expectProblem(
        await call('patch', `/documents/${document.id}`, {
          ifMatch: '"1"',
          body: { responsibleId: FAKE_USERS.heitor.id },
        }),
        422,
        'VALIDATION_ERROR',
      );
      expect(problem.errors[0]).toMatchObject({
        field: 'responsibleId',
        code: 'REFERENCE_NOT_FOUND',
      });
      expectProblem(
        await call('patch', `/documents/${document.id}`, { ifMatch: '"1"', body: {} }),
        422,
        'VALIDATION_ERROR',
      );
    });
  });

  describe('[Permissão]', () => {
    it('Reabrir sem a permissão DOCUMENT_REOPEN: 403 PERMISSION_DENIED e o status permanece APPROVED', async () => {
      const document = await newDocument(await newProcess());
      bodyOf(await finalize(document.id));
      const approvalId = newId();
      const { documentVersionId } = await runAsUser(LUCIA, (tx) =>
        documentFacadeOf(api).enterApprovalStageIn(tx, { documentId: document.id, approvalId }),
      );
      await runAsUser(LUCIA, (tx) =>
        documentFacadeOf(api).applyApprovalDecisionIn(tx, {
          documentId: document.id,
          approvalId,
          outcome: 'APPROVED',
          analyzedVersionId: documentVersionId,
        }),
      );
      const response = await call('post', `/documents/${document.id}/reopen`, {
        subject: 'sub-ana',
        ifMatch: `"${stored(document.id)?.version ?? 0}"`,
        body: { reopenReason: REASON },
      });
      expectProblem(response, 403, 'PERMISSION_DENIED');
      expect(stored(document.id)?.status).toBe('APPROVED');
      expect(auditOf('access.denied').at(-1)).toMatchObject({ reasonCode: 'DOCUMENT_REOPEN' });
    });

    it('Cancelar sem custódia do processo: 403 NOT_PROCESS_CUSTODIAN (V-06)', async () => {
      const document = await newDocument(await newProcess());
      // Ana vê o processo (setor solicitante) e tem DOCUMENT_CANCEL, mas a responsável é Lúcia.
      const view = bodyOf(await call('get', `/documents/${document.id}`, { subject: 'sub-ana' }));
      expect(view.meta.allowedActions).toEqual([]);
      const problem = expectProblem(
        await call('post', `/documents/${document.id}/cancel`, {
          subject: 'sub-ana',
          ifMatch: '"1"',
          body: { cancellationReason: REASON },
        }),
        403,
        'NOT_PROCESS_CUSTODIAN',
      );
      expect(problem.detail).toBe(
        'Apenas o responsável atual pelo processo pode cancelar este documento.',
      );
      expect(stored(document.id)?.status).toBe('DRAFT');
      expect(auditOf('access.denied').at(-1)).toMatchObject({ reasonCode: 'POL-01' });
    });

    it('Finalizar sem custódia nem participação (POL-02): 403 PERMISSION_DENIED', async () => {
      const document = await newDocument(await newProcess());
      expectProblem(
        await finalize(document.id, 1, { subject: 'sub-ana' }),
        403,
        'PERMISSION_DENIED',
      );
      expect(stored(document.id)?.status).toBe('DRAFT');
    });

    it('Sem vínculo com perfil (sem PROCESS_VIEW): 403; If-Match ausente: 428', async () => {
      const document = await newDocument(await newProcess());
      // Otávio só com CONSULTOR_EXTERNO e sem participação: nenhum PROCESS_VIEW (permissions.md §3.2).
      expectProblem(
        await call('get', `/documents/${document.id}`, { subject: 'sub-otavio' }),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(
        await call('post', `/documents/${document.id}/finalize`, { key: randomUUID() }),
        428,
        'PRECONDITION_REQUIRED',
      );
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Transição em documento de outro tenant: 404 NOT_FOUND', async () => {
      const foreign = buildDocument({ tenantId: B, processId: newId(), documentTypeId: newId() });
      documentRepositoryOf(api).seed(foreign);
      expectProblem(await finalize(foreign.id), 404, 'NOT_FOUND');
      expectProblem(await call('get', `/documents/${foreign.id}`), 404, 'NOT_FOUND');
      expectProblem(await call('get', `/documents/${foreign.id}/validation`), 404, 'NOT_FOUND');
      expect(stored(foreign.id)?.status).toBe('DRAFT');
    });
  });

  describe('[Duplicidade]', () => {
    it('Segundo documento de tipo singular no mesmo processo: 409 DOCUMENT_ALREADY_EXISTS', async () => {
      const processId = await newProcess();
      const etp = await newDocument(processId, types.etp, { title: 'Estudo Técnico Preliminar' });
      expect(etp.singletonKey).toBe(types.etp);
      documentRepositoryOf(api).seed({ ...etp, status: 'APPROVED' });

      await expect(newDocument(processId, types.etp)).rejects.toMatchObject({
        code: 'DOCUMENT_ALREADY_EXISTS',
        status: 409,
      });
      // Tipo múltiplo: dois despachos convivem.
      await newDocument(processId);
      await newDocument(processId);
      // Cancelado libera a vaga do tipo singular.
      documentRepositoryOf(api).seed({ ...etp, status: 'CANCELED', cancellationReason: REASON });
      await expect(newDocument(processId, types.etp)).resolves.toMatchObject({ status: 'DRAFT' });
    });

    it('Reenvio da finalização com a mesma chave de idempotência: 200 replay e uma única versão', async () => {
      const document = await newDocument(await newProcess());
      const key = randomUUID();
      const first = await finalize(document.id, 1, { key });
      bodyOf(first);
      const replay = await finalize(document.id, 1, { key });
      expect(replay.status).toBe(200);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toEqual(first.body);
      expect(versionsOf(document.id)).toHaveLength(1);
      expect(auditOf('document.finalize', document.id)).toHaveLength(1);
    });
  });

  describe('[Concorrência]', () => {
    it('Finalizar com ETag desatualizado: 412 VERSION_CONFLICT com currentVersion = 3 e nenhuma versão', async () => {
      const document = await newDocument(await newProcess());
      bodyOf(
        await call('patch', `/documents/${document.id}`, {
          ifMatch: '"1"',
          body: { title: 'Título revisto 1' },
        }),
      );
      bodyOf(
        await call('patch', `/documents/${document.id}`, {
          ifMatch: '"2"',
          body: { title: 'Título revisto 2' },
        }),
      );
      const problem = expectProblem(await finalize(document.id, 2), 412, 'VERSION_CONFLICT');
      expect((problem as unknown as { currentVersion: number }).currentVersion).toBe(3);
      expect(versionsOf(document.id)).toEqual([]);
      expect(stored(document.id)?.status).toBe('DRAFT');
    });

    it('Duas finalizações simultâneas do mesmo documento: uma 200 e a outra 412', async () => {
      const document = await newDocument(await newProcess());
      const [one, two] = await Promise.all([finalize(document.id), finalize(document.id)]);
      expect([one.status, two.status].sort()).toEqual([200, 412]);
      const loser = one.status === 412 ? one : two;
      expect(problemDetailsSchema.parse(loser.body).code).toBe('VERSION_CONFLICT');
      expect(versionsOf(document.id)).toHaveLength(1);
      expect(stored(document.id)).toMatchObject({ status: 'FINALIZED', version: 2 });
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível ao finalizar: 503 DEPENDENCY_UNAVAILABLE, status DRAFT e nenhuma versão', async () => {
      const document = await newDocument(await newProcess());
      const audits = api.auditRecords().length;
      transactions.down = true;
      const response = await finalize(document.id);
      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      expect(response.headers['retry-after']).toBeDefined();
      transactions.down = false;
      expect(stored(document.id)).toMatchObject({ status: 'DRAFT', version: 1 });
      expect(versionsOf(document.id)).toEqual([]);
      expect(
        api
          .auditRecords()
          .slice(audits)
          .filter((row) => row.action.startsWith('document.')),
      ).toEqual([]);
    });
  });

  describe('[Falha de integração]', () => {
    it('Outbox sem relay ao finalizar: 200 e o DocumentFinalized fica gravado para publicação posterior', async () => {
      const document = await newDocument(await newProcess());
      const { data } = bodyOf(await finalize(document.id));
      expect(data.status).toBe('FINALIZED');
      // Sem relay no teste: o evento fica no outbox (PENDING no PostgreSQL — tenant-leak/documents).
      expect(
        eventsOf(document.id).filter((row) => row.eventType === 'DocumentFinalized'),
      ).toHaveLength(1);
    });
  });
});
