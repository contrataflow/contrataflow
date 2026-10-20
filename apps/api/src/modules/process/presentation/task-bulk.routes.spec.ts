import { randomUUID } from 'node:crypto';

import { bulkResultResponseSchema, problemDetailsSchema } from '@contrataflow/validation';
import type { BulkResultResponse, ProcessDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

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
 * US-058 — TSK-03/TSK-04 (ações em lote da caixa de tarefas) pelo pipeline HTTP completo
 * (autenticação, tenant, vínculo, autorização, idempotência, filtro RFC 9457) com a identidade
 * fake, os seeders reais e repositórios em memória — as 8 categorias do Gherkin. Elenco (fakes):
 * Carlos = "Ana" (lotada em Compras, `PROCESS_CLAIM`, titular de Compras — atribui pela chefia);
 * Fernanda = "Fábio" (lotado em Compras); Daniela = "Otávio" (ADMIN_ORGAO + SOMENTE_LEITURA: sem
 * `PROCESS_CLAIM`/`PROCESS_ASSIGN` e sem chefia); "Lúcia" tem `PROCESS_CLAIM` mas não é lotada em
 * Compras; "Eva" é lotada em Compras sem `PROCESS_VIEW` (responsável inelegível). RLS, rollback real
 * e o evento `PENDING` no PostgreSQL: `test/tenant-leak/task-bulk.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-05T15:00:00.000Z');
const OPENED = new Date('2026-09-28T13:00:00.000Z');
const USER_AGENT = 'Vitest/US-058';
const REASON = 'Mutirão de triagem do exercício';

const ORG_A = '0192d058-0000-7000-8000-0000000000a0';
const ORG_B = '0192d058-0000-7000-8000-0000000000b0';
const UNITS_A = {
  organizationId: ORG_A,
  obras: '0192d058-0000-7000-8000-0000000000a1',
  manutencao: '0192d058-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d058-0000-7000-8000-0000000000a3',
  saude: '0192d058-0000-7000-8000-0000000000a4',
  posto: '0192d058-0000-7000-8000-0000000000a5',
};
const UNITS_B = {
  organizationId: ORG_B,
  obras: '0192d058-0000-7000-8000-0000000000b1',
  manutencao: '0192d058-0000-7000-8000-0000000000b2',
  pavimentacao: '0192d058-0000-7000-8000-0000000000b3',
  saude: '0192d058-0000-7000-8000-0000000000b4',
  posto: '0192d058-0000-7000-8000-0000000000b5',
};
const COMPRAS = '0192d058-0000-7000-8000-0000000000a7';
const FLOW_VERSION = '0192d058-0000-7000-8000-0000000000f1';

const CARLOS = { subject: 'sub-ana', user: FAKE_USERS.ana };
const FERNANDA = { subject: 'sub-fabio', user: FAKE_USERS.fabio };
const DANIELA = { subject: 'sub-otavio', user: FAKE_USERS.otavio };

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

/**
 * Transações do módulo: em fila (corridas serializadas, como o `FOR UPDATE`), banco fora e banco que
 * cai depois de `downAfterRuns` transações de escrita (meio do lote).
 */
class FlakyTransactions implements ProcessTransactions {
  down = false;
  downAfterRuns: number | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    if (this.downAfterRuns !== null) {
      if (this.downAfterRuns === 0) this.down = true;
      else this.downAfterRuns -= 1;
    }
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

function bulkOf(response: request.Response): BulkResultResponse {
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return bulkResultResponseSchema.parse(response.body);
}

function expectProblem(response: request.Response, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  const body = problemDetailsSchema.parse(response.body);
  expect(body.code).toBe(code);
  return body;
}

describe('Feature: Ações em lote na caixa de tarefas (US-058)', () => {
  let api: TestApi;
  let log: MockInstance<Logger['log']>;
  let warn: MockInstance<Logger['warn']>;
  let error: MockInstance<Logger['error']>;
  const transactions = new FlakyTransactions();
  const clock = { now: NOW };
  let catalog: { contractingType: string; origin: string };
  let sequence = 100;
  const words = (count: number) =>
    Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

  const auth = (call: request.Test, subject = CARLOS.subject, tenant: string = A) =>
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
  const post = (
    route: 'bulk-claim' | 'bulk-assign',
    body: unknown,
    options: { subject?: string; key?: string | null } = {},
  ) => {
    const call = auth(request(api.server).post(`/api/v1/tasks/${route}`), options.subject);
    if (options.key !== null) call.set('Idempotency-Key', options.key ?? randomUUID());
    return call.send(body as object);
  };
  const bulkClaim = (
    processIds: readonly string[],
    options: { subject?: string; key?: string } = {},
  ) => post('bulk-claim', { processIds }, options);
  const bulkAssign = (
    body: { processIds: readonly string[]; assigneeId?: string; reason?: string },
    options: { subject?: string; key?: string } = {},
  ) => post('bulk-assign', body, options);
  const eventsOf = (processId: string) =>
    api
      .outboxRows()
      .filter((row) => row.processId === processId && row.eventType === 'ProcessAssigned');
  const auditOf = (processId: string, action: string) =>
    api.auditRecords().filter((row) => row.processId === processId && row.action === action);
  const movementsOf = (processId: string, action: 'CLAIM' | 'ASSIGN') =>
    repository()
      .movementsOf(processId)
      .filter((movement) => movement.action === action);

  /** Processo criado pelo PRC-02 em 28/09 (Carlos responsável pela ABERTURA). */
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

  /** Processo na etapa TERMO_REFERENCIA do Setor de Compras, sem responsável (na fila). */
  async function processInQueue(
    options: { readonly responsible?: string | null; readonly tenantId?: string } = {},
  ): Promise<Process> {
    const created = await createProcess();
    const [opening] = repository().stagesOf(created.id);
    if (!opening) throw new Error('passagem de abertura ausente');
    repository().seedStage({ ...opening, status: 'COMPLETED', exitedAt: OPENED });
    const responsible = options.responsible ?? null;
    const id = newId();
    repository().seedStage({
      id,
      tenantId: A,
      processId: created.id,
      workflowStageId: flow.stageId('TERMO_REFERENCIA'),
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
    sequence += 1;
    const next: Process = {
      ...created,
      tenantId: options.tenantId ?? A,
      workflowVersionId: FLOW_VERSION,
      status: 'IN_PROGRESS',
      currentStageId: id,
      currentWorkflowStageId: flow.stageId('TERMO_REFERENCIA'),
      currentDepartmentId: COMPRAS,
      currentResponsibleId: responsible,
      number: sequence,
      code: `${String(sequence).padStart(4, '0')}/2026`,
      openedAt: created.createdAt,
      version: 4,
    };
    repository().seed(next, [
      { principalType: 'DEPARTMENT', departmentId: COMPRAS, reason: 'CURRENT' },
    ]);
    return next;
  }

  const queue = async (count: number) => {
    const processes: Process[] = [];
    for (let index = 0; index < count; index += 1) processes.push(await processInQueue());
    return processes;
  };
  const idsOf = (processes: readonly Process[]) => processes.map((process) => process.id);

  beforeAll(async () => {
    log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
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
    setDepartmentHead(api, COMPRAS, CARLOS.user.id, null);
    await seedPublishedInMemory(api, A, flow, 'TESTE_US058');
    await deactivateWorkflow(api, A, 'TESTE_US058');
    assignDepartment(api, membershipOf(CARLOS.user.id), UNITS_A.manutencao);
    assignDepartment(api, membershipOf(CARLOS.user.id), COMPRAS);
    assignDepartment(api, membershipOf(FERNANDA.user.id), COMPRAS);
    assignDepartment(api, membershipOf(FAKE_USERS.eva.id), COMPRAS);
    assignDepartment(api, membershipOf(FAKE_USERS.lucia.id), UNITS_A.manutencao);
    assignRole(api, {
      tenantId: A,
      membershipId: membershipOf(DANIELA.user.id),
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
    transactions.downAfterRuns = null;
  });

  describe('[Sucesso]', () => {
    it('Assumir vários processos de uma vez: 5 sucessos, Carlos responsável e 5 ProcessAssigned (CLAIM)', async () => {
      const processes = await queue(5);
      const key = randomUUID();
      log.mockClear();
      warn.mockClear();

      const result = bulkOf(await bulkClaim(idsOf(processes), { key }));

      expect(result.meta).toEqual({ successCount: 5, errorCount: 0 });
      expect(result.data.map((item) => item.processId)).toEqual(idsOf(processes));
      for (const [index, process] of processes.entries()) {
        expect(result.data[index]).toEqual({
          processId: process.id,
          ok: true,
          process: {
            id: process.id,
            code: process.code,
            version: 5,
            currentResponsible: { id: CARLOS.user.id, name: expect.any(String) as unknown },
          },
        });
        expect(stored(process.id)).toMatchObject({
          currentResponsibleId: CARLOS.user.id,
          version: 5,
        });
        expect(movementsOf(process.id, 'CLAIM')).toHaveLength(1);
        expect(eventsOf(process.id)).toEqual([
          expect.objectContaining({
            routingKey: 'process.assigned',
            payload: expect.objectContaining({
              assignmentType: 'CLAIM',
              toUserId: CARLOS.user.id,
              fromUserId: null,
            }) as unknown,
          }),
        ]);
      }
      // Auditoria `process.claim` por item, com o mesmo lote e a chave de idempotência.
      const audits = processes.flatMap((process) => auditOf(process.id, 'process.claim'));
      expect(audits).toHaveLength(5);
      const batchIds = new Set(audits.map((audit) => audit.metadata.batchId));
      expect(batchIds.size).toBe(1);
      expect(audits.every((audit) => audit.metadata.idempotencyKey === key)).toBe(true);
      // Log do lote só com contagens; sem falha parcial.
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'tasks.bulk_claim',
          batchSize: 5,
          successCount: 5,
          errorCount: 0,
          durationMs: expect.any(Number) as unknown,
        }),
        'tasks.bulk_claim',
      );
      expect(warn).not.toHaveBeenCalledWith(
        expect.objectContaining({ event: 'tasks.bulk_partial_failure' }),
        'tasks.bulk_partial_failure',
      );
    });

    it('Sucesso parcial: 4 sucessos e 1 PROCESS_ALREADY_ASSIGNED; os 4 saem da fila', async () => {
      const processes = await queue(4);
      const taken = await processInQueue({ responsible: FERNANDA.user.id });
      const ids = [...idsOf(processes.slice(0, 2)), taken.id, ...idsOf(processes.slice(2))];
      warn.mockClear();

      const result = bulkOf(await bulkClaim(ids));

      expect(result.meta).toEqual({ successCount: 4, errorCount: 1 });
      expect(result.data[2]).toEqual({
        processId: taken.id,
        ok: false,
        code: 'PROCESS_ALREADY_ASSIGNED',
        message: expect.stringContaining('já foi assumido por') as unknown,
      });
      for (const process of processes) {
        expect(stored(process.id).currentResponsibleId).toBe(CARLOS.user.id);
      }
      expect(stored(taken.id).currentResponsibleId).toBe(FERNANDA.user.id);
      expect(eventsOf(taken.id)).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'tasks.bulk_partial_failure',
          errorCount: 1,
          codes: ['PROCESS_ALREADY_ASSIGNED'],
        }),
        'tasks.bulk_partial_failure',
      );
    });

    it('Atribuir em lote pela chefia: todos ao mesmo responsável, motivo na tramitação e ProcessAssigned (MANUAL)', async () => {
      const processes = await queue(3);
      log.mockClear();

      const result = bulkOf(
        await bulkAssign({
          processIds: idsOf(processes),
          assigneeId: FERNANDA.user.id,
          reason: REASON,
        }),
      );

      expect(result.meta).toEqual({ successCount: 3, errorCount: 0 });
      for (const process of processes) {
        expect(stored(process.id).currentResponsibleId).toBe(FERNANDA.user.id);
        expect(movementsOf(process.id, 'ASSIGN')).toEqual([
          expect.objectContaining({ comment: REASON, toUserId: FERNANDA.user.id }),
        ]);
        expect(eventsOf(process.id)).toEqual([
          expect.objectContaining({
            payload: expect.objectContaining({
              assignmentType: 'MANUAL',
              toUserId: FERNANDA.user.id,
              hasReason: true,
            }) as unknown,
          }),
        ]);
        expect(auditOf(process.id, 'process.assign')).toEqual([
          expect.objectContaining({
            category: 'WORKFLOW',
            metadata: expect.objectContaining({
              batchId: expect.any(String) as unknown,
              viaHeadOrDeputy: true,
            }) as unknown,
          }),
        ]);
      }
      // O motivo nunca vai para o log.
      expect(JSON.stringify(log.mock.calls)).not.toContain(REASON);
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'tasks.bulk_assign', batchSize: 3, successCount: 3 }),
        'tasks.bulk_assign',
      );
    });

    it('FA-02: todos os itens falham — ainda 200, com o erro de cada item', async () => {
      const taken = [
        await processInQueue({ responsible: FERNANDA.user.id }),
        await processInQueue({ responsible: FERNANDA.user.id }),
      ];
      const result = bulkOf(await bulkClaim(idsOf(taken)));
      expect(result.meta).toEqual({ successCount: 0, errorCount: 2 });
      expect(result.data.every((item) => item.code === 'PROCESS_ALREADY_ASSIGNED')).toBe(true);
    });
  });

  describe('[Validação]', () => {
    it('Lote acima do limite: 422 VALIDATION_ERROR com TOO_LONG em processIds e nenhum processo assumido', async () => {
      const [process] = await queue(1);
      if (!process) throw new Error('processo ausente');
      const ids = [process.id, ...Array.from({ length: 50 }, () => randomUUID())];
      const body = expectProblem(await bulkClaim(ids), 422, 'VALIDATION_ERROR');
      expect(body.errors).toEqual([
        expect.objectContaining({
          field: 'processIds',
          code: 'TOO_LONG',
          message: 'Selecione no máximo 50 processos por vez.',
        }),
      ]);
      expect(stored(process.id).currentResponsibleId).toBeNull();
      expect(eventsOf(process.id)).toEqual([]);
    });

    it('V-01: menos de 2 itens → TOO_SHORT', async () => {
      const body = expectProblem(await bulkClaim([randomUUID()]), 422, 'VALIDATION_ERROR');
      expect(body.errors).toEqual([
        expect.objectContaining({
          field: 'processIds',
          code: 'TOO_SHORT',
          message: 'Selecione ao menos 2 processos.',
        }),
      ]);
    });

    it('V-03: item repetido → DUPLICATE_IN_LIST', async () => {
      const id = randomUUID();
      const body = expectProblem(await bulkClaim([id, id]), 422, 'VALIDATION_ERROR');
      expect(body.errors).toEqual([
        expect.objectContaining({ field: 'processIds', code: 'DUPLICATE_IN_LIST' }),
      ]);
    });

    it('V-04: bulk-assign sem responsável e sem motivo → REQUIRED', async () => {
      const body = expectProblem(
        await bulkAssign({ processIds: [randomUUID(), randomUUID()] }),
        422,
        'VALIDATION_ERROR',
      );
      expect(body.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'assigneeId', code: 'REQUIRED' }),
          expect.objectContaining({ field: 'reason', code: 'REQUIRED' }),
        ]),
      );
    });

    it('FA-04: responsável inelegível na unidade — cada item falha com ASSIGNEE_NOT_ELIGIBLE', async () => {
      const processes = await queue(2);
      const result = bulkOf(
        await bulkAssign({
          processIds: idsOf(processes),
          assigneeId: FAKE_USERS.eva.id,
          reason: REASON,
        }),
      );
      expect(result.meta).toEqual({ successCount: 0, errorCount: 2 });
      expect(result.data.map((item) => item.code)).toEqual([
        'ASSIGNEE_NOT_ELIGIBLE',
        'ASSIGNEE_NOT_ELIGIBLE',
      ]);
      for (const process of processes) expect(stored(process.id).currentResponsibleId).toBeNull();
    });
  });

  describe('[Permissão]', () => {
    it('Atribuir em lote sem PROCESS_ASSIGN e sem titularidade: 403 do lote e access.denied (PROCESS_ASSIGN)', async () => {
      const processes = await queue(2);
      const body = expectProblem(
        await bulkAssign(
          { processIds: idsOf(processes), assigneeId: FERNANDA.user.id, reason: REASON },
          { subject: DANIELA.subject },
        ),
        403,
        'PERMISSION_DENIED',
      );
      expect(body.detail).toBe('Você não tem permissão para esta ação em lote.');
      expect(api.auditRecords().at(-1)).toMatchObject({
        action: 'access.denied',
        reasonCode: 'PROCESS_ASSIGN',
      });
      for (const process of processes) expect(stored(process.id).currentResponsibleId).toBeNull();
    });

    it('Assumir em lote sem PROCESS_CLAIM: 403 do lote e access.denied (PROCESS_CLAIM)', async () => {
      const processes = await queue(2);
      expectProblem(
        await bulkClaim(idsOf(processes), { subject: DANIELA.subject }),
        403,
        'PERMISSION_DENIED',
      );
      expect(api.auditRecords().at(-1)).toMatchObject({
        action: 'access.denied',
        reasonCode: 'PROCESS_CLAIM',
      });
    });

    it('Com PROCESS_CLAIM mas fora da unidade: POL-04 por item (erro por item, nunca 403 global)', async () => {
      const processes = await queue(2);
      const result = bulkOf(await bulkClaim(idsOf(processes), { subject: 'sub-lucia' }));
      expect(result.meta).toEqual({ successCount: 0, errorCount: 2 });
      expect(result.data.map((item) => item.code)).toEqual([
        'PERMISSION_DENIED',
        'PERMISSION_DENIED',
      ]);
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Processo de outro tenant no lote: REFERENCE_NOT_FOUND sem revelar a existência; os demais seguem', async () => {
      const processes = await queue(2);
      const foreign = await processInQueue({ tenantId: B });
      const missing = randomUUID();

      const result = bulkOf(await bulkClaim([...idsOf(processes), foreign.id, missing]));

      expect(result.meta).toEqual({ successCount: 2, errorCount: 2 });
      expect(result.data.slice(2)).toEqual([
        {
          processId: foreign.id,
          ok: false,
          code: 'REFERENCE_NOT_FOUND',
          message: 'O processo não pôde ser processado.',
        },
        {
          processId: missing,
          ok: false,
          code: 'REFERENCE_NOT_FOUND',
          message: 'O processo não pôde ser processado.',
        },
      ]);
      expect(stored(foreign.id).currentResponsibleId).toBeNull();
      expect(eventsOf(foreign.id)).toEqual([]);
    });
  });

  describe('[Duplicidade]', () => {
    it('Reenvio com a mesma chave: 200 com o mesmo resultado, Idempotent-Replayed e nada reprocessado', async () => {
      const processes = await queue(5);
      // A chave "K2" do Gherkin (a API exige UUID).
      const key = randomUUID();
      const original = bulkOf(await bulkClaim(idsOf(processes), { key }));
      expect(original.meta.successCount).toBe(5);

      const replay = await bulkClaim(idsOf(processes), { key });

      expect(bulkOf(replay)).toEqual(original);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      for (const process of processes) {
        expect(movementsOf(process.id, 'CLAIM')).toHaveLength(1);
        expect(eventsOf(process.id)).toHaveLength(1);
      }
    });

    it('Mesma chave com corpo diferente: 422 IDEMPOTENCY_KEY_REUSED', async () => {
      const processes = await queue(3);
      const key = randomUUID();
      bulkOf(await bulkClaim(idsOf(processes.slice(0, 2)), { key }));
      expectProblem(
        await bulkClaim(idsOf(processes.slice(1)), { key }),
        422,
        'IDEMPOTENCY_KEY_REUSED',
      );
      expect(stored(processes[2]?.id ?? '').currentResponsibleId).toBeNull();
    });
  });

  describe('[Concorrência]', () => {
    it('Dois lotes com processos em comum: cada processo com exatamente um responsável; o perdedor recebe PROCESS_ALREADY_ASSIGNED', async () => {
      const shared = await queue(2);
      const [carlos, fernanda] = await Promise.all([
        bulkClaim(idsOf(shared), { subject: CARLOS.subject }),
        bulkClaim(idsOf(shared), { subject: FERNANDA.subject }),
      ]);
      const results = [bulkOf(carlos), bulkOf(fernanda)];
      for (const [index, process] of shared.entries()) {
        const outcomes = results.map((result) => result.data[index]);
        expect(outcomes.filter((item) => item?.ok)).toHaveLength(1);
        expect(outcomes.find((item) => item?.ok === false)).toMatchObject({
          code: 'PROCESS_ALREADY_ASSIGNED',
        });
        expect(movementsOf(process.id, 'CLAIM')).toHaveLength(1);
        expect(
          repository()
            .assignmentsOf(process.id)
            .filter((assignment) => assignment.isActive),
        ).toHaveLength(1);
        expect([CARLOS.user.id, FERNANDA.user.id]).toContain(
          stored(process.id).currentResponsibleId,
        );
      }
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco cai no meio do lote: itens já processados permanecem; os demais saem DEPENDENCY_UNAVAILABLE sem serem tentados', async () => {
      const processes = await queue(5);
      transactions.downAfterRuns = 2;

      const result = bulkOf(await bulkClaim(idsOf(processes)));

      transactions.downAfterRuns = null;
      transactions.down = false;
      expect(result.meta).toEqual({ successCount: 2, errorCount: 3 });
      expect(result.data.slice(2).map((item) => item.code)).toEqual([
        'DEPENDENCY_UNAVAILABLE',
        'DEPENDENCY_UNAVAILABLE',
        'DEPENDENCY_UNAVAILABLE',
      ]);
      expect(result.data[2]?.message).toBe('Não foi possível concluir a ação agora.');
      for (const process of processes.slice(0, 2)) {
        expect(stored(process.id).currentResponsibleId).toBe(CARLOS.user.id);
        expect(eventsOf(process.id)).toHaveLength(1);
      }
      for (const process of processes.slice(2)) {
        expect(stored(process.id).currentResponsibleId).toBeNull();
        expect(eventsOf(process.id)).toEqual([]);
      }
    });

    it('Banco fora antes de começar (permissão base pela chefia): 503 e tasks.bulk_failed', async () => {
      const processes = await queue(2);
      transactions.down = true;
      error.mockClear();
      const response = await bulkAssign({
        processIds: idsOf(processes),
        assigneeId: FERNANDA.user.id,
        reason: REASON,
      });
      transactions.down = false;
      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'tasks.bulk_failed', action: 'assign', batchSize: 2 }),
        'tasks.bulk_failed',
      );
    });
  });

  describe('[Falha de integração]', () => {
    it('Relay do outbox fora: 200 para os 5 itens e os 5 ProcessAssigned gravados no outbox', async () => {
      // Sem relay no teste em memória: os eventos ficam no outbox (o status PENDING é provado sobre
      // o PostgreSQL em test/tenant-leak/task-bulk.spec.ts).
      const processes = await queue(5);
      const result = bulkOf(await bulkClaim(idsOf(processes)));
      expect(result.meta.successCount).toBe(5);
      for (const process of processes) expect(eventsOf(process.id)).toHaveLength(1);
    });
  });
});
