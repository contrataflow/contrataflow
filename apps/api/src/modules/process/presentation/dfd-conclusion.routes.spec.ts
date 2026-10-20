import { randomUUID } from 'node:crypto';

import {
  actionEntrySchema,
  documentValidationSchema,
  forwardedProcessSchema,
  problemDetailsSchema,
} from '@contrataflow/validation';
import type {
  ActionEntry,
  DfdDto,
  DocumentDto,
  DocumentValidationDto,
  ForwardedProcessDto,
  ProcessDto,
  ProcessItemDto,
} from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { canonicalJson, sha256Hex } from '#shared/integrity/canonical-json.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import {
  approvalRepositoryOf,
  documentRepositoryOf,
  filledSection,
} from '../../../../test/support/document-fixtures.js';
import {
  CATALOG_CLOCK,
  catalogItemId,
  processRepositoryOf,
  runTenantSeeders,
  seedParticipant,
  seedProcessStructure,
  seedScanningAttachment,
  timelineRowsOf,
} from '../../../../test/support/process-fixtures.js';
import {
  fillDfdDraft,
  setDepartmentHead,
} from '../../../../test/support/process-forward-fixtures.js';
import { assignDepartment } from '../../../../test/support/structure-fixtures.js';
import { PROCESS_CLOCK, PROCESS_TRANSACTIONS } from '../application/ports.js';
import type { ProcessTransactions } from '../application/ports.js';
import type { Process } from '../domain/process.js';

/*
 * US-016 — "Concluir e enviar para aprovação" (PRC-19 de ABERTURA → APROVACAO_DFD) e "Finalizar
 * DFD" (DOC-10) pelo pipeline HTTP completo com a identidade fake, os seeders reais (workflow padrão
 * DEC-015, templates e tipos) e repositórios em memória — as 8 categorias do Gherkin. Ana =
 * "Cláudia" (requisitante e responsável), Marta = "Dra. Helena Prado" (titular da Secretaria de
 * Obras), Fábio = "Paulo Mendes" (substituto), Lúcia = "Marcos" (COLLABORATOR com DFD_SUBMIT pelo
 * perfil GESTOR_CONTRATACOES), Otávio = "Bruno" (CONSULTANT sem DFD_SUBMIT). Rollback real e RLS:
 * `test/tenant-leak/dfd-conclusion.spec.ts`; a mecânica genérica do encaminhamento e da aprovação
 * está nas specs da US-047/US-051.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
/** "Hoje é 05/10/2026" — meio-dia em São Paulo. */
const NOW = new Date('2026-10-05T15:00:00.000Z');
const MESSAGE = 'Demanda urgente para reposição de estoque';
const DFD_INCOMPLETE = 'O DFD deve estar completo.';

const ORG_A = '0192d016-0000-7000-8000-0000000000a0';
const ORG_B = '0192d016-0000-7000-8000-0000000000b0';
const UNITS_A = {
  organizationId: ORG_A,
  obras: '0192d016-0000-7000-8000-0000000000a1',
  manutencao: '0192d016-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d016-0000-7000-8000-0000000000a3',
  saude: '0192d016-0000-7000-8000-0000000000a4',
  posto: '0192d016-0000-7000-8000-0000000000a5',
};
const UNITS_B = {
  organizationId: ORG_B,
  obras: '0192d016-0000-7000-8000-0000000000b1',
  manutencao: '0192d016-0000-7000-8000-0000000000b2',
  pavimentacao: '0192d016-0000-7000-8000-0000000000b3',
  saude: '0192d016-0000-7000-8000-0000000000b4',
  posto: '0192d016-0000-7000-8000-0000000000b5',
};

