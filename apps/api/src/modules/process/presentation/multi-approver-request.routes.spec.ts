import { randomUUID } from 'node:crypto';

import {
  approvalSchema,
  forwardedProcessSchema,
  problemDetailsSchema,
} from '@contrataflow/validation';
import type {
  ApprovalDecisionPolicy,
  ApprovalDto,
  ForwardedProcessDto,
  ProcessDto,
} from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

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
import { PROCESS_CLOCK, PROCESS_TRANSACTIONS } from '../application/ports.js';
import type { ProcessTransactions } from '../application/ports.js';
import type { Process } from '../domain/process.js';

/*
 * US-133 — solicitar aprovação com múltiplos aprovadores, pelo pipeline HTTP completo (identidade
 * fake, seeders reais, repositórios em memória): o encaminhamento (PRC-19) a etapas `APPROVAL` com
 * política `SEQUENTIAL`, `ALL` e `ANY` (MVP 1) e a submissão avulsa (DOC-09) com lista no tipo — as
 * 8 categorias do Gherkin. Background: o processo "0012/2026" em CONTROLE_INTERNO com Ana
 * responsável. Personagens: Roberto = Marta (titular da Secretaria de Administração e da de Obras),
 * Helena = Fábio (substituto das duas), Marcos = Lúcia (usuário aprovador), "Bruno" = Otávio (só
 * SOMENTE_LEITURA, sem PROCESS_FORWARD). A memória não tem rollback: as recusas que acontecem
 * depois das escritas do encaminhamento (`SELF_APPROVAL_FORBIDDEN`, `APPROVER_DUPLICATED`) provam
 * aqui só a resposta e a ausência de aprovação/linhas; o rollback real, a RLS, o índice único das
 * linhas e o backfill ficam em `test/tenant-leak/approval-approvers.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-11-11T15:00:00.000Z');
const USER_AGENT = 'Vitest/US-133';

const ORG_A = '0192d133-0000-7000-8000-0000000000a0';
const ORG_B = '0192d133-0000-7000-8000-0000000000b0';
const UNITS_A = {
  organizationId: ORG_A,
  obras: '0192d133-0000-7000-8000-0000000000a1',
  manutencao: '0192d133-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d133-0000-7000-8000-0000000000a3',
  saude: '0192d133-0000-7000-8000-0000000000a4',
  posto: '0192d133-0000-7000-8000-0000000000a5',
};
const UNITS_B = {
  organizationId: ORG_B,
  obras: '0192d133-0000-7000-8000-0000000000b1',
  manutencao: '0192d133-0000-7000-8000-0000000000b2',
  pavimentacao: '0192d133-0000-7000-8000-0000000000b3',
  saude: '0192d133-0000-7000-8000-0000000000b4',
  posto: '0192d133-0000-7000-8000-0000000000b5',
};
const ADMINISTRACAO = '0192d133-0000-7000-8000-0000000000a6';
const GABINETE = '0192d133-0000-7000-8000-0000000000a7';
const CONTROLE = '0192d133-0000-7000-8000-0000000000a8';
const FLOW_VERSION = '0192d133-0000-7000-8000-0000000000f1';

const ROBERTO = FAKE_USERS.marta;
const HELENA = FAKE_USERS.fabio;
const MARCOS = FAKE_USERS.lucia;

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

/** Linha `WorkflowStageApprover` como o construtor de definições a guarda (US-132). */
type StageApproverLine = NonNullable<DefinitionBuilder['stages'][number]['approvers']>[number];

type LineSpec =
  | { readonly type: 'USER'; readonly userId: string }
  | { readonly type: 'HEAD'; readonly departmentId: string };

