import { randomUUID } from 'node:crypto';

import { isNotificationChannelEditable, NOTIFICATION_REGISTRY } from '@contrataflow/types';
import { forwardedProcessSchema, problemDetailsSchema } from '@contrataflow/validation';
import type { DocumentDto, ForwardedProcessDto, ProcessDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import {
  approvalRepositoryOf,
  buildDocumentType,
  buildTemplateVersion,
  createDocumentAs,
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
  deactivateWorkflow,
  setDepartmentHead,
} from '../../../../test/support/process-forward-fixtures.js';
import { seedPanelDocument } from '../../../../test/support/process-panel-fixtures.js';
import {
  assignDepartment,
  assignRole,
  seedDefaultRolesOf,
  seedDepartment,
} from '../../../../test/support/structure-fixtures.js';
import { seedPublishedInMemory } from '../../../../test/support/workflow-engine-fixtures.js';
import { DefinitionBuilder } from '../../../../test/support/workflow-fixtures.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { PROCESS_CLOCK, PROCESS_TRANSACTIONS } from '../application/ports.js';
import type { ProcessTransactions } from '../application/ports.js';
import type { Process } from '../domain/process.js';

/*
 * US-051 — solicitar aprovação e resolver o aprovador, pelos dois disparos e pelo pipeline HTTP
 * completo (identidade fake, seeders reais, repositórios em memória): o encaminhamento (PRC-19) a
 * uma etapa `APPROVAL` e a submissão avulsa (DOC-09) de um tipo com aprovação — as 8 categorias do
 * Gherkin. Background: o processo "0012/2026" em ESTUDOS_PRELIMINARES, unidade solicitante
 * "Secretaria de Obras", e a próxima etapa APROVACAO_AUTORIDADE (APPROVAL) com aprovador
 * DEPARTMENT_HEAD da secretaria solicitante (ou, na variante de perfil, ROLE AUTORIDADE_COMPETENTE).
 * Ana = "Carla" (quem encaminha), Marta = "Roberto" (titular da Secretaria de Obras), Fábio =
 * substituto, Eva = "Vera" (perfil só sobre a unidade pela qual o processo tramitou) e Lúcia =
 * "Marcelo" (perfil com escopo sobre a Secretaria de Obras). O rollback real (nenhuma linha órfã),
 * o índice único sob concorrência e a RLS ficam em `test/tenant-leak/approval-request.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-05T15:00:00.000Z');
const USER_AGENT = 'Vitest/US-051';
const UNRESOLVED_MESSAGE =
  'Não há aprovador configurado para esta etapa. Fale com o administrador do órgão.';
const COMMENT = 'Seguem ETP, mapa de riscos, pesquisa de preços e TR para aprovação.';

const ORG_A = '0192d051-0000-7000-8000-0000000000a0';
const ORG_B = '0192d051-0000-7000-8000-0000000000b0';
const UNITS_A = {
  organizationId: ORG_A,
  obras: '0192d051-0000-7000-8000-0000000000a1',
  manutencao: '0192d051-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d051-0000-7000-8000-0000000000a3',
  saude: '0192d051-0000-7000-8000-0000000000a4',
  posto: '0192d051-0000-7000-8000-0000000000a5',
};
const UNITS_B = {
  organizationId: ORG_B,
  obras: '0192d051-0000-7000-8000-0000000000b1',
  manutencao: '0192d051-0000-7000-8000-0000000000b2',
  pavimentacao: '0192d051-0000-7000-8000-0000000000b3',
  saude: '0192d051-0000-7000-8000-0000000000b4',
  posto: '0192d051-0000-7000-8000-0000000000b5',
};
const PLANEJAMENTO = '0192d051-0000-7000-8000-0000000000a6';
const FLOW_VERSION = '0192d051-0000-7000-8000-0000000000f1';
const COVERED = ['ETP', 'RISK_MAP', 'PRICE_RESEARCH', 'TR'] as const;

const membershipOf = (userId: string, tenantId: string = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';
const ANA = {
  tenantId: A,
  userId: FAKE_USERS.ana.id,
  membershipId: membershipOf(FAKE_USERS.ana.id),
};

/** Transações do módulo: em fila (corridas serializadas, como o `FOR UPDATE`) e banco fora. */
class FlakyTransactions implements ProcessTransactions {
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

  snapshot<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.read(work);
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

describe('Feature: Solicitar aprovação e resolver o aprovador (US-051)', () => {
  let api: TestApi;
  let flow: DefinitionBuilder;
  let authorityRoleId: string;
  let toHead: string;
  let toRole: string;
  let log: MockInstance<Logger['log']>;
  let warn: MockInstance<Logger['warn']>;
  let error: MockInstance<Logger['error']>;
  const transactions = new FlakyTransactions();
  const words = (count: number) =>
    Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

  const auth = (call: request.Test, subject = 'sub-ana', tenant: string = A) =>
    call
      .set('Authorization', api.bearer(subject, { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', tenant)
      .set('User-Agent', USER_AGENT);
  const repository = () => processRepositoryOf(api);
  const stored = (id: string): Process => {
    const process = repository()
      .allProcesses()
      .find((candidate) => candidate.id === id);
    if (!process) throw new Error(`processo ${id} ausente`);
    return process;
  };
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
      .set('Idempotency-Key', options.key ?? randomUUID())
      .set('If-Match', `"${String(process.version)}"`)
      .send({ expectedStageId: process.currentStageId, ...body });
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
  const documentsOf = (processId: string) =>
    documentRepositoryOf(api)
      .allDocuments()
      .filter((document) => document.processId === processId);
  const approverAccess = (processId: string) =>
    repository()
      .accessOf(processId)
      .filter((row) => row.reason === 'APPROVER')
      .map((row) => row.userId)
      .sort();
  /** O que a solicitação grava (para provar que nada foi gravado numa recusa). */
  const effects = (processId: string) => ({
    process: stored(processId),
    stages: repository().stagesOf(processId).length,
    movements: repository().movementsOf(processId).length,
    approvals: approvalsOf(processId).length,
    documents: documentsOf(processId).map((document) => ({
      status: document.status,
      pendingApprovalId: document.pendingApprovalId,
      currentVersionId: document.currentVersionId,
    })),
    events: api.outboxRows().filter((row) => row.processId === processId).length,
    audit: api.auditRecords().filter((row) => row.processId === processId).length,
  });

  /** Processo criado pelo PRC-02 (Ana), levado a ESTUDOS_PRELIMINARES com Ana responsável. */
  async function processAtStudies(): Promise<Process> {
    const response = await auth(request(api.server).post('/api/v1/processes'))
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Aquisição ${words(2)}`,
        object: `Objeto da contratação ${words(3)}`,
        contractingTypeId: catalogItemId(api, A, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
        requestingSecretariatId: UNITS_A.obras,
        requestingDepartmentId: UNITS_A.manutencao,
        originId: catalogItemId(api, A, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
        pcaStatus: 'NOT_APPLICABLE',
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const created = stored(data<ProcessDto>(response).id);
    const [opening] = repository().stagesOf(created.id);
    if (!opening) throw new Error('passagem de abertura ausente');
    repository().seedStage({
      ...opening,
      workflowStageId: flow.stageId('ABERTURA'),
      status: 'COMPLETED',
      exitedAt: new Date('2026-10-01T12:00:00.000Z'),
    });
    const studies = newId();
    repository().seedStage({
      id: studies,
      tenantId: A,
      processId: created.id,
      workflowStageId: flow.stageId('ESTUDOS_PRELIMINARES'),
      sequence: 2,
      status: 'ACTIVE',
      departmentId: PLANEJAMENTO,
      assigneeId: FAKE_USERS.ana.id,
      enteredAt: new Date('2026-10-01T12:00:00.000Z'),
      dueAt: null,
      slaDays: 15,
      slaType: 'BUSINESS',
      enteredViaMovementId: null,
    });
    const process: Process = {
      ...created,
      workflowVersionId: FLOW_VERSION,
      status: 'IN_PROGRESS',
      currentStageId: studies,
      currentWorkflowStageId: flow.stageId('ESTUDOS_PRELIMINARES'),
      currentDepartmentId: PLANEJAMENTO,
      currentResponsibleId: FAKE_USERS.ana.id,
      number: 12,
      code: '0012/2026',
      openedAt: created.createdAt,
      version: 14,
    };
    repository().seed(process, [
      { principalType: 'DEPARTMENT', departmentId: PLANEJAMENTO, reason: 'CURRENT' },
    ]);
    return process;
  }

  /** ETP aprovado (FA-01) e mapa de riscos, pesquisa de preços e TR finalizados, cada um na v1. */
  async function coveredDocuments(processId: string): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    for (const [index, typeCode] of COVERED.entries()) {
      ids.set(
        typeCode,
        await seedPanelDocument(api, {
          tenantId: A,
          processId,
          typeCode,
          code: `${typeCode} 000${String(index + 1)}/2026`,
          title: `${typeCode} do processo`,
          status: typeCode === 'ETP' ? 'APPROVED' : 'FINALIZED',
          versionNumber: 1,
          createdById: FAKE_USERS.ana.id,
        }),
      );
    }
    return ids;
  }

  const transitionOf = (key: string): string => {
    const transition = flow.transitions.find((candidate) => candidate.key === key);
    if (!transition) throw new Error(`transição ${key} ausente`);
    return transition.id;
  };

  beforeAll(async () => {
    log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
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
    seedDepartment(api, {
      tenantId: A,
      organizationId: ORG_A,
      id: PLANEJAMENTO,
      name: 'Coordenadoria de Planejamento',
    });
    const rolesA = seedDefaultRolesOf(api, A);
    authorityRoleId = rolesA.get('AUTORIDADE_COMPETENTE')?.id ?? '';
    flow = new DefinitionBuilder(FLOW_VERSION)
      .stage('ABERTURA', 'START', { name: 'Formalização da demanda', assignmentPolicy: 'CREATOR' })
      .stage('ESTUDOS_PRELIMINARES', 'TASK', {
        name: 'ETP e mapa de riscos',
        departmentResolution: 'CHOSEN_ON_FORWARD',
        slaDays: 15,
      })
      .stage('APROVACAO_AUTORIDADE', 'APPROVAL', {
        name: 'Aprovação da autoridade competente',
        departmentResolution: 'REQUESTING_SECRETARIAT',
        approverType: 'DEPARTMENT_HEAD',
        approverDepartmentResolution: 'REQUESTING_SECRETARIAT',
        approvalDocumentTypeCodes: [...COVERED],
        slaDays: 5,
      })
      .stage('APROVACAO_PERFIL', 'APPROVAL', {
        name: 'Aprovação pela autoridade (perfil)',
        departmentResolution: 'REQUESTING_SECRETARIAT',
        approverType: 'ROLE',
        approverRoleId: authorityRoleId,
        approverDepartmentResolution: null,
        approvalDocumentTypeCodes: [...COVERED],
        slaDays: 5,
      })
      .stage('CONCLUSAO', 'END', { name: 'Concluído' })
      .transition('ABERTURA', 'ESTUDOS_PRELIMINARES', 'FORWARD', { isPrimary: true })
      .transition('ESTUDOS_PRELIMINARES', 'APROVACAO_AUTORIDADE', 'FORWARD', { isPrimary: true })
      .transition('ESTUDOS_PRELIMINARES', 'APROVACAO_PERFIL', 'FORWARD')
      .transition('APROVACAO_AUTORIDADE', 'CONCLUSAO', 'APPROVE')
      .transition('APROVACAO_PERFIL', 'CONCLUSAO', 'APPROVE');
    toHead = transitionOf('ESTUDOS_PRELIMINARES_FORWARD_APROVACAO_AUTORIDADE');
    toRole = transitionOf('ESTUDOS_PRELIMINARES_FORWARD_APROVACAO_PERFIL');
    await seedPublishedInMemory(api, A, flow, 'TESTE_US051');
    await deactivateWorkflow(api, A, 'TESTE_US051');
    assignDepartment(api, ANA.membershipId, UNITS_A.manutencao);
    assignDepartment(api, ANA.membershipId, PLANEJAMENTO);
    // "Vera": o perfil só sobre a Coordenadoria (por onde o processo tramita — CURRENT/HISTORICAL).
    assignRole(api, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.eva.id),
      roleId: authorityRoleId,
      scopeType: 'DEPARTMENT',
      scopeDepartmentId: PLANEJAMENTO,
    });
    // Tenant B: um detentor do perfil com escopo TENANT nunca conta para A.
    assignRole(api, {
      tenantId: B,
      membershipId: membershipOf(FAKE_USERS.heitor.id, B),
      roleId: seedDefaultRolesOf(api, B).get('AUTORIDADE_COMPETENTE')?.id ?? '',
    });
    setDepartmentHead(api, UNITS_A.obras, FAKE_USERS.marta.id, FAKE_USERS.fabio.id);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await api.close();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    transactions.down = false;
    setDepartmentHead(api, UNITS_A.obras, FAKE_USERS.marta.id, FAKE_USERS.fabio.id);
  });

  describe('[Sucesso]', () => {
    it('Encaminhar para etapa de aprovação resolve o titular da secretaria: Approval PENDING, cobertura, acessos, timeline, auditoria e evento', async () => {
      const process = await processAtStudies();
      const documents = await coveredDocuments(process.id);
      const versions = new Map(
        documentsOf(process.id).map((document) => [document.id, document.currentVersionId]),
      );
      log.mockClear();

      const response = await forward(process, { transitionId: toHead, comment: COMMENT });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const dto = forwardedProcessSchema.parse(data<ForwardedProcessDto>(response));
      expect(dto).toMatchObject({
        status: 'AWAITING_APPROVAL',
        currentStage: { key: 'APROVACAO_AUTORIDADE' },
        approval: { approverLabel: 'Marta Ribeiro (titular da Secretaria de Obras)' },
      });
      const approvalId = dto.approval?.id ?? '';
      const entered = repository()
        .stagesOf(process.id)
        .find((stage) => stage.status === 'ACTIVE');
      const [approval, ...more] = approvalsOf(process.id);
      expect(more).toEqual([]);
      expect(approval).toMatchObject({
        id: approvalId,
        status: 'PENDING',
        subjectType: 'PROCESS_STAGE',
        processStageId: entered?.id,
        documentId: null,
        approverType: 'DEPARTMENT_HEAD',
        approverUserId: FAKE_USERS.marta.id,
        approverRoleId: null,
        approverDepartmentId: UNITS_A.obras,
        allowDeputy: true,
        requestedById: FAKE_USERS.ana.id,
        requestedAt: NOW,
        requestComment: COMMENT,
        dueAt: entered?.dueAt,
      });
      expect(entered?.dueAt).not.toBeNull();
      expect(approval?.title).toMatch(/^Aprovação da autoridade competente — \w+/);

      // Uma ApprovalDocument por documento, na versão vigente; status inalterado (DEC-018/FA-01).
      expect(
        approvalRepositoryOf(api)
          .coverageOf(approvalId)
          .map((item) => [item.documentId, item.documentVersionId])
          .sort(),
      ).toEqual([...documents.values()].map((id) => [id, versions.get(id)]).sort());
      for (const document of documentsOf(process.id)) {
        expect(document.pendingApprovalId).toBe(approvalId);
        expect(document.status).toBe(
          document.id === documents.get('ETP') ? 'APPROVED' : 'FINALIZED',
        );
        expect(document.currentVersionId).toBe(versions.get(document.id));
      }

      // RN-TRAM-53: titular e substituto com APPROVER; timeline; auditoria; evento no outbox.
      expect(approverAccess(process.id)).toEqual([FAKE_USERS.marta.id, FAKE_USERS.fabio.id].sort());
      expect(timelineOf(process.id, 'APPROVAL_REQUESTED')).toEqual([
        expect.objectContaining({
          entityId: approvalId,
          params: expect.objectContaining({
            approverType: 'DEPARTMENT_HEAD',
            approverLabel: 'Secretaria de Obras',
            dueAt: entered?.dueAt?.toISOString(),
          }) as unknown,
        }),
      ]);
      const [audit] = auditOf(process.id, 'approval.request');
      expect(audit).toMatchObject({
        entityType: 'Approval',
        entityId: approvalId,
        changes: [{ path: 'status', old: null, new: 'PENDING' }],
        metadata: expect.objectContaining({
          subjectType: 'PROCESS_STAGE',
          approverType: 'DEPARTMENT_HEAD',
          approverUserId: FAKE_USERS.marta.id,
          approverDepartmentId: UNITS_A.obras,
          documentIds: expect.arrayContaining([...documents.values()]) as unknown,
        }) as unknown,
      });
      expect(eventsOf(process.id, 'ApprovalRequested')).toEqual([
        expect.objectContaining({
          routingKey: 'approval.requested',
          payload: {
            approvalId,
            subjectType: 'PROCESS_STAGE',
            processStageId: entered?.id,
            documentId: null,
            documentVersionIds: expect.arrayContaining([...versions.values()]) as unknown,
            approverType: 'DEPARTMENT_HEAD',
            approverUserId: FAKE_USERS.marta.id,
            approverRoleId: null,
            approverDepartmentId: UNITS_A.obras,
            allowDeputy: true,
            dueAt: entered?.dueAt?.toISOString(),
          },
        }),
      ]);

      // Roberto (Marta) recebe APPROVAL_REQUESTED: in-app obrigatório, não pode ser desativado.
      expect(NOTIFICATION_REGISTRY.APPROVAL_REQUESTED).toMatchObject({
        sourceEvents: ['ApprovalRequested'],
        mandatory: true,
        emailByDefault: true,
      });
      expect(isNotificationChannelEditable('APPROVAL_REQUESTED', 'IN_APP')).toBe(false);

      // Log estruturado sem o comentário do pedido (nunca logar `requestComment`).
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'approval.requested',
          approvalId,
          subjectType: 'PROCESS_STAGE',
          approverType: 'DEPARTMENT_HEAD',
          resolvedVia: 'DEPARTMENT_HEAD',
          durationMs: expect.any(Number) as unknown,
        }),
        'approval.requested',
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain(COMMENT);
    });

    it('FA-02: etapa sem documento coberto cria a aprovação sem ApprovalDocument e registra aviso', async () => {
      const process = await processAtStudies();
      warn.mockClear();
      const response = await forward(process, { transitionId: toHead });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const [approval] = approvalsOf(process.id);
      expect(approval).toMatchObject({
        status: 'PENDING',
        title: 'Aprovação da autoridade competente',
        requestComment: null,
      });
      expect(approvalRepositoryOf(api).coverageOf(approval?.id ?? '')).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'approval.no_covered_documents' }),
        'approval.no_covered_documents',
      );
    });

    it('Disparo B — submissão avulsa (DOC-09): titular resolvido com substituto, sem prazo, evento e acessos', async () => {
      const process = await processAtStudies();
      const type = buildDocumentType({
        tenantId: A,
        code: `DESPACHO_${words(1).toUpperCase()}`,
        name: 'Despacho de autorização',
        requiresApproval: true,
        // RN-TRAM-48: allowDeputy = true sempre para DEPARTMENT_HEAD, mesmo com a política em false.
        approvalPolicy: {
          approverType: 'DEPARTMENT_HEAD',
          approverDepartmentResolution: 'REQUESTING_SECRETARIAT',
          allowDeputy: false,
        },
      });
      documentTypeRepositoryOf(api).seed(type);
      const document = await createDocumentAs(api, ANA, {
        processId: process.id,
        documentTypeId: type.id,
        title: 'Despacho nº 7',
        templateVersionId: null,
      });

      const response = await auth(
        request(api.server).post(`/api/v1/documents/${document.id}/submit`),
      )
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', '"1"')
        .send({});

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const submitted = data<DocumentDto>(response);
      expect(submitted).toMatchObject({ status: 'IN_REVIEW' });
      const approvalId = submitted.pendingApprovalId ?? '';
      expect(approvalsOf(process.id)).toEqual([
        expect.objectContaining({
          id: approvalId,
          subjectType: 'DOCUMENT',
          processStageId: null,
          documentId: document.id,
          title: 'Aprovação avulsa — Despacho de autorização "Despacho nº 7"',
          approverType: 'DEPARTMENT_HEAD',
          approverUserId: FAKE_USERS.marta.id,
          approverDepartmentId: UNITS_A.obras,
          allowDeputy: true,
          requestComment: null,
          dueAt: null,
        }),
      ]);
      expect(approvalRepositoryOf(api).coverageOf(approvalId)).toEqual([
        expect.objectContaining({
          documentId: document.id,
          documentVersionId: submitted.currentVersionId,
        }),
      ]);
      expect(eventsOf(process.id, 'ApprovalRequested')).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            approvalId,
            subjectType: 'DOCUMENT',
            documentId: document.id,
            documentVersionIds: [submitted.currentVersionId],
            dueAt: null,
          }) as unknown,
        }),
      ]);
      expect(approverAccess(process.id)).toEqual([FAKE_USERS.marta.id, FAKE_USERS.fabio.id].sort());
      expect(timelineOf(process.id, 'APPROVAL_REQUESTED')).toHaveLength(1);
      expect(auditOf(process.id, 'approval.request')).toEqual([
        expect.objectContaining({
          metadata: expect.objectContaining({
            subjectType: 'DOCUMENT',
            documentIds: [document.id],
          }) as unknown,
        }),
      ]);
    });
  });

  describe('[Validação]', () => {
    it('Documento coberto incompleto bloqueia a aprovação: 422 DOCUMENT_INCOMPLETE com as violações do TR, nenhuma Approval', async () => {
      const process = await processAtStudies();
      // TR em DRAFT com a seção obrigatória do template vazia (pendência BLOCKING — mesmas regras
      // do DOC-08).
      const template = buildTemplateVersion({
        tenantId: A,
        sections: [sectionDefinition('OBJETO', { title: 'Objeto da contratação' })],
      });
      seedTemplateVersions(api, template);
      const trId = await seedPanelDocument(api, {
        tenantId: A,
        processId: process.id,
        typeCode: 'TR',
        code: null,
        title: 'TR sem itens',
        status: 'DRAFT',
        createdById: FAKE_USERS.ana.id,
      });
      const tr = documentsOf(process.id).find((document) => document.id === trId);
      if (!tr) throw new Error('TR ausente');
      documentRepositoryOf(api).seed({ ...tr, templateVersionId: template.id });
      const before = effects(process.id);

      const body = expectProblem(
        await forward(process, { transitionId: toHead }),
        422,
        'DOCUMENT_INCOMPLETE',
      );

      expect(body.violations).toEqual(
        expect.arrayContaining([expect.objectContaining({ severity: 'BLOCKING' })]),
      );
      expect(approvalsOf(process.id)).toEqual([]);
      expect(stored(process.id).currentStageId).toBe(process.currentStageId);
      expect(effects(process.id)).toEqual(before);
      expect(documentRepositoryOf(api).versionsOf(trId)).toEqual([]);
    });
  });

  describe('[Permissão]', () => {
    it('Resolução de ROLE ignora concessões apenas de visibilidade: só quem tem escopo sobre a unidade solicitante conta', async () => {
      // Vera (Eva) tem o perfil só sobre a Coordenadoria — a unidade pela qual o processo tramita.
      const first = await processAtStudies();
      warn.mockClear();
      const before = effects(first.id);
      const refused = expectProblem(
        await forward(first, { transitionId: toRole }),
        422,
        'APPROVER_UNRESOLVED',
      );
      expect(refused.detail).toBe(UNRESOLVED_MESSAGE);
      expect(effects(first.id)).toEqual(before);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'approval.role_scope_empty',
          approverRoleId: authorityRoleId,
        }),
        'approval.role_scope_empty',
      );

      // Marcelo (Lúcia) recebe o perfil com escopo DEPARTMENT na Secretaria de Obras (solicitante).
      assignRole(api, {
        tenantId: A,
        membershipId: membershipOf(FAKE_USERS.lucia.id),
        roleId: authorityRoleId,
        scopeType: 'DEPARTMENT',
        scopeDepartmentId: UNITS_A.obras,
        includeSubtree: false,
      });
      const process = await processAtStudies();
      await coveredDocuments(process.id);
      const response = await forward(process, { transitionId: toRole });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(
        forwardedProcessSchema.parse(data<ForwardedProcessDto>(response)).approval,
      ).toMatchObject({ approverLabel: 'Autoridade competente' });
      expect(approvalsOf(process.id)).toEqual([
        expect.objectContaining({
          status: 'PENDING',
          approverType: 'ROLE',
          approverRoleId: authorityRoleId,
          approverUserId: null,
          approverDepartmentId: null,
          allowDeputy: false,
        }),
      ]);
      expect(timelineOf(process.id, 'APPROVAL_REQUESTED')).toEqual([
        expect.objectContaining({
          params: expect.objectContaining({
            approverType: 'ROLE',
            approverLabel: 'Autoridade competente',
          }) as unknown,
        }),
      ]);
      // ROLE não materializa pessoa: nenhuma concessão APPROVER; a unidade decide pelo CURRENT.
      expect(approverAccess(process.id)).toEqual([]);
      expect(
        repository()
          .accessOf(process.id)
          .some((row) => row.reason === 'CURRENT' && row.departmentId === UNITS_A.obras),
      ).toBe(true);
      // Competência (a mesma que a decisão — US-052 — vai consultar): só Marcelo, nunca Vera.
      const holders = await runWithRequestContext(
        { correlationId: newId(), ip: '127.0.0.1', userAgent: 'vitest' },
        () => {
          updateRequestContext({ tenantId: A });
          return runSimulatedTransaction((tx) =>
            api.app.get(AccessFacade, { strict: false }).roleHoldersInScopeIn(
              tx,
              authorityRoleId,
              {
                organizationId: ORG_A,
                departmentIds: [UNITS_A.obras, UNITS_A.manutencao],
              },
              NOW,
            ),
          );
        },
      );
      expect(holders).toEqual([FAKE_USERS.lucia.id]);
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Unidade aprovadora sempre do tenant do processo: titular sem vínculo ativo no tenant não é resolvido', async () => {
      // Erro de configuração: o "titular" da Secretaria de Obras é um usuário só do tenant B.
      setDepartmentHead(api, UNITS_A.obras, FAKE_USERS.heitor.id, null);
      const process = await processAtStudies();
      await coveredDocuments(process.id);
      const before = effects(process.id);
      expectProblem(await forward(process, { transitionId: toHead }), 422, 'APPROVER_UNRESOLVED');
      expect(effects(process.id)).toEqual(before);
      // Vínculo vencido também não resolve (Carla: consultora com validade expirada).
      setDepartmentHead(api, UNITS_A.obras, FAKE_USERS.carla.id, null);
      expectProblem(await forward(process, { transitionId: toHead }), 422, 'APPROVER_UNRESOLVED');
      expect(effects(process.id)).toEqual(before);
    });

    it('Processo de A pelo tenant B: 404, sem criar aprovação', async () => {
      const process = await processAtStudies();
      const before = effects(process.id);
      expectProblem(
        await forward(process, { transitionId: toHead }, { subject: 'sub-heitor', tenant: B }),
        404,
        'PROCESS_NOT_FOUND',
      );
      expect(effects(process.id)).toEqual(before);
    });
  });

  describe('[Duplicidade]', () => {
    it('Reenvio do encaminhamento com a mesma chave K7: mesma resposta, Idempotent-Replayed e uma única Approval PENDING', async () => {
      const process = await processAtStudies();
      await coveredDocuments(process.id);
      const key = randomUUID(); // "K7"
      const first = await forward(process, { transitionId: toHead }, { key });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      const replay = await forward(process, { transitionId: toHead }, { key });
      expect(replay.status).toBe(200);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toEqual(first.body);
      expect(approvalsOf(process.id).filter((row) => row.status === 'PENDING')).toHaveLength(1);
      expect(eventsOf(process.id, 'ApprovalRequested')).toHaveLength(1);
    });
  });

  describe('[Concorrência]', () => {
    it('Duas tentativas de gerar aprovação para a mesma etapa: uma Approval PENDING, a outra falha com conflito e sem notificação duplicada', async () => {
      const process = await processAtStudies();
      await coveredDocuments(process.id);
      const [one, two] = await Promise.all([
        forward(process, { transitionId: toHead }),
        forward(process, { transitionId: toHead }),
      ]);
      expect([one.status, two.status].sort()).toEqual([200, 409]);
      expect(approvalsOf(process.id).filter((row) => row.status === 'PENDING')).toHaveLength(1);
      expect(eventsOf(process.id, 'ApprovalRequested')).toHaveLength(1);

      // O índice de pendência única por etapa (RN-TRAM-43) recusa uma segunda aprovação.
      const [approval] = approvalsOf(process.id);
      if (!approval) throw new Error('aprovação ausente');
      await expect(
        runSimulatedTransaction((tx) =>
          approvalRepositoryOf(api).insert(tx, { ...approval, id: newId() }, []),
        ),
      ).rejects.toThrow('Já existe uma aprovação pendente');
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível durante a transação de encaminhamento: 503 DEPENDENCY_UNAVAILABLE e nada persistido', async () => {
      const process = await processAtStudies();
      await coveredDocuments(process.id);
      const before = effects(process.id);
      transactions.down = true;
      expectProblem(
        await forward(process, { transitionId: toHead }),
        503,
        'DEPENDENCY_UNAVAILABLE',
      );
      transactions.down = false;
      expect(effects(process.id)).toEqual(before);
    });
  });

  describe('[Falha de integração]', () => {
    it('Nenhum aprovador resolvido desfaz o encaminhamento: 422 APPROVER_UNRESOLVED, processo na etapa e documentos intactos', async () => {
      setDepartmentHead(api, UNITS_A.obras, null, null);
      const process = await processAtStudies();
      await coveredDocuments(process.id);
      const before = effects(process.id);
      error.mockClear();

      const body = expectProblem(
        await forward(process, { transitionId: toHead }),
        422,
        'APPROVER_UNRESOLVED',
      );

      expect(body.detail).toBe(UNRESOLVED_MESSAGE);
      expect(stored(process.id).currentStageId).toBe(process.currentStageId);
      expect(effects(process.id)).toEqual(before);
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'approval.request_failed',
          errorCode: 'APPROVER_UNRESOLVED',
          cause: 'NO_HEAD',
          subjectType: 'PROCESS_STAGE',
        }),
        'approval.request_failed',
      );
    });

    it('Submissão avulsa sem aprovador resolvido: 422 APPROVER_UNRESOLVED, sem Approval nem evento', async () => {
      setDepartmentHead(api, UNITS_A.obras, null, null);
      const process = await processAtStudies();
      const type = buildDocumentType({
        tenantId: A,
        code: `DESPACHO_${words(1).toUpperCase()}`,
        name: 'Despacho de autorização',
        requiresApproval: true,
        approvalPolicy: {
          approverType: 'DEPARTMENT_HEAD',
          approverDepartmentResolution: 'REQUESTING_SECRETARIAT',
          allowDeputy: true,
        },
      });
      documentTypeRepositoryOf(api).seed(type);
      const document = await createDocumentAs(api, ANA, {
        processId: process.id,
        documentTypeId: type.id,
        title: 'Despacho nº 8',
        templateVersionId: null,
      });
      const body = expectProblem(
        await auth(request(api.server).post(`/api/v1/documents/${document.id}/submit`))
          .set('Idempotency-Key', randomUUID())
          .set('If-Match', '"1"')
          .send({}),
        422,
        'APPROVER_UNRESOLVED',
      );
      expect(body.detail).toBe(
        'Não há aprovador configurado para este tipo de documento. Fale com o administrador do órgão.',
      );
      expect(approvalsOf(process.id)).toEqual([]);
      expect(eventsOf(process.id, 'ApprovalRequested')).toEqual([]);
    });
  });
});
