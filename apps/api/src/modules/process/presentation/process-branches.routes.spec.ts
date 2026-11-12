import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type { ProcessDto } from '@contrataflow/validation';
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
import { approvalRepositoryOf } from '../../../../test/support/document-fixtures.js';
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
  registerTestDocumentFacts,
  setDepartmentHead,
} from '../../../../test/support/process-forward-fixtures.js';
import type { TestDocumentFacts } from '../../../../test/support/process-forward-fixtures.js';
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
import { branchInvariantViolations } from '../domain/process-branches.js';
import type { Process } from '../domain/process.js';

/*
 * US-124 — ramos paralelos em execução (DEC-194 · RN-WF2-13..28) pelo pipeline HTTP completo
 * (autenticação, tenant, vínculo, autorização, `If-Match`, `Idempotency-Key`, RFC 9457) com a
 * identidade fake e repositórios em memória — as 8 categorias do Gherkin. Personagens: Ana =
 * "Carla" (TERMO_REFERENCIA, Planejamento), Fábio = "Paulo" (titular e lotado na Procuradoria — ramo
 * JURIDICO), Lúcia = "Rita" (titular e lotada no Controle Interno — ramo CONTROLE_INTERNO), Marta =
 * titular da Secretaria de Obras (aprovadora das etapas `APPROVAL`). Atomicidade com rollback real,
 * RLS, `FOR UPDATE` do split e o outbox que falha: `test/tenant-leak/process-branches.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-05T15:00:00.000Z');
const ORG_A = '0192d124-0000-7000-8000-0000000000a0';
const ORG_B = '0192d124-0000-7000-8000-0000000000b0';
const UNITS_A = {
  organizationId: ORG_A,
  obras: '0192d124-0000-7000-8000-0000000000a1',
  manutencao: '0192d124-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d124-0000-7000-8000-0000000000a3',
  saude: '0192d124-0000-7000-8000-0000000000a4',
  posto: '0192d124-0000-7000-8000-0000000000a5',
};
const UNITS_B = {
  organizationId: ORG_B,
  obras: '0192d124-0000-7000-8000-0000000000b1',
  manutencao: '0192d124-0000-7000-8000-0000000000b2',
  pavimentacao: '0192d124-0000-7000-8000-0000000000b3',
  saude: '0192d124-0000-7000-8000-0000000000b4',
  posto: '0192d124-0000-7000-8000-0000000000b5',
};
const PLANEJAMENTO = '0192d124-0000-7000-8000-0000000000a6';
const PROCURADORIA = '0192d124-0000-7000-8000-0000000000a7';
const CONTROLE = '0192d124-0000-7000-8000-0000000000a8';
const FLOW_VERSION = '0192d124-0000-7000-8000-0000000000f1';
const OPINION_MESSAGE = 'Parecer jurídico finalizado';
/** A "K-77" do Gherkin (a chave de idempotência é um UUID). */
const K77 = '0192d124-0000-7000-8000-000000000077';

