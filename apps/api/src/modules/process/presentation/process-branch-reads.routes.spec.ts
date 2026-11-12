import { randomUUID } from 'node:crypto';

import { problemDetailsSchema } from '@contrataflow/validation';
import type {
  ApprovalDto,
  ApprovalListItemDto,
  BulkItemResultDto,
  ProcessDto,
  ProcessListItemDto,
  ProcessSummaryDto,
  TaskInboxItemDto,
} from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import { mirrorListLineOf } from '../../../../test/support/approval-fixtures.js';
import {
  APPROVAL_LIST_READER,
  INBOX_CLOCK,
  INBOX_READER,
  InMemoryApprovalListReader,
  InMemoryInboxReader,
} from '../../../../test/support/branch-read-fixtures.js';
import type {
  ApprovalListRow,
  InboxProcessRow,
} from '../../../../test/support/branch-read-fixtures.js';
import { approvalRepositoryOf } from '../../../../test/support/document-fixtures.js';
import {
  CATALOG_CLOCK,
  catalogItemId,
  processRepositoryOf,
  runTenantSeeders,
  seedProcessStructure,
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
  seedCustomRole,
  seedDefaultRolesOf,
  seedDepartment,
} from '../../../../test/support/structure-fixtures.js';
import { seedPublishedInMemory } from '../../../../test/support/workflow-engine-fixtures.js';
import { DefinitionBuilder } from '../../../../test/support/workflow-fixtures.js';
import { PROCESS_CLOCK, PROCESS_TRANSACTIONS } from '../application/ports.js';
import type { ProcessTransactions } from '../application/ports.js';
import type { Process } from '../domain/process.js';

/*
 * US-125 — ramos paralelos nas LEITURAS (DEC-194 · RN-WF2-29..38) pelo pipeline HTTP completo com
 * a identidade fake e repositórios em memória: caixa de tarefas (TSK-01/02, linhas sincronizadas
 * do repositório do processo como a view `v_inbox_processes` as produziria), lote por ramo
 * (TSK-03), lista (PRC-01), painel (PRC-07) e aprovações (APV-01/02) — as 8 categorias do Gherkin.
 * O mesmo workflow da US-124: Fábio = "Paulo" (Procuradoria — ramo JURIDICO, 10 dias úteis),
 * Lúcia = "Rita" (Controle Interno — ramo CONTROLE_INTERNO, 5 dias úteis: a etapa crítica). As
 * views em PostgreSQL (uma linha por etapa ativa, RLS) ficam em `test/tenant-leak/inbox-branches`;
 * o job `deadlines` por ramo, em `apps/worker` (`deadline-scanner.spec.ts`).
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-05T15:00:00.000Z');
const ORG_A = '0192d125-0000-7000-8000-0000000000a0';
const ORG_B = '0192d125-0000-7000-8000-0000000000b0';
const UNITS_A = {
  organizationId: ORG_A,
  obras: '0192d125-0000-7000-8000-0000000000a1',
  manutencao: '0192d125-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d125-0000-7000-8000-0000000000a3',
  saude: '0192d125-0000-7000-8000-0000000000a4',
  posto: '0192d125-0000-7000-8000-0000000000a5',
};
const UNITS_B = {
  organizationId: ORG_B,
  obras: '0192d125-0000-7000-8000-0000000000b1',
  manutencao: '0192d125-0000-7000-8000-0000000000b2',
  pavimentacao: '0192d125-0000-7000-8000-0000000000b3',
  saude: '0192d125-0000-7000-8000-0000000000b4',
  posto: '0192d125-0000-7000-8000-0000000000b5',
};
const PLANEJAMENTO = '0192d125-0000-7000-8000-0000000000a6';
const PROCURADORIA = '0192d125-0000-7000-8000-0000000000a7';
const CONTROLE = '0192d125-0000-7000-8000-0000000000a8';
const FLOW_VERSION = '0192d125-0000-7000-8000-0000000000f1';

const membershipOf = (userId: string, tenantId = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

const fixed = (departmentId: string) => ({
  departmentResolution: 'FIXED' as const,
  fixedDepartmentId: departmentId,
  assignmentPolicy: 'DEPARTMENT_HEAD' as const,
});

/** O workflow da US-124 (TERMO_REFERENCIA → split → JURIDICO / CONTROLE_INTERNO → join). */
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
  .transition('CONTROLE_INTERNO', 'APROVACAO_CI', 'FORWARD', { isPrimary: true })
  .transition('CONTROLE_INTERNO', 'JUNCAO_ANALISES', 'FORWARD')
  .transition('CONTROLE_INTERNO', 'TERMO_REFERENCIA', 'RETURN')
  .transition('APROVACAO_CI', 'JUNCAO_ANALISES', 'APPROVE')
  .transition('APROVACAO_CI', 'CONTROLE_INTERNO', 'RETURN')
  .transition('JUNCAO_ANALISES', 'AUTORIZACAO_LICITACAO', 'FORWARD')
  .transition('AUTORIZACAO_LICITACAO', 'FIM', 'APPROVE')
  .transition('AUTORIZACAO_LICITACAO', 'TERMO_REFERENCIA', 'RETURN');

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

