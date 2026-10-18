import { randomUUID } from 'node:crypto';

import { actionEntrySchema, problemDetailsSchema } from '@contrataflow/validation';
import type {
  ActionEntry,
  ProcessDto,
  ProcessSummaryDto,
  ResumeMeta,
  SuspensionProcessDto,
} from '@contrataflow/validation';
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
import { approvalRepositoryOf } from '../../../../test/support/document-fixtures.js';
import {
  CATALOG_CLOCK,
  catalogItemId,
  processRepositoryOf,
  runTenantSeeders,
  seedProcessStructure,
  timelineRowsOf,
} from '../../../../test/support/process-fixtures.js';
import { deactivateWorkflow } from '../../../../test/support/process-forward-fixtures.js';
import { seedPanelApproval } from '../../../../test/support/process-panel-fixtures.js';
import { assignDepartment, seedDepartment } from '../../../../test/support/structure-fixtures.js';
import { seedPublishedInMemory } from '../../../../test/support/workflow-engine-fixtures.js';
import { DefinitionBuilder } from '../../../../test/support/workflow-fixtures.js';
import { PROCESS_CLOCK, PROCESS_TRANSACTIONS } from '../application/ports.js';
import type { ProcessTransactions } from '../application/ports.js';
import type { Process } from '../domain/process.js';

/*
 * US-008 — PRC-23/PRC-24 (suspender e retomar processo) pelo pipeline HTTP completo (autenticação,
 * tenant, vínculo, autorização, `If-Match`, idempotência, filtro RFC 9457) com a identidade fake, os
 * seeders reais (feriado nacional de 12/10) e repositórios em memória — as 8 categorias do Gherkin.
 * Background: o processo "0012/2026", aberto por "Ana" (REQUISITANTE), está `IN_PROGRESS` na etapa
 * PESQUISA_PRECOS com prazo em 09/10/2026 (dias úteis) e "Fábio" como responsável ("Juliana");
 * "Lúcia" (GESTOR_CONTRATACOES, escopo TENANT) faz o papel de "Patrícia". Atomicidade com rollback
 * real, RLS e o evento `PENDING` sobre o PostgreSQL: `test/tenant-leak/process-suspension.spec.ts`;
 * os destinatários do aviso, no worker (`ProcessStakeholdersLookup`).
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const SUSPENDED_TENANT = FAKE_TENANTS.prefeituraSuspensa.id;
const OPENED = new Date('2026-09-28T13:00:00.000Z');
const SUSPEND_AT = new Date('2026-10-06T13:00:00.000Z'); // 06/10 10:00 em Brasília
const RESUME_AT = new Date('2026-10-13T18:00:00.000Z'); // 13/10 15:00 em Brasília
const DUE_09 = new Date('2026-10-10T02:59:59.999Z'); // fim de 09/10 em Brasília
const DUE_08 = new Date('2026-10-09T02:59:59.999Z'); // fim de 08/10 em Brasília
const USER_AGENT = 'Vitest/US-008';
const REASON = 'Aguardando definição da dotação pela Secretaria de Finanças';

const ORG_A = '0192d008-0000-7000-8000-0000000000a0';
const ORG_B = '0192d008-0000-7000-8000-0000000000b0';
const UNITS_A = {
  organizationId: ORG_A,
  obras: '0192d008-0000-7000-8000-0000000000a1',
  manutencao: '0192d008-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d008-0000-7000-8000-0000000000a3',
  saude: '0192d008-0000-7000-8000-0000000000a4',
  posto: '0192d008-0000-7000-8000-0000000000a5',
};
const UNITS_B = {
  organizationId: ORG_B,
  obras: '0192d008-0000-7000-8000-0000000000b1',
  manutencao: '0192d008-0000-7000-8000-0000000000b2',
  pavimentacao: '0192d008-0000-7000-8000-0000000000b3',
  saude: '0192d008-0000-7000-8000-0000000000b4',
  posto: '0192d008-0000-7000-8000-0000000000b5',
};
const COMPRAS = '0192d008-0000-7000-8000-0000000000a7';
const FLOW_VERSION = '0192d008-0000-7000-8000-0000000000f1';

const membershipOf = (userId: string, tenantId = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

/** ABERTURA → PESQUISA_PRECOS → TERMO_REFERENCIA → APROVACAO (aprovação) → CONCLUSAO. */
const flow = new DefinitionBuilder(FLOW_VERSION)
  .stage('ABERTURA', 'START', { name: 'Formalização da demanda', assignmentPolicy: 'CREATOR' })
  .stage('PESQUISA_PRECOS', 'TASK', {
    name: 'Pesquisa de preços',
    departmentResolution: 'FIXED',
    fixedDepartmentId: COMPRAS,
  })
  .stage('TERMO_REFERENCIA', 'TASK', {
    name: 'Termo de referência',
    departmentResolution: 'FIXED',
    fixedDepartmentId: COMPRAS,
  })
  .stage('APROVACAO', 'APPROVAL', {
    name: 'Aprovação da autoridade',
    departmentResolution: 'FIXED',
    fixedDepartmentId: COMPRAS,
  })
  .stage('CONCLUSAO', 'END', { name: 'Concluído' })
  .transition('ABERTURA', 'PESQUISA_PRECOS', 'FORWARD', { isPrimary: true })
  .transition('PESQUISA_PRECOS', 'TERMO_REFERENCIA', 'FORWARD', { isPrimary: true })
  .transition('TERMO_REFERENCIA', 'APROVACAO', 'FORWARD', { isPrimary: true })
  .transition('APROVACAO', 'CONCLUSAO', 'APPROVE');

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

