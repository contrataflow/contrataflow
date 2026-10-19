import { randomUUID } from 'node:crypto';

import { actionEntrySchema, problemDetailsSchema } from '@contrataflow/validation';
import type { ActionEntry, ProcessDto } from '@contrataflow/validation';
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
 * US-050 — PRC-22 (atribuir/reatribuir responsável) pelo pipeline HTTP completo (autenticação,
 * tenant, vínculo, autorização, `If-Match`, filtro RFC 9457) com a identidade fake, os seeders reais
 * e repositórios em memória — as 8 categorias do Gherkin. Background: o processo "0012/2026" está
 * na etapa TERMO_REFERENCIA do "Setor de Compras", responsável "Felipe". Elenco (fakes): Renata =
 * "Lúcia" (GESTOR_CONTRATACOES, `PROCESS_ASSIGN` em TENANT); Felipe = "Ana" e Juliana = "Fábio"
 * (lotados em Compras, com `PROCESS_VIEW`); Marcos = "Otávio" (ADMIN_ORGAO: sem `PROCESS_ASSIGN`);
 * titular de Compras = "Marta" (ADMIN_ORGAO); "Eva" lotada em Compras sem perfil (sem
 * `PROCESS_VIEW`); "Paulo" só tem vínculo em outro tenant. Rollback real, RLS e o evento `PENDING`
 * sobre o PostgreSQL: `test/tenant-leak/process-assign.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-05T15:00:00.000Z');
const OPENED = new Date('2026-09-28T13:00:00.000Z');
const USER_AGENT = 'Vitest/US-050';
const REASON = 'Felipe está de férias';

const ORG_A = '0192d050-0000-7000-8000-0000000000a0';
const ORG_B = '0192d050-0000-7000-8000-0000000000b0';
const UNITS_A = {
  organizationId: ORG_A,
  obras: '0192d050-0000-7000-8000-0000000000a1',
  manutencao: '0192d050-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d050-0000-7000-8000-0000000000a3',
  saude: '0192d050-0000-7000-8000-0000000000a4',
  posto: '0192d050-0000-7000-8000-0000000000a5',
};
const UNITS_B = {
  organizationId: ORG_B,
  obras: '0192d050-0000-7000-8000-0000000000b1',
  manutencao: '0192d050-0000-7000-8000-0000000000b2',
  pavimentacao: '0192d050-0000-7000-8000-0000000000b3',
  saude: '0192d050-0000-7000-8000-0000000000b4',
  posto: '0192d050-0000-7000-8000-0000000000b5',
};
const COMPRAS = '0192d050-0000-7000-8000-0000000000a7';
const FLOW_VERSION = '0192d050-0000-7000-8000-0000000000f1';

const RENATA = { subject: 'sub-lucia', user: FAKE_USERS.lucia };
const MARCOS = { subject: 'sub-otavio', user: FAKE_USERS.otavio };
const TITULAR = { subject: 'sub-marta', user: FAKE_USERS.marta };
const FELIPE = FAKE_USERS.ana;
const JULIANA = FAKE_USERS.fabio;

const membershipOf = (userId: string, tenantId = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

/** ABERTURA → TERMO_REFERENCIA (tarefa) → APROVACAO_AUTORIDADE (aprovação) → CONCLUSAO. */
const flow = new DefinitionBuilder(FLOW_VERSION)
  .stage('ABERTURA', 'START', { name: 'Formalização da demanda', assignmentPolicy: 'CREATOR' })
  .stage('TERMO_REFERENCIA', 'TASK', {
    name: 'Termo de referência',
    departmentResolution: 'FIXED',
    fixedDepartmentId: COMPRAS,
  })
  .stage('APROVACAO_AUTORIDADE', 'APPROVAL', {
    name: 'Aprovação da autoridade',
    departmentResolution: 'FIXED',
    fixedDepartmentId: COMPRAS,
  })
  .stage('CONCLUSAO', 'END', { name: 'Concluído' })
  .transition('ABERTURA', 'TERMO_REFERENCIA', 'FORWARD', { isPrimary: true })
  .transition('TERMO_REFERENCIA', 'APROVACAO_AUTORIDADE', 'FORWARD', { isPrimary: true })
  .transition('APROVACAO_AUTORIDADE', 'CONCLUSAO', 'APPROVE');

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

describe('Feature: Atribuir e reatribuir responsável (US-050)', () => {
  let api: TestApi;
  let log: MockInstance<Logger['log']>;
  let warn: MockInstance<Logger['warn']>;
  const transactions = new FlakyTransactions();
  const clock = { now: NOW };
  let catalog: { contractingType: string; origin: string };
  const words = (count: number) =>
    Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

  const auth = (call: request.Test, subject = RENATA.subject, tenant: string = A) =>
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
  const assign = (
    process: Pick<Process, 'id' | 'version'>,
    body: Record<string, unknown>,
    options: { subject?: string; tenant?: string; ifMatch?: string | null } = {},
  ) => {
    const call = auth(
      request(api.server).post(`/api/v1/processes/${process.id}/assign`),
      options.subject,
      options.tenant,
    );
    if (options.ifMatch !== null) {
      call.set('If-Match', options.ifMatch ?? `"${String(process.version)}"`);
    }
    return call.send(body);
  };
  const assignEntryOf = async (processId: string, subject = RENATA.subject) => {
    const response = await auth(
      request(api.server).get(`/api/v1/processes/${processId}/available-actions`),
      subject,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return z
      .array(actionEntrySchema)
      .parse(data<ActionEntry[]>(response))
      .find((action) => action.action === 'ASSIGN');
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
  const assignsOf = (processId: string) =>
    repository()
      .movementsOf(processId)
      .filter((movement) => movement.action === 'ASSIGN');
  /** Efeitos gravados do processo (para provar que nada foi gravado numa recusa). */
  const effects = (processId: string) => ({
    process: stored(processId),
    stages: repository().stagesOf(processId),
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
    } finally {
      clock.now = NOW;
    }
  }

  /**
   * O processo "0012/2026" na etapa `key` do Setor de Compras, versão 4, com `responsible` (padrão
   * Felipe; `null` = na fila da unidade).
   */
  async function processInCompras(
    options: {
      readonly key?: string;
      readonly status?: Process['status'];
      readonly responsible?: string | null;
    } = {},
  ): Promise<Process> {
    const created = await createProcess();
    const [opening] = repository().stagesOf(created.id);
    if (!opening) throw new Error('passagem de abertura ausente');
    repository().seedStage({ ...opening, status: 'COMPLETED', exitedAt: OPENED });
    const responsible = options.responsible === undefined ? FELIPE.id : options.responsible;
    const id = newId();
    const key = options.key ?? 'TERMO_REFERENCIA';
    repository().seedStage({
      id,
      tenantId: A,
      processId: created.id,
      workflowStageId: flow.stageId(key),
      sequence: 2,
      status: 'ACTIVE',
      departmentId: COMPRAS,
      assigneeId: responsible,
      enteredAt: new Date('2026-10-02T12:00:00.000Z'),
      dueAt: null,
      slaDays: null,
      slaType: null,
      enteredViaMovementId: null,
    });
    repository().seedAssignment({
      id: newId(),
      tenantId: A,
      processId: created.id,
      processStageId: id,
      departmentId: COMPRAS,
      assigneeId: responsible,
      type: 'STAGE_ENTRY',
      assignedById: null,
      startedAt: new Date('2026-10-02T12:00:00.000Z'),
    });
    const next: Process = {
      ...created,
      workflowVersionId: FLOW_VERSION,
      status: options.status ?? 'IN_PROGRESS',
      currentStageId: id,
      currentWorkflowStageId: flow.stageId(key),
      currentDepartmentId: COMPRAS,
      currentResponsibleId: responsible,
      number: 12,
      code: '0012/2026',
      openedAt: created.createdAt,
      version: 4,
    };
    repository().seed(next, [
      { principalType: 'DEPARTMENT', departmentId: COMPRAS, reason: 'CURRENT' },
      ...(responsible === null
        ? []
        : [
            { principalType: 'USER' as const, userId: responsible, reason: 'RESPONSIBLE' as const },
          ]),
    ]);
    return next;
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
    seedDepartment(api, {
      tenantId: A,
      organizationId: ORG_A,
      id: COMPRAS,
      name: 'Setor de Compras',
    });
    setDepartmentHead(api, COMPRAS, TITULAR.user.id, null);
    await seedPublishedInMemory(api, A, flow, 'TESTE_US050');
    await deactivateWorkflow(api, A, 'TESTE_US050');
    assignDepartment(api, membershipOf(FELIPE.id), UNITS_A.manutencao);
    assignDepartment(api, membershipOf(FELIPE.id), COMPRAS);
    assignDepartment(api, membershipOf(JULIANA.id), COMPRAS);
    assignDepartment(api, membershipOf(FAKE_USERS.eva.id), COMPRAS);
    assignDepartment(api, membershipOf(FAKE_USERS.bruno.id), COMPRAS);
    // POL-05 por escopo: Felipe com PROCESS_ASSIGN (GESTOR_CONTRATACOES) no órgão do processo.
    assignRole(api, {
      tenantId: A,
      membershipId: membershipOf(FELIPE.id),
      roleId: seedDefaultRolesOf(api, A).get('GESTOR_CONTRATACOES')?.id ?? '',
      scopeType: 'ORGANIZATION',
      scopeOrganizationId: ORG_A,
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
    setDepartmentHead(api, COMPRAS, TITULAR.user.id, null);
  });

  describe('[Sucesso]', () => {
    it('Gestor reatribui o processo a outro membro: responsável atual, tramitação ASSIGN, auditoria, evento MANUAL, timeline e acesso', async () => {
      const process = await processInCompras();
      expect(await assignEntryOf(process.id)).toMatchObject({ enabled: true, reasons: [] });
      log.mockClear();

      const response = await assign(process, { assigneeId: JULIANA.id, reason: REASON });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers.etag).toBe('"5"');
      expect(response.headers['cache-control']).toContain('no-store');
      expect(data<ProcessDto>(response)).toMatchObject({
        id: process.id,
        status: 'IN_PROGRESS',
        currentResponsible: { id: JULIANA.id },
        currentDepartment: { id: COMPRAS },
        currentStage: { key: 'TERMO_REFERENCIA' },
        version: 5,
      });

      // Tramitação ASSIGN na mesma passagem, com o motivo, o autor e os nomes congelados.
      const [movement, ...more] = assignsOf(process.id);
      expect(more).toEqual([]);
      expect(movement).toMatchObject({
        action: 'ASSIGN',
        fromProcessStageId: process.currentStageId,
        toProcessStageId: process.currentStageId,
        fromDepartmentId: COMPRAS,
        toDepartmentId: COMPRAS,
        fromUserId: FELIPE.id,
        toUserId: JULIANA.id,
        actorId: RENATA.user.id,
        comment: REASON,
        userAgent: USER_AGENT,
        metadata: {
          labels: { fromUser: 'Ana Souza', toUser: 'Fabi Nunes' },
          clientChannel: 'WEB',
        },
      });

      // Uma única responsabilidade ativa: a MANUAL com o autor; a anterior foi encerrada.
      const assignments = repository().assignmentsOf(process.id);
      expect(assignments.filter((assignment) => assignment.isActive)).toEqual([
        expect.objectContaining({
          type: 'MANUAL',
          assigneeId: JULIANA.id,
          assignedById: RENATA.user.id,
          processStageId: process.currentStageId,
          departmentId: COMPRAS,
        }),
      ]);
      expect(
        repository()
          .stagesOf(process.id)
          .find((stage) => stage.id === process.currentStageId),
      ).toMatchObject({ status: 'ACTIVE', assigneeId: JULIANA.id });
      expect(stored(process.id)).toMatchObject({
        currentResponsibleId: JULIANA.id,
        updatedById: RENATA.user.id,
        version: 5,
      });

      // ProcessAccess RESPONSIBLE da Juliana; timeline PROCESS_ASSIGNED.
      const access = repository()
        .accessOf(process.id)
        .map((row) => [row.reason, row.departmentId ?? row.userId]);
      expect(access).toContainEqual(['RESPONSIBLE', JULIANA.id]);
      expect(
        timelineRowsOf(api).filter(
          (row) => row.processId === process.id && row.type === 'PROCESS_ASSIGNED',
        ),
      ).toHaveLength(1);

      // Auditoria `process.assign` (WORKFLOW) com a mudança e o tamanho do motivo (nunca o texto).
      const [audit, ...otherAudits] = auditOf(process.id, 'process.assign');
      expect(otherAudits).toEqual([]);
      expect(audit).toMatchObject({
        category: 'WORKFLOW',
        metadata: {
          fromUserId: FELIPE.id,
          toUserId: JULIANA.id,
          viaHeadOrDeputy: false,
          reasonLength: REASON.length,
          movementId: movement?.id,
        },
      });
      expect(audit?.changes).toEqual([
        { path: 'currentResponsibleId', old: FELIPE.id, new: JULIANA.id },
      ]);

      // Evento MANUAL (o worker notifica a Juliana com PROCESS_ASSIGNED).
      expect(eventsOf(process.id, 'ProcessAssigned')).toEqual([
        expect.objectContaining({
          routingKey: 'process.assigned',
          payload: {
            processStageId: process.currentStageId,
            departmentId: COMPRAS,
            fromUserId: FELIPE.id,
            toUserId: JULIANA.id,
            assignmentType: 'MANUAL',
            hasReason: true,
          },
        }),
      ]);
      expect(eventsOf(process.id).map((row) => row.eventType)).toEqual(
        expect.not.arrayContaining(['ProcessStageChanged', 'ProcessStatusChanged']),
      );

      // Log de negócio só com ids; o motivo nunca vai para o log.
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'process.assigned',
          processId: process.id,
          fromUserId: FELIPE.id,
          toUserId: JULIANA.id,
          actorId: RENATA.user.id,
        }),
        'process.assigned',
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain(REASON);
    });

    it('FA-01: primeira atribuição a partir da fila dispensa o motivo', async () => {
      const process = await processInCompras({ responsible: null });
      const response = await assign(process, { assigneeId: JULIANA.id });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(stored(process.id).currentResponsibleId).toBe(JULIANA.id);
      expect(eventsOf(process.id, 'ProcessAssigned')[0]?.payload).toMatchObject({
        fromUserId: null,
        hasReason: false,
      });
      expect(assignsOf(process.id)[0]).toMatchObject({ comment: null });
    });

    it('FA-02: remover o responsável (assigneeId null) devolve à fila da unidade com motivo', async () => {
      const process = await processInCompras({ status: 'RETURNED' });
      const response = await assign(process, {
        assigneeId: null,
        reason: 'Redistribuir na equipe',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(data<ProcessDto>(response)).toMatchObject({
        status: 'RETURNED',
        currentResponsible: null,
      });
      expect(stored(process.id)).toMatchObject({
        currentResponsibleId: null,
        currentDepartmentId: COMPRAS,
      });
      const active = repository()
        .assignmentsOf(process.id)
        .filter((assignment) => assignment.isActive);
      expect(active).toEqual([expect.objectContaining({ type: 'MANUAL', assigneeId: null })]);
      expect(eventsOf(process.id, 'ProcessAssigned')[0]?.payload).toMatchObject({
        fromUserId: FELIPE.id,
        toUserId: null,
      });
    });

    it('RN-TRAM-41: o gestor pode se designar responsável se for elegível; sem lotação, 422', async () => {
      const process = await processInCompras({ responsible: null });
      // Renata (Lúcia) não é lotada em Compras: não é elegível.
      expectProblem(
        await assign(process, { assigneeId: RENATA.user.id }),
        422,
        'ASSIGNEE_NOT_ELIGIBLE',
      );
      // Lotada em Compras, a gestora pode se designar responsável.
      assignDepartment(api, membershipOf(RENATA.user.id), COMPRAS);
      const response = await assign(process, { assigneeId: RENATA.user.id });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(stored(process.id).currentResponsibleId).toBe(RENATA.user.id);
    });
  });

  describe('[Validação]', () => {
    it('Reatribuição sem motivo: 422 VALIDATION_ERROR no campo reason e Felipe continua responsável', async () => {
      const process = await processInCompras();
      const before = effects(process.id);
      const body = expectProblem(
        await assign(process, { assigneeId: JULIANA.id }),
        422,
        'VALIDATION_ERROR',
      );
      expect(body.errors).toEqual([
        expect.objectContaining({
          field: 'reason',
          message: 'Informe o motivo da troca de responsável.',
        }),
      ]);
      expect(effects(process.id)).toEqual(before);
      expect(stored(process.id).currentResponsibleId).toBe(FELIPE.id);
    });

    it('Remover o responsável sem motivo também exige o motivo', async () => {
      const process = await processInCompras();
      const body = expectProblem(
        await assign(process, { assigneeId: null }),
        422,
        'VALIDATION_ERROR',
      );
      expect(body.errors[0]).toMatchObject({ field: 'reason' });
    });

    it('V-01/V-03: assigneeId ausente e motivo curto = 422 VALIDATION_ERROR', async () => {
      const process = await processInCompras();
      const missing = expectProblem(
        await assign(process, { reason: REASON }),
        422,
        'VALIDATION_ERROR',
      );
      expect(missing.errors[0]).toMatchObject({
        field: 'assigneeId',
        message: 'Selecione um responsável ou deixe na fila da unidade.',
      });
      const short = expectProblem(
        await assign(process, { assigneeId: JULIANA.id, reason: 'curto' }),
        422,
        'VALIDATION_ERROR',
      );
      expect(short.errors[0]).toMatchObject({
        field: 'reason',
        message: 'O motivo deve ter ao menos 10 caracteres.',
      });
      expect(stored(process.id).currentResponsibleId).toBe(FELIPE.id);
    });

    it('V-04: pessoa sem PROCESS_VIEW, com vínculo suspenso ou sem lotação na unidade = 422 ASSIGNEE_NOT_ELIGIBLE', async () => {
      const process = await processInCompras();
      for (const candidate of [FAKE_USERS.eva, FAKE_USERS.bruno, FAKE_USERS.marta]) {
        const body = expectProblem(
          await assign(process, { assigneeId: candidate.id, reason: REASON }),
          422,
          'ASSIGNEE_NOT_ELIGIBLE',
        );
        expect(body.detail).toBe('Esta pessoa não pode ser responsável por este processo.');
        expect(body.errors[0]).toMatchObject({ field: 'assigneeId' });
      }
      expect(assignsOf(process.id)).toEqual([]);
    });

    it('V-06: etapa de aprovação ou status incompatível = 409 INVALID_PROCESS_STATUS, botão indisponível', async () => {
      const approval = await processInCompras({ key: 'APROVACAO_AUTORIDADE' });
      expect(await assignEntryOf(approval.id)).toMatchObject({
        enabled: false,
        reasons: [expect.objectContaining({ code: 'INVALID_PROCESS_STATUS' })],
      });
      const before = effects(approval.id);
      const body = expectProblem(
        await assign(approval, { assigneeId: JULIANA.id, reason: REASON }),
        409,
        'INVALID_PROCESS_STATUS',
      );
      expect(body.detail).toBe('Este processo não pode ser atribuído no momento.');
      expect(effects(approval.id)).toEqual(before);
      for (const status of ['DRAFT', 'AWAITING_APPROVAL', 'SUSPENDED', 'COMPLETED'] as const) {
        const process = await processInCompras({ status });
        expectProblem(
          await assign(process, { assigneeId: JULIANA.id, reason: REASON }),
          409,
          'INVALID_PROCESS_STATUS',
        );
      }
    });

    it('Sem If-Match: 428 PRECONDITION_REQUIRED', async () => {
      const process = await processInCompras();
      expectProblem(
        await assign(process, { assigneeId: JULIANA.id, reason: REASON }, { ifMatch: null }),
        428,
        'PRECONDITION_REQUIRED',
      );
    });
  });

  describe('[Permissão]', () => {
    it('Sem PROCESS_ASSIGN nem titularidade: 403 PERMISSION_DENIED com access.denied, botão omitido', async () => {
      const process = await processInCompras();
      expect(await assignEntryOf(process.id, MARCOS.subject)).toBeUndefined();
      const before = effects(process.id);
      const body = expectProblem(
        await assign(
          process,
          { assigneeId: JULIANA.id, reason: REASON },
          { subject: MARCOS.subject },
        ),
        403,
        'PERMISSION_DENIED',
      );
      expect(body.detail).toBe('Você não pode atribuir responsáveis neste processo.');
      expect(api.auditRecords().at(-1)).toMatchObject({
        action: 'access.denied',
        reasonCode: 'PROCESS_ASSIGN',
      });
      const after = effects(process.id);
      expect({ ...after, audit: before.audit }).toEqual(before);
    });

    it('FA-03: titular da unidade atual sem PROCESS_ASSIGN atribui (viaHeadOrDeputy, log da exceção)', async () => {
      const process = await processInCompras();
      expect(await assignEntryOf(process.id, TITULAR.subject)).toMatchObject({ enabled: true });
      warn.mockClear();
      const response = await assign(
        process,
        { assigneeId: JULIANA.id, reason: REASON },
        { subject: TITULAR.subject },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(auditOf(process.id, 'process.assign')[0]?.metadata).toMatchObject({
        viaHeadOrDeputy: true,
      });
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'assign.not_head_or_deputy_fallback' }),
        'assign.not_head_or_deputy_fallback',
      );
    });

    it('FA-03: substituto da unidade atual também atribui; deixando a chefia, perde a exceção', async () => {
      const process = await processInCompras();
      setDepartmentHead(api, COMPRAS, TITULAR.user.id, MARCOS.user.id);
      const response = await assign(
        process,
        { assigneeId: JULIANA.id, reason: REASON },
        { subject: MARCOS.subject },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      setDepartmentHead(api, COMPRAS, null, null);
      const next = stored(process.id);
      expectProblem(
        await assign(next, { assigneeId: FELIPE.id, reason: REASON }, { subject: TITULAR.subject }),
        403,
        'PERMISSION_DENIED',
      );
    });

    it('Chefia de OUTRA unidade não atribui', async () => {
      const process = await processInCompras();
      setDepartmentHead(api, COMPRAS, null, null);
      setDepartmentHead(api, UNITS_A.manutencao, TITULAR.user.id, null);
      try {
        expectProblem(
          await assign(
            process,
            { assigneeId: JULIANA.id, reason: REASON },
            { subject: TITULAR.subject },
          ),
          403,
          'PERMISSION_DENIED',
        );
      } finally {
        setDepartmentHead(api, UNITS_A.manutencao, null, null);
      }
    });

    it('PROCESS_ASSIGN com escopo ORGANIZATION do órgão do processo vale (Felipe)', async () => {
      // O escopo de unidade, que não basta, é coberto em application/process-viewer.spec.ts.
      const process = await processInCompras();
      expect(await assignEntryOf(process.id, 'sub-ana')).toMatchObject({ enabled: true });
      const response = await assign(
        process,
        { assigneeId: JULIANA.id, reason: REASON },
        { subject: 'sub-ana' },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(auditOf(process.id, 'process.assign')[0]?.metadata).toMatchObject({
        viaHeadOrDeputy: false,
      });
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Novo responsável de outro tenant: 422 VALIDATION_ERROR REFERENCE_NOT_FOUND sem revelar o registro', async () => {
      const process = await processInCompras();
      const before = effects(process.id);
      const response = await assign(process, { assigneeId: FAKE_USERS.paulo.id, reason: REASON });
      const body = expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(body.errors).toEqual([
        expect.objectContaining({ field: 'assigneeId', code: 'REFERENCE_NOT_FOUND' }),
      ]);
      expect(JSON.stringify(response.body)).not.toContain(FAKE_USERS.paulo.name);
      expect(JSON.stringify(response.body)).not.toContain('Encerrando');
      expect(effects(process.id)).toEqual(before);
    });

    it('Processo de outro tenant: 404 PROCESS_NOT_FOUND sem alterar nada', async () => {
      const process = await processInCompras();
      const before = effects(process.id);
      expectProblem(
        await assign(
          process,
          { assigneeId: JULIANA.id, reason: REASON },
          { subject: 'sub-heitor', tenant: B },
        ),
        404,
        'PROCESS_NOT_FOUND',
      );
      expect(effects(process.id)).toEqual(before);
    });
  });

  describe('[Duplicidade]', () => {
    it('Reenvio da mesma requisição com If-Match "4" após o 200 (ETag "5"): 412 VERSION_CONFLICT, sem nova tramitação', async () => {
      const process = await processInCompras();
      const first = await assign(process, { assigneeId: JULIANA.id, reason: REASON });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(first.headers.etag).toBe('"5"');
      const second = await assign(process, { assigneeId: JULIANA.id, reason: REASON });
      const body = expectProblem(second, 412, 'VERSION_CONFLICT');
      expect(body.detail).toBe('Os dados do processo mudaram. Atualize a página.');
      expect(second.body).toMatchObject({ currentVersion: 5, sentVersion: 4 });
      expect(assignsOf(process.id)).toHaveLength(1);
      expect(stored(process.id)).toMatchObject({ currentResponsibleId: JULIANA.id, version: 5 });
    });
  });

  describe('[Concorrência]', () => {
    it('Dois gestores reatribuem ao mesmo tempo: só a primeira aplica, a segunda recebe 412', async () => {
      const process = await processInCompras();
      const [renata, titular] = await Promise.all([
        assign(process, { assigneeId: JULIANA.id, reason: REASON }),
        assign(
          process,
          { assigneeId: null, reason: 'Redistribuir na equipe' },
          { subject: TITULAR.subject },
        ),
      ]);
      expect([renata.status, titular.status].sort()).toEqual([200, 412]);
      const loser = renata.status === 200 ? titular : renata;
      expectProblem(loser, 412, 'VERSION_CONFLICT');
      expect(assignsOf(process.id)).toHaveLength(1);
      expect(
        repository()
          .assignmentsOf(process.id)
          .filter((assignment) => assignment.isActive),
      ).toHaveLength(1);
      expect(stored(process.id).version).toBe(5);
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível: 503 DEPENDENCY_UNAVAILABLE e o processo permanece com o responsável anterior', async () => {
      const process = await processInCompras();
      const before = effects(process.id);
      transactions.down = true;
      const response = await assign(process, { assigneeId: JULIANA.id, reason: REASON });
      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      transactions.down = false;
      expect(effects(process.id)).toEqual(before);
      expect(stored(process.id).currentResponsibleId).toBe(FELIPE.id);
    });
  });

  describe('[Falha de integração]', () => {
    it('Relay do outbox fora: 200 e o ProcessAssigned gravado no outbox no mesmo commit', async () => {
      // Sem relay no teste em memória: o evento fica no outbox (o status PENDING é provado sobre o
      // PostgreSQL em test/tenant-leak/process-assign.spec.ts).
      const process = await processInCompras();
      const response = await assign(process, { assigneeId: JULIANA.id, reason: REASON });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(eventsOf(process.id, 'ProcessAssigned')).toHaveLength(1);
    });
  });
});
