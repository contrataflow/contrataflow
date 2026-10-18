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
import { deactivateWorkflow } from '../../../../test/support/process-forward-fixtures.js';
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
 * US-049 — PRC-21 (assumir processo) pelo pipeline HTTP completo (autenticação, tenant, vínculo,
 * autorização, `If-Match`, filtro RFC 9457) com a identidade fake, os seeders reais e repositórios
 * em memória — as 8 categorias do Gherkin. Background: o processo "0012/2026" está na etapa
 * TERMO_REFERENCIA do "Departamento de Compras", sem responsável. Felipe = "Ana" fake (lotada em
 * Compras); Marina = "Lúcia" (lotada só no setor solicitante); o segundo lotado em Compras,
 * "Fábio". Atomicidade com rollback real, RLS e o índice único de responsabilidade ativa sobre o
 * PostgreSQL: `test/tenant-leak/process-claim.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-05T15:00:00.000Z');
const OPENED = new Date('2026-09-28T13:00:00.000Z');
const USER_AGENT = 'Vitest/US-049';

const ORG_A = '0192d049-0000-7000-8000-0000000000a0';
const ORG_B = '0192d049-0000-7000-8000-0000000000b0';
const UNITS_A = {
  organizationId: ORG_A,
  obras: '0192d049-0000-7000-8000-0000000000a1',
  manutencao: '0192d049-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d049-0000-7000-8000-0000000000a3',
  saude: '0192d049-0000-7000-8000-0000000000a4',
  posto: '0192d049-0000-7000-8000-0000000000a5',
};
const UNITS_B = {
  organizationId: ORG_B,
  obras: '0192d049-0000-7000-8000-0000000000b1',
  manutencao: '0192d049-0000-7000-8000-0000000000b2',
  pavimentacao: '0192d049-0000-7000-8000-0000000000b3',
  saude: '0192d049-0000-7000-8000-0000000000b4',
  posto: '0192d049-0000-7000-8000-0000000000b5',
};
const COMPRAS = '0192d049-0000-7000-8000-0000000000a7';
const FLOW_VERSION = '0192d049-0000-7000-8000-0000000000f1';

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

describe('Feature: Assumir processo recebido pela unidade (US-049)', () => {
  let api: TestApi;
  let log: MockInstance<Logger['log']>;
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
  const claim = (
    process: Pick<Process, 'id' | 'version'>,
    options: { subject?: string; tenant?: string; ifMatch?: string | null } = {},
  ) => {
    const call = auth(
      request(api.server).post(`/api/v1/processes/${process.id}/claim`),
      options.subject,
      options.tenant,
    );
    if (options.ifMatch !== null) {
      call.set('If-Match', options.ifMatch ?? `"${String(process.version)}"`);
    }
    return call.send();
  };
  const actionsOf = async (processId: string, subject = 'sub-ana') => {
    const response = await auth(
      request(api.server).get(`/api/v1/processes/${processId}/available-actions`),
      subject,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return z.array(actionEntrySchema).parse(data<ActionEntry[]>(response));
  };
  const claimEntryOf = async (processId: string, subject = 'sub-ana') =>
    (await actionsOf(processId, subject)).find((action) => action.action === 'CLAIM');
  const eventsOf = (processId: string, eventType?: string) =>
    api
      .outboxRows()
      .filter(
        (row) =>
          row.processId === processId && (eventType === undefined || row.eventType === eventType),
      );
  const auditOf = (processId: string, action: string) =>
    api.auditRecords().filter((row) => row.processId === processId && row.action === action);
  const claimsOf = (processId: string) =>
    repository()
      .movementsOf(processId)
      .filter((movement) => movement.action === 'CLAIM');
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

  /**
   * O processo "0012/2026" na etapa `key`, no Departamento de Compras, SEM responsável (a
   * abertura é encerrada e a passagem ativa nasce na fila, com a responsabilidade da fila).
   */
  async function processInQueue(
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
    const responsible = options.responsible ?? null;
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
      version: 14,
    };
    repository().seed(next, [
      { principalType: 'DEPARTMENT', departmentId: COMPRAS, reason: 'CURRENT' },
    ]);
    return next;
  }

  beforeAll(async () => {
    log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
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
    await seedPublishedInMemory(api, A, flow, 'TESTE_US049');
    await deactivateWorkflow(api, A, 'TESTE_US049');
    assignDepartment(api, membershipOf(FAKE_USERS.ana.id), UNITS_A.manutencao);
    assignDepartment(api, membershipOf(FAKE_USERS.ana.id), COMPRAS);
    assignDepartment(api, membershipOf(FAKE_USERS.fabio.id), COMPRAS);
    assignDepartment(api, membershipOf(FAKE_USERS.lucia.id), UNITS_A.manutencao);
    // Otávio só com SOMENTE_LEITURA (sem PROCESS_CLAIM em nenhum escopo).
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
    it('Assumir processo sem responsável: responsável atual, tramitação CLAIM, auditoria, evento e timeline; sem notificação', async () => {
      const process = await processInQueue();
      expect(await claimEntryOf(process.id)).toMatchObject({ enabled: true, reasons: [] });
      log.mockClear();

      const response = await claim(process);

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers.etag).toBe('"15"');
      expect(response.headers['cache-control']).toContain('no-store');
      expect(data<ProcessDto>(response)).toMatchObject({
        id: process.id,
        status: 'IN_PROGRESS',
        currentResponsible: { id: FAKE_USERS.ana.id },
        currentDepartment: { id: COMPRAS },
        currentStage: { key: 'TERMO_REFERENCIA' },
        version: 15,
      });

      // Tramitação CLAIM na mesma passagem, sem motivo, com o ator, IP/user-agent e nomes.
      const [movement, ...more] = claimsOf(process.id);
      expect(more).toEqual([]);
      expect(movement).toMatchObject({
        action: 'CLAIM',
        sequence: 2,
        workflowTransitionId: null,
        fromProcessStageId: process.currentStageId,
        toProcessStageId: process.currentStageId,
        fromDepartmentId: COMPRAS,
        toDepartmentId: COMPRAS,
        fromUserId: null,
        toUserId: FAKE_USERS.ana.id,
        statusFrom: 'IN_PROGRESS',
        statusTo: 'IN_PROGRESS',
        actorId: FAKE_USERS.ana.id,
        comment: null,
        documents: [],
        userAgent: USER_AGENT,
        metadata: {
          labels: { toStage: 'Termo de referência', toUser: 'Ana Souza' },
          clientChannel: 'WEB',
        },
      });

      // A passagem segue a mesma, agora com a Ana; a responsabilidade da fila foi encerrada.
      const active = repository()
        .stagesOf(process.id)
        .filter((stage) => stage.status === 'ACTIVE');
      expect(active).toEqual([
        expect.objectContaining({ id: process.currentStageId, assigneeId: FAKE_USERS.ana.id }),
      ]);
      const assignments = repository().assignmentsOf(process.id);
      expect(assignments.filter((assignment) => assignment.isActive)).toEqual([
        expect.objectContaining({
          type: 'CLAIM',
          assigneeId: FAKE_USERS.ana.id,
          assignedById: null,
          processStageId: process.currentStageId,
          departmentId: COMPRAS,
        }),
      ]);
      expect(
        assignments.find(
          (assignment) => assignment.type === 'STAGE_ENTRY' && assignment.assigneeId === null,
        ),
      ).toMatchObject({ isActive: false });

      expect(stored(process.id)).toMatchObject({
        currentResponsibleId: FAKE_USERS.ana.id,
        updatedById: FAKE_USERS.ana.id,
        version: 15,
      });

      // ProcessAccess: RESPONSIBLE da Ana, mantendo o CURRENT da unidade.
      const access = repository()
        .accessOf(process.id)
        .map((row) => [row.reason, row.departmentId ?? row.userId]);
      expect(access).toContainEqual(['RESPONSIBLE', FAKE_USERS.ana.id]);
      expect(access).toContainEqual(['CURRENT', COMPRAS]);

      // Timeline `PROCESS_CLAIMED`.
      expect(
        timelineRowsOf(api).filter(
          (row) => row.processId === process.id && row.type === 'PROCESS_CLAIMED',
        ),
      ).toHaveLength(1);

      // Auditoria `process.claim` (WORKFLOW) com a mudança do responsável.
      const [audit, ...otherAudits] = auditOf(process.id, 'process.claim');
      expect(otherAudits).toEqual([]);
      expect(audit).toMatchObject({
        category: 'WORKFLOW',
        metadata: { processStageId: process.currentStageId, movementId: movement?.id },
      });
      expect(audit?.changes).toEqual([
        { path: 'currentResponsibleId', old: null, new: FAKE_USERS.ana.id },
      ]);

      // Evento: só `ProcessAssigned` (CLAIM) — nada de mudança de etapa/status nem aviso ao ator.
      expect(eventsOf(process.id).map((row) => row.eventType)).toEqual(
        expect.not.arrayContaining(['ProcessStageChanged', 'ProcessStatusChanged']),
      );
      expect(eventsOf(process.id, 'ProcessAssigned')).toEqual([
        expect.objectContaining({
          routingKey: 'process.assigned',
          payload: {
            processStageId: process.currentStageId,
            departmentId: COMPRAS,
            fromUserId: null,
            toUserId: FAKE_USERS.ana.id,
            assignmentType: 'CLAIM',
            hasReason: false,
          },
        }),
      ]);

      // Logs sem dados pessoais; o botão deixa de ser elegível.
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'process.claimed',
          processId: process.id,
          userId: FAKE_USERS.ana.id,
        }),
        'process.claimed',
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain('Ana Souza');
      expect(await claimEntryOf(process.id)).toMatchObject({
        enabled: false,
        reasons: [expect.objectContaining({ code: 'PROCESS_ALREADY_ASSIGNED' })],
      });
    });

    it('Processo RETURNED sem responsável também pode ser assumido', async () => {
      const process = await processInQueue({ status: 'RETURNED' });
      const response = await claim(process);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(stored(process.id)).toMatchObject({
        status: 'RETURNED',
        currentResponsibleId: FAKE_USERS.ana.id,
      });
    });
  });

  describe('[Validação]', () => {
    it('Etapa do tipo aprovação: "Assumir" indisponível e POST 409 INVALID_PROCESS_STATUS', async () => {
      const process = await processInQueue({ key: 'APROVACAO_AUTORIDADE' });
      expect(await claimEntryOf(process.id)).toMatchObject({
        enabled: false,
        reasons: [expect.objectContaining({ code: 'INVALID_PROCESS_STATUS' })],
      });
      const before = effects(process.id);
      const body = expectProblem(await claim(process), 409, 'INVALID_PROCESS_STATUS');
      expect(body.detail).toBe('Este processo não pode ser assumido no momento.');
      expect(effects(process.id)).toEqual(before);
    });

    it.each(['DRAFT', 'AWAITING_APPROVAL', 'SUSPENDED', 'CANCELED', 'COMPLETED'] as const)(
      'Processo em %s: 409 INVALID_PROCESS_STATUS e nada gravado',
      async (status) => {
        const process = await processInQueue({ status });
        const before = effects(process.id);
        expectProblem(await claim(process), 409, 'INVALID_PROCESS_STATUS');
        expect(effects(process.id)).toEqual(before);
      },
    );

    it('Processo que já tem responsável: 409 PROCESS_ALREADY_ASSIGNED com o nome e o responsável, nada gravado', async () => {
      const process = await processInQueue({ responsible: FAKE_USERS.fabio.id });
      const before = effects(process.id);
      const response = await claim(process);
      const body = expectProblem(response, 409, 'PROCESS_ALREADY_ASSIGNED');
      expect(body.detail).toBe(`Este processo já foi assumido por ${FAKE_USERS.fabio.socialName}.`);
      expect(response.body).toMatchObject({
        currentResponsible: { id: FAKE_USERS.fabio.id, name: FAKE_USERS.fabio.socialName },
      });
      expect(effects(process.id)).toEqual(before);
    });

    it('Sem If-Match: 428 PRECONDITION_REQUIRED', async () => {
      const process = await processInQueue();
      expectProblem(await claim(process, { ifMatch: null }), 428, 'PRECONDITION_REQUIRED');
      expect(stored(process.id).currentResponsibleId).toBeNull();
    });
  });

  describe('[Permissão]', () => {
    it('Usuário de outra unidade: 403 PERMISSION_DENIED com access.denied, "Assumir" sem sucesso e processo inalterado', async () => {
      const process = await processInQueue();
      expect(await claimEntryOf(process.id, 'sub-lucia')).toMatchObject({
        enabled: false,
        reasons: [expect.objectContaining({ code: 'NOT_PROCESS_CUSTODIAN' })],
      });
      const before = effects(process.id);
      const body = expectProblem(
        await claim(process, { subject: 'sub-lucia' }),
        403,
        'PERMISSION_DENIED',
      );
      expect(body.detail).toBe('Você não pertence à unidade responsável por este processo.');
      expect(api.auditRecords().at(-1)).toMatchObject({
        action: 'access.denied',
        reasonCode: 'PROCESS_CLAIM',
      });
      const after = effects(process.id);
      expect({ ...after, audit: before.audit }).toEqual(before);
    });

    it('Sem PROCESS_CLAIM em nenhum escopo: 403 PERMISSION_DENIED, botão omitido e access.denied', async () => {
      const process = await processInQueue();
      expect(await claimEntryOf(process.id, 'sub-otavio')).toBeUndefined();
      expectProblem(await claim(process, { subject: 'sub-otavio' }), 403, 'PERMISSION_DENIED');
      expect(api.auditRecords().at(-1)).toMatchObject({ action: 'access.denied' });
      expect(stored(process.id).currentResponsibleId).toBeNull();
    });

    it('Outro lotado na unidade (Fábio) também assume — não só quem abriu o processo', async () => {
      const process = await processInQueue();
      const response = await claim(process, { subject: 'sub-fabio' });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(stored(process.id).currentResponsibleId).toBe(FAKE_USERS.fabio.id);
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Processo de outro tenant: 404 PROCESS_NOT_FOUND sem alterar nada', async () => {
      const process = await processInQueue();
      const before = effects(process.id);
      expectProblem(
        await claim(process, { subject: 'sub-heitor', tenant: B }),
        404,
        'PROCESS_NOT_FOUND',
      );
      expect(effects(process.id)).toEqual(before);
    });

    it('Id inexistente: 404 PROCESS_NOT_FOUND', async () => {
      expectProblem(await claim({ id: randomUUID(), version: 1 }), 404, 'PROCESS_NOT_FOUND');
    });
  });

  describe('[Duplicidade]', () => {
    it('Clique duplo: o reenvio com o If-Match já consumido responde 412 VERSION_CONFLICT e o estado fica com um único CLAIM', async () => {
      const process = await processInQueue();
      const first = await claim(process);
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      const second = await claim(process); // ainda com o If-Match "14"
      const body = expectProblem(second, 412, 'VERSION_CONFLICT');
      expect(body.detail).toBe('Os dados do processo mudaram. Atualize a página.');
      expect(second.body).toMatchObject({ currentVersion: 15, sentVersion: 14 });
      expect(claimsOf(process.id)).toHaveLength(1);
      expect(stored(process.id)).toMatchObject({
        currentResponsibleId: FAKE_USERS.ana.id,
        version: 15,
      });
      // Com a versão nova, o processo já é dela: 409 (a tela só mostra o responsável).
      expectProblem(await claim(stored(process.id)), 409, 'PROCESS_ALREADY_ASSIGNED');
    });
  });

  describe('[Concorrência]', () => {
    it('Dois usuários assumem ao mesmo tempo: um 200, o outro 409 PROCESS_ALREADY_ASSIGNED com o nome do vencedor', async () => {
      const process = await processInQueue();
      const [felipe, marina] = await Promise.all([
        claim(process, { subject: 'sub-ana' }),
        claim(process, { subject: 'sub-fabio' }),
      ]);
      expect([felipe.status, marina.status].sort()).toEqual([200, 409]);
      const winner = felipe.status === 200 ? FAKE_USERS.ana : FAKE_USERS.fabio;
      const loser = felipe.status === 200 ? marina : felipe;
      const body = expectProblem(loser, 409, 'PROCESS_ALREADY_ASSIGNED');
      expect(body.detail).toBe(
        `Este processo já foi assumido por ${winner.socialName ?? winner.name}.`,
      );
      expect(stored(process.id).currentResponsibleId).toBe(winner.id);
      expect(claimsOf(process.id)).toHaveLength(1);
      expect(
        repository()
          .assignmentsOf(process.id)
          .filter((assignment) => assignment.isActive),
      ).toHaveLength(1);
    });

    it('10 claims simultâneos: exatamente um vencedor e nove 409', async () => {
      const process = await processInQueue();
      const responses = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          claim(process, { subject: index % 2 === 0 ? 'sub-ana' : 'sub-fabio' }),
        ),
      );
      const statuses = responses.map((response) => response.status);
      expect(statuses.filter((status) => status === 200)).toHaveLength(1);
      const refused = responses.filter((response) => response.status !== 200);
      expect(refused).toHaveLength(9);
      for (const response of refused) {
        // O mesmo usuário reenviando com o If-Match vencido recebe 412; o outro, 409.
        expect([409, 412]).toContain(response.status);
      }
      expect(claimsOf(process.id)).toHaveLength(1);
      expect(
        repository()
          .assignmentsOf(process.id)
          .filter((assignment) => assignment.isActive),
      ).toHaveLength(1);
      expect(stored(process.id).version).toBe(15);
    });

    it('If-Match desatualizado em processo ainda na fila: 412 VERSION_CONFLICT', async () => {
      const process = await processInQueue();
      repository().replace({ ...stored(process.id), version: 15 });
      const conflict = await claim(process, { ifMatch: '"14"' });
      expectProblem(conflict, 412, 'VERSION_CONFLICT');
      expect(stored(process.id).currentResponsibleId).toBeNull();
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível durante o claim: 503 DEPENDENCY_UNAVAILABLE com Retry-After e o processo segue sem responsável', async () => {
      const process = await processInQueue();
      const before = effects(process.id);
      transactions.down = true;
      const response = await claim(process);
      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      expect(response.headers['retry-after']).toEqual(expect.any(String));
      transactions.down = false;
      expect(effects(process.id)).toEqual(before);
      expect(stored(process.id).currentResponsibleId).toBeNull();
    });
  });

  describe('[Falha de integração]', () => {
    it('Relay do outbox fora: 200 e o ProcessAssigned gravado no outbox no mesmo commit', async () => {
      // Sem relay no teste em memória: o evento fica no outbox (o status PENDING é provado sobre o
      // PostgreSQL em test/tenant-leak/process-claim.spec.ts).
      const process = await processInQueue();
      const response = await claim(process);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(eventsOf(process.id, 'ProcessAssigned')).toHaveLength(1);
    });
  });
});