const membershipOf = (userId: string, tenantId = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

const fixed = (departmentId: string) => ({
  departmentResolution: 'FIXED' as const,
  fixedDepartmentId: departmentId,
  assignmentPolicy: 'DEPARTMENT_HEAD' as const,
});

/**
 * Workflow do Background: TERMO_REFERENCIA → RAMIFICACAO_ANALISES (split) → ramo JURIDICO
 * (JURIDICO → REVISAO_JURIDICA) e ramo CONTROLE_INTERNO (CONTROLE_INTERNO → APROVACAO_CI) →
 * JUNCAO_ANALISES (regra BLOCKING "Parecer jurídico finalizado") → AUTORIZACAO_LICITACAO
 * (`APPROVAL`) → FIM.
 */
const flow = new DefinitionBuilder(FLOW_VERSION)
  .stage('ABERTURA', 'START', { name: 'Formalização da demanda', assignmentPolicy: 'CREATOR' })
  .stage('TERMO_REFERENCIA', 'TASK', { name: 'Termo de referência', slaDays: 10 })
  .stage('RAMIFICACAO_ANALISES', 'PARALLEL_SPLIT', { name: 'Análises em paralelo' })
  .stage('JURIDICO', 'TASK', {
    name: 'Análise jurídica',
    ...fixed(PROCURADORIA),
    slaDays: 10,
    branchKey: 'JURIDICO',
  })
  .stage('REVISAO_JURIDICA', 'TASK', {
    name: 'Revisão jurídica',
    ...fixed(PROCURADORIA),
    slaDays: 3,
    branchKey: 'JURIDICO',
  })
  .stage('CONTROLE_INTERNO', 'TASK', {
    name: 'Controle interno',
    ...fixed(CONTROLE),
    slaDays: 5,
    branchKey: 'CONTROLE_INTERNO',
  })
  .stage('APROVACAO_CI', 'APPROVAL', {
    name: 'Aprovação do controle interno',
    departmentResolution: 'FIXED',
    fixedDepartmentId: CONTROLE,
    branchKey: 'CONTROLE_INTERNO',
  })
  .stage('JUNCAO_ANALISES', 'PARALLEL_JOIN', { name: 'Junção das análises' })
  .stage('AUTORIZACAO_LICITACAO', 'APPROVAL', { name: 'Autorização da licitação' })
  .stage('FIM', 'END', { name: 'Concluído' })
  .transition('ABERTURA', 'TERMO_REFERENCIA', 'FORWARD')
  .transition('TERMO_REFERENCIA', 'RAMIFICACAO_ANALISES', 'FORWARD', { isPrimary: true })
  .transition('TERMO_REFERENCIA', 'ABERTURA', 'RETURN')
  .transition('RAMIFICACAO_ANALISES', 'JURIDICO', 'FORWARD')
  .transition('RAMIFICACAO_ANALISES', 'CONTROLE_INTERNO', 'FORWARD')
  .transition('JURIDICO', 'REVISAO_JURIDICA', 'FORWARD')
  .transition('JURIDICO', 'TERMO_REFERENCIA', 'RETURN')
  .transition('REVISAO_JURIDICA', 'JUNCAO_ANALISES', 'FORWARD')
  .transition('REVISAO_JURIDICA', 'JURIDICO', 'RETURN')
  .transition('REVISAO_JURIDICA', 'TERMO_REFERENCIA', 'RETURN')
  .transition('CONTROLE_INTERNO', 'APROVACAO_CI', 'FORWARD')
  .transition('CONTROLE_INTERNO', 'JUNCAO_ANALISES', 'FORWARD')
  .transition('CONTROLE_INTERNO', 'TERMO_REFERENCIA', 'RETURN')
  .transition('APROVACAO_CI', 'JUNCAO_ANALISES', 'APPROVE')
  .transition('APROVACAO_CI', 'CONTROLE_INTERNO', 'RETURN')
  .transition('JUNCAO_ANALISES', 'AUTORIZACAO_LICITACAO', 'FORWARD')
  .transition('AUTORIZACAO_LICITACAO', 'FIM', 'APPROVE')
  .transition('AUTORIZACAO_LICITACAO', 'TERMO_REFERENCIA', 'RETURN')
  .rule(
    'REQUIRED_DOCUMENT',
    { documentTypeCode: 'ETP', minStatus: 'COMPLETE' },
    { stage: 'JUNCAO_ANALISES' },
    { name: OPINION_MESSAGE, message: OPINION_MESSAGE },
  );

const transitionOf = (from: string, action: string, to: string): string => {
  const transition = flow.transitions.find(
    (candidate) => candidate.key === `${from}_${action}_${to}`,
  );
  if (!transition) throw new Error(`transição ${from}→${to} ausente`);
  return transition.id;
};
const TO_SPLIT = transitionOf('TERMO_REFERENCIA', 'FORWARD', 'RAMIFICACAO_ANALISES');
const TO_REVISION = transitionOf('JURIDICO', 'FORWARD', 'REVISAO_JURIDICA');
const REVISION_TO_JOIN = transitionOf('REVISAO_JURIDICA', 'FORWARD', 'JUNCAO_ANALISES');
const CI_TO_JOIN = transitionOf('CONTROLE_INTERNO', 'FORWARD', 'JUNCAO_ANALISES');
const CI_TO_APPROVAL = transitionOf('CONTROLE_INTERNO', 'FORWARD', 'APROVACAO_CI');

/** Transações em fila (corridas serializadas, como o `FOR UPDATE`) e banco que pode cair. */
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

function expectProblem(response: request.Response, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  const body = problemDetailsSchema.parse(response.body);
  expect(body.code).toBe(code);
  return body;
}

describe('Feature: Executar ramos paralelos no processo (US-124)', () => {
  let api: TestApi;
  let facts: TestDocumentFacts;
  const transactions = new FlakyTransactions();
  let catalog: { contractingType: string; origin: string };
  const words = (count: number) =>
    Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

  const auth = (call: request.Test, subject = 'sub-ana', tenant: string = A) =>
    call
      .set('Authorization', api.bearer(subject, { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', tenant);
  const repository = () => processRepositoryOf(api);
  const stored = (id: string): Process => {
    const process = repository()
      .allProcesses()
      .find((candidate) => candidate.id === id);
    if (!process) throw new Error(`processo ${id} ausente`);
    return process;
  };
  const activeStages = (processId: string) =>
    repository()
      .stagesOf(processId)
      .filter((stage) => stage.status === 'ACTIVE');
  const stageOf = (processId: string, key: string) => {
    const stage = [...repository().stagesOf(processId)]
      .reverse()
      .find((candidate) => candidate.workflowStageId === flow.stageId(key));
    if (!stage) throw new Error(`passagem ${key} ausente`);
    return stage;
  };
  const eventsOf = (processId: string, eventType: string) =>
    api.outboxRows().filter((row) => row.processId === processId && row.eventType === eventType);
  const auditOf = (processId: string, action: string) =>
    api.auditRecords().filter((row) => row.processId === processId && row.action === action);
  const timelineOf = (processId: string, type: string) =>
    timelineRowsOf(api).filter((row) => row.processId === processId && row.type === type);
  /** Invariantes do bloco (RN-WF2-21): sem etapa ativa órfã, contagem consistente. */
  const expectInvariants = (processId: string) => {
    const process = stored(processId);
    const stages = repository()
      .stagesOf(processId)
      .map((stage) => ({
        ...stage,
        exitedAt: stage.exitedAt ?? null,
        stageType: stage.stageType ?? 'TASK',
        branchKey: stage.branchKey ?? null,
        splitProcessStageId: stage.splitProcessStageId ?? null,
        openedByReturn: false,
      }));
    expect(branchInvariantViolations(process, stages, repository().branchesOf(processId))).toEqual(
      [],
    );
  };

  const post = (
    path: string,
    process: Pick<Process, 'id' | 'version'>,
    body: Record<string, unknown>,
    options: { subject?: string; tenant?: string; key?: string; version?: number } = {},
  ) =>
    auth(
      request(api.server).post(`/api/v1/processes/${process.id}/${path}`),
      options.subject,
      options.tenant,
    )
      .set('Idempotency-Key', options.key ?? randomUUID())
      .set('If-Match', `"${String(options.version ?? process.version)}"`)
      .send(body);
  const forwardStage = (
    processId: string,
    stageKey: string,
    transitionId: string,
    options: {
      subject?: string;
      tenant?: string;
      key?: string;
      omitStage?: boolean;
      body?: object;
    } = {},
  ) => {
    const stage = stageOf(processId, stageKey);
    return post(
      'forward',
      stored(processId),
      {
        transitionId,
        expectedStageId: stage.id,
        ...(options.omitStage === true ? {} : { processStageId: stage.id }),
        ...options.body,
      },
      options,
    );
  };

  /** Processo criado pelo PRC-02 e posto em TERMO_REFERENCIA (Ana responsável, Planejamento). */
  async function processAtTerm(): Promise<Process> {
    const response = await auth(request(api.server).post('/api/v1/processes'))
      .set('Idempotency-Key', randomUUID())
      .send({
        title: `Licitação ${words(3)}`,
        object: `Contratação de ${words(4)}`,
        contractingTypeId: catalog.contractingType,
        requestingSecretariatId: UNITS_A.obras,
        requestingDepartmentId: UNITS_A.manutencao,
        originId: catalog.origin,
        pcaStatus: 'NOT_APPLICABLE',
      });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const created = stored((response.body as { data: ProcessDto }).data.id);
    const [opening] = repository().stagesOf(created.id);
    if (!opening) throw new Error('passagem de abertura ausente');
    repository().seedStage({
      ...opening,
      workflowStageId: flow.stageId('ABERTURA'),
      stageType: 'START',
      status: 'COMPLETED',
      exitedAt: new Date('2026-10-01T12:00:00.000Z'),
    });
    const term = newId();
    repository().seedStage({
      id: term,
      tenantId: A,
      processId: created.id,
      workflowStageId: flow.stageId('TERMO_REFERENCIA'),
      sequence: 2,
      status: 'ACTIVE',
      departmentId: PLANEJAMENTO,
      assigneeId: FAKE_USERS.ana.id,
      enteredAt: new Date('2026-10-01T12:00:00.000Z'),
      dueAt: null,
      slaDays: 10,
      slaType: 'BUSINESS',
      enteredViaMovementId: null,
      stageType: 'TASK',
    });
    const process: Process = {
      ...created,
      workflowVersionId: FLOW_VERSION,
      status: 'IN_PROGRESS',
      currentStageId: term,
      currentWorkflowStageId: flow.stageId('TERMO_REFERENCIA'),
      currentDepartmentId: PLANEJAMENTO,
      currentResponsibleId: FAKE_USERS.ana.id,
      number: 45,
      code: '0045/2026',
      openedAt: created.createdAt,
      version: 7,
      activeStagesCount: 1,
    };
    repository().seed(process, [
      { principalType: 'DEPARTMENT', departmentId: PLANEJAMENTO, reason: 'CURRENT' },
    ]);
    facts.set(process.id, [
      {
        documentTypeCode: 'ETP',
        status: 'FINALIZED',
        isComplete: true,
        versionNumber: 1,
        approvedAt: null,
      },
    ]);
    return process;
  }

  /** Background + "Carla encaminhou para a ramificação": os dois ramos abertos. */
  async function processInBranches(): Promise<Process> {
    const process = await processAtTerm();
    const response = await post('forward', process, {
      transitionId: TO_SPLIT,
      expectedStageId: process.currentStageId,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return stored(process.id);
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
      'workflow.seedWorkflows',
    ]);
    await runTenantSeeders(api, B, ['catalog.items', 'access.defaultRoles']);
    seedProcessStructure(api, A, { ...UNITS_A, shortName: 'PMSJ', cnpj: '11222333000181' });
    seedProcessStructure(api, B, { ...UNITS_B, shortName: 'PMB', cnpj: '60746948000112' });
    const base = { tenantId: A, organizationId: ORG_A };
    seedDepartment(api, { ...base, id: PLANEJAMENTO, name: 'Coordenadoria de Planejamento' });
    seedDepartment(api, { ...base, id: PROCURADORIA, name: 'Procuradoria' });
    seedDepartment(api, { ...base, id: CONTROLE, name: 'Controle Interno' });
    await seedPublishedInMemory(api, A, flow, 'TESTE_US124');
    await deactivateWorkflow(api, A, 'TESTE_US124');
    facts = registerTestDocumentFacts(api);
    assignDepartment(api, membershipOf(FAKE_USERS.ana.id), UNITS_A.manutencao);
    assignDepartment(api, membershipOf(FAKE_USERS.ana.id), PLANEJAMENTO);
    assignDepartment(api, membershipOf(FAKE_USERS.fabio.id), PROCURADORIA);
    assignDepartment(api, membershipOf(FAKE_USERS.lucia.id), CONTROLE);
    setDepartmentHead(api, PROCURADORIA, FAKE_USERS.fabio.id);
    setDepartmentHead(api, CONTROLE, FAKE_USERS.lucia.id);
    setDepartmentHead(api, UNITS_A.obras, FAKE_USERS.marta.id);
    // Marta decide as aprovações (AUTORIDADE_COMPETENTE — APPROVAL_DECIDE).
    assignRole(api, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.marta.id),
      roleId: seedDefaultRolesOf(api, A).get('AUTORIDADE_COMPETENTE')?.id ?? '',
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
    it('Entrar no split abre um ramo por transição: etapas, ramos, acessos, eventos, auditoria e timeline', async () => {
      const process = await processAtTerm();

      const response = await post('forward', process, {
        transitionId: TO_SPLIT,
        expectedStageId: process.currentStageId,
      });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const after = stored(process.id);
      const actives = activeStages(process.id);
      const split = actives.find((stage) => stage.stageType === 'PARALLEL_SPLIT');
      const branches = actives.filter(
        (stage) => stage.branchKey !== null && stage.branchKey !== undefined,
      );
      expect(branches.map((stage) => stage.branchKey).sort()).toEqual([
        'CONTROLE_INTERNO',
        'JURIDICO',
      ]);
      expect(branches.every((stage) => stage.splitProcessStageId === split?.id)).toBe(true);
      expect(after.currentStageId).toBe(split?.id);
      expect(after.currentResponsibleId).toBeNull();
      expect(after.currentDepartmentId).toBe(PROCURADORIA);
      expect(after.activeStagesCount).toBe(2);
      expect(after.status).toBe('IN_PROGRESS');
      expect(stageOf(process.id, 'JURIDICO').assigneeId).toBe(FAKE_USERS.fabio.id);
      expect(stageOf(process.id, 'CONTROLE_INTERNO').assigneeId).toBe(FAKE_USERS.lucia.id);
      expect(
        repository()
          .branchesOf(process.id)
          .map((branch) => branch.status),
      ).toEqual(['OPEN', 'OPEN']);
      // Um movimento só (etapa anterior → split), com os ramos nos rótulos.
      const movements = repository()
        .movementsOf(process.id)
        .filter((m) => m.action === 'FORWARD');
      expect(movements).toHaveLength(1);
      expect(movements[0]?.toProcessStageId).toBe(split?.id);
      // Uma responsabilidade ativa por etapa de ramo; a do TERMO_REFERENCIA encerrada.
      const assignments = repository()
        .assignmentsOf(process.id)
        .filter((assignment) => assignment.isActive);
      expect(assignments.map((assignment) => assignment.processStageId).sort()).toEqual(
        branches.map((stage) => stage.id).sort(),
      );
      // ProcessAccess CURRENT por ramo.
      const current = repository()
        .accessOf(process.id)
        .filter((row) => row.reason === 'CURRENT')
        .map((row) => row.departmentId);
      expect(current).toEqual(expect.arrayContaining([PROCURADORIA, CONTROLE]));
      expect(auditOf(process.id, 'process.branch_open')).toHaveLength(1);
      expect(eventsOf(process.id, 'ProcessBranchesOpened')).toHaveLength(1);
      const [changed] = eventsOf(process.id, 'ProcessStageChanged');
      expect((changed?.payload as { activeStageIds: string[] }).activeStageIds).toHaveLength(2);
      expect(eventsOf(process.id, 'ProcessAssigned')).toHaveLength(2);
      expect(timelineOf(process.id, 'BRANCHES_OPENED')).toHaveLength(1);
      expectInvariants(process.id);
    });

    it('Concluir um ramo mantém o outro ativo; o último faz a junção na mesma transação e solicita a aprovação', async () => {
      const process = await processInBranches();
      await forwardStage(process.id, 'JURIDICO', TO_REVISION, { subject: 'sub-fabio' }).expect(200);

      const first = await forwardStage(process.id, 'REVISAO_JURIDICA', REVISION_TO_JOIN, {
        subject: 'sub-fabio',
      });

      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(
        repository()
          .branchesOf(process.id)
          .find((b) => b.branchKey === 'JURIDICO')?.status,
      ).toBe('ARRIVED');
      expect(stored(process.id).activeStagesCount).toBe(1);
      expect(stored(process.id).currentDepartmentId).toBe(CONTROLE);
      const forwardAudit = auditOf(process.id, 'process.forward').at(-1);
      expect((forwardAudit?.metadata as { branchKey: string }).branchKey).toBe('JURIDICO');
      const [arrived] = eventsOf(process.id, 'ProcessBranchArrived');
      expect((arrived?.payload as { openBranchesLeft: number }).openBranchesLeft).toBe(1);
      expect(timelineOf(process.id, 'BRANCH_ARRIVED')).toHaveLength(1);
      expectInvariants(process.id);

      const last = await forwardStage(process.id, 'CONTROLE_INTERNO', CI_TO_JOIN, {
        subject: 'sub-lucia',
      });

      expect(last.status, JSON.stringify(last.body)).toBe(200);
      const after = stored(process.id);
      const authorization = stageOf(process.id, 'AUTORIZACAO_LICITACAO');
      expect(after.currentStageId).toBe(authorization.id);
      expect(after.activeStagesCount).toBe(1);
      expect(after.status).toBe('AWAITING_APPROVAL');
      expect(activeStages(process.id).map((stage) => stage.id)).toEqual([authorization.id]);
      expect(stageOf(process.id, 'JUNCAO_ANALISES').status).toBe('COMPLETED');
      expect(stageOf(process.id, 'RAMIFICACAO_ANALISES').status).toBe('COMPLETED');
      expect(
        repository()
          .branchesOf(process.id)
          .every((b) => b.status === 'ARRIVED'),
      ).toBe(true);
      const pending = approvalRepositoryOf(api)
        .approvals()
        .filter((approval) => approval.processStageId === authorization.id);
      expect(pending.map((approval) => approval.status)).toEqual(['PENDING']);
      expect(auditOf(process.id, 'process.branch_join')).toHaveLength(1);
      expect(auditOf(process.id, 'approval.request').length).toBeGreaterThanOrEqual(1);
      expect(eventsOf(process.id, 'ProcessBranchesJoined')).toHaveLength(1);
      expect(eventsOf(process.id, 'ApprovalRequested').length).toBeGreaterThanOrEqual(1);
      expect(
        eventsOf(process.id, 'ProcessStatusChanged').some(
          (row) => (row.payload as { toStatus: string }).toStatus === 'AWAITING_APPROVAL',
        ),
      ).toBe(true);
      expect(timelineOf(process.id, 'BRANCHES_JOINED')).toHaveLength(1);
      // Os CURRENT dos ramos viraram HISTORICAL.
      const current = repository()
        .accessOf(process.id)
        .filter((row) => row.reason === 'CURRENT')
        .map((row) => row.departmentId);
      expect(current).not.toContain(PROCURADORIA);
      expect(current).not.toContain(CONTROLE);
      expectInvariants(process.id);
    });

    it('Devolver dentro do ramo não afeta o outro: ramo OPEN, status RETURNED', async () => {
      const process = await processInBranches();
      await forwardStage(process.id, 'JURIDICO', TO_REVISION, { subject: 'sub-fabio' }).expect(200);
      const ci = stageOf(process.id, 'CONTROLE_INTERNO');
      const revision = stageOf(process.id, 'REVISAO_JURIDICA');

      const response = await post(
        'return',
        stored(process.id),
        {
          processStageId: revision.id,
          targetStageId: flow.stageId('JURIDICO'),
          comment: 'Faltou citar a cláusula de reajuste.',
        },
        { subject: 'sub-fabio' },
      );

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const reopened = stageOf(process.id, 'JURIDICO');
      expect(reopened.status).toBe('ACTIVE');
      expect(reopened.branchKey).toBe('JURIDICO');
      expect(stageOf(process.id, 'REVISAO_JURIDICA').status).toBe('RETURNED');
      expect(stageOf(process.id, 'CONTROLE_INTERNO')).toEqual(ci);
      expect(
        repository()
          .branchesOf(process.id)
          .every((b) => b.status === 'OPEN'),
      ).toBe(true);
      expect(stored(process.id).status).toBe('RETURNED');
      expect(stored(process.id).activeStagesCount).toBe(2);
      const audit = auditOf(process.id, 'process.return').at(-1);
      expect((audit?.metadata as { branchKey: string }).branchKey).toBe('JURIDICO');
      const movement = repository().movementsOf(process.id).at(-1);
      expect(movement?.branchKey).toBe('JURIDICO');
      expectInvariants(process.id);
    });

    it('Devolver para antes da ramificação cancela os outros ramos e a aprovação pendente', async () => {
      const process = await processInBranches();
      await forwardStage(process.id, 'CONTROLE_INTERNO', CI_TO_APPROVAL, {
        subject: 'sub-lucia',
      }).expect(200);
      const approvalStage = stageOf(process.id, 'APROVACAO_CI');
      const [pending] = approvalRepositoryOf(api)
        .approvals()
        .filter((approval) => approval.processStageId === approvalStage.id);
      expect(pending?.status).toBe('PENDING');
      const juridico = stageOf(process.id, 'JURIDICO');

      const response = await post(
        'return',
        stored(process.id),
        {
          processStageId: juridico.id,
          targetStageId: flow.stageId('TERMO_REFERENCIA'),
          confirmBranchCancellation: true,
          comment: 'Ajustar o objeto antes das análises.',
        },
        { subject: 'sub-fabio' },
      );

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(stageOf(process.id, 'JURIDICO').status).toBe('RETURNED');
      expect(stageOf(process.id, 'APROVACAO_CI').status).toBe('CANCELED');
      expect(stageOf(process.id, 'RAMIFICACAO_ANALISES').status).toBe('RETURNED');
      expect(
        repository()
          .branchesOf(process.id)
          .map((b) => [b.status, b.cancellationReason]),
      ).toEqual([
        ['CANCELED', 'Processo devolvido para etapa anterior à ramificação'],
        ['CANCELED', 'Processo devolvido para etapa anterior à ramificação'],
      ]);
      const reopened = stageOf(process.id, 'TERMO_REFERENCIA');
      expect(reopened.status).toBe('ACTIVE');
      expect(stored(process.id).currentStageId).toBe(reopened.id);
      expect(stored(process.id).status).toBe('RETURNED');
      expect(stored(process.id).activeStagesCount).toBe(1);
      expect(
        approvalRepositoryOf(api)
          .approvals()
          .find((a) => a.id === pending?.id)?.status,
      ).toBe('CANCELED');
      expect(auditOf(process.id, 'process.branch_cancel')).toHaveLength(1);
      expect(eventsOf(process.id, 'ProcessBranchesCanceled')).toHaveLength(1);
      expect(
        eventsOf(process.id, 'ApprovalCanceled').map(
          (row) => (row.payload as { reason: string }).reason,
        ),
      ).toEqual(['BRANCH_CANCELED']);
      expect(
        eventsOf(process.id, 'ProcessStatusChanged').some(
          (row) => (row.payload as { toStatus: string }).toStatus === 'RETURNED',
        ),
      ).toBe(true);
      expect(timelineOf(process.id, 'BRANCHES_CANCELED')).toHaveLength(1);
      expectInvariants(process.id);
    });

    it('FA-02: aprovar a etapa APPROVAL do ramo chega à junção sem tocar no outro ramo', async () => {
      const process = await processInBranches();
      await forwardStage(process.id, 'CONTROLE_INTERNO', CI_TO_APPROVAL, {
        subject: 'sub-lucia',
      }).expect(200);
      const approvalStage = stageOf(process.id, 'APROVACAO_CI');
      expect(stored(process.id).status).toBe('IN_PROGRESS');
      const [pending] = approvalRepositoryOf(api)
        .approvals()
        .filter((approval) => approval.processStageId === approvalStage.id);
      const juridico = stageOf(process.id, 'JURIDICO');

      const response = await auth(
        request(api.server).post(`/api/v1/approvals/${pending?.id ?? ''}/decide`),
        'sub-marta',
      )
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', '"1"')
        .send({ decision: 'APPROVE' });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(stageOf(process.id, 'APROVACAO_CI').status).toBe('COMPLETED');
      expect(
        repository()
          .branchesOf(process.id)
          .find((b) => b.branchKey === 'CONTROLE_INTERNO')?.status,
      ).toBe('ARRIVED');
      expect(stageOf(process.id, 'JURIDICO')).toEqual(juridico);
      expect(stored(process.id).activeStagesCount).toBe(1);
      expectInvariants(process.id);
    });

    it('FA-02: retirar a aprovação do ramo volta à etapa anterior do MESMO ramo', async () => {
      const process = await processInBranches();
      await forwardStage(process.id, 'CONTROLE_INTERNO', CI_TO_APPROVAL, {
        subject: 'sub-lucia',
      }).expect(200);
      const approvalStage = stageOf(process.id, 'APROVACAO_CI');
      const [pending] = approvalRepositoryOf(api)
        .approvals()
        .filter((approval) => approval.processStageId === approvalStage.id);
      const juridico = stageOf(process.id, 'JURIDICO');

      const response = await auth(
        request(api.server).post(`/api/v1/approvals/${pending?.id ?? ''}/withdraw`),
        'sub-lucia',
      )
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', '"1"')
        .send({ reason: 'Vou complementar a análise do controle.' });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const reopened = stageOf(process.id, 'CONTROLE_INTERNO');
      expect(reopened.status).toBe('ACTIVE');
      expect(reopened.branchKey).toBe('CONTROLE_INTERNO');
      expect(stageOf(process.id, 'JURIDICO')).toEqual(juridico);
      expect(
        repository()
          .branchesOf(process.id)
          .every((b) => b.status === 'OPEN'),
      ).toBe(true);
      expect(stored(process.id).status).toBe('RETURNED');
      expectInvariants(process.id);
    });

    it('FA-08: reentrar no split depois da devolução cria nova rodada de ramos', async () => {
      const process = await processInBranches();
      const juridico = stageOf(process.id, 'JURIDICO');
      await post(
        'return',
        stored(process.id),
        {
          processStageId: juridico.id,
          targetStageId: flow.stageId('TERMO_REFERENCIA'),
          confirmBranchCancellation: true,
          comment: 'Ajustar o objeto antes das análises.',
        },
        { subject: 'sub-fabio' },
      ).expect(200);
      const term = stageOf(process.id, 'TERMO_REFERENCIA');

      const response = await post('forward', stored(process.id), {
        transitionId: TO_SPLIT,
        expectedStageId: term.id,
      });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const branches = repository().branchesOf(process.id);
      expect(branches.map((b) => b.status)).toEqual(['CANCELED', 'CANCELED', 'OPEN', 'OPEN']);
      expect(new Set(branches.map((b) => b.splitProcessStageId)).size).toBe(2);
      expectInvariants(process.id);
    });
  });

  describe('[Sucesso] — ações do MVP 1 sobre ramos', () => {
    it('Atribuir a etapa do ramo à fila e assumi-la (FA-06): o processo segue sem responsável', async () => {
      const process = await processInBranches();
      const juridico = stageOf(process.id, 'JURIDICO');
      const ci = stageOf(process.id, 'CONTROLE_INTERNO');

      const assigned = await post(
        'assign',
        stored(process.id),
        {
          processStageId: juridico.id,
          assigneeId: null,
          reason: 'Redistribuir na Procuradoria.',
        },
        { subject: 'sub-lucia' },
      );

      expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
      expect(stageOf(process.id, 'JURIDICO').assigneeId).toBeNull();
      expect(stageOf(process.id, 'CONTROLE_INTERNO')).toEqual(ci);
      expect(stored(process.id).currentResponsibleId).toBeNull();
      expect(stored(process.id).currentStageId).toBe(process.currentStageId);

      const claimed = await post(
        'claim',
        stored(process.id),
        { processStageId: juridico.id },
        { subject: 'sub-fabio' },
      );

      expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
      expect(stageOf(process.id, 'JURIDICO').assigneeId).toBe(FAKE_USERS.fabio.id);
      expect(stored(process.id).currentResponsibleId).toBeNull();
      const active = repository()
        .assignmentsOf(process.id)
        .filter((assignment) => assignment.isActive);
      expect(active.map((assignment) => assignment.processStageId).sort()).toEqual(
        [juridico.id, ci.id].sort(),
      );
      expect(repository().movementsOf(process.id).at(-1)?.branchKey).toBe('JURIDICO');
      expectInvariants(process.id);
    });

    it('Suspender pausa todas as etapas ativas e barra ações de ramo; retomar estende cada prazo', async () => {
      const process = await processInBranches();
      const before = activeStages(process.id).filter((stage) => stage.branchKey);

      const suspended = await post(
        'suspend',
        stored(process.id),
        { reason: 'Aguardando decisão judicial sobre o certame.' },
        { subject: 'sub-lucia' },
      );

      expect(suspended.status, JSON.stringify(suspended.body)).toBe(200);
      expect(activeStages(process.id).every((stage) => stage.pausedAt)).toBe(true);
      expectProblem(
        await forwardStage(process.id, 'JURIDICO', TO_REVISION, { subject: 'sub-fabio' }),
        409,
        'INVALID_PROCESS_STATUS',
      );

      const resumed = await post('resume', stored(process.id), {}, { subject: 'sub-lucia' });

      expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
      expect(activeStages(process.id).every((stage) => !stage.pausedAt)).toBe(true);
      for (const stage of before) {
        const now = activeStages(process.id).find((candidate) => candidate.id === stage.id);
        expect(now?.dueAt?.getTime()).toBeGreaterThanOrEqual(stage.dueAt?.getTime() ?? 0);
      }
      expect(stored(process.id).status).toBe('IN_PROGRESS');
      expectInvariants(process.id);
    });

    it('Cancelar o processo cancela os ramos abertos e todas as etapas ativas', async () => {
      const process = await processInBranches();

      const response = await post(
        'cancel',
        stored(process.id),
        { cancellationReason: 'Demanda atendida por ata de registro de preços vigente.' },
        { subject: 'sub-lucia' },
      );

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(activeStages(process.id)).toEqual([]);
      expect(
        repository()
          .branchesOf(process.id)
          .map((b) => [b.status, b.cancellationReason]),
      ).toEqual([
        ['CANCELED', 'Processo cancelado'],
        ['CANCELED', 'Processo cancelado'],
      ]);
      expect(stored(process.id).status).toBe('CANCELED');
      expect(stored(process.id).activeStagesCount).toBe(0);
      expect(eventsOf(process.id, 'ProcessBranchesCanceled')).toHaveLength(0);
      expectInvariants(process.id);
    });
  });

  describe('[Sucesso] — leituras', () => {
    const get = (path: string, subject = 'sub-ana', tenant: string = A) =>
      auth(request(api.server).get(`/api/v1${path}`), subject, tenant);

    it('PRC-04/PRC-08/PRC-39/PRC-11: etapas ativas, ações por etapa, ramos e filtro por ramo', async () => {
      const process = await processInBranches();
      await forwardStage(process.id, 'JURIDICO', TO_REVISION, { subject: 'sub-fabio' }).expect(200);

      const detail = await get(`/processes/${process.id}`, 'sub-fabio');
      expect(detail.status, JSON.stringify(detail.body)).toBe(200);
      const dto = (detail.body as { data: ProcessDto }).data;
      expect(dto.currentStage?.key).toBe('RAMIFICACAO_ANALISES');
      expect(dto.activeStagesCount).toBe(2);
      expect(dto.activeStages?.map((stage) => [stage.stageKey, stage.branchKey]).sort()).toEqual([
        ['CONTROLE_INTERNO', 'CONTROLE_INTERNO'],
        ['REVISAO_JURIDICA', 'JURIDICO'],
      ]);

      const actions = await get(`/processes/${process.id}/available-actions`, 'sub-fabio');
      expect(actions.status, JSON.stringify(actions.body)).toBe(200);
      const body = actions.body as {
        data: { action: string; enabled: boolean; processStageId?: string; branchKey?: string }[];
        stages: { processStageId: string; branchKey: string; isMine: boolean }[];
      };
      expect(body.stages.map((stage) => [stage.branchKey, stage.isMine]).sort()).toEqual([
        ['CONTROLE_INTERNO', false],
        ['JURIDICO', true],
      ]);
      const revision = stageOf(process.id, 'REVISAO_JURIDICA');
      const mine = body.data.filter((entry) => entry.action === 'FORWARD' && entry.enabled);
      expect(mine.map((entry) => entry.processStageId)).toEqual([revision.id]);
      const others = body.data.filter(
        (entry) => entry.action === 'FORWARD' && entry.branchKey === 'CONTROLE_INTERNO',
      );
      expect(others.every((entry) => !entry.enabled)).toBe(true);

      const branches = await get(`/processes/${process.id}/branches`);
      expect(branches.status, JSON.stringify(branches.body)).toBe(200);
      const view = (
        branches.body as {
          data: {
            splitStageKey: string;
            joinStageKey: string;
            openBranchesLeft: number;
            branches: { branchKey: string; status: string; passes: unknown[] }[];
          };
        }
      ).data;
      expect(view).toMatchObject({
        splitStageKey: 'RAMIFICACAO_ANALISES',
        joinStageKey: 'JUNCAO_ANALISES',
        openBranchesLeft: 2,
      });
      expect(view.branches.find((b) => b.branchKey === 'JURIDICO')?.passes).toHaveLength(2);

      const movements = await get(`/processes/${process.id}/movements?branchKey=JURIDICO`);
      expect(movements.status, JSON.stringify(movements.body)).toBe(200);
      const items = (movements.body as { data: { branchKey: string | null }[] }).data;
      expect(items.length).toBeGreaterThan(0);
      expect(items.every((item) => item.branchKey === 'JURIDICO')).toBe(true);
    });

    it('PRC-39 fora da ramificação: data null; de outro tenant: 404 PROCESS_NOT_FOUND', async () => {
      const process = await processAtTerm();
      const none = await get(`/processes/${process.id}/branches`);
      expect(none.status, JSON.stringify(none.body)).toBe(200);
      expect((none.body as { data: unknown }).data).toBeNull();

      const branched = await processInBranches();
      const foreign = await get(`/processes/${branched.id}/branches`, 'sub-heitor', B);
      expectProblem(foreign, 404, 'PROCESS_NOT_FOUND');
      expect(JSON.stringify(foreign.body)).not.toContain(branched.title);
    });
  });

  describe('[Validação]', () => {
    it('Ação sem informar o ramo: 422 PROCESS_STAGE_REQUIRED e nenhum movimento', async () => {
      const process = await processInBranches();
      const movements = repository().movementsOf(process.id).length;

      const response = await forwardStage(process.id, 'JURIDICO', TO_REVISION, {
        subject: 'sub-fabio',
        omitStage: true,
      });

      expectProblem(response, 422, 'PROCESS_STAGE_REQUIRED');
      expect(repository().movementsOf(process.id)).toHaveLength(movements);
    });

    it('Leitor do MVP 1 com expectedStageId = currentStageId (o split): 409 STAGE_CHANGED', async () => {
      const process = await processInBranches();

      const response = await post(
        'forward',
        process,
        { transitionId: TO_REVISION, expectedStageId: process.currentStageId },
        { subject: 'sub-fabio' },
      );

      expectProblem(response, 409, 'STAGE_CHANGED');
    });

    it('Etapa que não é do processo: 422 PROCESS_STAGE_INVALID', async () => {
      const process = await processInBranches();

      const response = await post(
        'forward',
        process,
        {
          transitionId: TO_REVISION,
          expectedStageId: process.currentStageId,
          processStageId: process.currentStageId,
        },
        { subject: 'sub-fabio' },
      );

      expectProblem(response, 422, 'PROCESS_STAGE_INVALID');
    });

    it('Regra de saída da junção violada no último ramo: 422 TRANSITION_BLOCKED e ramo OPEN', async () => {
      const process = await processInBranches();
      await forwardStage(process.id, 'JURIDICO', TO_REVISION, { subject: 'sub-fabio' }).expect(200);
      await forwardStage(process.id, 'REVISAO_JURIDICA', REVISION_TO_JOIN, {
        subject: 'sub-fabio',
      }).expect(200);
      facts.set(process.id, [
        {
          documentTypeCode: 'ETP',
          status: 'DRAFT',
          isComplete: false,
          versionNumber: 1,
          approvedAt: null,
        },
      ]);
      const arrivedBefore = eventsOf(process.id, 'ProcessBranchArrived').length;

      const response = await forwardStage(process.id, 'CONTROLE_INTERNO', CI_TO_JOIN, {
        subject: 'sub-lucia',
      });

      const problem = expectProblem(response, 422, 'TRANSITION_BLOCKED');
      expect(JSON.stringify(problem)).toContain(OPINION_MESSAGE);
      expect(
        repository()
          .branchesOf(process.id)
          .find((b) => b.branchKey === 'CONTROLE_INTERNO')?.status,
      ).toBe('OPEN');
      expect(eventsOf(process.id, 'ProcessBranchArrived')).toHaveLength(arrivedBefore);
      expect(stageOf(process.id, 'CONTROLE_INTERNO').status).toBe('ACTIVE');
    });

    it('Devolver antes do split sem confirmar: 422 BRANCH_CANCELLATION_NOT_CONFIRMED', async () => {
      const process = await processInBranches();
      const juridico = stageOf(process.id, 'JURIDICO');

      const response = await post(
        'return',
        process,
        {
          processStageId: juridico.id,
          targetStageId: flow.stageId('TERMO_REFERENCIA'),
          comment: 'Ajustar o objeto antes das análises.',
        },
        { subject: 'sub-fabio' },
      );

      expectProblem(response, 422, 'BRANCH_CANCELLATION_NOT_CONFIRMED');
      expect(
        repository()
          .branchesOf(process.id)
          .every((b) => b.status === 'OPEN'),
      ).toBe(true);
    });
  });

  describe('[Permissão]', () => {
    it('Quem tem um ramo não age no outro: 403 NOT_PROCESS_CUSTODIAN e access.denied', async () => {
      const process = await processInBranches();

      const response = await forwardStage(process.id, 'CONTROLE_INTERNO', CI_TO_JOIN, {
        subject: 'sub-fabio',
      });

      expectProblem(response, 403, 'NOT_PROCESS_CUSTODIAN');
      expect(api.auditRecords().at(-1)).toMatchObject({
        action: 'access.denied',
        reasonCode: 'NOT_PROCESS_CUSTODIAN',
      });
      expect(stageOf(process.id, 'CONTROLE_INTERNO').status).toBe('ACTIVE');
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Processo de outro tenant em ramificação: 404 PROCESS_NOT_FOUND, nada revelado', async () => {
      const process = await processInBranches();

      const response = await forwardStage(process.id, 'JURIDICO', TO_REVISION, {
        subject: 'sub-heitor',
        tenant: B,
      });

      expectProblem(response, 404, 'PROCESS_NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toContain(process.title);
    });
  });

  describe('[Duplicidade]', () => {
    it('Reenvio do último ramo com a mesma chave: replay sem segunda junção; outra chave: 409 STAGE_CHANGED', async () => {
      const process = await processInBranches();
      await forwardStage(process.id, 'JURIDICO', TO_REVISION, { subject: 'sub-fabio' }).expect(200);
      await forwardStage(process.id, 'REVISAO_JURIDICA', REVISION_TO_JOIN, {
        subject: 'sub-fabio',
      }).expect(200);
      const ci = stageOf(process.id, 'CONTROLE_INTERNO');
      const version = stored(process.id).version;
      const body = { transitionId: CI_TO_JOIN, expectedStageId: ci.id, processStageId: ci.id };

      const first = await post('forward', { id: process.id, version }, body, {
        subject: 'sub-lucia',
        key: K77,
      });
      const movements = repository().movementsOf(process.id).length;
      const replay = await post('forward', { id: process.id, version }, body, {
        subject: 'sub-lucia',
        key: K77,
      });

      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(replay.status).toBe(200);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(repository().movementsOf(process.id)).toHaveLength(movements);
      expect(eventsOf(process.id, 'ProcessBranchesJoined')).toHaveLength(1);

      const again = await post('forward', stored(process.id), body, { subject: 'sub-lucia' });
      expectProblem(again, 409, 'STAGE_CHANGED');
    });
  });

  describe('[Concorrência]', () => {
    it('Os dois últimos ramos terminam ao mesmo tempo: exatamente uma junção, sem 5xx', async () => {
      const process = await processInBranches();
      await forwardStage(process.id, 'JURIDICO', TO_REVISION, { subject: 'sub-fabio' }).expect(200);
      const version = stored(process.id).version;
      const revision = stageOf(process.id, 'REVISAO_JURIDICA');
      const ci = stageOf(process.id, 'CONTROLE_INTERNO');

      const responses = await Promise.all([
        post(
          'forward',
          { id: process.id, version },
          {
            transitionId: REVISION_TO_JOIN,
            expectedStageId: revision.id,
            processStageId: revision.id,
          },
          { subject: 'sub-fabio' },
        ),
        post(
          'forward',
          { id: process.id, version },
          { transitionId: CI_TO_JOIN, expectedStageId: ci.id, processStageId: ci.id },
          { subject: 'sub-lucia' },
        ),
      ]);

      expect(responses.every((response) => response.status < 500)).toBe(true);
      expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
      const loser = responses.find((response) => response.status !== 200);
      expect(loser?.status).toBe(412);
      // O perdedor recarrega e repete: a junção acontece uma única vez.
      const retry = loser === responses[0] ? revision : ci;
      const retried = await post(
        'forward',
        stored(process.id),
        {
          transitionId: retry === revision ? REVISION_TO_JOIN : CI_TO_JOIN,
          expectedStageId: retry.id,
          processStageId: retry.id,
        },
        { subject: retry === revision ? 'sub-fabio' : 'sub-lucia' },
      );
      expect(retried.status, JSON.stringify(retried.body)).toBe(200);
      expect(eventsOf(process.id, 'ProcessBranchesJoined')).toHaveLength(1);
      expect(activeStages(process.id).map((stage) => stage.workflowStageId)).toEqual([
        flow.stageId('AUTORIZACAO_LICITACAO'),
      ]);
      expectInvariants(process.id);
    });

    it('Devolução para antes do split enquanto o outro ramo é encaminhado: o perdedor recebe 409 STAGE_CHANGED', async () => {
      const process = await processInBranches();
      const juridico = stageOf(process.id, 'JURIDICO');
      const ci = stageOf(process.id, 'CONTROLE_INTERNO');

      const [returned, forwarded] = await Promise.all([
        post(
          'return',
          process,
          {
            processStageId: juridico.id,
            targetStageId: flow.stageId('TERMO_REFERENCIA'),
            confirmBranchCancellation: true,
            comment: 'Ajustar o objeto antes das análises.',
          },
          { subject: 'sub-fabio' },
        ),
        post(
          'forward',
          process,
          { transitionId: CI_TO_JOIN, expectedStageId: ci.id, processStageId: ci.id },
          { subject: 'sub-lucia', version: process.version + 1 },
        ),
      ]);

      expect(returned.status, JSON.stringify(returned.body)).toBe(200);
      expectProblem(forwarded, 409, 'STAGE_CHANGED');
      expect(
        activeStages(process.id).filter(
          (stage) => stage.branchKey !== null && stage.branchKey !== undefined,
        ),
      ).toEqual([]);
      expectInvariants(process.id);
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível no último ramo: 503 DEPENDENCY_UNAVAILABLE e nada muda', async () => {
      const process = await processInBranches();
      await forwardStage(process.id, 'JURIDICO', TO_REVISION, { subject: 'sub-fabio' }).expect(200);
      await forwardStage(process.id, 'REVISAO_JURIDICA', REVISION_TO_JOIN, {
        subject: 'sub-fabio',
      }).expect(200);
      transactions.down = true;

      const response = await forwardStage(process.id, 'CONTROLE_INTERNO', CI_TO_JOIN, {
        subject: 'sub-lucia',
      });

      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      transactions.down = false;
      expect(
        repository()
          .branchesOf(process.id)
          .map((b) => [b.branchKey, b.status]),
      ).toEqual([
        ['JURIDICO', 'ARRIVED'],
        ['CONTROLE_INTERNO', 'OPEN'],
      ]);
      expect(
        repository()
          .stagesOf(process.id)
          .some((stage) => stage.workflowStageId === flow.stageId('JUNCAO_ANALISES')),
      ).toBe(false);
    });
  });
});
