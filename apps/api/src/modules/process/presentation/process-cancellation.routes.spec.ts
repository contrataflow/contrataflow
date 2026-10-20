import { randomUUID } from 'node:crypto';

import { actionEntrySchema, problemDetailsSchema } from '@contrataflow/validation';
import type {
  ActionEntry,
  CanceledProcessDto,
  ProcessDto,
  ProcessListItemDto,
  ProcessSummaryDto,
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
import {
  seedPanelApproval,
  seedPanelDocument,
  storedPanelDocument,
} from '../../../../test/support/process-panel-fixtures.js';
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
 * US-009 — PRC-25/PRC-06 (cancelar processo e descartar rascunho) pelo pipeline HTTP completo
 * (autenticação, tenant, vínculo, autorização, `If-Match`, filtro RFC 9457) com a identidade fake,
 * os seeders reais e repositórios em memória — as 8 categorias do Gherkin. Background: "Lúcia"
 * (GESTOR_CONTRATACOES, escopo TENANT) faz o papel de "Carla" (`PROCESS_CANCEL` cobrindo a Secretaria
 * de Obras); "Otávio" só com SOMENTE_LEITURA faz o papel de "Bruno"; o processo "0012/2026", aberto
 * por "Ana" (REQUISITANTE), está com "Fábio" no Setor de Compras. Atomicidade com rollback real, RLS,
 * a exclusão lógica e o evento `PENDING` sobre o PostgreSQL: `test/tenant-leak/process-cancellation.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const OPENED = new Date('2026-09-28T13:00:00.000Z');
const NOW = new Date('2026-10-06T13:00:00.000Z');
const DUE_09 = new Date('2026-10-10T02:59:59.999Z');
const USER_AGENT = 'Vitest/US-009';
const REASON = 'Demanda já atendida por contrato vigente';

const ORG_A = '0192d009-0000-7000-8000-0000000000a0';
const ORG_B = '0192d009-0000-7000-8000-0000000000b0';
const UNITS_A = {
  organizationId: ORG_A,
  obras: '0192d009-0000-7000-8000-0000000000a1',
  manutencao: '0192d009-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d009-0000-7000-8000-0000000000a3',
  saude: '0192d009-0000-7000-8000-0000000000a4',
  posto: '0192d009-0000-7000-8000-0000000000a5',
};
const UNITS_B = {
  organizationId: ORG_B,
  obras: '0192d009-0000-7000-8000-0000000000b1',
  manutencao: '0192d009-0000-7000-8000-0000000000b2',
  pavimentacao: '0192d009-0000-7000-8000-0000000000b3',
  saude: '0192d009-0000-7000-8000-0000000000b4',
  posto: '0192d009-0000-7000-8000-0000000000b5',
};
const COMPRAS = '0192d009-0000-7000-8000-0000000000a7';
const FLOW_VERSION = '0192d009-0000-7000-8000-0000000000f1';

const membershipOf = (userId: string, tenantId = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

/** ABERTURA → PESQUISA_PRECOS → APROVACAO (aprovação) → CONCLUSAO. */
const flow = new DefinitionBuilder(FLOW_VERSION)
  .stage('ABERTURA', 'START', { name: 'Formalização da demanda', assignmentPolicy: 'CREATOR' })
  .stage('PESQUISA_PRECOS', 'TASK', {
    name: 'Pesquisa de preços',
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
  .transition('PESQUISA_PRECOS', 'APROVACAO', 'FORWARD', { isPrimary: true })
  .transition('APROVACAO', 'CONCLUSAO', 'APPROVE');

/**
 * Transações do módulo: em fila (corridas serializadas, como o `FOR UPDATE`), banco fora e a trava
 * "segurada" para provar a corrida entre duas abas (as duas chegam antes de a primeira gravar).
 */
class FlakyTransactions implements ProcessTransactions {
  down = false;
  waiting = 0;
  private held: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  hold(): () => void {
    let release: () => void = () => undefined;
    this.held = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => {
      this.held = null;
      release();
    };
  }

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    if (this.down) return Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED')));
    const held = this.held;
    this.waiting += 1;
    const next = this.queue
      .then(() => held)
      .then(() => {
        this.waiting -= 1;
        return runSimulatedTransaction(work);
      });
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

describe('Feature: Cancelar processo ou descartar rascunho (US-009)', () => {
  let api: TestApi;
  let log: MockInstance<Logger['log']>;
  const transactions = new FlakyTransactions();
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

  interface CallOptions {
    readonly subject?: string;
    readonly tenant?: string;
    readonly ifMatch?: string | null;
  }
  const withIfMatch = (
    call: request.Test,
    process: Pick<Process, 'version'>,
    options: CallOptions,
  ) =>
    options.ifMatch === null
      ? call
      : call.set('If-Match', options.ifMatch ?? `"${String(process.version)}"`);
  const cancel = (
    process: Pick<Process, 'id' | 'version'>,
    body: Record<string, unknown> = { cancellationReason: REASON },
    options: CallOptions = {},
  ) =>
    withIfMatch(
      auth(
        request(api.server).post(`/api/v1/processes/${process.id}/cancel`),
        options.subject,
        options.tenant,
      ),
      process,
      options,
    ).send(body);
  const discard = (
    process: Pick<Process, 'id' | 'version'>,
    body: Record<string, unknown> | null = null,
    options: CallOptions = {},
  ) => {
    const call = withIfMatch(
      auth(
        request(api.server).delete(`/api/v1/processes/${process.id}`),
        options.subject,
        options.tenant,
      ),
      process,
      options,
    );
    return body === null ? call.send() : call.send(body);
  };

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
  const movementsOf = (processId: string, action: 'CANCEL') =>
    repository()
      .movementsOf(processId)
      .filter((movement) => movement.action === action);
  const timelineOf = (processId: string, type?: string) =>
    timelineRowsOf(api).filter(
      (row) => row.processId === processId && (type === undefined || row.type === type),
    );
  const approvalOf = (approvalId: string) =>
    approvalRepositoryOf(api)
      .approvals()
      .find((row) => row.id === approvalId);
  /** Efeitos gravados do processo (para provar que nada foi gravado numa recusa). */
  const effects = (processId: string) => ({
    process: stored(processId),
    deletion: repository().deletionOf(processId),
    stages: repository().stagesOf(processId),
    assignments: repository().assignmentsOf(processId),
    movements: repository().movementsOf(processId).length,
    events: eventsOf(processId).length,
    audit: api.auditRecords().filter((row) => row.processId === processId).length,
    timeline: timelineOf(processId).length,
  });

  /** Processo criado pelo PRC-02 em 28/09 (Ana, por padrão). */
  async function createProcess(subject = 'sub-ana'): Promise<Process> {
    const response = await auth(request(api.server).post('/api/v1/processes'), subject)
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

  /** Rascunho SEM número (numeração em `START` — FA-03 da US-001), criado por `subject`. */
  async function unnumberedDraft(subject = 'sub-lucia'): Promise<Process> {
    const created = await createProcess(subject);
    const draft: Process = { ...created, status: 'DRAFT', number: null, code: null };
    repository().replace(draft);
    return draft;
  }

  /**
   * O processo "0012/2026" na etapa `key` do Setor de Compras (versão 12), com Fábio responsável e
   * prazo no fim de 09/10.
   */
  async function processAt(
    options: { readonly key?: string; readonly status?: Process['status'] } = {},
  ): Promise<Process> {
    const created = await createProcess();
    const [opening] = repository().stagesOf(created.id);
    if (!opening) throw new Error('passagem de abertura ausente');
    repository().seedStage({ ...opening, status: 'COMPLETED', exitedAt: OPENED });
    for (const assignment of repository().assignmentsOf(created.id)) {
      repository().seedAssignment(assignment, OPENED);
    }
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
      assigneeId: FAKE_USERS.fabio.id,
      enteredAt: new Date('2026-10-02T12:00:00.000Z'),
      dueAt: DUE_09,
      slaDays: 5,
      slaType: 'BUSINESS',
      enteredViaMovementId: null,
    });
    repository().seedAssignment({
      id: newId(),
      tenantId: A,
      processId: created.id,
      processStageId: stageId,
      departmentId: COMPRAS,
      assigneeId: FAKE_USERS.fabio.id,
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
      currentResponsibleId: FAKE_USERS.fabio.id,
      currentStageDueAt: DUE_09,
      number: 12,
      code: '0012/2026',
      openedAt: created.createdAt,
      version: 12,
    };
    repository().seed(next, [
      { principalType: 'DEPARTMENT', departmentId: COMPRAS, reason: 'CURRENT' },
    ]);
    return next;
  }

  /** "0012/2026" aguardando aprovação com 1 aprovação pendente que cobre o DFD (`IN_REVIEW`). */
  async function awaitingApproval() {
    const process = await processAt({ key: 'APROVACAO', status: 'AWAITING_APPROVAL' });
    const approvalId = newId();
    const dfd = await seedPanelDocument(api, {
      tenantId: A,
      processId: process.id,
      typeCode: 'DFD',
      code: 'DFD 0007/2026',
      title: 'Documento de formalização da demanda',
      status: 'IN_REVIEW',
      versionNumber: 2,
      pendingApprovalId: approvalId,
      createdById: FAKE_USERS.ana.id,
    });
    const etp = await seedPanelDocument(api, {
      tenantId: A,
      processId: process.id,
      typeCode: 'ETP',
      code: 'ETP 0003/2026',
      title: 'Estudo técnico preliminar',
      status: 'FINALIZED',
      versionNumber: 1,
      pendingApprovalId: approvalId,
      createdById: FAKE_USERS.ana.id,
    });
    const approval = seedPanelApproval(api, {
      id: approvalId,
      tenantId: A,
      processId: process.id,
      processStageId: process.currentStageId,
      title: 'Aprovação da autoridade',
      approverType: 'USER',
      approverUserId: FAKE_USERS.otavio.id,
      dueAt: DUE_09,
    });
    // A cobertura (`ApprovalDocument`) da pendente: o DFD e o ETP nas versões analisadas.
    approvalRepositoryOf(api).seed(
      approval,
      [dfd, etp].map((documentId) => ({
        id: newId(),
        documentId,
        documentVersionId: storedPanelDocument(api, documentId).currentVersionId ?? newId(),
      })),
    );
    return { process, approvalId, dfd, etp };
  }

  beforeAll(async () => {
    log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    api = await createTestApi({
      providers: [
        { token: PROCESS_TRANSACTIONS, value: transactions },
        { token: PROCESS_CLOCK, value: () => NOW },
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
    await seedPublishedInMemory(api, A, flow, 'TESTE_US009');
    await deactivateWorkflow(api, A, 'TESTE_US009');
    assignDepartment(api, membershipOf(FAKE_USERS.ana.id), UNITS_A.manutencao);
    assignDepartment(api, membershipOf(FAKE_USERS.fabio.id), COMPRAS);
    // "Bruno": Otávio só com SOMENTE_LEITURA (vê os processos, sem PROCESS_CANCEL/PROCESS_CREATE).
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
    it('Cancelar processo aguardando aprovação: CANCELED, aprovação cancelada, DFD de volta a DRAFT, etapa encerrada, auditoria e eventos', async () => {
      const { process, approvalId, dfd, etp } = await awaitingApproval();
      expect(
        (await actionsOf(process.id)).find((entry) => entry.action === 'CANCEL'),
      ).toMatchObject({ enabled: true });
      log.mockClear();

      // Lúcia não é a responsável (Fábio): POL-01 não se aplica ao cancelamento (RN-PROC-110).
      const response = await cancel(process);

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers.etag).toBe('"13"');
      expect(response.headers['cache-control']).toContain('no-store');
      expect(data<CanceledProcessDto>(response)).toMatchObject({
        id: process.id,
        status: 'CANCELED',
        canceledAt: NOW.toISOString(),
        cancellationReason: REASON,
        version: 13,
      });

      expect(stored(process.id)).toMatchObject({ status: 'CANCELED', version: 13 });
      expect(repository().canceledByOf(process.id)).toBe(FAKE_USERS.lucia.id);
      // RN-PROC-107: etapa ativa CANCELED e responsabilidade ativa encerrada.
      expect(
        repository()
          .stagesOf(process.id)
          .find((stage) => stage.id === process.currentStageId),
      ).toMatchObject({ status: 'CANCELED', exitedAt: NOW });
      expect(
        repository()
          .stagesOf(process.id)
          .some((stage) => stage.status === 'ACTIVE'),
      ).toBe(false);
      expect(
        repository()
          .assignmentsOf(process.id)
          .some((assignment) => assignment.isActive),
      ).toBe(false);
      const [movement, ...more] = movementsOf(process.id, 'CANCEL');
      expect(more).toEqual([]);
      expect(movement).toMatchObject({
        statusFrom: 'AWAITING_APPROVAL',
        statusTo: 'CANCELED',
        comment: REASON,
        fromProcessStageId: process.currentStageId,
        actorId: FAKE_USERS.lucia.id,
        userAgent: USER_AGENT,
      });

      // RN-PROC-106: a aprovação pendente cancelada; o DFD em análise volta a DRAFT; o ETP finalizado
      // só perde o selo "Em aprovação".
      expect(approvalOf(approvalId)).toMatchObject({ status: 'CANCELED' });
      expect(storedPanelDocument(api, dfd)).toMatchObject({
        status: 'DRAFT',
        pendingApprovalId: null,
      });
      expect(storedPanelDocument(api, etp)).toMatchObject({
        status: 'FINALIZED',
        pendingApprovalId: null,
      });

      expect(eventsOf(process.id, 'ProcessStatusChanged')).toEqual([
        expect.objectContaining({
          routingKey: 'process.status_changed.canceled',
          payload: {
            fromStatus: 'AWAITING_APPROVAL',
            toStatus: 'CANCELED',
            cause: 'CANCEL',
            reasonProvided: true,
            reason: REASON,
          },
        }),
      ]);
      expect(eventsOf(process.id, 'ApprovalCanceled')).toEqual([
        expect.objectContaining({
          routingKey: 'approval.canceled',
          payload: { approvalId, reason: 'PROCESS_CANCELED' },
        }),
      ]);
      expect(eventsOf(process.id, 'DocumentWithdrawn')).toEqual([
        expect.objectContaining({
          routingKey: 'document.withdrawn.dfd',
          payload: {
            documentId: dfd,
            documentTypeCode: 'DFD',
            approvalId,
            reason: 'Processo cancelado',
          },
        }),
      ]);
      expect(timelineOf(process.id, 'PROCESS_CANCELED')).toEqual([
        expect.objectContaining({
          params: expect.objectContaining({ reason: REASON }) as unknown,
        }),
      ]);
      expect(timelineOf(process.id, 'APPROVAL_CANCELED')).toHaveLength(1);
      expect(timelineOf(process.id, 'DOCUMENT_WITHDRAWN')).toHaveLength(1);

      const [audit, ...otherAudits] = auditOf(process.id, 'process.cancel');
      expect(otherAudits).toEqual([]);
      expect(audit).toMatchObject({
        metadata: {
          fromStatus: 'AWAITING_APPROVAL',
          pendingApprovalsCanceled: 1,
          approvalIds: [approvalId],
          movementId: movement?.id,
        },
      });
      expect(audit?.changes).toEqual([
        { path: 'status', old: 'AWAITING_APPROVAL', new: 'CANCELED' },
      ]);
      // A auditoria guarda o hash da justificativa, nunca o texto.
      expect((audit?.metadata as { reasonHash: string }).reasonHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(audit)).not.toContain(REASON);
      expect(auditOf(process.id, 'approval.cancel')).toHaveLength(1);
      expect(auditOf(process.id, 'document.withdraw')).toHaveLength(1);

      // Painel: cancelado com o motivo; ações bloqueadas (cancelar de novo desabilitado).
      const summary = await summaryOf(process.id);
      expect(summary.where).toMatchObject({ status: 'CANCELED', cancellationReason: REASON });
      expect(summary.approvals).toEqual([]);
      expect((await actionsOf(process.id)).find((e) => e.action === 'CANCEL')).toMatchObject({
        enabled: false,
      });

      // Log `process.canceled` sem a justificativa.
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'process.canceled',
          processId: process.id,
          fromStatus: 'AWAITING_APPROVAL',
          pendingApprovalsCanceled: 1,
        }),
        'process.canceled',
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain(REASON);
    });

    it('FA-03: cancelar processo suspenso descarta o status anterior à suspensão', async () => {
      const process = await processAt({ status: 'SUSPENDED' });
      repository().setSituation(process.id, {
        statusBeforeSuspension: 'IN_PROGRESS',
        suspendedAt: new Date('2026-10-03T12:00:00.000Z'),
        suspensionReason: 'Aguardando definição da dotação orçamentária',
      });
      const response = await cancel(process);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect((await summaryOf(process.id)).where).toMatchObject({
        status: 'CANCELED',
        statusBeforeSuspension: null,
      });
      expect(movementsOf(process.id, 'CANCEL')[0]).toMatchObject({ statusFrom: 'SUSPENDED' });
    });

    it('Descartar rascunho sem número: deletedAt, some da lista e do detalhe, auditoria e evento; sem timeline', async () => {
      const draft = await unnumberedDraft();
      expect((await actionsOf(draft.id)).find((entry) => entry.action === 'DISCARD')).toMatchObject(
        { enabled: true },
      );
      const timelineBefore = timelineOf(draft.id).length;
      log.mockClear();

      const response = await discard(draft);

      expect(response.status, JSON.stringify(response.body)).toBe(204);
      expect(response.body).toEqual({});
      expect(repository().deletionOf(draft.id)).toEqual({ at: NOW, by: FAKE_USERS.lucia.id });
      expect(stored(draft.id)).toMatchObject({ status: 'DRAFT', version: draft.version + 1 });
      // RN-PROC-109: nenhuma etapa ou responsabilidade ativa apontando para o excluído.
      expect(
        repository()
          .stagesOf(draft.id)
          .every((stage) => stage.status === 'CANCELED'),
      ).toBe(true);
      expect(
        repository()
          .assignmentsOf(draft.id)
          .some((row) => row.isActive),
      ).toBe(false);

      // RN-PROC-108: some do detalhe e da lista padrão.
      expectProblem(
        await auth(request(api.server).get(`/api/v1/processes/${draft.id}`)),
        404,
        'PROCESS_NOT_FOUND',
      );
      const list = await auth(request(api.server).get('/api/v1/processes?pageSize=100'));
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      expect(data<ProcessListItemDto[]>(list).map((row) => row.id)).not.toContain(draft.id);

      expect(auditOf(draft.id, 'process.discard_draft')).toEqual([
        expect.objectContaining({ metadata: { reasonProvided: false, asCreator: true } }),
      ]);
      expect(eventsOf(draft.id, 'ProcessDraftDiscarded')).toEqual([
        expect.objectContaining({
          routingKey: 'process.draft_discarded',
          payload: { reasonProvided: false },
        }),
      ]);
      expect(eventsOf(draft.id, 'ProcessStatusChanged')).toEqual([]);
      expect(timelineOf(draft.id)).toHaveLength(timelineBefore);
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'process.draft_discarded', processId: draft.id }),
        'process.draft_discarded',
      );
    });

    it('FA-05: a criadora sem PROCESS_CANCEL vê só "Descartar rascunho" e descarta com motivo', async () => {
      const draft = await unnumberedDraft('sub-ana');
      const actions = await actionsOf(draft.id, 'sub-ana');
      expect(actions.find((entry) => entry.action === 'DISCARD')).toMatchObject({ enabled: true });
      expect(actions.find((entry) => entry.action === 'CANCEL')).toBeUndefined();

      const response = await discard(
        draft,
        { reason: 'Aberto em duplicidade.' },
        { subject: 'sub-ana' },
      );

      expect(response.status, JSON.stringify(response.body)).toBe(204);
      expect(repository().deletionOf(draft.id)).toMatchObject({ by: FAKE_USERS.ana.id });
      expect(auditOf(draft.id, 'process.discard_draft')[0]?.metadata).toEqual({
        reasonProvided: true,
        reason: 'Aberto em duplicidade.',
        asCreator: true,
      });
      expect(eventsOf(draft.id, 'ProcessDraftDiscarded')[0]?.payload).toEqual({
        reasonProvided: true,
      });
    });
  });

  describe('[Validação]', () => {
    it('Descartar rascunho que já tem número: 409 CANNOT_DISCARD_NUMBERED_PROCESS sem alterar nada', async () => {
      const created = await createProcess('sub-lucia');
      const numbered: Process = { ...created, status: 'DRAFT', number: 13, code: '0013/2026' };
      repository().replace(numbered);
      expect((await actionsOf(numbered.id)).find((e) => e.action === 'DISCARD')).toBeUndefined();
      const before = effects(numbered.id);
      const body = expectProblem(await discard(numbered), 409, 'CANNOT_DISCARD_NUMBERED_PROCESS');
      expect(body.detail).toBe('Este processo já tem número; cancele-o em vez de descartar.');
      expect(effects(numbered.id)).toEqual(before);
    });

    it('Descartar processo fora de rascunho: 409 INVALID_PROCESS_STATUS', async () => {
      const process = await processAt();
      expectProblem(await discard(process), 409, 'INVALID_PROCESS_STATUS');
      expect(repository().deletionOf(process.id)).toBeNull();
    });

    it.each([
      [{}, 'cancellationReason'],
      [{ cancellationReason: 'Curta demais' }, 'cancellationReason'],
      [{ cancellationReason: `   ${'x'.repeat(19)}   ` }, 'cancellationReason'],
    ])('V-01: justificativa ausente ou curta (%j) → 422 sem alterar nada', async (body, field) => {
      const process = await processAt();
      const before = effects(process.id);
      const problem = expectProblem(await cancel(process, body), 422, 'VALIDATION_ERROR');
      expect(problem.errors[0]).toMatchObject({
        field,
        message: 'A justificativa deve ter pelo menos 20 caracteres.',
      });
      expect(effects(process.id)).toEqual(before);
    });

    it('Motivo do descarte acima de 500 caracteres: 422', async () => {
      const draft = await unnumberedDraft();
      expectProblem(await discard(draft, { reason: 'x'.repeat(501) }), 422, 'VALIDATION_ERROR');
      expect(repository().deletionOf(draft.id)).toBeNull();
    });

    it('Sem If-Match: 428 PRECONDITION_REQUIRED (cancelar e descartar)', async () => {
      const process = await processAt();
      expectProblem(
        await cancel(process, undefined, { ifMatch: null }),
        428,
        'PRECONDITION_REQUIRED',
      );
      const draft = await unnumberedDraft();
      expectProblem(await discard(draft, null, { ifMatch: null }), 428, 'PRECONDITION_REQUIRED');
      expect(stored(process.id).status).toBe('IN_PROGRESS');
      expect(repository().deletionOf(draft.id)).toBeNull();
    });
  });

  describe('[Permissão]', () => {
    it('Bruno (SOMENTE_LEITURA) cancela: 403 PERMISSION_DENIED com access.denied "PROCESS_CANCEL" e ação omitida', async () => {
      const process = await processAt();
      expect(
        (await actionsOf(process.id, 'sub-otavio')).find((entry) => entry.action === 'CANCEL'),
      ).toBeUndefined();
      const before = effects(process.id);
      const body = expectProblem(
        await cancel(process, undefined, { subject: 'sub-otavio' }),
        403,
        'PERMISSION_DENIED',
      );
      expect(body.detail).toBe('Você não tem permissão para esta ação.');
      expect(api.auditRecords().at(-1)).toMatchObject({
        action: 'access.denied',
        reasonCode: 'PROCESS_CANCEL',
      });
      expect({ ...effects(process.id), audit: before.audit }).toEqual(before);
    });

    it('A criadora sem PROCESS_CANCEL não cancela (só descarta o próprio rascunho)', async () => {
      const process = await processAt();
      expectProblem(
        await cancel(process, undefined, { subject: 'sub-ana' }),
        403,
        'PERMISSION_DENIED',
      );
      expect(stored(process.id).status).toBe('IN_PROGRESS');
    });

    it('Sem PROCESS_CANCEL e sem ser o criador: descarte → 403 com access.denied "PROCESS_CANCEL"', async () => {
      const draft = await unnumberedDraft();
      expect((await actionsOf(draft.id, 'sub-otavio')).find((e) => e.action === 'DISCARD')).toBe(
        undefined,
      );
      expectProblem(
        await discard(draft, null, { subject: 'sub-otavio' }),
        403,
        'PERMISSION_DENIED',
      );
      expect(api.auditRecords().at(-1)).toMatchObject({
        action: 'access.denied',
        reasonCode: 'PROCESS_CANCEL',
      });
      expect(repository().deletionOf(draft.id)).toBeNull();
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Cancelar e descartar processo de outro tenant: 404 PROCESS_NOT_FOUND sem alterar nada', async () => {
      const process = await processAt();
      const draft = await unnumberedDraft();
      const before = [effects(process.id), effects(draft.id)];
      expectProblem(
        await cancel(process, undefined, { subject: 'sub-heitor', tenant: B }),
        404,
        'PROCESS_NOT_FOUND',
      );
      expectProblem(
        await discard(draft, null, { subject: 'sub-heitor', tenant: B }),
        404,
        'PROCESS_NOT_FOUND',
      );
      expect([effects(process.id), effects(draft.id)]).toEqual(before);
    });

    it('Id inexistente: 404 PROCESS_NOT_FOUND', async () => {
      expectProblem(await cancel({ id: newId(), version: 1 }), 404, 'PROCESS_NOT_FOUND');
    });
  });

  describe('[Duplicidade]', () => {
    it('Reenviar o cancelamento após o sucesso: 409 INVALID_PROCESS_STATUS, sem nova aprovação nem tramitação', async () => {
      const { process, approvalId } = await awaitingApproval();
      expect((await cancel(process)).status).toBe(200);
      const after = effects(process.id);

      const body = expectProblem(await cancel(process), 409, 'INVALID_PROCESS_STATUS');
      expect(body.detail).toBe('Este processo já foi encerrado e não pode ser alterado.');
      expect(movementsOf(process.id, 'CANCEL')).toHaveLength(1);
      expect(approvalOf(approvalId)).toMatchObject({ status: 'CANCELED' });
      expect(eventsOf(process.id, 'ApprovalCanceled')).toHaveLength(1);
      expect(effects(process.id)).toEqual(after);
    });
  });

  describe('[Concorrência]', () => {
    it('Cancelamento simultâneo em duas abas com If-Match "12": um 200 CANCELED, o outro 412 VERSION_CONFLICT', async () => {
      const process = await processAt();
      const release = transactions.hold();
      const pending = [cancel(process), cancel(process)].map((call) => call.then((r) => r));
      await vi.waitFor(() => {
        expect(transactions.waiting).toBe(2);
      });
      release();
      const responses = await Promise.all(pending);

      const statuses = responses.map((response) => response.status).sort();
      expect(statuses).toEqual([200, 412]);
      const winner = responses.find((response) => response.status === 200);
      expect(data<CanceledProcessDto>(winner as request.Response).status).toBe('CANCELED');
      const loser = responses.find((response) => response.status === 412);
      expect(problemDetailsSchema.parse(loser?.body).code).toBe('VERSION_CONFLICT');
      expect(movementsOf(process.id, 'CANCEL')).toHaveLength(1);
    });

    it('If-Match desatualizado: 412 VERSION_CONFLICT com currentVersion', async () => {
      const process = await processAt();
      const body = expectProblem(
        await cancel(process, undefined, { ifMatch: '"11"' }),
        412,
        'VERSION_CONFLICT',
      );
      expect(body).toMatchObject({ currentVersion: 12 });
      expect(stored(process.id).status).toBe('IN_PROGRESS');
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível ao cancelar: 503 DEPENDENCY_UNAVAILABLE com Retry-After; nada cancelado', async () => {
      const { process, approvalId, dfd } = await awaitingApproval();
      const before = effects(process.id);
      transactions.down = true;
      const response = await cancel(process);
      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      expect(response.headers['retry-after']).toBeDefined();
      transactions.down = false;
      expect(effects(process.id)).toEqual(before);
      expect(stored(process.id).status).toBe('AWAITING_APPROVAL');
      expect(approvalOf(approvalId)).toMatchObject({ status: 'PENDING' });
      expect(storedPanelDocument(api, dfd).status).toBe('IN_REVIEW');
    });
  });

  describe('[Falha de integração]', () => {
    it('Relay do outbox fora: 200 e um único ProcessStatusChanged gravado no outbox no mesmo commit', async () => {
      // Sem relay no teste em memória: o evento fica no outbox (o status PENDING é provado sobre o
      // PostgreSQL em test/tenant-leak/process-cancellation.spec.ts).
      const process = await processAt();
      const response = await cancel(process);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(eventsOf(process.id, 'ProcessStatusChanged')).toHaveLength(1);
    });
  });
});
