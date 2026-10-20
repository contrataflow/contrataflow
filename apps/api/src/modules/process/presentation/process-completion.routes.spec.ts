import { randomUUID } from 'node:crypto';

import {
  actionEntrySchema,
  completedProcessSchema,
  problemDetailsSchema,
} from '@contrataflow/validation';
import type { ActionEntry, CompletedProcessDto, ProcessDto } from '@contrataflow/validation';
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
} from '../../../../test/support/process-forward-fixtures.js';
import type { TestDocumentFacts } from '../../../../test/support/process-forward-fixtures.js';
import { assignDepartment, seedDepartment } from '../../../../test/support/structure-fixtures.js';
import { seedPublishedInMemory } from '../../../../test/support/workflow-engine-fixtures.js';
import { DefinitionBuilder } from '../../../../test/support/workflow-fixtures.js';
import { PROCESS_CLOCK, PROCESS_TRANSACTIONS } from '../application/ports.js';
import type { ProcessTransactions } from '../application/ports.js';
import type { Process } from '../domain/process.js';

/*
 * US-010 — PRC-26 (concluir processo) pelo pipeline HTTP completo (autenticação, tenant, vínculo,
 * autorização, `If-Match`, `Idempotency-Key`, filtro RFC 9457) com a identidade fake, os seeders
 * reais e repositórios em memória — as 8 categorias do Gherkin. O workflow publicado em memória tem
 * a etapa PLANEJAMENTO (ETP completo — BLOCKING; mapa de riscos — WARNING) com a transição
 * `COMPLETE` para a etapa `END` "Planejamento da contratação concluído" e um encaminhamento para
 * REVISAO (sem conclusão). Lúcia = "Carla" (GESTOR_CONTRATACOES, responsável), Fábio = "Diego"
 * (COMPRAS, sem custódia nem lotação na unidade atual), Ana = REQUISITANTE (sem PROCESS_COMPLETE),
 * Heitor = gestor da Prefeitura B. A conclusão automática pela aprovação final está em
 * `approval-decision.routes.spec.ts`; RLS e a gravação real em `test/tenant-leak/process-completion.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-20T15:00:00.000Z');
const ETP_MESSAGE = 'O ETP deve estar completo.';
const RISK_MESSAGE = 'Recomenda-se elaborar o mapa de riscos.';
const COMMENT = 'Planejamento pronto para a seleção do fornecedor';

const ORG_A = '0192d010-0000-7000-8000-0000000000a0';
const ORG_B = '0192d010-0000-7000-8000-0000000000b0';
const UNITS_A = {
  organizationId: ORG_A,
  obras: '0192d010-0000-7000-8000-0000000000a1',
  manutencao: '0192d010-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d010-0000-7000-8000-0000000000a3',
  saude: '0192d010-0000-7000-8000-0000000000a4',
  posto: '0192d010-0000-7000-8000-0000000000a5',
};
const UNITS_B = {
  organizationId: ORG_B,
  obras: '0192d010-0000-7000-8000-0000000000b1',
  manutencao: '0192d010-0000-7000-8000-0000000000b2',
  pavimentacao: '0192d010-0000-7000-8000-0000000000b3',
  saude: '0192d010-0000-7000-8000-0000000000b4',
  posto: '0192d010-0000-7000-8000-0000000000b5',
};
const PLANEJAMENTO = '0192d010-0000-7000-8000-0000000000a6';
const FLOW_VERSION = '0192d010-0000-7000-8000-0000000000f1';

const membershipOf = (userId: string, tenantId = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

const flow = new DefinitionBuilder(FLOW_VERSION)
  .stage('ABERTURA', 'START', { name: 'Formalização da demanda', assignmentPolicy: 'CREATOR' })
  .stage('PLANEJAMENTO', 'TASK', {
    name: 'Planejamento da contratação',
    departmentResolution: 'FIXED',
    fixedDepartmentId: PLANEJAMENTO,
    documentTypeCodes: ['ETP', 'RISK_MAP'],
    slaDays: 10,
  })
  .stage('REVISAO', 'TASK', {
    name: 'Revisão',
    departmentResolution: 'FIXED',
    fixedDepartmentId: PLANEJAMENTO,
    slaDays: null,
  })
  .stage('CONCLUSAO', 'END', {
    name: 'Planejamento da contratação concluído',
    departmentResolution: 'REQUESTING_DEPARTMENT',
  })
  .transition('ABERTURA', 'PLANEJAMENTO', 'FORWARD', { isPrimary: true })
  .transition('PLANEJAMENTO', 'REVISAO', 'FORWARD', { name: 'Enviar para revisão' })
  .transition('PLANEJAMENTO', 'CONCLUSAO', 'COMPLETE', {
    name: 'Concluir planejamento',
    isPrimary: true,
  })
  .transition('REVISAO', 'PLANEJAMENTO', 'FORWARD', { isPrimary: true })
  .rule(
    'REQUIRED_DOCUMENT',
    { documentTypeCode: 'ETP', minStatus: 'COMPLETE' },
    { stage: 'PLANEJAMENTO' },
    { name: 'ETP completo', message: ETP_MESSAGE },
  )
  .rule(
    'REQUIRED_DOCUMENT',
    { documentTypeCode: 'RISK_MAP', minStatus: 'EXISTS' },
    { stage: 'PLANEJAMENTO' },
    { name: 'Mapa de riscos', message: RISK_MESSAGE, severity: 'WARNING' },
  );

const TO_REVISAO =
  flow.transitions.find((candidate) => candidate.key === 'PLANEJAMENTO_FORWARD_REVISAO')?.id ?? '';
const WARNING_RULE = flow.rules.find((rule) => rule.severity === 'WARNING')?.id ?? '';

/**
 * Transações do módulo: em fila (corridas serializadas, como o `FOR UPDATE`), banco fora e um
 * gancho que avisa quando uma transação entra na fila (corrida determinística).
 */
