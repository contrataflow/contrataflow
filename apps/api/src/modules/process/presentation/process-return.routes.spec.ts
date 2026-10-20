import { randomUUID } from 'node:crypto';

import {
  actionEntrySchema,
  problemDetailsSchema,
  returnedProcessSchema,
} from '@contrataflow/validation';
import type { ActionEntry, ProcessDto, ReturnedProcessDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { z } from 'zod';

import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { IDEMPOTENCY_STORE } from '#shared/idempotency/idempotency.js';
import { InMemoryIdempotencyStore } from '#shared/idempotency/in-memory-idempotency.store.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import { documentRepositoryOf } from '../../../../test/support/document-fixtures.js';
import {
  CATALOG_CLOCK,
  catalogItemId,
  processRepositoryOf,
  runTenantSeeders,
  seedProcessStructure,
  timelineRowsOf,
} from '../../../../test/support/process-fixtures.js';
import { deactivateWorkflow } from '../../../../test/support/process-forward-fixtures.js';
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
 * US-048 — PRC-20 (devolver processo) pelo pipeline HTTP completo (autenticação, tenant, vínculo,
 * autorização, `If-Match`, `Idempotency-Key`, filtro RFC 9457) com a identidade fake, os seeders
 * reais e repositórios em memória — as 8 categorias do Gherkin. Background: o processo "0012/2026"
 * percorreu ABERTURA e APROVACAO_DFD e está em ESTUDOS_PRELIMINARES. Carla (custodiante) = "Ana"
 * fake; Ana (responsável anterior pela ABERTURA) = "Lúcia"; Bruno (sem custódia nem lotação) =
 * "Fábio". Atomicidade com rollback real, RLS e concorrência sobre o PostgreSQL:
 * `test/tenant-leak/process-return.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
/** "Hoje é 05/10/2026" (segunda) — meio-dia em São Paulo. */
const NOW = new Date('2026-10-05T15:00:00.000Z');
/** Abertura do processo, antes do Background. */
const OPENED = new Date('2026-09-28T13:00:00.000Z');
/** 13/10/2026 23:59:59 em São Paulo: 5 dias úteis, sem o feriado de 12/10. */
const DUE_13_10 = '2026-10-14T02:59:59.999Z';
/** 30/10/2026 23:59:59 em São Paulo (prazo informado na devolução). */
const DUE_30_10 = '2026-10-31T02:59:59.999Z';
const REASON = 'Faltou detalhar a justificativa da contratação no DFD';
const USER_AGENT = 'Vitest/US-048';

const ORG_A = '0192d048-0000-7000-8000-0000000000a0';
const ORG_B = '0192d048-0000-7000-8000-0000000000b0';
const UNITS_A = {
  organizationId: ORG_A,
  obras: '0192d048-0000-7000-8000-0000000000a1',
  manutencao: '0192d048-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d048-0000-7000-8000-0000000000a3',
  saude: '0192d048-0000-7000-8000-0000000000a4',
  posto: '0192d048-0000-7000-8000-0000000000a5',
};
const UNITS_B = {
  organizationId: ORG_B,
  obras: '0192d048-0000-7000-8000-0000000000b1',
  manutencao: '0192d048-0000-7000-8000-0000000000b2',
  pavimentacao: '0192d048-0000-7000-8000-0000000000b3',
  saude: '0192d048-0000-7000-8000-0000000000b4',
  posto: '0192d048-0000-7000-8000-0000000000b5',
};
const PLANEJAMENTO = '0192d048-0000-7000-8000-0000000000a6';
const COMPRAS = '0192d048-0000-7000-8000-0000000000a7';
const FLOW_VERSION = '0192d048-0000-7000-8000-0000000000f1';
const FLOW_B_VERSION = '0192d048-0000-7000-8000-0000000000f2';

const membershipOf = (userId: string, tenantId = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

/**
 * Workflow do Background: ESTUDOS_PRELIMINARES devolve para ABERTURA (unidade solicitante, SLA 5
 * dias úteis, prazo alterável); PESQUISA_PRECOS devolve para ESTUDOS_PRELIMINARES (unidade escolhida
 * no encaminhamento, prazo não alterável).
 */
const flow = new DefinitionBuilder(FLOW_VERSION)
  .stage('ABERTURA', 'START', {
    name: 'Formalização da demanda',
    assignmentPolicy: 'CREATOR',
    slaDays: 5,
    slaType: 'BUSINESS',
  })
  .stage('APROVACAO_DFD', 'APPROVAL', {
    name: 'Aprovação da demanda',
    departmentResolution: 'REQUESTING_SECRETARIAT',
  })
  .stage('ESTUDOS_PRELIMINARES', 'TASK', {
    name: 'ETP e mapa de riscos',
    departmentResolution: 'CHOSEN_ON_FORWARD',
    slaDays: 15,
  })
  .stage('PESQUISA_PRECOS', 'TASK', {
    name: 'Pesquisa de preços',
    departmentResolution: 'FIXED',
    fixedDepartmentId: COMPRAS,
    slaDays: 10,
  })
  .stage('CONCLUSAO', 'END', { name: 'Concluído' })
  .transition('ABERTURA', 'APROVACAO_DFD', 'FORWARD', { isPrimary: true })
  .transition('APROVACAO_DFD', 'ESTUDOS_PRELIMINARES', 'APPROVE')
  .transition('APROVACAO_DFD', 'ABERTURA', 'RETURN')
  .transition('ESTUDOS_PRELIMINARES', 'PESQUISA_PRECOS', 'FORWARD', {
    name: 'Encaminhar para pesquisa de preços',
    isPrimary: true,
  })
  .transition('ESTUDOS_PRELIMINARES', 'ABERTURA', 'RETURN', {
    name: 'Devolver para a formalização da demanda',
    allowDueDateOverride: true,
  })
  .transition('PESQUISA_PRECOS', 'ESTUDOS_PRELIMINARES', 'RETURN', {
    name: 'Devolver ao ETP e mapa de riscos',
    allowDueDateOverride: false,
  });
/** Workflow publicado no tenant B ("0030/2026"): a mesma chave de etapa, outro id. */
const flowB = new DefinitionBuilder(FLOW_B_VERSION)
  .stage('ABERTURA', 'START', { name: 'Abertura LEAK-B' })
  .stage('ANALISE', 'TASK')
  .stage('FIM', 'END')
  .transition('ABERTURA', 'ANALISE', 'FORWARD', { isPrimary: true })
  .transition('ANALISE', 'ABERTURA', 'RETURN');

const TO_PESQUISA = flow.transitions.find(
  (transition) => transition.key === 'ESTUDOS_PRELIMINARES_FORWARD_PESQUISA_PRECOS',
)?.id;

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

describe('Feature: Devolver processo (US-048)', () => {
  let api: TestApi;
  let log: MockInstance<Logger['log']>;
  let warn: MockInstance<Logger['warn']>;
  const transactions = new FlakyTransactions();
  const clock = { now: NOW };
  let catalog: { contractingType: string; origin: string };
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
  const giveBack = (
    process: Pick<Process, 'id' | 'currentStageId' | 'version'>,
    body: Record<string, unknown>,
    options: { subject?: string; tenant?: string; ifMatch?: string | null; key?: string } = {},
  ) => {
    const call = auth(
      request(api.server).post(`/api/v1/processes/${process.id}/return`),
      options.subject,
      options.tenant,
    ).set('Idempotency-Key', options.key ?? randomUUID());
    if (options.ifMatch !== null) {
      call.set('If-Match', options.ifMatch ?? `"${String(process.version)}"`);
    }
    return call.send({ expectedStageId: process.currentStageId, ...body });
  };
  const toAbertura = (body: Record<string, unknown> = {}) => ({
    targetStageId: flow.stageId('ABERTURA'),
    comment: REASON,
    ...body,
  });
  const actionsOf = async (processId: string, subject = 'sub-ana') => {
    const response = await auth(
      request(api.server).get(`/api/v1/processes/${processId}/available-actions`),
      subject,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return z.array(actionEntrySchema).parse(data<ActionEntry[]>(response));
  };
  const eventsOf = (processId: string, eventType?: string) =>
    api
      .outboxRows()
      .filter(
        (row) =>
          row.processId === processId && (eventType === undefined || row.eventType === eventType),
      );
  const auditOf = (processId: string, action: string) =>
    api.auditRecords().filter((row) => row.processId === processId && row.action === action);
  const returnsOf = (processId: string) =>
    repository()
      .movementsOf(processId)
      .filter((movement) => movement.action === 'RETURN');
  /** Efeitos gravados do processo (para provar que nada foi gravado numa recusa). */
  const effects = (processId: string) => ({
    process: stored(processId),
    stages: repository().stagesOf(processId).length,
    assignments: repository().assignmentsOf(processId).length,
    movements: repository().movementsOf(processId).length,
    access: repository().accessOf(processId).length,
    events: eventsOf(processId).length,
    audit: api.auditRecords().filter((row) => row.processId === processId).length,
    timeline: timelineRowsOf(api).filter((row) => row.processId === processId).length,
  });

  /** Processo criado pelo PRC-02 em 28/09 (Ana fake responsável pela ABERTURA). */
  async function createProcess(): Promise<Process> {
    clock.now = OPENED;
    try {
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
      return stored(data<ProcessDto>(response).id);
    } finally {
      clock.now = NOW;
    }
  }

  /** Passagem encerrada (e a sua responsabilidade, se houver) direto no repositório em memória. */
  function closedPass(
    process: Process,
    key: string,
    sequence: number,
    options: { departmentId: string; assigneeId: string | null; at: string; id?: string },
  ): string {
    const id = options.id ?? newId();
    repository().seedStage({
      id,
      tenantId: A,
      processId: process.id,
      workflowStageId: flow.stageId(key),
      sequence,
      status: 'COMPLETED',
      departmentId: options.departmentId,
      assigneeId: options.assigneeId,
      enteredAt: new Date(options.at),
      exitedAt: new Date(new Date(options.at).getTime() + 86_400_000),
      dueAt: null,
      slaDays: null,
      slaType: null,
      enteredViaMovementId: null,
    });
    if (options.assigneeId !== null) {
      repository().seedAssignment(
        {
          id: newId(),
          tenantId: A,
          processId: process.id,
          processStageId: id,
          departmentId: options.departmentId,
          assigneeId: options.assigneeId,
          type: 'CLAIM',
          assignedById: null,
          startedAt: new Date(options.at),
        },
        new Date(new Date(options.at).getTime() + 86_400_000),
      );
    }
    return id;
  }

  /** Passagem ativa com a responsabilidade e o processo `IN_PROGRESS` (versão 14) nela. */
  function activePass(
    process: Process,
    key: string,
    sequence: number,
    options: { departmentId: string; responsible: string | null; status?: Process['status'] },
  ): Process {
    const id = newId();
    repository().seedStage({
      id,
      tenantId: A,
      processId: process.id,
      workflowStageId: flow.stageId(key),
      sequence,
      status: 'ACTIVE',
      departmentId: options.departmentId,
      assigneeId: options.responsible,
      enteredAt: new Date('2026-10-02T12:00:00.000Z'),
      dueAt: null,
      slaDays: 15,
      slaType: 'BUSINESS',
      enteredViaMovementId: null,
    });
    repository().seedAssignment({
      id: newId(),
      tenantId: A,
      processId: process.id,
      processStageId: id,
      departmentId: options.departmentId,
      assigneeId: options.responsible,
      type: 'STAGE_ENTRY',
      assignedById: null,
      startedAt: new Date('2026-10-02T12:00:00.000Z'),
    });
    const next: Process = {
      ...process,
      workflowVersionId: FLOW_VERSION,
      status: options.status ?? 'IN_PROGRESS',
      currentStageId: id,
      currentWorkflowStageId: flow.stageId(key),
      currentDepartmentId: options.departmentId,
      currentResponsibleId: options.responsible,
      number: 12,
      code: '0012/2026',
      openedAt: process.createdAt,
      version: 14,
    };
    repository().seed(next, [
      { principalType: 'DEPARTMENT', departmentId: options.departmentId, reason: 'CURRENT' },
    ]);
    return next;
  }

  /**
   * Background: ABERTURA (Lúcia = "Ana" assumiu depois da abertura) e APROVACAO_DFD (fila da
   * Secretaria) percorridas; ESTUDOS_PRELIMINARES ativa na Coordenadoria com a Ana fake ("Carla").
   */
  async function processAtStudies(
    options: { readonly responsible?: string | null; readonly status?: Process['status'] } = {},
  ): Promise<Process> {
    const created = await createProcess();
    const [opening] = repository().stagesOf(created.id);
    if (!opening) throw new Error('passagem de abertura ausente');
    closedPass(created, 'ABERTURA', 1, {
      id: opening.id,
      departmentId: UNITS_A.manutencao,
      assigneeId: FAKE_USERS.lucia.id,
      at: '2026-09-29T12:00:00.000Z',
    });
    closedPass(created, 'APROVACAO_DFD', 2, {
      departmentId: UNITS_A.obras,
      assigneeId: null,
      at: '2026-09-30T12:00:00.000Z',
    });
    return activePass(created, 'ESTUDOS_PRELIMINARES', 3, {
      departmentId: PLANEJAMENTO,
      responsible: options.responsible === undefined ? FAKE_USERS.ana.id : options.responsible,
      ...(options.status === undefined ? {} : { status: options.status }),
    });
  }

  /** ESTUDOS_PRELIMINARES já percorrida na fila da Coordenadoria; PESQUISA_PRECOS ativa (Ana fake). */
  async function processAtPesquisa(): Promise<Process> {
    const created = await processAtStudies({ responsible: null });
    const [, , studies] = repository().stagesOf(created.id);
    if (!studies) throw new Error('passagem de estudos ausente');
    repository().seedStage({ ...studies, status: 'COMPLETED' });
    const process = activePass(stored(created.id), 'PESQUISA_PRECOS', 4, {
      departmentId: COMPRAS,
      responsible: FAKE_USERS.ana.id,
    });
    return process;
  }

  beforeAll(async () => {
    log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    api = await createTestApi({
      providers: [
        { token: PROCESS_TRANSACTIONS, value: transactions },
        { token: PROCESS_CLOCK, value: () => clock.now },
        { token: CATALOG_CLOCK, value: () => NOW },
        { token: IDEMPOTENCY_STORE, value: new InMemoryIdempotencyStore() },
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
    seedDepartment(api, { ...base, id: COMPRAS, name: 'Departamento de Compras' });
    await seedPublishedInMemory(api, A, flow, 'TESTE_US048');
    await deactivateWorkflow(api, A, 'TESTE_US048');
    await seedPublishedInMemory(api, B, flowB, 'TESTE_US048_B');
    assignDepartment(api, membershipOf(FAKE_USERS.ana.id), UNITS_A.manutencao);
    assignDepartment(api, membershipOf(FAKE_USERS.ana.id), PLANEJAMENTO);
    assignDepartment(api, membershipOf(FAKE_USERS.ana.id), COMPRAS);
    assignDepartment(api, membershipOf(FAKE_USERS.lucia.id), UNITS_A.manutencao);
    // Otávio só com SOMENTE_LEITURA (sem PROCESS_RETURN em nenhum escopo).
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
    it('Devolver para etapa anterior com responsável resolvido automaticamente (PREVIOUS_ASSIGNEE)', async () => {
      const process = await processAtStudies();
      const etp = await seedPanelDocument(api, {
        tenantId: A,
        processId: process.id,
        typeCode: 'ETP',
        code: 'ETP 0003/2026',
        title: 'Estudo técnico preliminar',
        status: 'FINALIZED',
        versionNumber: 2,
        createdById: FAKE_USERS.ana.id,
      });
      log.mockClear();

      const response = await giveBack(process, toAbertura());

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers.etag).toBe('"15"');
      const dto = returnedProcessSchema.parse(data<ReturnedProcessDto>(response));
      expect(dto).toMatchObject({
        status: 'RETURNED',
        statusFrom: 'IN_PROGRESS',
        currentStage: { key: 'ABERTURA', name: 'Formalização da demanda', dueAt: DUE_13_10 },
        currentDepartment: { id: UNITS_A.manutencao },
        currentResponsible: { id: FAKE_USERS.lucia.id },
        movement: { sequence: 2 },
        version: 15,
      });

      // Tramitação RETURN com o motivo, IP, user-agent e correlationId.
      const [movement, ...more] = returnsOf(process.id);
      expect(more).toEqual([]);
      expect(movement).toMatchObject({
        id: dto.movement.id,
        workflowTransitionId: flow.transitions.find(
          (transition) => transition.key === 'ESTUDOS_PRELIMINARES_RETURN_ABERTURA',
        )?.id,
        fromProcessStageId: process.currentStageId,
        fromDepartmentId: PLANEJAMENTO,
        toDepartmentId: UNITS_A.manutencao,
        fromUserId: FAKE_USERS.ana.id,
        toUserId: FAKE_USERS.lucia.id,
        statusFrom: 'IN_PROGRESS',
        statusTo: 'RETURNED',
        actorId: FAKE_USERS.ana.id,
        comment: REASON,
        documents: [],
        userAgent: USER_AGENT,
        metadata: {
          computedDueAt: DUE_13_10,
          dueDateOverridden: false,
          labels: {
            fromStage: 'ETP e mapa de riscos',
            toStage: 'Formalização da demanda',
            fromDepartment: 'Coordenadoria de Planejamento',
          },
          clientChannel: 'WEB',
        },
      });
      expect(movement?.correlationId).toEqual(expect.any(String));

      // Passagem ativa RETURNED → nova passagem ABERTURA com a Lúcia; responsabilidade RETURN.
      const stages = repository().stagesOf(process.id);
      expect(stages.find((stage) => stage.id === process.currentStageId)).toMatchObject({
        status: 'RETURNED',
        exitedAt: NOW,
      });
      expect(stages.filter((stage) => stage.status === 'ACTIVE')).toEqual([
        expect.objectContaining({
          sequence: 4,
          workflowStageId: flow.stageId('ABERTURA'),
          departmentId: UNITS_A.manutencao,
          assigneeId: FAKE_USERS.lucia.id,
          dueAt: new Date(DUE_13_10),
        }),
      ]);
      const active = repository()
        .assignmentsOf(process.id)
        .filter((assignment) => assignment.isActive);
      expect(active).toEqual([
        expect.objectContaining({ type: 'RETURN', assigneeId: FAKE_USERS.lucia.id }),
      ]);
      expect(stored(process.id)).toMatchObject({
        status: 'RETURNED',
        currentWorkflowStageId: flow.stageId('ABERTURA'),
        currentDepartmentId: UNITS_A.manutencao,
        currentResponsibleId: FAKE_USERS.lucia.id,
        currentStageDueAt: new Date(DUE_13_10),
        version: 15,
      });

      // ProcessAccess: CURRENT da Coordenadoria → HISTORICAL; CURRENT do setor; RESPONSIBLE da Lúcia.
      const access = repository()
        .accessOf(process.id)
        .map((row) => [row.reason, row.departmentId ?? row.userId]);
      expect(access).toContainEqual(['HISTORICAL', PLANEJAMENTO]);
      expect(access).toContainEqual(['CURRENT', UNITS_A.manutencao]);
      expect(access).toContainEqual(['RESPONSIBLE', FAKE_USERS.lucia.id]);
      expect(access).not.toContainEqual(['CURRENT', PLANEJAMENTO]);

      // RN-TRAM-29 (POL-11): o ETP finalizado continua FINALIZED.
      expect(
        documentRepositoryOf(api)
          .allDocuments()
          .find((document) => document.id === etp)?.status,
      ).toBe('FINALIZED');

      expect(
        timelineRowsOf(api).filter(
          (row) => row.processId === process.id && row.type === 'PROCESS_RETURNED',
        ),
      ).toEqual([
        expect.objectContaining({
          movementId: dto.movement.id,
          params: expect.objectContaining({
            toStageName: 'Formalização da demanda',
            toUserName: 'Lúcia Matos',
            hasComment: true,
          }) as unknown,
        }),
      ]);

      const [audit, ...otherAudits] = auditOf(process.id, 'process.return');
      expect(otherAudits).toEqual([]);
      expect(audit).toMatchObject({
        category: 'WORKFLOW',
        metadata: {
          movementId: dto.movement.id,
          fromStageKey: 'ESTUDOS_PRELIMINARES',
          toStageKey: 'ABERTURA',
          commentLength: REASON.length,
        },
      });
      expect(audit?.changes).toEqual([
        { path: 'status', old: 'IN_PROGRESS', new: 'RETURNED' },
        { path: 'currentStageId', old: process.currentStageId, new: dto.currentStage?.id },
        { path: 'currentResponsibleId', old: FAKE_USERS.ana.id, new: FAKE_USERS.lucia.id },
      ]);

      // Eventos: ProcessStageChanged (RETURN), ProcessStatusChanged e ProcessAssigned (RETURN).
      expect(eventsOf(process.id, 'ProcessStageChanged')).toEqual([
        expect.objectContaining({
          routingKey: 'process.stage_changed.return',
          payload: expect.objectContaining({
            cause: 'RETURN',
            movementId: dto.movement.id,
            toStage: expect.objectContaining({ key: 'ABERTURA', type: 'START' }) as unknown,
            fromDepartmentId: PLANEJAMENTO,
            toDepartmentId: UNITS_A.manutencao,
            // O dispatcher notifica PROCESS_RETURNED a quem está em `toUserId` (a Lúcia).
            toUserId: FAKE_USERS.lucia.id,
            dueAt: DUE_13_10,
            hasComment: true,
          }) as unknown,
        }),
      ]);
      expect(eventsOf(process.id, 'ProcessStatusChanged')).toEqual([
        expect.objectContaining({
          routingKey: 'process.status_changed.returned',
          payload: expect.objectContaining({
            fromStatus: 'IN_PROGRESS',
            toStatus: 'RETURNED',
            cause: 'RETURN',
          }) as unknown,
        }),
      ]);
      expect(eventsOf(process.id, 'ProcessAssigned')).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            assignmentType: 'RETURN',
            fromUserId: FAKE_USERS.ana.id,
            toUserId: FAKE_USERS.lucia.id,
          }) as unknown,
        }),
      ]);

      // Logs: process.returned com as chaves das etapas — nunca o motivo.
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'process.returned',
          fromStageKey: 'ESTUDOS_PRELIMINARES',
          toStageKey: 'ABERTURA',
          resolvedAssigneeId: FAKE_USERS.lucia.id,
        }),
        'process.returned',
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain(REASON);
      expect(JSON.stringify(eventsOf(process.id).map((row) => row.payload))).not.toContain(REASON);
      expect(JSON.stringify(audit)).not.toContain(REASON);
    });

    it('FA-01/RN-TRAM-27: destino sem responsável anterior fica na fila; CHOSEN_ON_FORWARD reaproveita a unidade da última passagem', async () => {
      const process = await processAtPesquisa();
      warn.mockClear();
      const response = await giveBack(process, {
        targetStageId: flow.stageId('ESTUDOS_PRELIMINARES'),
        comment: 'Rever o ETP antes da pesquisa de preços.',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(data<ReturnedProcessDto>(response)).toMatchObject({
        status: 'RETURNED',
        currentStage: { key: 'ESTUDOS_PRELIMINARES' },
        currentDepartment: { id: PLANEJAMENTO },
        currentResponsible: null,
      });
      expect(eventsOf(process.id, 'ProcessAssigned')).toEqual([]);
      expect(
        repository()
          .assignmentsOf(process.id)
          .filter((assignment) => assignment.isActive),
      ).toEqual([expect.objectContaining({ type: 'RETURN', assigneeId: null })]);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'return.previous_assignee_not_found' }),
        'return.previous_assignee_not_found',
      );
    });

    it('Prazo informado quando a transição permite: fim do dia escolhido, marcado como sobrescrito', async () => {
      const process = await processAtStudies();
      const response = await giveBack(process, toAbertura({ dueAt: '2026-10-30' }));
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const active = repository()
        .stagesOf(process.id)
        .find((stage) => stage.status === 'ACTIVE');
      expect(active).toMatchObject({ dueAt: new Date(DUE_30_10), dueDateOverridden: true });
      expect(returnsOf(process.id)[0]?.metadata).toMatchObject({
        computedDueAt: DUE_13_10,
        dueDateOverridden: true,
      });
    });

    it('PRC-08: "Devolver" lista o destino com id, nome e data da última passagem', async () => {
      const process = await processAtStudies();
      const returns = (await actionsOf(process.id)).filter((entry) => entry.action === 'RETURN');
      expect(returns).toEqual([
        expect.objectContaining({
          label: 'Devolver para a formalização da demanda',
          enabled: true,
          toStageId: flow.stageId('ABERTURA'),
          toStageName: 'Formalização da demanda',
          lastPassedAt: '2026-09-30T12:00:00.000Z',
          allowDueDateOverride: true,
          requiresComment: true,
        }),
      ]);
    });
  });

  describe('[Validação]', () => {
    it('Motivo abaixo do mínimo de caracteres: 422 VALIDATION_ERROR no campo comment e processo inalterado', async () => {
      const process = await processAtStudies();
      const before = effects(process.id);
      const body = expectProblem(
        await giveBack(process, toAbertura({ comment: 'Corrigir' })),
        422,
        'VALIDATION_ERROR',
      );
      expect(body.errors).toEqual([
        expect.objectContaining({
          field: 'comment',
          code: 'TOO_SHORT',
          message: 'O motivo deve ter ao menos 10 caracteres.',
        }),
      ]);
      expect(effects(process.id)).toEqual(before);
      expect(stored(process.id).currentWorkflowStageId).toBe(flow.stageId('ESTUDOS_PRELIMINARES'));
    });

    it('Destino e motivo ausentes, motivo longo e campo desconhecido: 422 VALIDATION_ERROR', async () => {
      const process = await processAtStudies();
      const missing = expectProblem(await giveBack(process, {}), 422, 'VALIDATION_ERROR');
      expect(missing.errors.map((error) => [error.field, error.code])).toEqual(
        expect.arrayContaining([
          ['targetStageId', 'REQUIRED'],
          ['comment', 'REQUIRED'],
        ]),
      );
      const long = expectProblem(
        await giveBack(process, toAbertura({ comment: 'x'.repeat(5001) })),
        422,
        'VALIDATION_ERROR',
      );
      expect(long.errors).toEqual([
        expect.objectContaining({ field: 'comment', code: 'TOO_LONG' }),
      ]);
      const unknown = expectProblem(
        await giveBack(process, toAbertura({ toUserId: FAKE_USERS.lucia.id })),
        422,
        'VALIDATION_ERROR',
      );
      expect(unknown.errors).toEqual([expect.objectContaining({ code: 'NOT_ALLOWED' })]);
    });

    it('Etapa não percorrida ou percorrida sem RETURN configurada: 422 TRANSITION_NOT_AVAILABLE', async () => {
      const process = await processAtStudies();
      for (const key of ['PESQUISA_PRECOS', 'APROVACAO_DFD', 'ESTUDOS_PRELIMINARES']) {
        const body = expectProblem(
          await giveBack(process, toAbertura({ targetStageId: flow.stageId(key) })),
          422,
          'TRANSITION_NOT_AVAILABLE',
        );
        expect(body.detail).toBe('Esta etapa não está disponível como destino da devolução.');
      }
      expect(returnsOf(process.id)).toEqual([]);
    });

    it('Prazo enviado sem a transição permitir: 422 DUE_DATE_OVERRIDE_NOT_ALLOWED', async () => {
      const process = await processAtPesquisa();
      const body = expectProblem(
        await giveBack(process, {
          targetStageId: flow.stageId('ESTUDOS_PRELIMINARES'),
          comment: 'Rever o ETP antes da pesquisa de preços.',
          dueAt: '2026-10-30',
        }),
        422,
        'DUE_DATE_OVERRIDE_NOT_ALLOWED',
      );
      expect(body.detail).toBe('O prazo desta devolução não pode ser alterado.');
    });

    it('Prazo no passado, além de 365 dias ou em formato inválido: 422 VALIDATION_ERROR no campo dueAt', async () => {
      const process = await processAtStudies();
      for (const dueAt of ['2026-10-01', '2027-12-01', '30/10/2026']) {
        const body = expectProblem(
          await giveBack(process, toAbertura({ dueAt })),
          422,
          'VALIDATION_ERROR',
        );
        expect(body.errors).toEqual([expect.objectContaining({ field: 'dueAt' })]);
      }
      expect(returnsOf(process.id)).toEqual([]);
    });
  });

  describe('[Permissão]', () => {
    it('Usuário sem custódia: "Devolver" desabilitado e POST 403 NOT_PROCESS_CUSTODIAN com access.denied, processo inalterado', async () => {
      const process = await processAtStudies();
      const [entry] = (await actionsOf(process.id, 'sub-fabio')).filter(
        (action) => action.action === 'RETURN',
      );
      expect(entry).toMatchObject({
        enabled: false,
        reasons: [expect.objectContaining({ code: 'NOT_PROCESS_CUSTODIAN' })],
      });
      const before = effects(process.id);
      const body = expectProblem(
        await giveBack(process, toAbertura(), { subject: 'sub-fabio' }),
        403,
        'NOT_PROCESS_CUSTODIAN',
      );
      expect(body.detail).toBe('Você não está com este processo.');
      expect(api.auditRecords().at(-1)).toMatchObject({
        action: 'access.denied',
        reasonCode: 'NOT_PROCESS_CUSTODIAN',
      });
      const after = effects(process.id);
      expect({ ...after, audit: before.audit }).toEqual(before);
    });

    it('Lotado na unidade com o processo na fila tem a custódia (POL-01)', async () => {
      const process = await processAtStudies({ responsible: null });
      const response = await giveBack(process, toAbertura());
      expect(response.status, JSON.stringify(response.body)).toBe(200);
    });

    it('Sem PROCESS_RETURN em nenhum escopo: 403 PERMISSION_DENIED e o botão omitido', async () => {
      const process = await processAtStudies();
      expectProblem(
        await giveBack(process, toAbertura(), { subject: 'sub-otavio' }),
        403,
        'PERMISSION_DENIED',
      );
    });

    it.each(['AWAITING_APPROVAL', 'RETURNED', 'SUSPENDED'] as const)(
      'Processo em %s: 409 INVALID_PROCESS_STATUS',
      async (status) => {
        const process = await processAtStudies({ status });
        const body = expectProblem(
          await giveBack(process, toAbertura()),
          409,
          'INVALID_PROCESS_STATUS',
        );
        expect(body.detail).toBe('Este processo não pode ser devolvido no status atual.');
      },
    );
  });

  describe('[Tenant incorreto]', () => {
    it('Etapa de destino percorrida por processo de outro tenant: 422 TRANSITION_NOT_AVAILABLE sem revelar dados', async () => {
      const process = await processAtStudies();
      const before = effects(process.id);
      const response = await giveBack(
        process,
        toAbertura({ targetStageId: flowB.stageId('ABERTURA') }),
      );
      expectProblem(response, 422, 'TRANSITION_NOT_AVAILABLE');
      expect(JSON.stringify(response.body)).not.toContain('LEAK-B');
      expect(JSON.stringify(response.body)).not.toContain(flowB.stageId('ABERTURA'));
      expect(effects(process.id)).toEqual(before);
    });

    it('Processo de outro tenant: 404 PROCESS_NOT_FOUND', async () => {
      const process = await processAtStudies();
      expectProblem(
        await giveBack(process, toAbertura(), { subject: 'sub-heitor', tenant: B }),
        404,
        'PROCESS_NOT_FOUND',
      );
      expect(stored(process.id).version).toBe(14);
    });
  });

  describe('[Duplicidade]', () => {
    it('Reenvio com a mesma chave de idempotência: 200 com Idempotent-Replayed e uma única tramitação RETURN', async () => {
      const process = await processAtStudies();
      const key = randomUUID();
      const first = await giveBack(process, toAbertura(), { key });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      const replay = await giveBack(process, toAbertura(), { key });
      expect(replay.status, JSON.stringify(replay.body)).toBe(200);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toEqual(first.body);
      expect(returnsOf(process.id)).toHaveLength(1);
      expect(
        repository()
          .stagesOf(process.id)
          .filter((stage) => stage.status === 'ACTIVE'),
      ).toHaveLength(1);
    });
  });

  describe('[Concorrência]', () => {
    it('Outro custodiante já encaminhou: devolução com expectedStageId antigo = 409 STAGE_CHANGED e nenhuma tramitação nova', async () => {
      const process = await processAtStudies();
      const forwarded = await auth(
        request(api.server).post(`/api/v1/processes/${process.id}/forward`),
      )
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', '"14"')
        .send({ transitionId: TO_PESQUISA, expectedStageId: process.currentStageId });
      expect(forwarded.status, JSON.stringify(forwarded.body)).toBe(200);
      const movements = repository().movementsOf(process.id).length;
      const body = expectProblem(
        await giveBack(process, toAbertura(), { ifMatch: '"14"' }),
        409,
        'STAGE_CHANGED',
      );
      expect(body.detail).toBe('Este processo foi tramitado por outra pessoa. Atualize a página.');
      expect(repository().movementsOf(process.id)).toHaveLength(movements);
    });

    it('Encaminhar e devolver ao mesmo tempo: um 200, o outro 409 STAGE_CHANGED; uma etapa ativa', async () => {
      const process = await processAtStudies();
      const [forwarded, returned] = await Promise.all([
        auth(request(api.server).post(`/api/v1/processes/${process.id}/forward`))
          .set('Idempotency-Key', randomUUID())
          .set('If-Match', '"14"')
          .send({ transitionId: TO_PESQUISA, expectedStageId: process.currentStageId }),
        giveBack(process, toAbertura()),
      ]);
      expect([forwarded.status, returned.status].sort()).toEqual([200, 409]);
      expectProblem(forwarded.status === 409 ? forwarded : returned, 409, 'STAGE_CHANGED');
      expect(
        repository()
          .stagesOf(process.id)
          .filter((stage) => stage.status === 'ACTIVE'),
      ).toHaveLength(1);
    });

    it('Versão divergente sem expectedStageId: 412 VERSION_CONFLICT; sem If-Match: 428', async () => {
      const process = await processAtStudies();
      repository().replace({ ...stored(process.id), version: 15 });
      const conflict = await auth(
        request(api.server).post(`/api/v1/processes/${process.id}/return`),
      )
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', '"14"')
        .send(toAbertura());
      const body = expectProblem(conflict, 412, 'VERSION_CONFLICT');
      expect(body.detail).toBe('Os dados do processo mudaram. Atualize a página.');
      expect(conflict.body).toMatchObject({ currentVersion: 15, sentVersion: 14 });
      expectProblem(
        await giveBack(process, toAbertura(), { ifMatch: null }),
        428,
        'PRECONDITION_REQUIRED',
      );
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível durante a devolução: 503 DEPENDENCY_UNAVAILABLE com Retry-After e nada gravado', async () => {
      const process = await processAtStudies();
      const before = effects(process.id);
      transactions.down = true;
      const response = await giveBack(process, toAbertura());
      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      expect(response.headers['retry-after']).toEqual(expect.any(String));
      transactions.down = false;
      expect(effects(process.id)).toEqual(before);
    });
  });

  describe('[Falha de integração]', () => {
    it('Relay do outbox fora: 200, processo RETURNED e os eventos gravados no outbox no mesmo commit', async () => {
      // Sem relay no teste em memória: os eventos ficam no outbox (o status PENDING é provado
      // sobre o PostgreSQL em test/tenant-leak/process-return.spec.ts).
      const process = await processAtStudies();
      const response = await giveBack(process, toAbertura());
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(stored(process.id).status).toBe('RETURNED');
      expect(eventsOf(process.id).map((row) => row.eventType)).toEqual(
        expect.arrayContaining(['ProcessStageChanged', 'ProcessStatusChanged', 'ProcessAssigned']),
      );
    });
  });
});