describe('Feature: Solicitar aprovação com múltiplos aprovadores (US-133)', () => {
  let api: TestApi;
  let flow: DefinitionBuilder;
  let log: MockInstance<Logger['log']>;
  let warn: MockInstance<Logger['warn']>;
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
    stageKey: string,
    options: { subject?: string; tenant?: string; key?: string } = {},
  ) =>
    auth(
      request(api.server).post(`/api/v1/processes/${process.id}/forward`),
      options.subject,
      options.tenant,
    )
      .set('Idempotency-Key', options.key ?? randomUUID())
      .set('If-Match', `"${String(process.version)}"`)
      .send({ expectedStageId: process.currentStageId, transitionId: transitionTo(stageKey) });
  const approvalsOf = (processId: string) =>
    approvalRepositoryOf(api)
      .approvals()
      .filter((approval) => approval.processId === processId);
  const linesOf = (approvalId: string) => approvalRepositoryOf(api).linesOf(approvalId);
  const eventsOf = (processId: string, eventType: string) =>
    api.outboxRows().filter((row) => row.processId === processId && row.eventType === eventType);
  const auditOf = (processId: string, action: string) =>
    api.auditRecords().filter((row) => row.processId === processId && row.action === action);
  const approverAccess = (processId: string) =>
    repository()
      .accessOf(processId)
      .filter((row) => row.reason === 'APPROVER')
      .map((row) => row.userId)
      .sort();
  const documentsOf = (processId: string) =>
    documentRepositoryOf(api)
      .allDocuments()
      .filter((document) => document.processId === processId);
  /** O que a solicitação grava (para provar que nada foi gravado numa recusa). */
  const effects = (processId: string) => ({
    process: stored(processId),
    stages: repository().stagesOf(processId).length,
    movements: repository().movementsOf(processId).length,
    approvals: approvalsOf(processId).length,
    lines: approvalsOf(processId).flatMap((approval) => linesOf(approval.id)).length,
    documents: documentsOf(processId).map((document) => ({
      status: document.status,
      pendingApprovalId: document.pendingApprovalId,
      currentVersionId: document.currentVersionId,
    })),
    access: approverAccess(processId),
    events: api.outboxRows().filter((row) => row.processId === processId).length,
    audit: api.auditRecords().filter((row) => row.processId === processId).length,
  });

  const transitionTo = (stageKey: string): string => {
    const transition = flow.transitions.find(
      (candidate) => candidate.key === `CONTROLE_INTERNO_FORWARD_${stageKey}`,
    );
    if (!transition) throw new Error(`transição para ${stageKey} ausente`);
    return transition.id;
  };

  /** Etapa `APPROVAL` com política e linhas (US-132), gravadas como o WF-65 grava. */
  function withApprovers(key: string, policy: ApprovalDecisionPolicy, lines: readonly LineSpec[]) {
    const index = flow.stages.findIndex((stage) => stage.key === key);
    const stage = flow.stages[index];
    if (!stage) throw new Error(`etapa ${key} ausente`);
    const approvers: StageApproverLine[] = lines.map((line, position) => ({
      id: newId(),
      tenantId: A,
      workflowVersionId: FLOW_VERSION,
      workflowStageId: stage.id,
      sequence: position + 1,
      approverType: line.type === 'USER' ? 'USER' : 'DEPARTMENT_HEAD',
      approverUserId: line.type === 'USER' ? line.userId : null,
      approverRoleId: null,
      approverDepartmentResolution: line.type === 'HEAD' ? 'FIXED' : null,
      approverFixedDepartmentId: line.type === 'HEAD' ? line.departmentId : null,
      allowDeputy: true,
      label: null,
      applicabilityRule: null,
      createdAt: NOW,
      updatedAt: NOW,
      createdById: null,
      updatedById: null,
      version: 1,
    }));
    flow.stages[index] = { ...stage, decisionPolicy: policy, approvers };
  }

  /** Processo criado pelo PRC-02 (Ana), levado a CONTROLE_INTERNO com Ana responsável. */
  async function processAtControl(): Promise<Process> {
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
      exitedAt: new Date('2026-11-01T12:00:00.000Z'),
    });
    const control = newId();
    repository().seedStage({
      id: control,
      tenantId: A,
      processId: created.id,
      workflowStageId: flow.stageId('CONTROLE_INTERNO'),
      sequence: 2,
      status: 'ACTIVE',
      departmentId: CONTROLE,
      assigneeId: FAKE_USERS.ana.id,
      enteredAt: new Date('2026-11-01T12:00:00.000Z'),
      dueAt: null,
      slaDays: 10,
      slaType: 'BUSINESS',
      enteredViaMovementId: null,
    });
    const process: Process = {
      ...created,
      workflowVersionId: FLOW_VERSION,
      status: 'IN_PROGRESS',
      currentStageId: control,
      currentWorkflowStageId: flow.stageId('CONTROLE_INTERNO'),
      currentDepartmentId: CONTROLE,
      currentResponsibleId: FAKE_USERS.ana.id,
      number: 12,
      code: '0012/2026',
      openedAt: created.createdAt,
      version: 9,
    };
    repository().seed(process, [
      { principalType: 'DEPARTMENT', departmentId: CONTROLE, reason: 'CURRENT' },
    ]);
    return process;
  }

  /** O "EDITAL" coberto (tipo TR finalizado na v1), criado por `authorId`. */
  async function coveredEdital(processId: string, authorId: string = FAKE_USERS.ana.id) {
    return seedPanelDocument(api, {
      tenantId: A,
      processId,
      typeCode: 'TR',
      code: 'ED 0003/2026',
      title: 'Edital do pregão',
      status: 'FINALIZED',
      versionNumber: 1,
      createdById: authorId,
    });
  }

  beforeAll(async () => {
    log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
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
    for (const [id, name] of [
      [ADMINISTRACAO, 'Secretaria de Administração'],
      [GABINETE, 'Gabinete do Prefeito'],
      [CONTROLE, 'Controladoria Interna'],
    ] as const) {
      seedDepartment(api, { tenantId: A, organizationId: ORG_A, id, name });
    }
    const approvalStage = (name: string) => ({
      name,
      departmentResolution: 'REQUESTING_SECRETARIAT' as const,
      approverType: 'DEPARTMENT_HEAD' as const,
      approverDepartmentResolution: 'REQUESTING_SECRETARIAT' as const,
      approvalDocumentTypeCodes: ['TR'],
      slaDays: 5,
    });
    flow = new DefinitionBuilder(FLOW_VERSION)
      .stage('ABERTURA', 'START', { name: 'Formalização da demanda', assignmentPolicy: 'CREATOR' })
      .stage('CONTROLE_INTERNO', 'TASK', {
        name: 'Manifestação do controle interno',
        departmentResolution: 'CHOSEN_ON_FORWARD',
        slaDays: 10,
      })
      .stage('AUT_SEQUENCIAL', 'APPROVAL', approvalStage('Autorização da licitação'))
      .stage('AUT_TODOS', 'APPROVAL', approvalStage('Autorização conjunta'))
      .stage('AUT_TITULAR', 'APPROVAL', approvalStage('Autorização com o titular'))
      .stage('AUT_MVP1', 'APPROVAL', approvalStage('Aprovação da autoridade competente'))
      .stage('AUT_SEM_TITULAR', 'APPROVAL', approvalStage('Autorização sem titular'))
      .stage('AUT_REPETIDA', 'APPROVAL', approvalStage('Autorização repetida'))
      .stage('FIM', 'END', { name: 'Concluído' })
      .transition('ABERTURA', 'CONTROLE_INTERNO', 'FORWARD', { isPrimary: true });
    for (const key of [
      'AUT_SEQUENCIAL',
      'AUT_TODOS',
      'AUT_TITULAR',
      'AUT_MVP1',
      'AUT_SEM_TITULAR',
      'AUT_REPETIDA',
    ]) {
      flow.transition('CONTROLE_INTERNO', key, 'FORWARD').transition(key, 'FIM', 'APPROVE');
    }
    withApprovers('AUT_SEQUENCIAL', 'SEQUENTIAL', [
      { type: 'HEAD', departmentId: ADMINISTRACAO },
      { type: 'USER', userId: MARCOS.id },
    ]);
    withApprovers('AUT_TODOS', 'ALL', [
      { type: 'USER', userId: ROBERTO.id },
      { type: 'USER', userId: MARCOS.id },
    ]);
    withApprovers('AUT_TITULAR', 'ALL', [
      { type: 'HEAD', departmentId: ADMINISTRACAO },
      { type: 'USER', userId: MARCOS.id },
    ]);
    withApprovers('AUT_SEM_TITULAR', 'ALL', [
      { type: 'USER', userId: MARCOS.id },
      { type: 'HEAD', departmentId: GABINETE },
    ]);
    withApprovers('AUT_REPETIDA', 'ALL', [
      { type: 'HEAD', departmentId: ADMINISTRACAO },
      { type: 'HEAD', departmentId: UNITS_A.obras },
    ]);
    await seedPublishedInMemory(api, A, flow, 'TESTE_US133');
    await deactivateWorkflow(api, A, 'TESTE_US133');
    assignDepartment(api, ANA.membershipId, UNITS_A.manutencao);
    assignDepartment(api, ANA.membershipId, CONTROLE);
    // "Bruno": Otávio só com SOMENTE_LEITURA (sem PROCESS_FORWARD em nenhum escopo).
    assignRole(api, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.otavio.id),
      roleId: seedDefaultRolesOf(api, A).get('SOMENTE_LEITURA')?.id ?? '',
    });
    setDepartmentHead(api, ADMINISTRACAO, ROBERTO.id, HELENA.id);
    setDepartmentHead(api, UNITS_A.obras, ROBERTO.id, HELENA.id);
    setDepartmentHead(api, GABINETE, null, null);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await api.close();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    transactions.down = false;
    setDepartmentHead(api, ADMINISTRACAO, ROBERTO.id, HELENA.id);
  });

  describe('[Sucesso]', () => {
    it('Aprovação em sequência abre só a primeira linha: estados, acesso APPROVER de todos, auditoria, evento e APV-02', async () => {
      const process = await processAtControl();
      await coveredEdital(process.id);
      log.mockClear();

      const response = await forward(process, 'AUT_SEQUENCIAL');

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const dto = forwardedProcessSchema.parse(data<ForwardedProcessDto>(response));
      expect(dto.status).toBe('AWAITING_APPROVAL');
      expect(dto.approval).toMatchObject({
        decisionPolicy: 'SEQUENTIAL',
        approverLabel: 'Marta Ribeiro (titular da Secretaria de Administração), depois Lúcia Matos',
        approvers: [
          { sequence: 1, status: 'PENDING', approverType: 'DEPARTMENT_HEAD' },
          { sequence: 2, status: 'WAITING', approverType: 'USER', label: 'Lúcia Matos' },
        ],
      });
      const approvalId = dto.approval?.id ?? '';
      const [approval, ...more] = approvalsOf(process.id);
      expect(more).toEqual([]);
      expect(approval).toMatchObject({
        id: approvalId,
        status: 'PENDING',
        decisionPolicy: 'SEQUENTIAL',
        // RN-APV-24: espelho da linha corrente (a 1).
        approverType: 'DEPARTMENT_HEAD',
        approverUserId: ROBERTO.id,
        approverDepartmentId: ADMINISTRACAO,
        allowDeputy: true,
      });
      const lines = linesOf(approvalId);
      expect(lines).toEqual([
        expect.objectContaining({
          sequence: 1,
          status: 'PENDING',
          approverUserId: ROBERTO.id,
          activatedAt: NOW,
        }),
        expect.objectContaining({
          sequence: 2,
          status: 'WAITING',
          approverUserId: MARCOS.id,
          activatedAt: null,
        }),
      ]);
      // RN-APV-25: titular, substituto e o aprovador da linha WAITING com APPROVER.
      expect(approverAccess(process.id)).toEqual([ROBERTO.id, HELENA.id, MARCOS.id].sort());
      expect(
        repository()
          .accessOf(process.id)
          .filter((row) => row.reason === 'APPROVER')
          .map((row) => row.sourceId)
          .sort(),
      ).toEqual([lines[0]?.id, lines[0]?.id, lines[1]?.id].sort());
      expect(auditOf(process.id, 'approval.request')).toEqual([
        expect.objectContaining({
          metadata: expect.objectContaining({
            decisionPolicy: 'SEQUENTIAL',
            approversCount: 2,
            lines: [
              { sequence: 1, approverType: 'DEPARTMENT_HEAD', status: 'PENDING' },
              { sequence: 2, approverType: 'USER', status: 'WAITING' },
            ],
          }) as unknown,
        }),
      ]);
      const events = eventsOf(process.id, 'ApprovalRequested');
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toMatchObject({
        decisionPolicy: 'SEQUENTIAL',
        approvers: [
          { approvalApproverId: lines[0]?.id, sequence: 1, status: 'PENDING' },
          { approvalApproverId: lines[1]?.id, sequence: 2, status: 'WAITING' },
        ],
      });
      expect(JSON.stringify(events)).not.toContain('Lúcia');
      // RN-APV-28: "A, depois B" na timeline.
      expect(
        timelineRowsOf(api).filter(
          (row) => row.processId === process.id && row.type === 'APPROVAL_REQUESTED',
        ),
      ).toEqual([
        expect.objectContaining({
          params: expect.objectContaining({
            approverLabel: 'Secretaria de Administração, depois Lúcia Matos',
            decisionPolicy: 'SEQUENTIAL',
          }) as unknown,
        }),
      ]);
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'approval.requested',
          decisionPolicy: 'SEQUENTIAL',
          linesCount: 2,
        }),
        'approval.requested',
      );

      // APV-02 (aditivo): política e linhas com rótulo e estado.
      const detail = await auth(request(api.server).get(`/api/v1/approvals/${approvalId}`));
      expect(detail.status, JSON.stringify(detail.body)).toBe(200);
      const body = approvalSchema.parse(data<ApprovalDto>(detail));
      expect(body.decisionPolicy).toBe('SEQUENTIAL');
      expect(body.approvers).toEqual([
        expect.objectContaining({
          id: lines[0]?.id,
          sequence: 1,
          status: 'PENDING',
          label: 'Marta Ribeiro (titular da Secretaria de Administração)',
          activatedAt: NOW.toISOString(),
          dueAt: null,
        }),
        expect.objectContaining({
          id: lines[1]?.id,
          sequence: 2,
          status: 'WAITING',
          activatedAt: null,
        }),
      ]);
    });

    it('Aprovação ALL abre todas as linhas com activatedAt = requestedAt', async () => {
      const process = await processAtControl();
      await coveredEdital(process.id);
      const response = await forward(process, 'AUT_TODOS');
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const dto = data<ForwardedProcessDto>(response);
      expect(dto.approval?.approverLabel).toBe('Marta Ribeiro e Lúcia Matos');
      const lines = linesOf(dto.approval?.id ?? '');
      expect(lines.map((line) => [line.status, line.activatedAt, line.approverUserId])).toEqual([
        ['PENDING', NOW, ROBERTO.id],
        ['PENDING', NOW, MARCOS.id],
      ]);
      expect(eventsOf(process.id, 'ApprovalRequested')[0]?.payload).toMatchObject({
        decisionPolicy: 'ALL',
        approvers: [{ status: 'PENDING' }, { status: 'PENDING' }],
      });
    });

    it('ANY com aprovador único comporta-se como no MVP 1: uma linha sequence 1 PENDING e a resposta do MVP 1 com os campos aditivos', async () => {
      const process = await processAtControl();
      await coveredEdital(process.id);
      const response = await forward(process, 'AUT_MVP1');
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const dto = forwardedProcessSchema.parse(data<ForwardedProcessDto>(response));
      expect(dto.approval).toMatchObject({
        approverLabel: 'Marta Ribeiro (titular da Secretaria de Obras)',
        decisionPolicy: 'ANY',
        approvers: [{ sequence: 1, status: 'PENDING', approverType: 'DEPARTMENT_HEAD' }],
      });
      expect(linesOf(dto.approval?.id ?? '')).toEqual([
        expect.objectContaining({ sequence: 1, status: 'PENDING', allowDeputy: true }),
      ]);
      expect(approvalsOf(process.id)[0]).toMatchObject({ decisionPolicy: 'ANY' });
    });

    it('Titular autor do documento tem a linha desviada para o substituto (allowDeputy falso) e selfApprovalAvoided na auditoria', async () => {
      const process = await processAtControl();
      await coveredEdital(process.id, ROBERTO.id);
      const response = await forward(process, 'AUT_TITULAR');
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const dto = data<ForwardedProcessDto>(response);
      const [line1] = linesOf(dto.approval?.id ?? '');
      expect(line1).toMatchObject({
        approverType: 'DEPARTMENT_HEAD',
        approverUserId: HELENA.id,
        approverDepartmentId: ADMINISTRACAO,
        allowDeputy: false,
      });
      expect(dto.approval?.approvers[0]?.label).toMatch(
        /^\S.* \(em substituição ao titular da Secretaria de Administração\)$/u,
      );
      expect(dto.approval?.approvers[0]?.label).not.toContain('Marta');
      // Roberto (autor) não ganha APPROVER por esta aprovação; Helena e Marcos sim.
      expect(approverAccess(process.id)).toEqual([HELENA.id, MARCOS.id].sort());
      expect(auditOf(process.id, 'approval.request')[0]?.metadata).toMatchObject({
        lines: [
          { sequence: 1, selfApprovalAvoided: true },
          { sequence: 2, approverType: 'USER', status: 'PENDING' },
        ],
      });
    });

    it('Submissão avulsa (FA-06): a approvalPolicy com lista abre as linhas pela política do tipo, sem prazo', async () => {
      const process = await processAtControl();
      const type = buildDocumentType({
        tenantId: A,
        code: `DESPACHO_${words(1).toUpperCase()}`,
        name: 'Despacho de autorização',
        requiresApproval: true,
        approvalPolicy: {
          decisionPolicy: 'SEQUENTIAL',
          approvers: [
            {
              approverType: 'DEPARTMENT_HEAD',
              approverDepartmentResolution: 'REQUESTING_SECRETARIAT',
              allowDeputy: true,
            },
            { approverType: 'USER', approverUserId: MARCOS.id, allowDeputy: true },
          ],
          approverType: 'DEPARTMENT_HEAD',
          approverDepartmentResolution: 'REQUESTING_SECRETARIAT',
          allowDeputy: true,
        },
      });
      documentTypeRepositoryOf(api).seed(type);
      const document = await createDocumentAs(api, ANA, {
        processId: process.id,
        documentTypeId: type.id,
        title: 'Despacho nº 9',
        templateVersionId: null,
      });
      const response = await auth(
        request(api.server).post(`/api/v1/documents/${document.id}/submit`),
      )
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', '"1"')
        .send({});
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const [approval] = approvalsOf(process.id);
      expect(approval).toMatchObject({
        subjectType: 'DOCUMENT',
        decisionPolicy: 'SEQUENTIAL',
        dueAt: null,
        approverUserId: ROBERTO.id,
      });
      expect(linesOf(approval?.id ?? '').map((line) => [line.status, line.approverUserId])).toEqual(
        [
          ['PENDING', ROBERTO.id],
          ['WAITING', MARCOS.id],
        ],
      );
    });
  });

  describe('[Validação]', () => {
    it('Linha sem aprovador (unidade sem titular) → 422 APPROVER_UNRESOLVED com meta.sequence 2, sem nomes, e nada gravado', async () => {
      const process = await processAtControl();
      await coveredEdital(process.id);
      const before = effects(process.id);
      warn.mockClear();
      const body = expectProblem(
        await forward(process, 'AUT_SEM_TITULAR'),
        422,
        'APPROVER_UNRESOLVED',
      );
      expect(body.detail).toBe(
        'Não há aprovador configurado para a linha 2 (titular da unidade) desta etapa. Fale com o administrador do órgão.',
      );
      expect((body as { meta?: unknown }).meta).toEqual({
        sequence: 2,
        approverLabel: 'titular da unidade',
      });
      expect(effects(process.id)).toEqual(before);
      expect(stored(process.id).currentStageId).toBe(process.currentStageId);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'approval.request_rejected',
          reason: 'APPROVER_UNRESOLVED',
          sequence: 2,
        }),
        'approval.request_rejected',
      );
    });

    it('Roberto titular das duas unidades das linhas 1 e 2 → 422 APPROVER_DUPLICATED, sem aprovação nem linha', async () => {
      const process = await processAtControl();
      await coveredEdital(process.id);
      const body = expectProblem(
        await forward(process, 'AUT_REPETIDA'),
        422,
        'APPROVER_DUPLICATED',
      );
      expect(body.detail).toBe(
        'A mesma pessoa não pode aprovar em duas linhas (1 e 2). Fale com o administrador do órgão.',
      );
      expect((body as { meta?: unknown }).meta).toEqual({ sequences: [1, 2] });
      expect(JSON.stringify(body)).not.toContain('Marta');
      expect(approvalsOf(process.id)).toEqual([]);
      expect(eventsOf(process.id, 'ApprovalRequested')).toEqual([]);
    });

    it('Edital incompleto (seção obrigatória vazia) → 422 DOCUMENT_INCOMPLETE antes de qualquer linha', async () => {
      const process = await processAtControl();
      const template = buildTemplateVersion({
        tenantId: A,
        sections: [sectionDefinition('OBJETO', { title: 'Objeto da contratação' })],
      });
      seedTemplateVersions(api, template);
      const editalId = await seedPanelDocument(api, {
        tenantId: A,
        processId: process.id,
        typeCode: 'TR',
        code: null,
        title: 'Edital em rascunho',
        status: 'DRAFT',
        createdById: FAKE_USERS.ana.id,
      });
      const edital = documentsOf(process.id).find((document) => document.id === editalId);
      if (!edital) throw new Error('edital ausente');
      documentRepositoryOf(api).seed({ ...edital, templateVersionId: template.id });
      const before = effects(process.id);
      expectProblem(await forward(process, 'AUT_TODOS'), 422, 'DOCUMENT_INCOMPLETE');
      expect(effects(process.id)).toEqual(before);
    });

    it('Autor sem substituto elegível: Marcos (linha 2, USER) autor do edital → 403 SELF_APPROVAL_FORBIDDEN com meta.sequence 2', async () => {
      const process = await processAtControl();
      await coveredEdital(process.id, MARCOS.id);
      const before = effects(process.id);
      const body = expectProblem(
        await forward(process, 'AUT_SEQUENCIAL'),
        403,
        'SELF_APPROVAL_FORBIDDEN',
      );
      expect(body.detail).toBe(
        'O aprovador da linha 2 é autor de um dos documentos e não tem substituto. Fale com o administrador do órgão.',
      );
      expect((body as { meta?: unknown }).meta).toEqual({ sequence: 2 });
      expect(JSON.stringify(body)).not.toContain('Lúcia');
      expect(approvalsOf(process.id)).toHaveLength(before.approvals);
      expect(eventsOf(process.id, 'ApprovalRequested')).toEqual([]);
    });

    it('Titular autor sem substituto ativo → 403 SELF_APPROVAL_FORBIDDEN com meta.sequence 1', async () => {
      setDepartmentHead(api, ADMINISTRACAO, ROBERTO.id, null);
      const process = await processAtControl();
      await coveredEdital(process.id, ROBERTO.id);
      const body = expectProblem(
        await forward(process, 'AUT_TITULAR'),
        403,
        'SELF_APPROVAL_FORBIDDEN',
      );
      expect((body as { meta?: unknown }).meta).toEqual({ sequence: 1 });
      expect(approvalsOf(process.id)).toEqual([]);
    });
  });

  describe('[Permissão]', () => {
    it('"Bruno" sem PROCESS_FORWARD → 403 PERMISSION_DENIED, nenhuma Approval e access.denied', async () => {
      const process = await processAtControl();
      await coveredEdital(process.id);
      const before = effects(process.id);
      expectProblem(
        await forward(process, 'AUT_SEQUENCIAL', { subject: 'sub-otavio' }),
        403,
        'PERMISSION_DENIED',
      );
      expect(approvalsOf(process.id)).toEqual([]);
      expect(effects(process.id).lines).toBe(before.lines);
      expect(
        api
          .auditRecords()
          .some(
            (row) => row.action === 'access.denied' && row.actorUserId === FAKE_USERS.otavio.id,
          ),
      ).toBe(true);
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Processo de A encaminhado pelo tenant B → 404, nada revelado nem gravado', async () => {
      const process = await processAtControl();
      await coveredEdital(process.id);
      const before = effects(process.id);
      const response = await forward(process, 'AUT_SEQUENCIAL', {
        subject: 'sub-heitor',
        tenant: B,
      });
      const body = expectProblem(response, 404, 'PROCESS_NOT_FOUND');
      expect(JSON.stringify(body)).not.toMatch(/Marta|Lúcia|Fábio|Administração/u);
      expect(effects(process.id)).toEqual(before);
    });
  });

  describe('[Duplicidade]', () => {
    it('Reenvio com a mesma Idempotency-Key "k-133": Idempotent-Replayed, uma Approval com as duas linhas e um único ApprovalRequested', async () => {
      const process = await processAtControl();
      await coveredEdital(process.id);
      const key = randomUUID(); // "k-133"
      const first = await forward(process, 'AUT_TODOS', { key });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      const replay = await forward(process, 'AUT_TODOS', { key });
      expect(replay.status).toBe(200);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toEqual(first.body);
      const approvals = approvalsOf(process.id);
      expect(approvals).toHaveLength(1);
      expect(linesOf(approvals[0]?.id ?? '')).toHaveLength(2);
      expect(eventsOf(process.id, 'ApprovalRequested')).toHaveLength(1);
    });
  });

  describe('[Concorrência]', () => {
    it('Dois encaminhamentos simultâneos com a mesma versão: uma Approval (com linhas), a outra 412/409', async () => {
      const process = await processAtControl();
      await coveredEdital(process.id);
      const [one, two] = await Promise.all([
        forward(process, 'AUT_SEQUENCIAL'),
        forward(process, 'AUT_SEQUENCIAL'),
      ]);
      const statuses = [one.status, two.status].sort();
      expect(statuses[0]).toBe(200);
      expect([409, 412]).toContain(statuses[1]);
      const loser = one.status === 200 ? two : one;
      expect(['VERSION_CONFLICT', 'STAGE_CHANGED', 'APPROVAL_NOT_PENDING']).toContain(
        problemDetailsSchema.parse(loser.body).code,
      );
      const approvals = approvalsOf(process.id);
      expect(approvals).toHaveLength(1);
      expect(linesOf(approvals[0]?.id ?? '')).toHaveLength(2);
      expect(eventsOf(process.id, 'ApprovalRequested')).toHaveLength(1);
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível durante o encaminhamento → 503 DEPENDENCY_UNAVAILABLE; processo, documentos e outbox como antes', async () => {
      const process = await processAtControl();
      await coveredEdital(process.id);
      const before = effects(process.id);
      transactions.down = true;
      expectProblem(await forward(process, 'AUT_TODOS'), 503, 'DEPENDENCY_UNAVAILABLE');
      transactions.down = false;
      expect(effects(process.id)).toEqual(before);
    });
  });

  describe('[Falha de integração]', () => {
    it('Fila/relay indisponíveis não afetam a solicitação: 200 e o ApprovalRequested fica no outbox (PENDING) para o relay', async () => {
      const process = await processAtControl();
      await coveredEdital(process.id);
      const response = await forward(process, 'AUT_SEQUENCIAL');
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      // Sem relay em memória: o evento fica gravado (o relay publica depois — US-082); a
      // notificação é do worker, a partir do outbox, sem duplicidade (um único evento).
      const events = eventsOf(process.id, 'ApprovalRequested');
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toMatchObject({ decisionPolicy: 'SEQUENTIAL' });
    });
  });
});