const membershipOf = (userId: string, tenantId = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

/** Transações do `process` com o banco que pode cair (Falha de banco). */
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
    return this.run(work);
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

describe('Feature: Concluir o DFD e enviá-lo para aprovação (US-016)', () => {
  let api: TestApi;
  const transactions = new FlakyTransactions();
  let catalog: { contractingType: string; origin: string; unit: string };
  const words = (count: number) =>
    Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

  const auth = (call: request.Test, subject = 'sub-ana', tenant: string = A) =>
    call
      .set('Authorization', api.bearer(subject, { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', tenant);
  const stored = (id: string): Process => {
    const process = processRepositoryOf(api)
      .allProcesses()
      .find((candidate) => candidate.id === id);
    if (!process) throw new Error(`processo ${id} ausente`);
    return process;
  };
  const storedDocument = (id: string) => {
    const document = documentRepositoryOf(api)
      .allDocuments()
      .find((candidate) => candidate.id === id);
    if (!document) throw new Error(`documento ${id} ausente`);
    return document;
  };
  const versionsOf = (documentId: string) => documentRepositoryOf(api).versionsOf(documentId);
  const approvalsOf = (processId: string) =>
    approvalRepositoryOf(api)
      .approvals()
      .filter((approval) => approval.processId === processId);
  const eventsOf = (processId: string, eventType: string) =>
    api.outboxRows().filter((row) => row.processId === processId && row.eventType === eventType);
  const auditOf = (processId: string, action: string) =>
    api.auditRecords().filter((row) => row.processId === processId && row.action === action);
  const timelineOf = (processId: string, type: string) =>
    timelineRowsOf(api).filter((row) => row.processId === processId && row.type === type);
  /** O que o envio grava — para provar que nada foi gravado numa recusa. */
  const effects = (processId: string, documentId: string) => ({
    process: stored(processId),
    movements: processRepositoryOf(api).movementsOf(processId).length,
    approvals: approvalsOf(processId).length,
    document: storedDocument(documentId),
    versions: versionsOf(documentId).length,
  });

  const forward = (
    process: Pick<Process, 'id' | 'currentStageId' | 'version'>,
    body: Record<string, unknown>,
    options: { subject?: string; tenant?: string; key?: string } = {},
  ) =>
    auth(
      request(api.server).post(`/api/v1/processes/${process.id}/forward`),
      options.subject,
      options.tenant,
    )
      .set('If-Match', `"${String(process.version)}"`)
      .set('Idempotency-Key', options.key ?? randomUUID())
      .send({ expectedStageId: process.currentStageId, acknowledgedWarnings: [], ...body });
  const finalize = (
    documentId: string,
    body: Record<string, unknown>,
    options: { subject?: string; version?: number } = {},
  ) =>
    auth(request(api.server).post(`/api/v1/documents/${documentId}/finalize`), options.subject)
      .set('If-Match', `"${String(options.version ?? storedDocument(documentId).version)}"`)
      .set('Idempotency-Key', randomUUID())
      .send({ acknowledgedWarnings: [], ...body });
  const validation = async (documentId: string): Promise<DocumentValidationDto> => {
    const response = await auth(
      request(api.server).get(`/api/v1/documents/${documentId}/validation`),
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return documentValidationSchema.parse(data(response));
  };
  const documentView = async (documentId: string, subject = 'sub-ana') => {
    const response = await auth(
      request(api.server).get(`/api/v1/documents/${documentId}`),
      subject,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response.body as { data: DocumentDto; meta: { allowedActions: string[] } };
  };
  const actionsOf = async (processId: string, subject = 'sub-ana') => {
    const response = await auth(
      request(api.server).get(`/api/v1/processes/${processId}/available-actions`),
      subject,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return z.array(actionEntrySchema).parse(data<ActionEntry[]>(response));
  };
  const sendEntryOf = async (processId: string, subject = 'sub-ana') => {
    const entry = (await actionsOf(processId, subject)).find(
      (action) => action.action === 'FORWARD' && action.toStageKey === 'APROVACAO_DFD',
    );
    if (!entry) throw new Error('transição ENVIAR_APROVACAO_DFD ausente');
    return entry;
  };

  /** Background: processo na ABERTURA (DRAFT, Ana responsável) com o DFD completo de 2 itens. */
  async function background(): Promise<{ process: Process; dfd: DfdDto }> {
    const created = await auth(request(api.server).post('/api/v1/processes'))
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
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const processId = data<ProcessDto>(created).id;
    const items: ProcessItemDto[] = [];
    for (const description of ['Cimento CP II 50 kg', 'Areia média lavada']) {
      const item = await auth(request(api.server).post(`/api/v1/processes/${processId}/items`))
        .set('Idempotency-Key', randomUUID())
        .send({ kind: 'GOOD', description, unitOfMeasureId: catalog.unit });
      expect(item.status, JSON.stringify(item.body)).toBe(201);
      items.push(data<ProcessItemDto>(item));
    }
    const dfdResponse = await auth(request(api.server).post(`/api/v1/processes/${processId}/dfds`))
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(dfdResponse.status, JSON.stringify(dfdResponse.body)).toBe(201);
    const dfd = data<DfdDto>(dfdResponse);
    const saved = await auth(request(api.server).put(`/api/v1/documents/${dfd.documentId}/items`))
      .set('If-Match', '"1"')
      .send({
        items: items.map((item, index) => ({
          processItemId: item.id,
          quantity: String((index + 1) * 100),
        })),
      });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    fillDfdDraft(
      api,
      dfd,
      {
        JUSTIFICATION: 'x'.repeat(380),
        EXPECTED_RESULTS: 'Manutenção contínua das vias do bairro Centro.',
      },
      { expectedDate: '2026-12-15', pcaStatus: 'PLANNED', pcaYear: 2026 },
    );
    return { process: stored(processId), dfd };
  }

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    api = await createTestApi({
      providers: [
        { token: PROCESS_TRANSACTIONS, value: transactions },
        { token: PROCESS_CLOCK, value: () => NOW },
        { token: CATALOG_CLOCK, value: () => NOW },
      ],
    });
    await runTenantSeeders(api, A, [
      'catalog.items',
      'catalog.holidays',
      'access.defaultRoles',
      'document.systemTypes',
      'document.templateLibrary',
      'workflow.seedWorkflows',
    ]);
    await runTenantSeeders(api, B, ['catalog.items', 'access.defaultRoles']);
    seedProcessStructure(api, A, { ...UNITS_A, shortName: 'PMSJ', cnpj: '11222333000181' });
    seedProcessStructure(api, B, { ...UNITS_B, shortName: 'PMB', cnpj: '60746948000112' });
    assignDepartment(api, membershipOf(FAKE_USERS.ana.id), UNITS_A.manutencao);
    setDepartmentHead(api, UNITS_A.obras, FAKE_USERS.marta.id, FAKE_USERS.fabio.id);
    catalog = {
      contractingType: catalogItemId(api, A, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
      origin: catalogItemId(api, A, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
      unit: catalogItemId(api, A, 'UNIT_OF_MEASURE', 'UN'),
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
    it('Concluir e enviar para aprovação: processo AWAITING_APPROVAL, DFD IN_REVIEW v1 com hash, aprovação do titular com substituto, tramitação, timeline, auditoria e eventos', async () => {
      const { process, dfd } = await background();
      const entry = await sendEntryOf(process.id);
      expect(entry).toMatchObject({
        transitionKey: 'ENVIAR_APROVACAO_DFD',
        toStageType: 'APPROVAL',
        enabled: true,
        primary: true,
        approverPreview: {
          type: 'DEPARTMENT_HEAD',
          label: 'Marta Ribeiro (titular da Secretaria de Obras)',
        },
      });

      const response = await forward(process, {
        transitionId: entry.transitionId,
        comment: MESSAGE,
        documentIds: [dfd.documentId],
      });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const dto = forwardedProcessSchema.parse(data<ForwardedProcessDto>(response));
      expect(dto).toMatchObject({
        status: 'AWAITING_APPROVAL',
        currentStage: { key: 'APROVACAO_DFD' },
        approval: { approverLabel: 'Marta Ribeiro (titular da Secretaria de Obras)' },
      });
      const approvalId = dto.approval?.id ?? '';

      // DFD em IN_REVIEW com a versão 1 SUBMISSION — o hash é o do conteúdo congelado.
      const document = storedDocument(dfd.documentId);
      expect(document).toMatchObject({
        status: 'IN_REVIEW',
        pendingApprovalId: approvalId,
        submittedById: FAKE_USERS.ana.id,
        currentVersionNumber: 1,
      });
      const [version, ...more] = versionsOf(dfd.documentId);
      expect(more).toEqual([]);
      expect(version).toMatchObject({
        versionNumber: 1,
        reason: 'SUBMISSION',
        statusAtCreation: 'IN_REVIEW',
      });
      expect(version?.contentHash).toBe(sha256Hex(canonicalJson(version?.content)));
      // RN-DFD-40: itens com número, descrição e unidade do momento; cabeçalho completo.
      expect(version?.content).toMatchObject({
        document: { versionNumber: 1, typeCode: 'DFD' },
        header: { pcaStatus: 'PLANNED', expectedDate: '2026-12-15' },
        sections: { JUSTIFICATION: { state: 'FILLED' } },
        collections: {
          items: [
            { sequence: 1, description: 'Cimento CP II 50 kg', quantity: '100.0000' },
            { sequence: 2, description: 'Areia média lavada', quantity: '200.0000' },
          ],
        },
      });

      // Aprovação PENDING do titular, substituto permitido, cobrindo exatamente a versão 1.
      const [approval] = approvalsOf(process.id);
      expect(approval).toMatchObject({
        id: approvalId,
        status: 'PENDING',
        subjectType: 'PROCESS_STAGE',
        approverType: 'DEPARTMENT_HEAD',
        approverUserId: FAKE_USERS.marta.id,
        allowDeputy: true,
        requestComment: MESSAGE,
        title: `Aprovação da demanda — ${document.code ?? ''}`,
      });
      expect(approvalRepositoryOf(api).coverageOf(approvalId)).toEqual([
        expect.objectContaining({ documentId: dfd.documentId, documentVersionId: version?.id }),
      ]);
      expect(processRepositoryOf(api).movementsOf(process.id).at(-1)).toMatchObject({
        action: 'FORWARD',
        comment: MESSAGE,
        documents: [{ documentId: dfd.documentId, versionNumber: 1, status: 'IN_REVIEW' }],
      });
      expect(
        processRepositoryOf(api)
          .accessOf(process.id)
          .filter((row) => row.reason === 'APPROVER')
          .map((row) => row.userId)
          .sort(),
      ).toEqual([FAKE_USERS.marta.id, FAKE_USERS.fabio.id].sort());

      for (const type of ['PROCESS_FORWARDED', 'DOCUMENT_SUBMITTED', 'APPROVAL_REQUESTED']) {
        expect(timelineOf(process.id, type), type).toHaveLength(1);
      }
      for (const action of [
        'process.forward',
        'document.submit',
        'document.version_create',
        'approval.request',
      ]) {
        expect(auditOf(process.id, action), action).toHaveLength(1);
      }
      expect(eventsOf(process.id, 'ProcessStageChanged').at(-1)?.payload).toMatchObject({
        toStage: { key: 'APROVACAO_DFD' },
      });
      expect(eventsOf(process.id, 'ProcessStatusChanged').at(-1)).toMatchObject({
        routingKey: 'process.status_changed.awaiting_approval',
      });
      expect(eventsOf(process.id, 'DocumentVersionCreated').map((row) => row.routingKey)).toContain(
        'document.version_created.dfd',
      );
      expect(eventsOf(process.id, 'DocumentSubmitted')).toEqual([
        expect.objectContaining({
          routingKey: 'document.submitted.dfd',
          payload: expect.objectContaining({ approvalId }) as unknown,
        }),
      ]);
      // O aviso APPROVAL_REQUESTED (titular + substituto) nasce deste evento no worker.
      expect(eventsOf(process.id, 'ApprovalRequested')).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            approverType: 'DEPARTMENT_HEAD',
            allowDeputy: true,
            documentVersionIds: [version?.id],
          }) as unknown,
        }),
      ]);

      // Modo leitura com o selo "Em aprovação" (pendingApprovalId) — sem UPDATE nas ações.
      const view = await documentView(dfd.documentId);
      expect(view.data.pendingApprovalId).toBe(approvalId);
      expect(view.meta.allowedActions).not.toContain('UPDATE');
      expect(view.meta.allowedActions).not.toContain('FINALIZE');
    });

    it('Finalizar o DFD sem encaminhar (colaborador com DFD_SUBMIT) e encaminhar depois: FINALIZED v1 sem nova versão', async () => {
      const { process, dfd } = await background();
      seedParticipant(api, {
        tenantId: A,
        processId: process.id,
        userId: FAKE_USERS.lucia.id,
        role: 'COLLABORATOR',
      });
      const before = await documentView(dfd.documentId, 'sub-lucia');
      expect(before.meta.allowedActions).toContain('FINALIZE');
      const checked = await validation(dfd.documentId);

      const finalized = await finalize(
        dfd.documentId,
        { expectedDraftRevision: checked.draftRevision },
        { subject: 'sub-lucia' },
      );

      expect(finalized.status, JSON.stringify(finalized.body)).toBe(200);
      expect(data<DocumentDto>(finalized)).toMatchObject({
        status: 'FINALIZED',
        finalizedById: FAKE_USERS.lucia.id,
        currentVersionNumber: 1,
      });
      expect(versionsOf(dfd.documentId)).toEqual([
        expect.objectContaining({ versionNumber: 1, reason: 'FINALIZATION' }),
      ]);
      expect(eventsOf(process.id, 'DocumentFinalized')).toEqual([
        expect.objectContaining({ routingKey: 'document.finalized.dfd' }),
      ]);
      expect(stored(process.id)).toMatchObject({ status: process.status });
      expect(stored(process.id).currentStageId).toBe(process.currentStageId);
      expect(timelineOf(process.id, 'DOCUMENT_FINALIZED')).toHaveLength(1);

      const entry = await sendEntryOf(process.id);
      const sent = await forward(stored(process.id), { transitionId: entry.transitionId });

      expect(sent.status, JSON.stringify(sent.body)).toBe(200);
      const approvalId = data<ForwardedProcessDto>(sent).approval?.id ?? '';
      expect(storedDocument(dfd.documentId)).toMatchObject({
        status: 'FINALIZED',
        pendingApprovalId: approvalId,
      });
      const [version, ...more] = versionsOf(dfd.documentId);
      expect(more).toEqual([]);
      expect(approvalRepositoryOf(api).coverageOf(approvalId)).toEqual([
        expect.objectContaining({ documentId: dfd.documentId, documentVersionId: version?.id }),
      ]);
      expect(eventsOf(process.id, 'DocumentSubmitted')).toEqual([]);
      expect((await documentView(dfd.documentId)).data.pendingApprovalId).toBe(approvalId);
    });
  });

  describe('[Validação]', () => {
    it('Pendência surgida entre a tela e o servidor: 422 TRANSITION_BLOCKED com WORKFLOW_RULE "O DFD deve estar completo." e nada criado', async () => {
      const { process, dfd } = await background();
      const entry = await sendEntryOf(process.id);
      // Outra pessoa apaga a justificativa depois que a tela foi aberta.
      fillDfdDraft(api, dfd, {}, {});
      const document = storedDocument(dfd.documentId);
      documentRepositoryOf(api).seed({
        ...document,
        draftContent: {
          sections: {
            ...document.draftContent.sections,
            JUSTIFICATION: filledSection('', { state: 'EMPTY', content: null }),
          },
        },
      });
      const before = effects(process.id, dfd.documentId);

      const problem = expectProblem(
        await forward(process, { transitionId: entry.transitionId }),
        422,
        'TRANSITION_BLOCKED',
      );

      expect(problem.violations).toContainEqual(
        expect.objectContaining({
          code: 'WORKFLOW_RULE',
          severity: 'BLOCKING',
          message: DFD_INCOMPLETE,
          params: { documentTypeCode: 'DFD', minStatus: 'COMPLETE' },
        }),
      );
      expect(effects(process.id, dfd.documentId)).toEqual(before);
      // O front recarrega o DOC-08 e mostra a pendência da seção.
      expect((await validation(dfd.documentId)).violations).toContainEqual(
        expect.objectContaining({ code: 'SECTION_REQUIRED', sectionKey: 'JUSTIFICATION' }),
      );
    });

    it('Alerta DFD_ATTACHMENTS_PENDING não reconhecido: 422 WARNINGS_NOT_ACKNOWLEDGED; reconhecido, fica na tramitação e na auditoria', async () => {
      const { process, dfd } = await background();
      seedScanningAttachment(api, {
        tenantId: A,
        processId: process.id,
        targetType: 'DOCUMENT',
        targetId: dfd.documentId,
        uploadedById: FAKE_USERS.ana.id,
        now: NOW,
      });
      const entry = await sendEntryOf(process.id);
      const before = effects(process.id, dfd.documentId);

      const problem = expectProblem(
        await forward(process, { transitionId: entry.transitionId }),
        422,
        'WARNINGS_NOT_ACKNOWLEDGED',
      );
      expect(problem.violations).toEqual([
        expect.objectContaining({ code: 'DFD_ATTACHMENTS_PENDING', severity: 'WARNING' }),
      ]);
      expect(effects(process.id, dfd.documentId)).toEqual(before);

      const sent = await forward(process, {
        transitionId: entry.transitionId,
        acknowledgedWarnings: ['DFD_ATTACHMENTS_PENDING'],
      });
      expect(sent.status, JSON.stringify(sent.body)).toBe(200);
      const acknowledged = [
        expect.objectContaining({ documentId: dfd.documentId, code: 'DFD_ATTACHMENTS_PENDING' }),
      ];
      expect(processRepositoryOf(api).movementsOf(process.id).at(-1)?.metadata).toMatchObject({
        documentWarningsAcknowledged: acknowledged,
      });
      expect(auditOf(process.id, 'process.forward')[0]?.metadata).toMatchObject({
        documentWarningsAcknowledged: acknowledged,
      });
      expect(auditOf(process.id, 'document.submit')[0]?.metadata).toMatchObject({
        warningsAcknowledged: [expect.objectContaining({ code: 'DFD_ATTACHMENTS_PENDING' })],
      });
    });

    it('Finalizar com a revisão conferida desatualizada: 412 VERSION_CONFLICT; mensagem ao aprovador acima de 5.000 caracteres: 422', async () => {
      const { process, dfd } = await background();
      const checked = await validation(dfd.documentId);
      const problem = expectProblem(
        await finalize(dfd.documentId, { expectedDraftRevision: checked.draftRevision + 1 }),
        412,
        'VERSION_CONFLICT',
      );
      expect(problem.detail).toBe('O documento foi alterado desde que você o revisou.');
      expect(storedDocument(dfd.documentId).status).toBe('DRAFT');
      expect(versionsOf(dfd.documentId)).toEqual([]);

      const entry = await sendEntryOf(process.id);
      const tooLong = expectProblem(
        await forward(process, { transitionId: entry.transitionId, comment: 'a'.repeat(5001) }),
        422,
        'VALIDATION_ERROR',
      );
      expect(tooLong.errors).toContainEqual(expect.objectContaining({ field: 'comment' }));
    });
  });

  describe('[Permissão]', () => {
    it('Colaborador sem custódia não encaminha: ação indisponível no PRC-08 e POST 403 NOT_PROCESS_CUSTODIAN com access.denied', async () => {
      const { process } = await background();
      seedParticipant(api, {
        tenantId: A,
        processId: process.id,
        userId: FAKE_USERS.lucia.id,
        role: 'COLLABORATOR',
      });
      const entry = await sendEntryOf(process.id, 'sub-lucia');
      expect(entry).toMatchObject({
        enabled: false,
        reasons: [expect.objectContaining({ code: 'NOT_PROCESS_CUSTODIAN' })],
      });

      expectProblem(
        await forward(process, { transitionId: entry.transitionId }, { subject: 'sub-lucia' }),
        403,
        'NOT_PROCESS_CUSTODIAN',
      );
      expect(api.auditRecords().at(-1)).toMatchObject({
        action: 'access.denied',
        reasonCode: 'NOT_PROCESS_CUSTODIAN',
      });
      expect(approvalsOf(process.id)).toEqual([]);
    });

    it('Consultor participante sem DFD_SUBMIT não finaliza: 403 PERMISSION_DENIED', async () => {
      const { process, dfd } = await background();
      seedParticipant(api, {
        tenantId: A,
        processId: process.id,
        userId: FAKE_USERS.otavio.id,
        role: 'CONSULTANT',
        expiresAt: new Date('2026-12-31T23:59:59Z'),
      });
      expect((await documentView(dfd.documentId, 'sub-otavio')).meta.allowedActions).not.toContain(
        'FINALIZE',
      );
      expectProblem(
        await finalize(dfd.documentId, {}, { subject: 'sub-otavio' }),
        403,
        'PERMISSION_DENIED',
      );
      expect(storedDocument(dfd.documentId).status).toBe('DRAFT');
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Encaminhar processo de outro tenant: 404 PROCESS_NOT_FOUND', async () => {
      const { process, dfd } = await background();
      const entry = await sendEntryOf(process.id);
      expectProblem(
        await forward(
          process,
          { transitionId: entry.transitionId },
          { subject: 'sub-heitor', tenant: B },
        ),
        404,
        'PROCESS_NOT_FOUND',
      );
      expect(storedDocument(dfd.documentId).status).toBe('DRAFT');
    });
  });

  describe('[Duplicidade]', () => {
    it('Duplo clique com a mesma chave: mesma resposta com Idempotent-Replayed e uma única aprovação, versão e tramitação', async () => {
      const { process, dfd } = await background();
      const entry = await sendEntryOf(process.id);
      const movements = processRepositoryOf(api).movementsOf(process.id).length;
      const body = { transitionId: entry.transitionId, comment: MESSAGE };

      const first = await forward(process, body, { key: 'b2f4d016-0000-4000-8000-00000000e001' });
      const second = await forward(process, body, { key: 'b2f4d016-0000-4000-8000-00000000e001' });

      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(second.status).toBe(200);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.body).toEqual(first.body);
      expect(approvalsOf(process.id)).toHaveLength(1);
      expect(versionsOf(dfd.documentId)).toHaveLength(1);
      expect(processRepositoryOf(api).movementsOf(process.id)).toHaveLength(movements + 1);
    });

    it('Reenvio por outra aba depois do envio (nova chave, etapa antiga): 409 STAGE_CHANGED', async () => {
      const { process, dfd } = await background();
      const entry = await sendEntryOf(process.id);
      expect((await forward(process, { transitionId: entry.transitionId })).status).toBe(200);

      expectProblem(
        await forward(process, { transitionId: entry.transitionId }),
        409,
        'STAGE_CHANGED',
      );
      expect(approvalsOf(process.id)).toHaveLength(1);
      expect(versionsOf(dfd.documentId)).toHaveLength(1);
    });
  });

  describe('[Concorrência]', () => {
    it('Gravação de seção confirmada antes do envio entra na versão 1; depois do envio, 409; o conteúdo bate com o hash', async () => {
      const { process, dfd } = await background();
      // "Bruno" edita como colaborador enquanto "Cláudia" envia.
      seedParticipant(api, {
        tenantId: A,
        processId: process.id,
        userId: FAKE_USERS.lucia.id,
        role: 'COLLABORATOR',
      });
      const entry = await sendEntryOf(process.id);
      const text = 'Atendimento contínuo das vias e redução de chamados.';
      const section = (sectionText: string, ifMatch: string) =>
        auth(
          request(api.server).put(`/api/v1/documents/${dfd.documentId}/sections/EXPECTED_RESULTS`),
          'sub-lucia',
        )
          .set('If-Match', ifMatch)
          .send({
            content: {
              type: 'doc',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: sectionText }] }],
            },
            notApplicable: false,
            justification: null,
          });
      const before = await section(text, '"s1"');
      expect(before.status, JSON.stringify(before.body)).toBe(200);

      const sent = await forward(stored(process.id), { transitionId: entry.transitionId });
      expect(sent.status, JSON.stringify(sent.body)).toBe(200);

      // Chegou depois: 409. O processo em AWAITING_APPROVAL é conferido antes do documento
      // (ordem das checagens da US-065), então o código é INVALID_PROCESS_STATUS.
      expectProblem(
        await section('Texto que chegou depois do bloqueio.', '"s2"'),
        409,
        'INVALID_PROCESS_STATUS',
      );
      const [version] = versionsOf(dfd.documentId);
      expect(JSON.stringify(version?.content)).toContain(text);
      expect(JSON.stringify(version?.content)).not.toContain('chegou depois');
      expect(version?.contentHash).toBe(sha256Hex(canonicalJson(version?.content)));
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível no envio: 503 DEPENDENCY_UNAVAILABLE, DFD continua DRAFT sem versão e o processo na ABERTURA', async () => {
      const { process, dfd } = await background();
      const entry = await sendEntryOf(process.id);
      const before = effects(process.id, dfd.documentId);
      transactions.down = true;

      expectProblem(
        await forward(process, { transitionId: entry.transitionId }),
        503,
        'DEPENDENCY_UNAVAILABLE',
      );

      transactions.down = false;
      expect(effects(process.id, dfd.documentId)).toEqual(before);
      expect(storedDocument(dfd.documentId).status).toBe('DRAFT');
    });
  });

  describe('[Falha de integração]', () => {
    it('Gotenberg indisponível ao baixar o PDF da versão: 202 (PDF em geração) e o envio não é afetado', async () => {
      const { process, dfd } = await background();
      const entry = await sendEntryOf(process.id);
      expect((await forward(process, { transitionId: entry.transitionId })).status).toBe(200);
      const [version] = versionsOf(dfd.documentId);

      // A renderização é assíncrona (fila `document-render`): o pedido nunca toca o Gotenberg.
      const rendition = await auth(
        request(api.server).post(`/api/v1/document-versions/${version?.id ?? ''}/renditions`),
      ).send({ kind: 'CONTENT' });

      expect(rendition.status, JSON.stringify(rendition.body)).toBe(202);
      expect(stored(process.id).status).toBe('AWAITING_APPROVAL');
      expect(storedDocument(dfd.documentId).status).toBe('IN_REVIEW');
    });
  });
});