describe('Feature: Suspender e retomar processo (US-008)', () => {
  let api: TestApi;
  let log: MockInstance<Logger['log']>;
  const transactions = new FlakyTransactions();
  const clock = { now: SUSPEND_AT };
  let catalog: { contractingType: string; origin: string };
  const words = (count: number) =>
    Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

  const auth = (call: request.Test, subject = 'sub-lucia', tenant: string = A) =>
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
  const activeStageOf = (id: string) =>
    repository()
      .stagesOf(id)
      .find((stage) => stage.status === 'ACTIVE');

  interface CallOptions {
    readonly subject?: string;
    readonly tenant?: string;
    readonly ifMatch?: string | null;
    readonly key?: string;
  }
  const command = (
    path: 'suspend' | 'resume',
    process: Pick<Process, 'id' | 'version'>,
    body: Record<string, unknown>,
    options: CallOptions = {},
  ) => {
    const call = auth(
      request(api.server).post(`/api/v1/processes/${process.id}/${path}`),
      options.subject,
      options.tenant,
    ).set('Idempotency-Key', options.key ?? randomUUID());
    if (options.ifMatch !== null) {
      call.set('If-Match', options.ifMatch ?? `"${String(process.version)}"`);
    }
    return call.send(body);
  };
  const suspend = (
    process: Pick<Process, 'id' | 'version'>,
    body: Record<string, unknown> = { reason: REASON },
    options: CallOptions = {},
  ) => command('suspend', process, body, options);
  const resume = (
    process: Pick<Process, 'id' | 'version'>,
    body: Record<string, unknown> = {},
    options: CallOptions = {},
  ) => command('resume', process, body, options);

  const actionsOf = async (processId: string, subject = 'sub-lucia') => {
    const response = await auth(
      request(api.server).get(`/api/v1/processes/${processId}/available-actions`),
      subject,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return z.array(actionEntrySchema).parse(data<ActionEntry[]>(response));
  };
  const summaryOf = async (processId: string) => {
    const response = await auth(request(api.server).get(`/api/v1/processes/${processId}/summary`));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return data<ProcessSummaryDto>(response);
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
  const movementsOf = (processId: string, action: 'SUSPEND' | 'RESUME') =>
    repository()
      .movementsOf(processId)
      .filter((movement) => movement.action === action);
  const timelineOf = (processId: string, type: string) =>
    timelineRowsOf(api).filter((row) => row.processId === processId && row.type === type);
  /** Efeitos gravados do processo (para provar que nada foi gravado numa recusa). */
  const effects = (processId: string) => ({
    process: stored(processId),
    stages: repository().stagesOf(processId),
    movements: repository().movementsOf(processId).length,
    access: repository().accessOf(processId).length,
    events: eventsOf(processId).length,
    audit: api.auditRecords().filter((row) => row.processId === processId).length,
    timeline: timelineRowsOf(api).filter((row) => row.processId === processId).length,
  });

  /** Processo criado pelo PRC-02 em 28/09 por Ana. */
  async function createProcess(): Promise<Process> {
    const previous = clock.now;
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
      clock.now = previous;
    }
  }

  /**
   * O processo "0012/2026" na etapa `key` do Departamento de Compras (versão 12), com o
   * responsável e o prazo da passagem ativa (padrão: Fábio, fim de 09/10 em dias úteis).
   */
  async function processAt(
    options: {
      readonly key?: string;
      readonly status?: Process['status'];
      readonly responsible?: string | null;
      readonly dueAt?: Date | null;
      readonly slaType?: 'BUSINESS' | 'CALENDAR';
      readonly overdueSince?: Date | null;
    } = {},
  ): Promise<Process> {
    const created = await createProcess();
    const [opening] = repository().stagesOf(created.id);
    if (!opening) throw new Error('passagem de abertura ausente');
    repository().seedStage({ ...opening, status: 'COMPLETED', exitedAt: OPENED });
    const responsible =
      options.responsible === undefined ? FAKE_USERS.fabio.id : options.responsible;
    const dueAt = options.dueAt === undefined ? DUE_09 : options.dueAt;
    const stageId = newId();
    const key = options.key ?? 'PESQUISA_PRECOS';
    repository().seedStage({
      id: stageId,
      tenantId: A,
      processId: created.id,
      workflowStageId: flow.stageId(key),
      sequence: 2,
      status: 'ACTIVE',
      departmentId: COMPRAS,
      assigneeId: responsible,
      enteredAt: new Date('2026-10-02T12:00:00.000Z'),
      dueAt,
      slaDays: dueAt === null ? null : 5,
      slaType: dueAt === null ? null : (options.slaType ?? 'BUSINESS'),
      enteredViaMovementId: null,
      overdueSince: options.overdueSince ?? null,
    });
    repository().seedAssignment({
      id: newId(),
      tenantId: A,
      processId: created.id,
      processStageId: stageId,
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
      currentStageId: stageId,
      currentWorkflowStageId: flow.stageId(key),
      currentDepartmentId: COMPRAS,
      currentResponsibleId: responsible,
      currentStageDueAt: dueAt,
      number: 12,
      code: '0012/2026',
      openedAt: created.createdAt,
      targetDate: '2026-11-30',
      version: 12,
    };
    repository().seed(next, [
      { principalType: 'DEPARTMENT', departmentId: COMPRAS, reason: 'CURRENT' },
    ]);
    if (options.overdueSince) {
      repository().setSituation(created.id, { overdueSince: options.overdueSince });
    }
    return next;
  }

  /** Suspende pelo PRC-23 em `at` e devolve o processo gravado. */
  async function suspended(process: Process, at = SUSPEND_AT): Promise<Process> {
    clock.now = at;
    const response = await suspend(process);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return stored(process.id);
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
        { token: CATALOG_CLOCK, value: () => SUSPEND_AT },
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
    await seedPublishedInMemory(api, A, flow, 'TESTE_US008');
    await deactivateWorkflow(api, A, 'TESTE_US008');
    assignDepartment(api, membershipOf(FAKE_USERS.ana.id), UNITS_A.manutencao);
    assignDepartment(api, membershipOf(FAKE_USERS.ana.id), COMPRAS);
    assignDepartment(api, membershipOf(FAKE_USERS.fabio.id), COMPRAS);
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
    clock.now = SUSPEND_AT;
  });

  describe('[Sucesso]', () => {
    it('Suspender processo com motivo: SUSPENDED, pausa, tramitação SUSPEND, evento, timeline e auditoria', async () => {
      const process = await processAt();
      expect(
        (await actionsOf(process.id)).find((entry) => entry.action === 'SUSPEND'),
      ).toMatchObject({ enabled: true });
      log.mockClear();

      const response = await suspend(process);

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers.etag).toBe('"13"');
      expect(response.headers['cache-control']).toContain('no-store');
      expect(data<SuspensionProcessDto>(response)).toMatchObject({
        id: process.id,
        status: 'SUSPENDED',
        statusBeforeSuspension: 'IN_PROGRESS',
        suspendedAt: SUSPEND_AT.toISOString(),
        suspensionReason: REASON,
        currentStage: { key: 'PESQUISA_PRECOS', pausedAt: SUSPEND_AT.toISOString() },
        currentResponsible: { id: FAKE_USERS.fabio.id },
        version: 13,
      });

      // Status, autor e passagem pausada; etapa, unidade e responsável intactos (RN-PROC-102).
      expect(stored(process.id)).toMatchObject({
        status: 'SUSPENDED',
        currentStageId: process.currentStageId,
        currentDepartmentId: COMPRAS,
        currentResponsibleId: FAKE_USERS.fabio.id,
        currentStageDueAt: DUE_09,
        version: 13,
      });
      expect(repository().suspendedByOf(process.id)).toBe(FAKE_USERS.lucia.id);
      expect(activeStageOf(process.id)).toMatchObject({
        id: process.currentStageId,
        pausedAt: SUSPEND_AT,
        dueAt: DUE_09,
      });

      const [movement, ...more] = movementsOf(process.id, 'SUSPEND');
      expect(more).toEqual([]);
      expect(movement).toMatchObject({
        statusFrom: 'IN_PROGRESS',
        statusTo: 'SUSPENDED',
        comment: REASON,
        fromProcessStageId: process.currentStageId,
        toProcessStageId: process.currentStageId,
        fromDepartmentId: COMPRAS,
        toDepartmentId: COMPRAS,
        fromUserId: FAKE_USERS.fabio.id,
        toUserId: FAKE_USERS.fabio.id,
        actorId: FAKE_USERS.lucia.id,
        userAgent: USER_AGENT,
      });

      expect(eventsOf(process.id, 'ProcessStatusChanged')).toEqual([
        expect.objectContaining({
          routingKey: 'process.status_changed.suspended',
          payload: {
            fromStatus: 'IN_PROGRESS',
            toStatus: 'SUSPENDED',
            cause: 'SUSPEND',
            reasonProvided: true,
            reason: REASON,
          },
        }),
      ]);
      const [entry] = timelineOf(process.id, 'PROCESS_SUSPENDED');
      expect(entry).toMatchObject({ params: { reason: REASON } });

      const [audit, ...otherAudits] = auditOf(process.id, 'process.suspend');
      expect(otherAudits).toEqual([]);
      expect(audit).toMatchObject({
        category: 'WORKFLOW',
        metadata: {
          fromStatus: 'IN_PROGRESS',
          toStatus: 'SUSPENDED',
          reason: REASON,
          movementId: movement?.id,
        },
      });
      expect(audit?.changes).toEqual([
        { path: 'status', old: 'IN_PROGRESS', new: 'SUSPENDED' },
        { path: 'statusBeforeSuspension', old: null, new: 'IN_PROGRESS' },
        { path: 'suspendedAt', old: null, new: SUSPEND_AT.toISOString() },
      ]);

      // Painel: "Suspenso desde … — motivo", prazo pausado e "Retomar" como ação.
      const summary = await summaryOf(process.id);
      expect(summary.where).toMatchObject({
        status: 'SUSPENDED',
        statusBeforeSuspension: 'IN_PROGRESS',
        suspensionReason: REASON,
        suspendedAt: SUSPEND_AT.toISOString(),
      });
      expect(summary.deadline).toMatchObject({ isPaused: true });
      expect((await actionsOf(process.id)).find((e) => e.action === 'RESUME')).toMatchObject({
        enabled: true,
      });

      // O log nunca leva o motivo.
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'process.suspended',
          processId: process.id,
          fromStatus: 'IN_PROGRESS',
          toStatus: 'SUSPENDED',
        }),
        'process.suspended',
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain(REASON);
    });

    it('Retomar e estender o prazo pelos dias úteis suspensos (06, 07, 08 e 09/10; 12/10 feriado)', async () => {
      const process = await suspended(await processAt());
      clock.now = RESUME_AT;
      log.mockClear();

      const response = await resume(process, { comment: 'Dotação definida pela Secretaria.' });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers.etag).toBe('"14"');
      const body = response.body as { data: SuspensionProcessDto; meta: ResumeMeta };
      expect(body.meta).toEqual({
        extendedBy: { days: 4, slaType: 'BUSINESS' },
        newDueAt: '2026-10-17T02:59:59.999Z',
      });
      expect(body.data).toMatchObject({
        status: 'IN_PROGRESS',
        statusBeforeSuspension: null,
        suspendedAt: null,
        suspensionReason: null,
        currentStage: { dueAt: '2026-10-17T02:59:59.999Z', pausedAt: null },
        targetDate: '2026-11-30',
        version: 14,
      });

      expect(stored(process.id)).toMatchObject({
        status: 'IN_PROGRESS',
        currentStageDueAt: new Date('2026-10-17T02:59:59.999Z'),
        targetDate: '2026-11-30',
      });
      expect(repository().suspendedByOf(process.id)).toBeNull();
      expect(activeStageOf(process.id)).toMatchObject({
        pausedAt: null,
        pausedTotalSeconds: 622_800,
        dueAt: new Date('2026-10-17T02:59:59.999Z'),
      });
      expect(movementsOf(process.id, 'RESUME')).toEqual([
        expect.objectContaining({
          statusFrom: 'SUSPENDED',
          statusTo: 'IN_PROGRESS',
          comment: 'Dotação definida pela Secretaria.',
          actorId: FAKE_USERS.lucia.id,
        }),
      ]);
      expect(eventsOf(process.id, 'ProcessStatusChanged').map((row) => row.routingKey)).toEqual([
        'process.status_changed.suspended',
        'process.status_changed.resumed',
      ]);
      expect(timelineOf(process.id, 'PROCESS_RESUMED')).toHaveLength(1);
      expect(auditOf(process.id, 'process.resume')).toEqual([
        expect.objectContaining({
          category: 'WORKFLOW',
          changes: [
            { path: 'status', old: 'SUSPENDED', new: 'IN_PROGRESS' },
            {
              path: 'currentStageDueAt',
              old: DUE_09.toISOString(),
              new: '2026-10-17T02:59:59.999Z',
            },
          ],
          metadata: expect.objectContaining({
            pausedSeconds: 622_800,
            extendedDays: 4,
            approvalDueAtExtended: false,
          }) as unknown,
        }),
      ]);
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'process.resumed', extendedDays: 4 }),
        'process.resumed',
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain('Dotação definida');
    });

    it('Aprovação pendente congelada e estendida: segue PENDING e ganha 2 dias úteis', async () => {
      const process = await processAt({
        key: 'APROVACAO',
        status: 'AWAITING_APPROVAL',
        dueAt: DUE_08,
      });
      const approval = seedPanelApproval(api, {
        tenantId: A,
        processId: process.id,
        processStageId: process.currentStageId,
        title: 'Aprovação da autoridade',
        approverType: 'USER',
        approverUserId: FAKE_USERS.otavio.id,
        dueAt: DUE_08,
      });

      const paused = await suspended(process);
      const pending = () =>
        approvalRepositoryOf(api)
          .approvals()
          .find((row) => row.id === approval.id);
      expect(pending()).toMatchObject({ status: 'PENDING', dueAt: DUE_08 });

      clock.now = new Date('2026-10-08T13:00:00.000Z');
      const response = await resume(paused);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(data<SuspensionProcessDto>(response).status).toBe('AWAITING_APPROVAL');
      // 06 e 07/10 suspensos; 08 + 2 dias úteis = 09 e 13/10 (12/10 feriado).
      expect(pending()).toMatchObject({
        status: 'PENDING',
        dueAt: new Date('2026-10-14T02:59:59.999Z'),
      });
      expect(auditOf(process.id, 'process.resume')[0]?.metadata).toMatchObject({
        approvalDueAtExtended: true,
        approvalId: approval.id,
      });
    });

    it('FA-04: suspensão e retomada no mesmo dia não estendem o prazo', async () => {
      const process = await suspended(await processAt());
      clock.now = new Date('2026-10-06T20:00:00.000Z');
      const response = await resume(process);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect((response.body as { meta: ResumeMeta }).meta).toEqual({
        extendedBy: { days: 0, slaType: 'BUSINESS' },
        newDueAt: DUE_09.toISOString(),
      });
      expect(activeStageOf(process.id)).toMatchObject({
        dueAt: DUE_09,
        pausedTotalSeconds: 25_200,
      });
    });

    it('FA-02: etapa sem prazo só acumula a pausa', async () => {
      const process = await suspended(await processAt({ dueAt: null }));
      clock.now = RESUME_AT;
      const response = await resume(process);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect((response.body as { meta: ResumeMeta }).meta).toEqual({
        extendedBy: { days: 4, slaType: 'BUSINESS' },
        newDueAt: null,
      });
      expect(activeStageOf(process.id)).toMatchObject({ dueAt: null, pausedTotalSeconds: 622_800 });
    });

    it('FA-03: atrasado antes da suspensão e ainda vencido depois da extensão — o atraso permanece', async () => {
      const overdueSince = new Date('2026-10-01T03:00:00.000Z');
      const process = await suspended(
        await processAt({ dueAt: new Date('2026-10-01T02:59:59.999Z'), overdueSince }),
      );
      clock.now = RESUME_AT;
      expect((await resume(process)).status).toBe(200);
      expect(activeStageOf(process.id)?.overdueSince).toEqual(overdueSince);
    });

    it('SLA em dias corridos: estende pelos 7 dias corridos suspensos', async () => {
      const process = await suspended(await processAt({ slaType: 'CALENDAR' }));
      clock.now = RESUME_AT;
      const response = await resume(process);
      expect((response.body as { meta: ResumeMeta }).meta).toEqual({
        extendedBy: { days: 7, slaType: 'CALENDAR' },
        newDueAt: '2026-10-17T02:59:59.999Z',
      });
    });

    it('RETURNED também suspende e volta a RETURNED', async () => {
      const process = await suspended(await processAt({ status: 'RETURNED' }));
      clock.now = RESUME_AT;
      const response = await resume(process);
      expect(data<SuspensionProcessDto>(response).status).toBe('RETURNED');
    });
  });

  describe('[Validação]', () => {
    it.each([
      [{ reason: 'Pausa' }, 'TOO_SHORT'],
      [{}, 'REQUIRED'],
      [{ reason: 'x'.repeat(5001) }, 'TOO_LONG'],
    ])(
      'Motivo inválido %j: 422 VALIDATION_ERROR (%s em reason) e nada gravado',
      async (body, code) => {
        const process = await processAt();
        const before = effects(process.id);
        const response = await suspend(process, body);
        expectProblem(response, 422, 'VALIDATION_ERROR');
        expect(response.body).toMatchObject({
          errors: [
            expect.objectContaining({
              field: 'reason',
              code,
              ...(code === 'TOO_LONG'
                ? {}
                : { message: 'Informe o motivo da suspensão (mínimo de 20 caracteres).' }),
            }),
          ],
        });
        expect(effects(process.id)).toEqual(before);
      },
    );

    it.each(['DRAFT', 'CANCELED', 'COMPLETED'] as const)(
      'Suspender processo %s: 409 INVALID_PROCESS_STATUS e nada gravado',
      async (status) => {
        const process = await processAt({ status });
        const before = effects(process.id);
        const body = expectProblem(await suspend(process), 409, 'INVALID_PROCESS_STATUS');
        expect(body.detail).toBe(
          'Só é possível suspender processos em andamento, aguardando aprovação ou devolvidos.',
        );
        expect(effects(process.id)).toEqual(before);
      },
    );

    it('Retomar processo que não está suspenso: 409 INVALID_PROCESS_STATUS', async () => {
      const process = await processAt();
      const body = expectProblem(await resume(process), 409, 'INVALID_PROCESS_STATUS');
      expect(body.detail).toBe('Este processo não está suspenso.');
    });

    it('Sem If-Match: 428 PRECONDITION_REQUIRED', async () => {
      const process = await processAt();
      expectProblem(
        await suspend(process, { reason: REASON }, { ifMatch: null }),
        428,
        'PRECONDITION_REQUIRED',
      );
      expect(stored(process.id).status).toBe('IN_PROGRESS');
    });

    it('Comentário da retomada acima de 5.000 caracteres: 422', async () => {
      const process = await suspended(await processAt());
      expectProblem(await resume(process, { comment: 'x'.repeat(5001) }), 422, 'VALIDATION_ERROR');
      expect(stored(process.id).status).toBe('SUSPENDED');
    });
  });

  describe('[Permissão]', () => {
    it('Ana (REQUISITANTE) sem PROCESS_SUSPEND: 403 PERMISSION_DENIED com access.denied e ações omitidas', async () => {
      const process = await processAt();
      expect(
        (await actionsOf(process.id, 'sub-ana')).find((entry) => entry.action === 'SUSPEND'),
      ).toBeUndefined();
      const before = effects(process.id);
      const body = expectProblem(
        await suspend(process, { reason: REASON }, { subject: 'sub-ana' }),
        403,
        'PERMISSION_DENIED',
      );
      expect(body.detail).toBe('Você não tem permissão para suspender ou retomar este processo.');
      expect(api.auditRecords().at(-1)).toMatchObject({
        action: 'access.denied',
        reasonCode: 'PROCESS_SUSPEND',
      });
      const after = effects(process.id);
      expect({ ...after, audit: before.audit }).toEqual(before);

      const paused = await suspended(process);
      expectProblem(await resume(paused, {}, { subject: 'sub-ana' }), 403, 'PERMISSION_DENIED');
      expect(stored(process.id).status).toBe('SUSPENDED');
    });

    it('Gestor sem custódia suspende (POL-07 não exige custódia)', async () => {
      const process = await processAt({ responsible: FAKE_USERS.fabio.id });
      expect((await suspend(process)).status).toBe(200);
    });

    it('Ações congeladas durante a suspensão: assumir, editar e encaminhar → 409 INVALID_PROCESS_STATUS', async () => {
      const process = await suspended(await processAt({ responsible: FAKE_USERS.ana.id }));
      const ifMatch = `"${String(process.version)}"`;
      const before = effects(process.id);

      const claim = await auth(
        request(api.server).post(`/api/v1/processes/${process.id}/claim`),
        'sub-fabio',
      )
        .set('If-Match', ifMatch)
        .send();
      expectProblem(claim, 409, 'INVALID_PROCESS_STATUS');

      const patch = await auth(
        request(api.server).patch(`/api/v1/processes/${process.id}`),
        'sub-ana',
      )
        .set('If-Match', ifMatch)
        .send({ title: `Novo título ${words(2)}` });
      expectProblem(patch, 409, 'INVALID_PROCESS_STATUS');

      const forward = await auth(
        request(api.server).post(`/api/v1/processes/${process.id}/forward`),
        'sub-ana',
      )
        .set('If-Match', ifMatch)
        .set('Idempotency-Key', randomUUID())
        .send({ transitionId: newId(), expectedStageId: process.currentStageId });
      expectProblem(forward, 409, 'INVALID_PROCESS_STATUS');

      expect(effects(process.id)).toEqual({ ...before, audit: effects(process.id).audit });
      // As ações de custódia somem do PRC-08 (ou ficam desabilitadas) e "Retomar" é a primária.
      const actions = await actionsOf(process.id, 'sub-ana');
      expect(
        actions.filter(
          (entry) => ['FORWARD', 'RETURN', 'CLAIM', 'EDIT'].includes(entry.action) && entry.enabled,
        ),
      ).toEqual([]);
    });

    it('FA-01: aprovação pendente do processo suspenso continua PENDING no painel', async () => {
      const process = await processAt({ key: 'APROVACAO', status: 'AWAITING_APPROVAL' });
      seedPanelApproval(api, {
        tenantId: A,
        processId: process.id,
        processStageId: process.currentStageId,
        title: 'Aprovação da autoridade',
        approverType: 'USER',
        approverUserId: FAKE_USERS.otavio.id,
      });
      await suspended(process);
      const summary = await summaryOf(process.id);
      expect(summary.where.status).toBe('SUSPENDED');
      expect(summary.responsible.approver).toMatchObject({
        approvalId: expect.any(String) as unknown,
      });
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Processo de outro tenant: 404 PROCESS_NOT_FOUND sem alterar nada', async () => {
      const process = await processAt();
      const before = effects(process.id);
      expectProblem(
        await suspend(process, { reason: REASON }, { subject: 'sub-heitor', tenant: B }),
        404,
        'PROCESS_NOT_FOUND',
      );
      expect(effects(process.id)).toEqual(before);
    });

    it('Tenant suspenso: 403 TENANT_SUSPENDED ao retomar', async () => {
      const process = await processAt();
      expectProblem(
        await resume(process, {}, { subject: 'sub-davi', tenant: SUSPENDED_TENANT }),
        403,
        'TENANT_SUSPENDED',
      );
    });

    it('Id inexistente: 404 PROCESS_NOT_FOUND', async () => {
      expectProblem(await suspend({ id: randomUUID(), version: 1 }), 404, 'PROCESS_NOT_FOUND');
    });
  });

  describe('[Duplicidade]', () => {
    it('Duplo clique com a chave K7: replay 200 com Idempotent-Replayed e uma única tramitação SUSPEND', async () => {
      const process = await processAt();
      const key = randomUUID(); // "K7"
      const first = await suspend(process, { reason: REASON }, { key });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      const replay = await suspend(process, { reason: REASON }, { key });
      expect(replay.status, JSON.stringify(replay.body)).toBe(200);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toEqual(first.body);
      expect(movementsOf(process.id, 'SUSPEND')).toHaveLength(1);

      // Nova suspensão com a versão atual: 409.
      expectProblem(await suspend(stored(process.id)), 409, 'INVALID_PROCESS_STATUS');
      expect(movementsOf(process.id, 'SUSPEND')).toHaveLength(1);
    });
  });

  describe('[Concorrência]', () => {
    it('Suspensão e encaminhamento simultâneos com If-Match "12": só o primeiro vale, o outro recebe 412', async () => {
      const process = await processAt({ responsible: FAKE_USERS.ana.id });
      const transitionId = (await actionsOf(process.id, 'sub-ana')).find(
        (entry) => entry.action === 'FORWARD',
      );
      expect(transitionId).toBeDefined();
      const [forwarded, paused] = await Promise.all([
        auth(request(api.server).post(`/api/v1/processes/${process.id}/forward`), 'sub-ana')
          .set('If-Match', '"12"')
          .set('Idempotency-Key', randomUUID())
          .send({
            transitionId: (transitionId as { transitionId?: string }).transitionId,
            expectedStageId: process.currentStageId,
          }),
        suspend(process, { reason: REASON }, { ifMatch: '"12"' }),
      ]);
      expect([forwarded.status, paused.status].sort()).toEqual([200, 412]);
      const loser = forwarded.status === 200 ? paused : forwarded;
      expectProblem(loser, 412, 'VERSION_CONFLICT');
      expect(stored(process.id).version).toBe(13);
    });

    it('If-Match desatualizado: 412 VERSION_CONFLICT com currentVersion', async () => {
      const process = await processAt();
      repository().replace({ ...stored(process.id), version: 13 });
      const response = await suspend(process, { reason: REASON }, { ifMatch: '"12"' });
      const body = expectProblem(response, 412, 'VERSION_CONFLICT');
      expect(body.detail).toBe(
        'O processo foi alterado por outra pessoa. Recarregue e tente novamente.',
      );
      expect(response.body).toMatchObject({ currentVersion: 13, sentVersion: 12 });
      expect(stored(process.id).status).toBe('IN_PROGRESS');
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível ao suspender: 503 DEPENDENCY_UNAVAILABLE e nada de pausa, tramitação, timeline, auditoria ou evento', async () => {
      const process = await processAt();
      const before = effects(process.id);
      transactions.down = true;
      const response = await suspend(process);
      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      transactions.down = false;
      expect(effects(process.id)).toEqual(before);
      expect(stored(process.id).status).toBe('IN_PROGRESS');
      expect(activeStageOf(process.id)?.pausedAt ?? null).toBeNull();
    });
  });

  describe('[Falha de integração]', () => {
    it('Fila de notificações fora: 200 e um único ProcessStatusChanged gravado no outbox no mesmo commit', async () => {
      // Sem relay no teste em memória: o evento fica no outbox (o status PENDING é provado sobre o
      // PostgreSQL em test/tenant-leak/process-suspension.spec.ts) e o aviso sai uma vez quando a
      // fila volta (deduplicação do worker por `eventId`).
      const process = await processAt();
      const response = await suspend(process);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(eventsOf(process.id, 'ProcessStatusChanged')).toHaveLength(1);
    });
  });
});