interface BulkBody {
  readonly data: BulkItemResultDto[];
  readonly meta: { readonly successCount: number; readonly errorCount: number };
}

describe('Feature: Ramos paralelos na caixa de tarefas, no painel situacional e nos prazos (US-125)', () => {
  let api: TestApi;
  let facts: TestDocumentFacts;
  const transactions = new FlakyTransactions();
  const inbox = new InMemoryInboxReader();
  const approvalList = new InMemoryApprovalListReader();
  let catalog: { contractingType: string; origin: string };
  const words = (count: number) =>
    Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

  const auth = (call: request.Test, subject = 'sub-ana', tenant: string = A) =>
    call
      .set('Authorization', api.bearer(subject, { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', tenant);
  const get = (path: string, subject = 'sub-ana', tenant: string = A) =>
    auth(request(api.server).get(`/api/v1${path}`), subject, tenant);
  const repository = () => processRepositoryOf(api);
  const stored = (id: string): Process => {
    const process = repository()
      .allProcesses()
      .find((candidate) => candidate.id === id);
    if (!process) throw new Error(`processo ${id} ausente`);
    return process;
  };
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

  const post = (
    path: string,
    process: Pick<Process, 'id' | 'version'>,
    body: Record<string, unknown>,
    options: { subject?: string; tenant?: string; key?: string } = {},
  ) =>
    auth(
      request(api.server).post(`/api/v1/processes/${process.id}/${path}`),
      options.subject,
      options.tenant,
    )
      .set('Idempotency-Key', options.key ?? randomUUID())
      .set('If-Match', `"${String(process.version)}"`)
      .send(body);
  const forwardStage = (
    processId: string,
    stageKey: string,
    transitionId: string,
    subject: string,
  ) => {
    const stage = stageOf(processId, stageKey);
    return post(
      'forward',
      stored(processId),
      { transitionId, expectedStageId: stage.id, processStageId: stage.id },
      { subject },
    );
  };
  const bulkClaim = (body: Record<string, unknown>, options: { subject?: string; key?: string }) =>
    auth(request(api.server).post('/api/v1/tasks/bulk-claim'), options.subject ?? 'sub-fabio')
      .set('Idempotency-Key', options.key ?? randomUUID())
      .send(body);
  const bulkOf = (response: request.Response): BulkBody => {
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response.body as BulkBody;
  };

  /**
   * As linhas de `v_inbox_processes` como a view as produz (US-125): uma por etapa ativa de
   * trabalho (o split fica de fora), com a responsabilidade ativa DA etapa.
   */
  const inboxRowsOf = (processId: string): InboxProcessRow[] => {
    const process = stored(processId);
    const assignments = repository()
      .assignmentsOf(processId)
      .filter((assignment) => assignment.isActive);
    return repository()
      .stagesOf(processId)
      .filter(
        (stage) =>
          stage.status === 'ACTIVE' &&
          stage.stageType !== 'PARALLEL_SPLIT' &&
          stage.stageType !== 'PARALLEL_JOIN',
      )
      .map((stage) => {
        // A view casa a responsabilidade pela etapa no ramo e pelo processo no tronco.
        const assignment =
          (stage.branchKey ?? null) === null
            ? assignments[0]
            : assignments.find((row) => row.processStageId === stage.id);
        return {
          tenantId: process.tenantId,
          id: process.id,
          organizationId: process.organizationId,
          code: process.code,
          number: process.number,
          year: process.year,
          title: process.title,
          status: process.status,
          version: process.version,
          isBudgetConfidential: process.isBudgetConfidential,
          requestingSecretariatId: process.requestingSecretariatId,
          requestingDepartmentId: process.requestingDepartmentId,
          currentDepartmentId: process.currentDepartmentId,
          currentResponsibleId: process.currentResponsibleId,
          currentWorkflowStageId: process.currentWorkflowStageId,
          stageId: stage.id,
          enteredAt: stage.enteredAt,
          dueAt: stage.dueAt,
          overdueSince: stage.overdueSince ?? null,
          slaType: stage.slaType,
          pausedAt: stage.pausedAt ?? null,
          assignmentDepartmentId: assignment?.departmentId ?? null,
          assigneeId: assignment?.assigneeId ?? null,
          assignmentType: assignment?.type ?? null,
          branchKey: stage.branchKey ?? null,
          stageWorkflowStageId: stage.workflowStageId,
          stageDepartmentId: stage.departmentId,
          activeStagesCount: process.activeStagesCount ?? 1,
        };
      });
  };
  /** Ressincroniza a caixa com o estado atual dos processos (o "ciclo seguinte" do polling). */
  const syncInbox = (...processIds: string[]) => {
    inbox.clear();
    inbox.seed({ processes: processIds.flatMap(inboxRowsOf) });
  };
  const tasksOf = async (view: string, subject: string, query = '') => {
    const response = await get(`/tasks?view=${view}${query}`, subject);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return (response.body as { data: TaskInboxItemDto[] }).data;
  };

  /** Processo criado pelo PRC-02 e posto em TERMO_REFERENCIA (Ana responsável, Planejamento). */
  async function processAtTerm(tenant: string = A): Promise<Process> {
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
      tenantId: tenant,
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
    const number = Math.floor(Math.random() * 9000) + 100;
    const process: Process = {
      ...created,
      workflowVersionId: FLOW_VERSION,
      status: 'IN_PROGRESS',
      currentStageId: term,
      currentWorkflowStageId: flow.stageId('TERMO_REFERENCIA'),
      currentDepartmentId: PLANEJAMENTO,
      currentResponsibleId: FAKE_USERS.ana.id,
      number,
      code: `${String(number).padStart(4, '0')}/2026`,
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

  /** Background: o processo em ramificação — JURIDICO com Fábio, CONTROLE_INTERNO com Lúcia. */
  async function processInBranches(): Promise<Process> {
    const process = await processAtTerm();
    const response = await post('forward', process, {
      transitionId: TO_SPLIT,
      expectedStageId: process.currentStageId,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return stored(process.id);
  }

  /** O ramo JURIDICO devolvido à fila da Procuradoria (PRC-22 sem responsável). */
  async function juridicoInQueue(process: Process): Promise<string> {
    const juridico = stageOf(process.id, 'JURIDICO');
    const response = await post(
      'assign',
      stored(process.id),
      { processStageId: juridico.id, assigneeId: null, reason: 'Redistribuir na Procuradoria.' },
      { subject: 'sub-lucia' },
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return juridico.id;
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
        { token: INBOX_READER, value: inbox },
        { token: INBOX_CLOCK, value: () => NOW },
        { token: APPROVAL_LIST_READER, value: approvalList },
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
    await seedPublishedInMemory(api, A, flow, 'TESTE_US125');
    await deactivateWorkflow(api, A, 'TESTE_US125');
    facts = registerTestDocumentFacts(api);
    assignDepartment(api, membershipOf(FAKE_USERS.ana.id), UNITS_A.manutencao);
    assignDepartment(api, membershipOf(FAKE_USERS.ana.id), PLANEJAMENTO);
    assignDepartment(api, membershipOf(FAKE_USERS.fabio.id), PROCURADORIA);
    assignDepartment(api, membershipOf(FAKE_USERS.lucia.id), CONTROLE);
    assignDepartment(api, membershipOf(FAKE_USERS.marta.id), UNITS_A.obras);
    setDepartmentHead(api, PROCURADORIA, FAKE_USERS.fabio.id);
    setDepartmentHead(api, CONTROLE, FAKE_USERS.lucia.id);
    setDepartmentHead(api, UNITS_A.obras, FAKE_USERS.marta.id);
    assignRole(api, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.marta.id),
      roleId: seedDefaultRolesOf(api, A).get('AUTORIDADE_COMPETENTE')?.id ?? '',
    });
    // "Lia" (concorrência): Ana também na Procuradoria, com PROCESS_CLAIM pelo perfil de Compras.
    assignDepartment(api, membershipOf(FAKE_USERS.ana.id), PROCURADORIA);
    assignRole(api, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.ana.id),
      roleId: seedDefaultRolesOf(api, A).get('COMPRAS')?.id ?? '',
    });
    // "Bruno" (permissão): Otávio só consulta processos — sem INBOX_VIEW.
    const viewOnly = seedCustomRole(api, A, 'Somente consulta US-125', ['PROCESS_VIEW']);
    assignRole(api, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.otavio.id),
      roleId: viewOnly.id,
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
  beforeEach(() => {
    inbox.clear();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    transactions.down = false;
  });

  describe('[Sucesso]', () => {
    it('A caixa mostra uma linha por ramo e os contadores contam linhas', async () => {
      const process = await processInBranches();
      const other = await processAtTerm();
      syncInbox(process.id);
      // "0046/2026" sem ramificação, com a Lúcia responsável (linha do MVP 1).
      const [trunk] = inboxRowsOf(other.id);
      if (!trunk) throw new Error('linha do tronco ausente');
      inbox.seed({
        processes: [
          {
            ...trunk,
            assigneeId: FAKE_USERS.lucia.id,
            currentResponsibleId: FAKE_USERS.lucia.id,
          },
        ],
      });
      const ci = stageOf(process.id, 'CONTROLE_INTERNO');
      const audits = api.auditRecords().length;
      const events = api.outboxRows().length;

      const rows = await tasksOf('MINE', 'sub-lucia');

      expect(rows).toHaveLength(2);
      const branch = rows.find((row) => row.processId === process.id);
      expect(branch).toMatchObject({
        id: process.id,
        rowKey: `${process.id}:${ci.id}`,
        processStageId: ci.id,
        branchKey: 'CONTROLE_INTERNO',
        branchLabel: 'Controle interno',
        activeStagesCount: 2,
        currentStage: { key: 'CONTROLE_INTERNO', name: 'Controle interno' },
        currentDepartment: { id: CONTROLE, name: 'Controle Interno' },
        currentResponsible: { id: FAKE_USERS.lucia.id },
        dueAt: ci.dueAt?.toISOString() ?? null,
        siblings: [
          {
            branchKey: 'JURIDICO',
            branchLabel: 'Análise jurídica',
            stageName: 'Análise jurídica',
            status: 'OPEN',
            isOverdue: false,
          },
        ],
        siblingsMore: 0,
      });
      const plain = rows.find((row) => row.processId === other.id);
      expect(plain).toMatchObject({
        id: other.id,
        rowKey: other.id,
        branchKey: null,
        branchLabel: null,
        siblings: [],
        activeStagesCount: 1,
      });
      // RN-WF2-30: sem pessoas nem valores nos irmãos.
      expect(JSON.stringify(branch?.siblings)).not.toContain(FAKE_USERS.fabio.id);

      const counters = await get('/tasks/counters', 'sub-lucia');
      expect(counters.status, JSON.stringify(counters.body)).toBe(200);
      expect(counters.body).toMatchObject({ data: { mine: 2 }, meta: { countUnit: 'ROW' } });
      // Leitura: nem auditoria nem evento.
      expect(api.auditRecords()).toHaveLength(audits);
      expect(api.outboxRows()).toHaveLength(events);
    });

    it('O painel lista as etapas ativas e o prazo do processo é o menor', async () => {
      const process = await processInBranches();
      const ci = stageOf(process.id, 'CONTROLE_INTERNO');
      const juridico = stageOf(process.id, 'JURIDICO');
      expect(ci.dueAt?.getTime()).toBeLessThan(juridico.dueAt?.getTime() ?? 0);

      const response = await get(`/processes/${process.id}/summary`, 'sub-lucia');

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const summary = (response.body as { data: ProcessSummaryDto }).data;
      expect(summary.where.stage?.type).toBe('PARALLEL_SPLIT');
      expect(summary.where.stages?.map((stage) => [stage.stageKey, stage.isMine]).sort()).toEqual([
        ['CONTROLE_INTERNO', true],
        ['JURIDICO', false],
      ]);
      expect(summary.where.branches?.map((branch) => [branch.branchKey, branch.status])).toEqual([
        ['JURIDICO', 'OPEN'],
        ['CONTROLE_INTERNO', 'OPEN'],
      ]);
      expect(summary.deadline?.dueAt).toBe(ci.dueAt?.toISOString());
      expect(summary.deadline?.criticalStage).toEqual({
        processStageId: ci.id,
        branchKey: 'CONTROLE_INTERNO',
        stageName: 'Controle interno',
      });
      const byStage = summary.nextStep.byStage ?? [];
      const mine = byStage.find((entry) => entry.isMine);
      expect(mine?.branchKey).toBe('CONTROLE_INTERNO');
      expect(mine?.action?.action).toBe('FORWARD');
      expect(mine?.waitingFor).toBeNull();
      expect(byStage.find((entry) => !entry.isMine)).toMatchObject({
        branchKey: 'JURIDICO',
        action: null,
        waitingFor: { stageName: 'Análise jurídica', departmentName: 'Procuradoria' },
      });
      expect(summary.responsible.byStage?.map((entry) => entry.user?.id).sort()).toEqual(
        [FAKE_USERS.fabio.id, FAKE_USERS.lucia.id].sort(),
      );
    });

    it('A lista mostra as etapas ativas e o menor prazo; o filtro casa com qualquer etapa ativa', async () => {
      const process = await processInBranches();
      const ci = stageOf(process.id, 'CONTROLE_INTERNO');

      const list = async (query: string) => {
        const response = await get(`/processes?${query}`, 'sub-lucia');
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        return (response.body as { data: ProcessListItemDto[] }).data;
      };

      const byControl = await list(`currentDepartmentId=${CONTROLE}`);
      const item = byControl.find((row) => row.id === process.id);
      expect(item?.activeStagesCount).toBe(2);
      expect(item?.activeStages?.map((stage) => [stage.branchKey, stage.departmentName])).toEqual(
        expect.arrayContaining([
          ['JURIDICO', 'Procuradoria'],
          ['CONTROLE_INTERNO', 'Controle Interno'],
        ]) as unknown,
      );
      expect(item?.deadline.dueAt).toBe(ci.dueAt?.toISOString());
      expect(item?.deadline.criticalStage?.branchKey).toBe('CONTROLE_INTERNO');
      // Etapa e responsável de QUALQUER ramo.
      expect(
        (await list(`currentWorkflowStageId=${flow.stageId('JURIDICO')}`)).map((row) => row.id),
      ).toContain(process.id);
      expect(
        (await list(`currentResponsibleId=${FAKE_USERS.lucia.id}`)).map((row) => row.id),
      ).toContain(process.id);
      expect(
        (await list(`currentResponsibleId=${FAKE_USERS.ana.id}`)).map((row) => row.id),
      ).not.toContain(process.id);
    });

    it('Assumir em lote por ramo: um item por etapa, auditoria e evento por item', async () => {
      const first = await processInBranches();
      const second = await processInBranches();
      const items = [
        { processId: first.id, processStageId: await juridicoInQueue(first) },
        { processId: second.id, processStageId: await juridicoInQueue(second) },
      ];
      const assignedBefore = [first, second].map(
        (process) => eventsOf(process.id, 'ProcessAssigned').length,
      );

      const result = bulkOf(await bulkClaim({ items }, {}));

      expect(result.meta).toEqual({ successCount: 2, errorCount: 0 });
      expect(result.data.map((item) => item.processStageId)).toEqual(
        items.map((item) => item.processStageId),
      );
      for (const [index, item] of items.entries()) {
        expect(
          repository()
            .stagesOf(item.processId)
            .find((s) => s.id === item.processStageId),
        ).toMatchObject({ assigneeId: FAKE_USERS.fabio.id });
        const [audit] = auditOf(item.processId, 'process.claim');
        expect(audit?.metadata).toMatchObject({
          processStageId: item.processStageId,
          branchKey: 'JURIDICO',
        });
        expect(eventsOf(item.processId, 'ProcessAssigned')).toHaveLength(
          (assignedBefore[index] ?? 0) + 1,
        );
      }
    });

    it('APV-01/APV-02 e o painel mostram o ramo da aprovação e os outros ramos', async () => {
      const process = await processInBranches();
      await forwardStage(process.id, 'CONTROLE_INTERNO', CI_TO_APPROVAL, 'sub-lucia').expect(200);
      const approvalStage = stageOf(process.id, 'APROVACAO_CI');
      const [pending] = approvalRepositoryOf(api)
        .approvals()
        .filter((approval) => approval.processStageId === approvalStage.id);
      if (!pending) throw new Error('aprovação pendente ausente');
      // A linha de APV-01 como a consulta sobre `approvals` a produz (com a etapa da aprovação).
      const current = stored(process.id);
      const listRow: ApprovalListRow = {
        tenantId: A,
        id: pending.id,
        processId: process.id,
        subjectType: pending.subjectType,
        title: pending.title,
        documentId: null,
        processStageId: approvalStage.id,
        status: 'PENDING',
        requestedById: pending.requestedById,
        requestedAt: pending.requestedAt,
        dueAt: pending.dueAt,
        approverType: pending.approverType,
        approverUserId: pending.approverUserId,
        approverRoleId: pending.approverRoleId,
        approverDepartmentId: pending.approverDepartmentId,
        allowDeputy: pending.allowDeputy,
        decidedById: null,
        process: {
          code: current.code,
          number: current.number,
          year: current.year,
          title: current.title,
          organizationId: current.organizationId,
          requestingSecretariatId: current.requestingSecretariatId,
          requestingDepartmentId: current.requestingDepartmentId,
          isBudgetConfidential: current.isBudgetConfidential,
        },
        decisionPolicy: 'ANY',
        lines: [],
      };
      approvalList.seed([{ ...listRow, lines: [mirrorListLineOf(listRow, newId())] }]);

      const list = await get('/approvals?status=PENDING', 'sub-marta');
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      const row = (list.body as { data: ApprovalListItemDto[] }).data.find(
        (item) => item.id === pending.id,
      );
      expect(row).toMatchObject({
        branchKey: 'CONTROLE_INTERNO',
        branchLabel: 'Controle interno',
        siblings: [{ branchKey: 'JURIDICO', status: 'OPEN', stageName: 'Análise jurídica' }],
        siblingsMore: 0,
      });

      const detail = await get(`/approvals/${pending.id}`, 'sub-marta');
      expect(detail.status, JSON.stringify(detail.body)).toBe(200);
      expect((detail.body as { data: ApprovalDto }).data).toMatchObject({
        branchKey: 'CONTROLE_INTERNO',
        siblings: [{ branchKey: 'JURIDICO' }],
      });

      const summary = await get(`/processes/${process.id}/summary`, 'sub-lucia');
      const approvals = (summary.body as { data: ProcessSummaryDto }).data.approvals;
      expect(approvals.find((item) => item.id === pending.id)?.branchKey).toBe('CONTROLE_INTERNO');
    });

    it('Alerta de atraso por ramo: só o responsável do ramo atrasado vê a linha em "Atrasados"; o processo aparece atrasado', async () => {
      const process = await processInBranches();
      const juridico = stageOf(process.id, 'JURIDICO');
      // O job `deadlines` marcou o ramo JURIDICO (vencido ontem); o CONTROLE_INTERNO, não.
      repository().seedStage({
        ...juridico,
        dueAt: new Date('2026-10-04T02:59:59.999Z'),
        overdueSince: new Date('2026-10-04T03:15:00.000Z'),
      });
      // …e desnormalizou o atraso no processo (`processes.overdue_since`).
      repository().setListExtras(process.id, {
        overdueSince: new Date('2026-10-04T03:15:00.000Z'),
      });
      syncInbox(process.id);

      const fabio = await tasksOf('OVERDUE', 'sub-fabio');
      expect(fabio.map((row) => [row.processId, row.branchKey, row.isOverdue])).toEqual([
        [process.id, 'JURIDICO', true],
      ]);
      expect(await tasksOf('OVERDUE', 'sub-lucia')).toEqual([]);
      const [rita] = await tasksOf('MINE', 'sub-lucia');
      expect(rita?.siblings).toEqual([
        expect.objectContaining({ branchKey: 'JURIDICO', isOverdue: true }),
      ]);

      const response = await get('/processes?overdue=true', 'sub-lucia');
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const listed = (response.body as { data: ProcessListItemDto[] }).data.find(
        (item) => item.id === process.id,
      );
      expect(listed?.deadline.isOverdue).toBe(true);
      expect(listed?.deadline.criticalStage?.branchKey).toBe('JURIDICO');
    });

    it('FA-02/FA-03: o ramo concluído sai da caixa; na junção, as linhas dos ramos dão lugar à etapa seguinte', async () => {
      const process = await processInBranches();
      await forwardStage(process.id, 'JURIDICO', TO_REVISION, 'sub-fabio').expect(200);
      await forwardStage(process.id, 'REVISAO_JURIDICA', REVISION_TO_JOIN, 'sub-fabio').expect(200);
      syncInbox(process.id);

      expect(await tasksOf('MINE', 'sub-fabio')).toEqual([]);
      const [rita] = await tasksOf('MINE', 'sub-lucia');
      expect(rita?.siblings).toEqual([
        expect.objectContaining({ branchKey: 'JURIDICO', status: 'ARRIVED' }),
      ]);
      const summary = await get(`/processes/${process.id}/summary`, 'sub-lucia');
      const branches = (summary.body as { data: ProcessSummaryDto }).data.where.branches;
      expect(branches?.find((branch) => branch.branchKey === 'JURIDICO')).toMatchObject({
        status: 'ARRIVED',
        arrivedAt: NOW.toISOString(),
      });

      await forwardStage(process.id, 'CONTROLE_INTERNO', CI_TO_JOIN, 'sub-lucia').expect(200);
      syncInbox(process.id);
      const rows = inboxRowsOf(process.id);
      expect(rows.map((row) => row.branchKey)).toEqual([null]);
      const after = await get(`/processes/${process.id}/summary`, 'sub-lucia');
      const data = (after.body as { data: ProcessSummaryDto }).data;
      expect(data.where.stage?.key).toBe('AUTORIZACAO_LICITACAO');
      expect(data.where.stages).toBeUndefined();
      expect(data.deadline?.criticalStage).toBeUndefined();
    });
  });

  describe('[Validação]', () => {
    it('Lote com os dois formatos de seleção: 422 NOT_ALLOWED; processIds de processo com dois ramos: item PROCESS_STAGE_REQUIRED', async () => {
      const both = await processInBranches();
      const stage = await juridicoInQueue(both);
      const body = expectProblem(
        await bulkClaim(
          {
            items: [
              { processId: both.id, processStageId: stage },
              { processId: both.id, processStageId: stageOf(both.id, 'CONTROLE_INTERNO').id },
            ],
            processIds: [both.id, newId()],
          },
          {},
        ),
        422,
        'VALIDATION_ERROR',
      );
      expect(JSON.stringify(body)).toContain('NOT_ALLOWED');

      // Outro processo com um único ramo restante (o CONTROLE_INTERNO chegou à junção).
      const single = await processInBranches();
      await juridicoInQueue(single);
      await forwardStage(single.id, 'CONTROLE_INTERNO', CI_TO_JOIN, 'sub-lucia').expect(200);

      const result = bulkOf(await bulkClaim({ processIds: [both.id, single.id] }, {}));

      expect(result.data.map((item) => [item.processId, item.ok, item.code ?? null])).toEqual([
        [both.id, false, 'PROCESS_STAGE_REQUIRED'],
        [single.id, true, null],
      ]);
      expect(stageOf(single.id, 'JURIDICO').assigneeId).toBe(FAKE_USERS.fabio.id);
    });
  });

  describe('[Permissão]', () => {
    it('Quem não é da unidade do ramo não o vê na fila; sem INBOX_VIEW → 403 e access.denied', async () => {
      const process = await processInBranches();
      await juridicoInQueue(process);
      syncInbox(process.id);

      expect((await tasksOf('UNIT_QUEUE', 'sub-fabio')).map((row) => row.branchKey)).toEqual([
        'JURIDICO',
      ]);
      expect((await tasksOf('UNIT_QUEUE', 'sub-lucia')).map((row) => row.processId)).not.toContain(
        process.id,
      );
      expect((await tasksOf('UNIT_QUEUE', 'sub-marta')).map((row) => row.processId)).not.toContain(
        process.id,
      );

      const denied = api.auditRecords().filter((row) => row.action === 'access.denied').length;
      // "Bruno": só consulta processos, sem INBOX_VIEW (Otávio, com o perfil do `beforeAll`).
      expectProblem(await get('/tasks?view=MINE', 'sub-otavio'), 403, 'PERMISSION_DENIED');
      expect(api.auditRecords().filter((row) => row.action === 'access.denied').length).toBe(
        denied + 1,
      );
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Linhas e ramos de outro tenant não aparecem; o resumo responde 404 PROCESS_NOT_FOUND', async () => {
      const process = await processInBranches();
      syncInbox(process.id);
      // A mesma linha "vista" de outro tenant: o leitor só devolve as do tenant da requisição.
      inbox.seed({ processes: inboxRowsOf(process.id).map((row) => ({ ...row, tenantId: B })) });

      const counters = await get('/tasks/counters', 'sub-lucia');
      expect(counters.body).toMatchObject({ data: { mine: 1 } });

      expectProblem(
        await get(`/processes/${process.id}/summary`, 'sub-heitor', B),
        404,
        'PROCESS_NOT_FOUND',
      );
      const list = await get('/processes', 'sub-heitor', B);
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      expect((list.body as { data: { id: string }[] }).data.map((row) => row.id)).not.toContain(
        process.id,
      );
    });
  });

  describe('[Duplicidade]', () => {
    it('Reenvio do lote por ramo com a mesma chave: mesmo resultado, Idempotent-Replayed e nada reprocessado', async () => {
      const process = await processInBranches();
      const stage = await juridicoInQueue(process);
      const other = await processInBranches();
      const otherStage = await juridicoInQueue(other);
      const items = [
        { processId: process.id, processStageId: stage },
        { processId: other.id, processStageId: otherStage },
      ];
      const key = randomUUID();
      const original = bulkOf(await bulkClaim({ items }, { key }));
      const claims = auditOf(process.id, 'process.claim').length;
      const assigned = eventsOf(process.id, 'ProcessAssigned').length;

      const replay = await bulkClaim({ items }, { key });

      expect(bulkOf(replay)).toEqual(original);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(auditOf(process.id, 'process.claim')).toHaveLength(claims);
      expect(eventsOf(process.id, 'ProcessAssigned')).toHaveLength(assigned);
    });
  });

  describe('[Concorrência]', () => {
    it('Duas pessoas assumem o mesmo ramo: uma vence, a outra recebe PROCESS_ALREADY_ASSIGNED', async () => {
      const first = await processInBranches();
      const second = await processInBranches();
      const items = [
        { processId: first.id, processStageId: await juridicoInQueue(first) },
        { processId: second.id, processStageId: await juridicoInQueue(second) },
      ];
      // "Lia": Ana, lotada também na Procuradoria e com o perfil de Compras (`beforeAll`).

      const [paulo, lia] = await Promise.all([
        bulkClaim({ items }, { subject: 'sub-fabio' }),
        bulkClaim({ items }, { subject: 'sub-ana' }),
      ]);

      const results = [bulkOf(paulo), bulkOf(lia)];
      for (const [index, item] of items.entries()) {
        const outcomes = results.map((result) => result.data[index]);
        expect(outcomes.filter((outcome) => outcome?.ok)).toHaveLength(1);
        expect(
          outcomes.find((outcome) => outcome?.ok === false),
          JSON.stringify(outcomes),
        ).toMatchObject({ code: 'PROCESS_ALREADY_ASSIGNED' });
        const stage = repository()
          .stagesOf(item.processId)
          .find((candidate) => candidate.id === item.processStageId);
        expect(stage?.assigneeId).not.toBeNull();
        syncInbox(item.processId);
        expect(
          inboxRowsOf(item.processId).filter((row) => row.branchKey === 'JURIDICO'),
        ).toHaveLength(1);
      }
    });

    it('Ramo movimentado enquanto a caixa estava aberta: "Assumir" na linha antiga → STAGE_CHANGED', async () => {
      const process = await processInBranches();
      const stage = await juridicoInQueue(process);
      // Outra pessoa assumiu e encaminhou o ramo enquanto a linha antiga seguia na tela.
      await post(
        'claim',
        stored(process.id),
        { processStageId: stage },
        {
          subject: 'sub-fabio',
        },
      ).expect(200);
      await forwardStage(process.id, 'JURIDICO', TO_REVISION, 'sub-fabio').expect(200);

      const result = bulkOf(
        await bulkClaim(
          {
            items: [
              { processId: process.id, processStageId: stage },
              {
                processId: process.id,
                processStageId: stageOf(process.id, 'CONTROLE_INTERNO').id,
              },
            ],
          },
          { subject: 'sub-fabio' },
        ),
      );

      expect(result.data[0]).toMatchObject({ ok: false, code: 'STAGE_CHANGED' });
      syncInbox(process.id);
      const keys = inboxRowsOf(process.id).map((row) => row.stageWorkflowStageId);
      expect(keys).toContain(flow.stageId('REVISAO_JURIDICA'));
      expect(keys).not.toContain(flow.stageId('JURIDICO'));
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível ao abrir o painel do processo: 503 DEPENDENCY_UNAVAILABLE', async () => {
      const process = await processInBranches();
      transactions.down = true;

      expectProblem(
        await get(`/processes/${process.id}/summary`, 'sub-lucia'),
        503,
        'DEPENDENCY_UNAVAILABLE',
      );
    });
  });

  describe('[Compatibilidade] DEC-108', () => {
    it('Processo sem ramificação: PRC-07 e PRC-01 sem nenhum campo de ramo; TSK-01 com a linha do MVP 1', async () => {
      const process = await processAtTerm();
      syncInbox(process.id);

      const summary = await get(`/processes/${process.id}/summary`);
      const data = (summary.body as { data: ProcessSummaryDto }).data;
      expect(data.where).not.toHaveProperty('stages');
      expect(data.where).not.toHaveProperty('branches');
      expect(data.responsible).not.toHaveProperty('byStage');
      expect(data.nextStep).not.toHaveProperty('byStage');
      expect(data.deadline).not.toHaveProperty('criticalStage');
      expect(data.pending.items.every((item) => !('processStageId' in item))).toBe(true);

      const list = await get('/processes');
      const item = (list.body as { data: ProcessListItemDto[] }).data.find(
        (row) => row.id === process.id,
      );
      expect(item).toBeDefined();
      expect(item).not.toHaveProperty('activeStages');
      expect(item).not.toHaveProperty('activeStagesCount');
      expect(item?.deadline).not.toHaveProperty('criticalStage');

      const [row] = await tasksOf('MINE', 'sub-ana');
      expect(row).toMatchObject({
        id: process.id,
        rowKey: process.id,
        processStageId: process.currentStageId,
        branchKey: null,
        branchLabel: null,
        siblings: [],
        siblingsMore: 0,
        activeStagesCount: 1,
      });
    });
  });
});