class FlakyTransactions implements ProcessTransactions {
  down = false;
  private queue: Promise<unknown> = Promise.resolve();
  private waiters: (() => void)[] = [];

  /** Resolve quando a próxima transação de escrita entrar na fila. */
  nextRun(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    if (this.down) return Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED')));
    const next = this.queue.then(() => runSimulatedTransaction(work));
    this.queue = next.catch(() => undefined);
    for (const resolve of this.waiters.splice(0)) resolve();
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

describe('Feature: Concluir processo (planejamento da contratação) (US-010)', () => {
  let api: TestApi;
  let facts: TestDocumentFacts;
  let log: MockInstance<Logger['log']>;
  let warn: MockInstance<Logger['warn']>;
  const transactions = new FlakyTransactions();
  let catalog: { contractingType: string; origin: string };
  const words = (count: number) =>
    Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

  const auth = (call: request.Test, subject = 'sub-lucia', tenant: string = A) =>
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
  const complete = (
    process: Pick<Process, 'id' | 'version'>,
    body: Record<string, unknown> = {},
    options: { subject?: string; tenant?: string; ifMatch?: string | null; key?: string } = {},
  ) => {
    const call = auth(
      request(api.server).post(`/api/v1/processes/${process.id}/complete`),
      options.subject,
      options.tenant,
    ).set('Idempotency-Key', options.key ?? randomUUID());
    if (options.ifMatch !== null) {
      call.set('If-Match', options.ifMatch ?? `"${String(process.version)}"`);
    }
    return call.send(body);
  };
  const forward = (process: Pick<Process, 'id' | 'currentStageId' | 'version'>) =>
    auth(request(api.server).post(`/api/v1/processes/${process.id}/forward`))
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', `"${String(process.version)}"`)
      .send({ transitionId: TO_REVISAO, expectedStageId: process.currentStageId });
  const actionsOf = async (processId: string, subject = 'sub-lucia') => {
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
  const timelineOf = (processId: string, type: string) =>
    timelineRowsOf(api).filter((row) => row.processId === processId && row.type === type);
  /** Efeitos gravados do processo (para provar que nada foi gravado numa recusa). */
  const effects = (processId: string) => ({
    process: stored(processId),
    stages: repository().stagesOf(processId).length,
    movements: repository().movementsOf(processId).length,
    events: eventsOf(processId).length,
    audit: auditOf(processId, 'process.complete').length,
  });

  /** Processo criado pelo PRC-02 (Ana, na ABERTURA do workflow padrão). */
  async function createProcess(): Promise<Process> {
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
    return stored(data<ProcessDto>(response).id);
  }

  /**
   * Background: o processo "0012/2026" na etapa `stageKey` (PLANEJAMENTO, salvo indicação) da
   * Coordenadoria de Planejamento, IN_PROGRESS, versão 5, sob custódia de Lúcia ("Carla") — ETP
   * completo e mapa de riscos existente, salvo indicação.
   */
  async function processAt(
    options: {
      readonly stageKey?: string;
      readonly status?: Process['status'];
      readonly etpComplete?: boolean;
      readonly riskMap?: boolean;
    } = {},
  ): Promise<Process> {
    const created = await createProcess();
    const [opening] = repository().stagesOf(created.id);
    if (!opening) throw new Error('passagem de abertura ausente');
    repository().seedStage({
      ...opening,
      workflowStageId: flow.stageId('ABERTURA'),
      status: 'COMPLETED',
      exitedAt: new Date('2026-10-01T12:00:00.000Z'),
    });
    const stageKey = options.stageKey ?? 'PLANEJAMENTO';
    const current = newId();
    repository().seedStage({
      id: current,
      tenantId: A,
      processId: created.id,
      workflowStageId: flow.stageId(stageKey),
      sequence: 2,
      status: 'ACTIVE',
      departmentId: PLANEJAMENTO,
      assigneeId: FAKE_USERS.lucia.id,
      enteredAt: new Date('2026-10-01T12:00:00.000Z'),
      dueAt: null,
      slaDays: null,
      slaType: 'BUSINESS',
      enteredViaMovementId: null,
    });
    repository().seedAssignment({
      id: newId(),
      tenantId: A,
      processId: created.id,
      processStageId: current,
      departmentId: PLANEJAMENTO,
      assigneeId: FAKE_USERS.lucia.id,
      type: 'STAGE_ENTRY',
      assignedById: null,
      startedAt: new Date('2026-10-01T12:00:00.000Z'),
    });
    const process: Process = {
      ...created,
      workflowVersionId: FLOW_VERSION,
      status: options.status ?? 'IN_PROGRESS',
      currentStageId: current,
      currentWorkflowStageId: flow.stageId(stageKey),
      currentDepartmentId: PLANEJAMENTO,
      currentResponsibleId: FAKE_USERS.lucia.id,
      number: 12,
      code: '0012/2026',
      openedAt: created.createdAt,
      version: 5,
    };
    repository().seed(process, [
      { principalType: 'DEPARTMENT', departmentId: PLANEJAMENTO, reason: 'CURRENT' },
      { principalType: 'USER', userId: FAKE_USERS.lucia.id, reason: 'RESPONSIBLE' },
    ]);
    facts.set(process.id, [
      {
        documentTypeCode: 'ETP',
        status: options.etpComplete === false ? 'DRAFT' : 'FINALIZED',
        isComplete: options.etpComplete !== false,
        versionNumber: 2,
        approvedAt: null,
      },
      ...(options.riskMap === false
        ? []
        : [
            {
              documentTypeCode: 'RISK_MAP',
              status: 'DRAFT' as const,
              isComplete: false,
              versionNumber: null,
              approvedAt: null,
            },
          ]),
    ]);
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
    await seedPublishedInMemory(api, A, flow, 'TESTE_US010');
    await deactivateWorkflow(api, A, 'TESTE_US010');
    facts = registerTestDocumentFacts(api);
    assignDepartment(api, membershipOf(FAKE_USERS.ana.id), UNITS_A.manutencao);
    assignDepartment(api, membershipOf(FAKE_USERS.lucia.id), PLANEJAMENTO);
    assignDepartment(api, membershipOf(FAKE_USERS.fabio.id), UNITS_A.saude);
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
    it('Concluir manualmente com as regras satisfeitas: COMPLETED com completedAt, etapa encerrada, END registrada, auditoria, eventos e timeline', async () => {
      // O aviso "Mapa de riscos" pendente, reconhecido no diálogo (as BLOCKING estão satisfeitas).
      const process = await processAt({ riskMap: false });
      const [entry] = (await actionsOf(process.id)).filter(
        (action) => action.action === 'COMPLETE',
      );
      expect(entry).toMatchObject({
        label: 'Concluir planejamento',
        enabled: true,
        primary: true,
        toStageType: 'END',
      });
      log.mockClear();

      const response = await complete(process, {
        comment: COMMENT,
        acknowledgedWarnings: [WARNING_RULE],
      });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers.etag).toBe('"6"');
      const dto = completedProcessSchema.parse(data<CompletedProcessDto>(response));
      expect(dto).toMatchObject({
        status: 'COMPLETED',
        completedAt: NOW.toISOString(),
        completedBy: { id: FAKE_USERS.lucia.id },
        currentStage: { key: 'CONCLUSAO', name: 'Planejamento da contratação concluído' },
        version: 6,
      });

      // RN-PROC-115/116: carimbo, etapa ativa e passagem END encerradas como COMPLETED.
      const updated = stored(process.id);
      expect(updated).toMatchObject({ status: 'COMPLETED', version: 6 });
      expect(repository().completedByOf(process.id)).toBe(FAKE_USERS.lucia.id);
      const stages = repository().stagesOf(process.id);
      expect(stages.find((stage) => stage.id === process.currentStageId)).toMatchObject({
        status: 'COMPLETED',
        exitedAt: NOW,
      });
      expect(stages.find((stage) => stage.id === updated.currentStageId)).toMatchObject({
        workflowStageId: flow.stageId('CONCLUSAO'),
        status: 'COMPLETED',
        exitedAt: NOW,
      });
      expect(
        repository()
          .assignmentsOf(process.id)
          .every((item) => !item.isActive),
      ).toBe(true);
      const movement = repository().movementsOf(process.id).at(-1);
      expect(movement).toMatchObject({
        action: 'COMPLETE',
        fromProcessStageId: process.currentStageId,
        toProcessStageId: updated.currentStageId,
        statusFrom: 'IN_PROGRESS',
        statusTo: 'COMPLETED',
        actorId: FAKE_USERS.lucia.id,
        comment: COMMENT,
      });

      const [audit, ...more] = auditOf(process.id, 'process.complete');
      expect(more).toEqual([]);
      expect(audit).toMatchObject({
        entityId: process.id,
        changes: [
          { path: 'status', old: 'IN_PROGRESS', new: 'COMPLETED' },
          { path: 'completedAt', old: null, new: NOW.toISOString() },
        ],
        metadata: {
          cause: 'MANUAL',
          processCode: '0012/2026',
          movementId: movement?.id,
          fromStatus: 'IN_PROGRESS',
          toStatus: 'COMPLETED',
        },
      });
      expect(eventsOf(process.id, 'ProcessStageChanged').at(-1)).toMatchObject({
        routingKey: 'process.stage_changed.complete',
        payload: {
          cause: 'COMPLETE',
          hasComment: true,
          toStage: { key: 'CONCLUSAO', type: 'END' },
        },
      });
      expect(eventsOf(process.id, 'ProcessStatusChanged').at(-1)).toMatchObject({
        routingKey: 'process.status_changed.completed',
        payload: { fromStatus: 'IN_PROGRESS', toStatus: 'COMPLETED', cause: 'COMPLETE' },
      });
      expect(timelineOf(process.id, 'PROCESS_COMPLETED')).toHaveLength(1);
      // Logs: o caminho e a duração — nunca o comentário (story · Logs).
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'process.completed', cause: 'MANUAL' }),
        'process.completed',
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain(COMMENT);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'workflow.exit_rule_warning_acknowledged',
          ruleId: WARNING_RULE,
        }),
        'workflow.exit_rule_warning_acknowledged',
      );
    });

    it('RN-PROC-117: depois da conclusão, nenhuma tramitação nem nova conclusão é aceita (INVALID_PROCESS_STATUS) e a ação some', async () => {
      const process = await processAt({ riskMap: false });
      const first = await complete(process, { acknowledgedWarnings: [WARNING_RULE] });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      const completed = stored(process.id);

      expectProblem(
        await complete(completed, { acknowledgedWarnings: [WARNING_RULE] }),
        409,
        'INVALID_PROCESS_STATUS',
      );
      expectProblem(
        await auth(request(api.server).post(`/api/v1/processes/${process.id}/forward`))
          .set('Idempotency-Key', randomUUID())
          .set('If-Match', `"${String(completed.version)}"`)
          .send({ transitionId: TO_REVISAO, expectedStageId: completed.currentStageId }),
        409,
        'INVALID_PROCESS_STATUS',
      );
      expectProblem(
        await auth(request(api.server).patch(`/api/v1/processes/${process.id}`))
          .set('If-Match', `"${String(completed.version)}"`)
          .send({ title: 'Novo título do processo' }),
        409,
        'INVALID_PROCESS_STATUS',
      );
      const actions = await actionsOf(process.id);
      expect(actions.filter((action) => action.action === 'COMPLETE')).toEqual([]);
      expect(stored(process.id).version).toBe(completed.version);
    });

    it('FA-03: etapa atual já END aguardando confirmação → "Concluir processo" sem transição e a passagem END encerrada', async () => {
      const process = await processAt({ stageKey: 'CONCLUSAO' });
      const [entry] = (await actionsOf(process.id)).filter(
        (action) => action.action === 'COMPLETE',
      );
      expect(entry).toMatchObject({ label: 'Concluir processo', enabled: true });
      expect(entry?.transitionId).toBeUndefined();

      const response = await complete(process);

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(data<CompletedProcessDto>(response)).toMatchObject({
        status: 'COMPLETED',
        completedAt: NOW.toISOString(),
      });
      const updated = stored(process.id);
      expect(updated.currentStageId).toBe(process.currentStageId);
      expect(updated.currentResponsibleId).toBe(FAKE_USERS.lucia.id);
      expect(
        repository()
          .stagesOf(process.id)
          .find((stage) => stage.id === process.currentStageId),
      ).toMatchObject({ status: 'COMPLETED', exitedAt: NOW });
      expect(repository().movementsOf(process.id).at(-1)).toMatchObject({
        action: 'COMPLETE',
        workflowTransitionId: null,
        fromProcessStageId: process.currentStageId,
        toProcessStageId: process.currentStageId,
        statusTo: 'COMPLETED',
      });
      expect(eventsOf(process.id, 'ProcessStatusChanged').at(-1)?.routingKey).toBe(
        'process.status_changed.completed',
      );
      expect(auditOf(process.id, 'process.complete')[0]?.metadata).toMatchObject({
        cause: 'MANUAL',
      });
    });
  });

  describe('[Validação]', () => {
    it('Regra BLOCKING pendente: 422 TRANSITION_BLOCKED com violations[], processo segue IN_PROGRESS e nada gravado', async () => {
      const process = await processAt({ etpComplete: false });
      const [entry] = (await actionsOf(process.id)).filter(
        (action) => action.action === 'COMPLETE',
      );
      expect(entry).toMatchObject({
        enabled: false,
        reasons: [expect.objectContaining({ code: 'TRANSITION_BLOCKED', message: ETP_MESSAGE })],
      });
      const before = effects(process.id);

      const body = expectProblem(
        await complete(process, { acknowledgedWarnings: [WARNING_RULE] }),
        422,
        'TRANSITION_BLOCKED',
      );

      expect(body.detail).toBe('Há pendências que impedem a conclusão.');
      expect(body.violations.map((item) => [item.severity, item.message])).toEqual([
        ['BLOCKING', ETP_MESSAGE],
      ]);
      expect(effects(process.id)).toEqual(before);
      expect(stored(process.id).status).toBe('IN_PROGRESS');
    });

    it('FA-02: aviso WARNING não reconhecido → 422 WARNINGS_NOT_ACKNOWLEDGED; reenvio com acknowledgedWarnings conclui', async () => {
      const process = await processAt({ riskMap: false });
      const body = expectProblem(await complete(process), 422, 'WARNINGS_NOT_ACKNOWLEDGED');
      expect(body.detail).toBe('Confirme que está ciente dos avisos para continuar.');
      expect(body.violations.map((item) => item.ruleId)).toEqual([WARNING_RULE]);
      expect(stored(process.id).status).toBe('IN_PROGRESS');

      const retry = await complete(process, { acknowledgedWarnings: [WARNING_RULE] });
      expect(retry.status, JSON.stringify(retry.body)).toBe(200);
      expect(auditOf(process.id, 'process.complete')[0]?.metadata).toMatchObject({
        warningsAcknowledged: [expect.objectContaining({ ruleId: WARNING_RULE })],
      });
    });

    it('FA-04: processo suspenso → 409 INVALID_PROCESS_STATUS ("Retome o processo antes de concluí-lo.")', async () => {
      const process = await processAt({ status: 'SUSPENDED' });
      const body = expectProblem(await complete(process), 409, 'INVALID_PROCESS_STATUS');
      expect(body.detail).toBe('Retome o processo antes de concluí-lo.');
      expect(stored(process.id).status).toBe('SUSPENDED');
    });

    it.each<Process['status']>(['RETURNED', 'AWAITING_APPROVAL'])(
      'RN-PROC-114: a conclusão manual a partir de %s é recusada com 409',
      async (status) => {
        const process = await processAt({ status });
        expectProblem(await complete(process), 409, 'INVALID_PROCESS_STATUS');
      },
    );

    it('etapa sem transição COMPLETE → 422 TRANSITION_NOT_AVAILABLE', async () => {
      const process = await processAt({ stageKey: 'REVISAO' });
      expectProblem(await complete(process), 422, 'TRANSITION_NOT_AVAILABLE');
    });

    it('Observação acima de 5.000 caracteres e campo desconhecido → 422 VALIDATION_ERROR', async () => {
      const process = await processAt();
      expectProblem(
        await complete(process, { comment: 'x'.repeat(5001) }),
        422,
        'VALIDATION_ERROR',
      );
      expectProblem(await complete(process, { status: 'COMPLETED' }), 422, 'VALIDATION_ERROR');
    });

    it('V-06: sem If-Match → 428 PRECONDITION_REQUIRED; If-Match divergente → 412 VERSION_CONFLICT', async () => {
      const process = await processAt();
      expectProblem(await complete(process, {}, { ifMatch: null }), 428, 'PRECONDITION_REQUIRED');
      expectProblem(await complete(process, {}, { ifMatch: '"4"' }), 412, 'VERSION_CONFLICT');
    });
  });

  describe('[Permissão]', () => {
    it('Usuário sem custódia nem lotação na unidade atual → 403 NOT_PROCESS_CUSTODIAN com access.denied', async () => {
      const process = await processAt();
      const [entry] = (await actionsOf(process.id, 'sub-fabio')).filter(
        (action) => action.action === 'COMPLETE',
      );
      expect(entry).toMatchObject({
        enabled: false,
        reasons: [expect.objectContaining({ code: 'NOT_PROCESS_CUSTODIAN' })],
      });
      const before = effects(process.id);

      const body = expectProblem(
        await complete(process, {}, { subject: 'sub-fabio' }),
        403,
        'NOT_PROCESS_CUSTODIAN',
      );

      expect(body.detail).toBe('Apenas quem está com o processo pode concluí-lo.');
      expect(api.auditRecords().at(-1)).toMatchObject({
        action: 'access.denied',
        reasonCode: 'NOT_PROCESS_CUSTODIAN',
      });
      expect(effects(process.id)).toEqual(before);
    });

    it('Sem PROCESS_COMPLETE em nenhum escopo → ação oculta e 403 PERMISSION_DENIED', async () => {
      const process = await processAt();
      // Ana (REQUISITANTE) não tem PROCESS_COMPLETE em nenhum escopo: o guard barra antes do caso de uso.
      const body = expectProblem(
        await complete(process, {}, { subject: 'sub-ana' }),
        403,
        'PERMISSION_DENIED',
      );
      expect(body.detail).toBe('Você não tem permissão para concluir este processo.');
      expect(api.auditRecords().at(-1)).toMatchObject({ action: 'access.denied' });
      expect(stored(process.id).status).toBe('IN_PROGRESS');
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Concluir processo de outro tenant → 404 PROCESS_NOT_FOUND sem revelar nem alterar nada', async () => {
      const process = await processAt();
      const before = effects(process.id);
      const body = expectProblem(
        await complete(process, {}, { subject: 'sub-heitor', tenant: B }),
        404,
        'PROCESS_NOT_FOUND',
      );
      expect(JSON.stringify(body)).not.toContain('0012/2026');
      expect(effects(process.id)).toEqual(before);
    });
  });

  describe('[Duplicidade]', () => {
    it('Reenvio com a mesma Idempotency-Key ("K5") → 200 com o mesmo processo e Idempotent-Replayed: true', async () => {
      const process = await processAt();
      const key = randomUUID();
      const first = await complete(process, { acknowledgedWarnings: [WARNING_RULE] }, { key });
      expect(first.status, JSON.stringify(first.body)).toBe(200);

      const replay = await complete(process, { acknowledgedWarnings: [WARNING_RULE] }, { key });

      expect(replay.status, JSON.stringify(replay.body)).toBe(200);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toEqual(first.body);
      expect(
        repository()
          .movementsOf(process.id)
          .filter((movement) => movement.action === 'COMPLETE'),
      ).toHaveLength(1);
      expect(auditOf(process.id, 'process.complete')).toHaveLength(1);
    });

    it('A mesma chave com outro corpo → 422 IDEMPOTENCY_KEY_REUSED', async () => {
      const process = await processAt();
      const key = randomUUID();
      const first = await complete(process, { acknowledgedWarnings: [WARNING_RULE] }, { key });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expectProblem(
        await complete(process, { comment: 'outro corpo' }, { key }),
        422,
        'IDEMPOTENCY_KEY_REUSED',
      );
    });
  });

  describe('[Concorrência]', () => {
    it('Encaminhamento e conclusão simultâneos com If-Match "5": só um aplicado, o outro 412 VERSION_CONFLICT', async () => {
      const process = await processAt();
      const queued = transactions.nextRun();
      const forwarding = forward(process).then((response) => response);
      await queued;
      const completing = complete(process, { acknowledgedWarnings: [WARNING_RULE] }).then(
        (response) => response,
      );
      const [forwarded, completed] = await Promise.all([forwarding, completing]);

      expect(forwarded.status, JSON.stringify(forwarded.body)).toBe(200);
      expectProblem(completed, 412, 'VERSION_CONFLICT');
      expect(stored(process.id)).toMatchObject({ status: 'IN_PROGRESS', version: 6 });
      expect(auditOf(process.id, 'process.complete')).toEqual([]);
    });

    it('Duas conclusões simultâneas: uma 200, a outra 412; uma única tramitação COMPLETE', async () => {
      const process = await processAt();
      const [one, two] = await Promise.all([
        complete(process, { acknowledgedWarnings: [WARNING_RULE] }),
        complete(process, { acknowledgedWarnings: [WARNING_RULE] }),
      ]);
      expect([one.status, two.status].sort()).toEqual([200, 412]);
      expect(
        repository()
          .movementsOf(process.id)
          .filter((movement) => movement.action === 'COMPLETE'),
      ).toHaveLength(1);
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível durante a conclusão: 503 DEPENDENCY_UNAVAILABLE com Retry-After e o processo segue IN_PROGRESS', async () => {
      const process = await processAt();
      const before = effects(process.id);
      transactions.down = true;
      const response = await complete(process, { acknowledgedWarnings: [WARNING_RULE] });
      transactions.down = false;
      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      expect(response.headers['retry-after']).toEqual(expect.any(String));
      expect(effects(process.id)).toEqual(before);
      expect(stored(process.id).status).toBe('IN_PROGRESS');
    });
  });

  describe('[Falha de integração]', () => {
    it('Relay do outbox indisponível: 200, processo COMPLETED e um único ProcessStatusChanged no outbox', async () => {
      // Sem relay no teste em memória: o evento fica no outbox (o status PENDING é provado sobre o
      // PostgreSQL em test/tenant-leak/process-completion.spec.ts).
      const process = await processAt();
      const response = await complete(process, { acknowledgedWarnings: [WARNING_RULE] });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(stored(process.id).status).toBe('COMPLETED');
      const events = eventsOf(process.id, 'ProcessStatusChanged');
      expect(events).toHaveLength(1);
      expect(events[0]?.routingKey).toBe('process.status_changed.completed');
    });
  });
});
