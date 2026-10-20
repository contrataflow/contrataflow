import { randomUUID } from 'node:crypto';

import {
  approvalSchema,
  documentSchema,
  problemDetailsSchema,
  withdrawnApprovalSchema,
} from '@contrataflow/validation';
import type {
  ApprovalDto,
  ApprovalMeta,
  DocumentDto,
  ForwardedProcessDto,
  ProcessDto,
  WithdrawnApprovalDto,
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
  APPROVAL_CLOCK,
  APPROVAL_TRANSACTIONS,
} from '../../../../test/support/approval-fixtures.js';
import type { ApprovalTransactions } from '../../../../test/support/approval-fixtures.js';
import {
  approvalRepositoryOf,
  documentRepositoryOf,
} from '../../../../test/support/document-fixtures.js';
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
 * US-053 — retirar ou redirecionar aprovação pendente (APV-04/APV-05/DOC-11) pelo pipeline HTTP
 * completo (identidade fake, seeders reais, repositórios em memória): as 8 categorias do Gherkin e
 * as regras RN-TRAM-64..71. Background (o mesmo da US-052): Ana encaminha (PRC-19) o processo
 * "0012/2026" à "Aprovação da autoridade competente" (`DEPARTMENT_HEAD` da Secretaria de Obras —
 * Marta titular, Fábio substituto) ou à "Aprovação técnica" (`USER` Lúcia = "Carla"); Fábio =
 * "Diego" (também `AUTORIDADE_COMPETENTE`), Marta = o gestor que redireciona (`APPROVAL_REASSIGN`
 * pelo perfil) e Otávio = "Bruno" (perfil só sobre a Saúde: nem solicitante, nem lotado na unidade
 * de origem). O rollback real, a corrida e o outbox `PENDING` no PostgreSQL ficam em
 * `test/tenant-leak/approval-withdrawal.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-05T15:00:00.000Z');
const USER_AGENT = 'Vitest/US-053';
const WITHDRAW_REASON = 'Encaminhado antes da revisão final do TR.';
const LEAVE = 'Carla está de licença médica';

const ORG_A = '0192d052-0000-7000-8000-0000000000a0';
const ORG_B = '0192d052-0000-7000-8000-0000000000b0';
const UNITS_A = {
  organizationId: ORG_A,
  obras: '0192d052-0000-7000-8000-0000000000a1',
  manutencao: '0192d052-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d052-0000-7000-8000-0000000000a3',
  saude: '0192d052-0000-7000-8000-0000000000a4',
  posto: '0192d052-0000-7000-8000-0000000000a5',
};
const UNITS_B = {
  organizationId: ORG_B,
  obras: '0192d052-0000-7000-8000-0000000000b1',
  manutencao: '0192d052-0000-7000-8000-0000000000b2',
  pavimentacao: '0192d052-0000-7000-8000-0000000000b3',
  saude: '0192d052-0000-7000-8000-0000000000b4',
  posto: '0192d052-0000-7000-8000-0000000000b5',
};
const PLANEJAMENTO = '0192d052-0000-7000-8000-0000000000a6';
const FLOW_VERSION = '0192d052-0000-7000-8000-0000000000f1';
const COVERED = ['ETP', 'TR'] as const;

const membershipOf = (userId: string, tenantId: string = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

/** Transações em fila (corridas serializadas, como o `FOR UPDATE`) e banco fora. */
class FlakyTransactions implements ProcessTransactions, ApprovalTransactions {
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

describe('Feature: Retirar ou redirecionar aprovação pendente (US-053)', () => {
  let api: TestApi;
  let flow: DefinitionBuilder;
  let log: MockInstance<Logger['log']>;
  /** Perfis padrão do tenant A (ids do seed — `seedDefaultRolesOf` gera ids novos a cada chamada). */
  let roles: ReadonlyMap<string, { readonly id: string }>;
  const processTx = new FlakyTransactions();
  const approvalTx = new FlakyTransactions();
  const words = (count: number) =>
    Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

  const auth = (call: request.Test, subject: string, tenant: string = A) =>
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
  const approvalOf = (id: string) => {
    const approval = approvalRepositoryOf(api)
      .approvals()
      .find((candidate) => candidate.id === id);
    if (!approval) throw new Error(`aprovação ${id} ausente`);
    return approval;
  };
  const documentsOf = (processId: string) =>
    documentRepositoryOf(api)
      .allDocuments()
      .filter((document) => document.processId === processId);
  const eventsOf = (processId: string, eventType: string) =>
    api.outboxRows().filter((row) => row.processId === processId && row.eventType === eventType);
  const auditOf = (processId: string, action: string) =>
    api.auditRecords().filter((row) => row.processId === processId && row.action === action);
  /** O que a retirada/o redirecionamento gravam (para provar que nada foi gravado numa recusa). */
  const effects = (processId: string, approvalId: string) => ({
    process: stored(processId),
    approval: approvalOf(approvalId),
    stages: repository().stagesOf(processId).length,
    movements: repository().movementsOf(processId).length,
    documents: documentsOf(processId).map((document) => ({
      status: document.status,
      pendingApprovalId: document.pendingApprovalId,
    })),
    events: api.outboxRows().filter((row) => row.processId === processId).length,
    access: repository().accessOf(processId).length,
  });

  const getApproval = (id: string, subject: string, tenant: string = A) =>
    auth(request(api.server).get(`/api/v1/approvals/${id}`), subject, tenant);
  const decide = (
    id: string,
    body: Record<string, unknown>,
    options: { subject?: string; tenant?: string; key?: string; version?: number } = {},
  ) =>
    auth(
      request(api.server).post(`/api/v1/approvals/${id}/decide`),
      options.subject ?? 'sub-marta',
      options.tenant,
    )
      .set('Idempotency-Key', options.key ?? randomUUID())
      .set('If-Match', `"${String(options.version ?? 1)}"`)
      .send(body);

  const post = (
    path: string,
    body: Record<string, unknown>,
    options: { subject?: string; tenant?: string; key?: string; version?: number },
    subject: string,
  ) =>
    auth(request(api.server).post(path), options.subject ?? subject, options.tenant)
      .set('Idempotency-Key', options.key ?? randomUUID())
      .set('If-Match', `"${String(options.version ?? 1)}"`)
      .send(body);
  const withdraw = (
    id: string,
    body: Record<string, unknown> = {},
    options: { subject?: string; tenant?: string; key?: string; version?: number } = {},
  ) => post(`/api/v1/approvals/${id}/withdraw`, body, options, 'sub-ana');
  const reassign = (
    id: string,
    body: Record<string, unknown>,
    options: { subject?: string; tenant?: string; key?: string; version?: number } = {},
  ) => post(`/api/v1/approvals/${id}/reassign`, body, options, 'sub-marta');
  const withdrawDocument = (
    id: string,
    body: Record<string, unknown> = {},
    options: { subject?: string; tenant?: string; key?: string; version?: number } = {},
  ) => post(`/api/v1/documents/${id}/withdraw`, body, options, 'sub-ana');
  /** Concessões `APPROVER` ativas da aprovação (troca limpa no redirecionamento — RN-TRAM-70). */
  const approverGrantsOf = (processId: string, approvalId: string) =>
    repository()
      .accessOf(processId)
      .filter((row) => row.reason === 'APPROVER' && row.sourceId === approvalId)
      .map((row) => row.userId);
  const toDiego = {
    approverType: 'USER',
    targetApproverUserId: FAKE_USERS.fabio.id,
    reason: LEAVE,
  };
  const transitionOf = (key: string): string => {
    const transition = flow.transitions.find((candidate) => candidate.key === key);
    if (!transition) throw new Error(`transição ${key} ausente`);
    return transition.id;
  };

  /** Processo em TERMO_REFERENCIA (Ana responsável), depois de passar pela abertura. */
  async function processAtTerm(): Promise<Process> {
    const response = await auth(request(api.server).post('/api/v1/processes'), 'sub-ana')
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
    });
    // A responsabilidade da passagem (base de `PREVIOUS_ASSIGNEE` na devolução).
    repository().seedAssignment({
      id: newId(),
      tenantId: A,
      processId: created.id,
      processStageId: term,
      departmentId: PLANEJAMENTO,
      assigneeId: FAKE_USERS.ana.id,
      type: 'STAGE_ENTRY',
      assignedById: null,
      startedAt: new Date('2026-10-01T12:00:00.000Z'),
    });
    const process: Process = {
      ...created,
      workflowVersionId: FLOW_VERSION,
      status: 'IN_PROGRESS',
      currentStageId: term,
      currentWorkflowStageId: flow.stageId('TERMO_REFERENCIA'),
      currentDepartmentId: PLANEJAMENTO,
      currentResponsibleId: FAKE_USERS.ana.id,
      number: 12,
      code: '0012/2026',
      openedAt: created.createdAt,
      version: 9,
    };
    repository().seed(process, [
      { principalType: 'DEPARTMENT', departmentId: PLANEJAMENTO, reason: 'CURRENT' },
    ]);
    return process;
  }

  /** ETP já aprovado (FA-04) e TR finalizado, cada um na v1, criados por `authorId`. */
  async function coveredDocuments(processId: string, authorId: string = FAKE_USERS.ana.id) {
    const ids = new Map<string, string>();
    for (const [index, typeCode] of COVERED.entries()) {
      ids.set(
        typeCode,
        await seedPanelDocument(api, {
          tenantId: A,
          processId,
          typeCode,
          code: `${typeCode} 000${String(index + 1)}/2026`,
          title: `${typeCode} do processo`,
          status: typeCode === 'ETP' ? 'APPROVED' : 'FINALIZED',
          versionNumber: 1,
          createdById: authorId,
        }),
      );
    }
    return ids;
  }

  /** Encaminha (PRC-19, Ana) à etapa de aprovação e devolve o processo e a aprovação aberta. */
  async function pendingApproval(
    stageKey:
      'APROVACAO_AUTORIDADE' | 'APROVACAO_TECNICA' | 'APROVACAO_AVISO' = 'APROVACAO_AUTORIDADE',
    authorId?: string,
  ) {
    const process = await processAtTerm();
    const documents = await coveredDocuments(process.id, authorId);
    const response = await auth(
      request(api.server).post(`/api/v1/processes/${process.id}/forward`),
      'sub-ana',
    )
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', `"${String(process.version)}"`)
      .send({
        expectedStageId: process.currentStageId,
        transitionId: transitionOf(`TERMO_REFERENCIA_FORWARD_${stageKey}`),
        comment: 'Seguem ETP e TR para aprovação.',
      });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const approvalId = data<ForwardedProcessDto>(response).approval?.id ?? '';
    return { processId: process.id, approvalId, documents };
  }

  beforeAll(async () => {
    log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    api = await createTestApi({
      providers: [
        { token: PROCESS_TRANSACTIONS, value: processTx },
        { token: APPROVAL_TRANSACTIONS, value: approvalTx },
        { token: PROCESS_CLOCK, value: () => NOW },
        { token: APPROVAL_CLOCK, value: () => NOW },
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
    roles = seedDefaultRolesOf(api, A);
    const authorityRoleId = roles.get('AUTORIDADE_COMPETENTE')?.id ?? '';
    flow = new DefinitionBuilder(FLOW_VERSION)
      .stage('ABERTURA', 'START', { name: 'Formalização da demanda', assignmentPolicy: 'CREATOR' })
      .stage('TERMO_REFERENCIA', 'TASK', {
        name: 'Termo de Referência',
        departmentResolution: 'CHOSEN_ON_FORWARD',
        slaDays: 10,
      })
      .stage('APROVACAO_AUTORIDADE', 'APPROVAL', {
        name: 'Aprovação da autoridade competente',
        departmentResolution: 'REQUESTING_SECRETARIAT',
        approverType: 'DEPARTMENT_HEAD',
        approverDepartmentResolution: 'REQUESTING_SECRETARIAT',
        approvalDocumentTypeCodes: [...COVERED],
        slaDays: 5,
      })
      .stage('APROVACAO_TECNICA', 'APPROVAL', {
        name: 'Aprovação técnica',
        departmentResolution: 'REQUESTING_SECRETARIAT',
        approverType: 'USER',
        approverUserId: FAKE_USERS.lucia.id,
        approverDepartmentResolution: null,
        approvalDocumentTypeCodes: [...COVERED],
        slaDays: 5,
      })
      .stage('APROVACAO_AVISO', 'APPROVAL', {
        name: 'Aprovação com aviso',
        departmentResolution: 'REQUESTING_SECRETARIAT',
        approverType: 'DEPARTMENT_HEAD',
        approverDepartmentResolution: 'REQUESTING_SECRETARIAT',
        approvalDocumentTypeCodes: [...COVERED],
        slaDays: 5,
      })
      .stage('CONCLUSAO', 'END', {
        name: 'Planejamento da contratação concluído',
        departmentResolution: 'REQUESTING_DEPARTMENT',
        assignmentPolicy: 'UNASSIGNED',
      })
      .transition('ABERTURA', 'TERMO_REFERENCIA', 'FORWARD', { isPrimary: true })
      .transition('TERMO_REFERENCIA', 'APROVACAO_AUTORIDADE', 'FORWARD', { isPrimary: true })
      .transition('TERMO_REFERENCIA', 'APROVACAO_TECNICA', 'FORWARD')
      .transition('TERMO_REFERENCIA', 'APROVACAO_AVISO', 'FORWARD')
      .transition('APROVACAO_AUTORIDADE', 'CONCLUSAO', 'APPROVE', {
        name: 'Aprovar o planejamento',
      })
      .transition('APROVACAO_AUTORIDADE', 'TERMO_REFERENCIA', 'RETURN', {
        name: 'Devolver ao Termo de Referência',
      })
      .transition('APROVACAO_AUTORIDADE', 'ABERTURA', 'RETURN', {
        name: 'Devolver à formalização da demanda',
      })
      .transition('APROVACAO_AUTORIDADE', 'ABERTURA', 'REJECT', { name: 'Indeferir a contratação' })
      .transition('APROVACAO_TECNICA', 'APROVACAO_AUTORIDADE', 'APPROVE')
      .transition('APROVACAO_TECNICA', 'TERMO_REFERENCIA', 'RETURN')
      .transition('APROVACAO_TECNICA', 'ABERTURA', 'REJECT')
      .transition('APROVACAO_AVISO', 'CONCLUSAO', 'APPROVE')
      .transition('APROVACAO_AVISO', 'TERMO_REFERENCIA', 'RETURN')
      .transition('APROVACAO_AVISO', 'ABERTURA', 'REJECT')
      .rule(
        'CONDITION',
        { expression: { '==': [{ var: 'process.status' }, 'CANCELED'] } },
        { transition: 'APROVACAO_AVISO_APPROVE_CONCLUSAO' },
        {
          severity: 'WARNING',
          message: 'O mapa de riscos não foi atualizado desde a última versão.',
        },
      );
    await seedPublishedInMemory(api, A, flow, 'TESTE_US053');
    await deactivateWorkflow(api, A, 'TESTE_US053');
    assignDepartment(api, membershipOf(FAKE_USERS.ana.id), UNITS_A.manutencao);
    assignDepartment(api, membershipOf(FAKE_USERS.ana.id), PLANEJAMENTO);
    for (const user of [FAKE_USERS.marta, FAKE_USERS.fabio, FAKE_USERS.lucia]) {
      assignRole(api, {
        tenantId: A,
        membershipId: membershipOf(user.id),
        roleId: authorityRoleId,
      });
    }
    // Otávio ("Bruno"): APPROVAL_DECIDE só sobre a Saúde — não é titular, substituto nem aprovador.
    assignRole(api, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.otavio.id),
      roleId: authorityRoleId,
      scopeType: 'DEPARTMENT',
      scopeDepartmentId: UNITS_A.saude,
    });
    setDepartmentHead(api, UNITS_A.obras, FAKE_USERS.marta.id, FAKE_USERS.fabio.id);
    // Lúcia: lotada também na unidade de origem, com PROCESS_FORWARD pelo perfil (RN-TRAM-64).
    assignDepartment(api, membershipOf(FAKE_USERS.lucia.id), PLANEJAMENTO);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await api.close();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    processTx.down = false;
    approvalTx.down = false;
    setDepartmentHead(api, UNITS_A.obras, FAKE_USERS.marta.id, FAKE_USERS.fabio.id);
  });

  /** Submissão avulsa (FA-01): despacho `IN_REVIEW` coberto por aprovação `DOCUMENT` de Lúcia. */
  async function standaloneSubmission() {
    const process = await processAtTerm();
    const approvalId = newId();
    const documentId = await seedPanelDocument(api, {
      tenantId: A,
      processId: process.id,
      typeCode: 'DESPACHO',
      code: 'DESPACHO 0001/2026',
      title: 'Despacho de abertura',
      status: 'IN_REVIEW',
      versionNumber: 1,
      pendingApprovalId: approvalId,
      createdById: FAKE_USERS.ana.id,
    });
    const document = documentsOf(process.id).find((candidate) => candidate.id === documentId);
    approvalRepositoryOf(api).seed(
      {
        id: approvalId,
        tenantId: A,
        processId: process.id,
        subjectType: 'DOCUMENT',
        processStageId: null,
        documentId,
        title: 'Aprovação avulsa — Despacho DESPACHO 0001/2026',
        requestedById: FAKE_USERS.ana.id,
        requestedAt: NOW,
        requestComment: null,
        approverType: 'USER',
        approverUserId: FAKE_USERS.lucia.id,
        approverRoleId: null,
        approverDepartmentId: null,
        allowDeputy: false,
        dueAt: null,
        status: 'PENDING',
        createdAt: NOW,
        createdById: FAKE_USERS.ana.id,
      },
      [{ id: newId(), documentId, documentVersionId: document?.currentVersionId ?? '' }],
    );
    return { processId: process.id, approvalId, documentId, version: document?.version ?? 1 };
  }

  const documentOf = (processId: string, documentId: string) =>
    documentsOf(processId).find((candidate) => candidate.id === documentId);

  describe('[Sucesso]', () => {
    it('Retirar aprovação de etapa devolve o processo a quem encaminhou: CANCELED/WITHDRAWN, RETURNED, Ana responsável, ApprovalCanceled e approval.withdraw', async () => {
      const { processId, approvalId, documents } = await pendingApproval();
      const detail = await getApproval(approvalId, 'sub-ana');
      expect((detail.body as { meta: ApprovalMeta }).meta.allowedActions).toEqual(['WITHDRAW']);
      log.mockClear();

      const response = await withdraw(approvalId, { reason: WITHDRAW_REASON });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers.etag).toBe('"2"');
      const dto = withdrawnApprovalSchema.parse(data<WithdrawnApprovalDto>(response));
      expect(dto).toMatchObject({
        status: 'CANCELED',
        decision: null,
        processStage: { key: 'TERMO_REFERENCIA', name: 'Termo de Referência' },
        processStatus: 'RETURNED',
        version: 2,
      });
      expect(approvalOf(approvalId)).toMatchObject({
        status: 'CANCELED',
        cancellationReason: 'WITHDRAWN',
        canceledById: FAKE_USERS.ana.id,
        canceledAt: NOW,
      });
      // RN-TRAM-68: de volta à etapa de origem, com Ana (quem encaminhou) responsável.
      const process = stored(processId);
      expect(process).toMatchObject({
        status: 'RETURNED',
        currentWorkflowStageId: flow.stageId('TERMO_REFERENCIA'),
        currentDepartmentId: PLANEJAMENTO,
        currentResponsibleId: FAKE_USERS.ana.id,
      });
      const movement = repository().movementsOf(processId).at(-1);
      expect(movement).toMatchObject({
        action: 'RETURN',
        approvalId,
        comment: WITHDRAW_REASON,
        metadata: expect.objectContaining({ withdrawn: true }) as unknown,
      });
      // RN-TRAM-66/67: os cobertos (aprovado/finalizado) só deixam de estar "em aprovação".
      for (const document of documentsOf(processId)) {
        expect(document.pendingApprovalId).toBeNull();
      }
      expect(documentOf(processId, documents.get('TR') ?? '')?.status).toBe('FINALIZED');
      expect(documentOf(processId, documents.get('ETP') ?? '')?.status).toBe('APPROVED');
      // Eventos (outbox) e auditoria.
      expect(eventsOf(processId, 'ApprovalCanceled').map((row) => row.payload)).toEqual([
        { approvalId, reason: 'WITHDRAWN' },
      ]);
      const stageChanged = eventsOf(processId, 'ProcessStageChanged').at(-1);
      expect(stageChanged?.payload).toMatchObject({ cause: 'RETURN', approvalId });
      const [audit] = auditOf(processId, 'approval.withdraw');
      expect(audit).toMatchObject({
        category: 'WORKFLOW',
        entityType: 'Approval',
        entityId: approvalId,
        metadata: expect.objectContaining({
          processCode: '0012/2026',
          subjectType: 'PROCESS_STAGE',
          hasReason: true,
          movementId: movement?.id,
        }) as unknown,
      });
      // Logs: o motivo nunca vai a log.
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'approval.withdrawn', approvalId, processId }),
        'approval.withdrawn',
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain(WITHDRAW_REASON);
      // A aprovação retirada mostra o registro (sem ações).
      const after = await getApproval(approvalId, 'sub-ana');
      expect((after.body as { meta: ApprovalMeta }).meta).toMatchObject({
        allowedActions: [],
        decisionBlocker: 'NOT_PENDING',
      });
    });

    it('[RN-TRAM-67] Documento coberto em análise (IN_REVIEW) volta a DRAFT com DocumentWithdrawn', async () => {
      const { processId, approvalId, documents } = await pendingApproval();
      const termId = documents.get('TR') ?? '';
      const term = documentOf(processId, termId);
      if (!term) throw new Error('TR ausente');
      documentRepositoryOf(api).seed({ ...term, status: 'IN_REVIEW' });

      const response = await withdraw(approvalId);

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(documentOf(processId, termId)).toMatchObject({
        status: 'DRAFT',
        pendingApprovalId: null,
      });
      expect(eventsOf(processId, 'DocumentWithdrawn').map((row) => row.payload)).toEqual([
        expect.objectContaining({ documentId: termId, approvalId, reason: 'Aprovação retirada' }),
      ]);
      expect(auditOf(processId, 'document.withdraw')[0]?.metadata).toMatchObject({
        approvalId,
        automatic: false,
      });
      expect(auditOf(processId, 'approval.withdraw')[0]?.metadata).toMatchObject({
        hasReason: false,
      });
      // Sem motivo, a devolução leva o texto fixo (a `RETURN` exige comentário no banco).
      expect(repository().movementsOf(processId).at(-1)?.comment).toBe(
        'Aprovação retirada por quem encaminhou o processo.',
      );
    });

    it('Redirecionar aprovação para outro aprovador elegível: PENDING com Diego, acesso trocado e ApprovalReassigned', async () => {
      const { processId, approvalId } = await pendingApproval('APROVACAO_TECNICA');
      const before = approvalOf(approvalId);
      expect(approverGrantsOf(processId, approvalId)).toEqual([FAKE_USERS.lucia.id]);
      const detail = await getApproval(approvalId, 'sub-marta');
      expect((detail.body as { meta: ApprovalMeta }).meta.allowedActions).toEqual(['REASSIGN']);
      log.mockClear();

      const response = await reassign(approvalId, toDiego);

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers.etag).toBe('"2"');
      const dto = approvalSchema.parse(data<ApprovalDto>(response));
      expect(dto).toMatchObject({
        status: 'PENDING',
        approver: { type: 'USER', userId: FAKE_USERS.fabio.id },
        version: 2,
      });
      // RN-TRAM-70: título, prazo, solicitante e cobertura preservados.
      expect(approvalOf(approvalId)).toMatchObject({
        status: 'PENDING',
        approverType: 'USER',
        approverUserId: FAKE_USERS.fabio.id,
        title: before.title,
        dueAt: before.dueAt,
        requestedById: before.requestedById,
        requestedAt: before.requestedAt,
      });
      expect(approvalRepositoryOf(api).coverageOf(approvalId)).toHaveLength(2);
      // "Carla" perde o acesso de aprovador e "Diego" ganha.
      expect(approverGrantsOf(processId, approvalId)).toEqual([FAKE_USERS.fabio.id]);
      expect(
        repository()
          .revokedAccessOf(processId)
          .filter((row) => row.reason === 'APPROVER')
          .map((row) => row.userId),
      ).toEqual([FAKE_USERS.lucia.id]);
      expect(eventsOf(processId, 'ApprovalReassigned').map((row) => row.payload)).toEqual([
        expect.objectContaining({
          approvalId,
          fromApproverUserId: FAKE_USERS.lucia.id,
          toApproverUserId: FAKE_USERS.fabio.id,
          hasReason: true,
        }),
      ]);
      expect(JSON.stringify(eventsOf(processId, 'ApprovalReassigned'))).not.toContain(LEAVE);
      expect(auditOf(processId, 'approval.reassign')[0]).toMatchObject({
        category: 'WORKFLOW',
        changes: expect.arrayContaining([
          { path: 'approverUserId', old: FAKE_USERS.lucia.id, new: FAKE_USERS.fabio.id },
        ]) as unknown,
        metadata: expect.objectContaining({ hasReason: true }) as unknown,
      });
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'approval.reassigned',
          fromApproverId: FAKE_USERS.lucia.id,
          toApproverId: FAKE_USERS.fabio.id,
        }),
        'approval.reassigned',
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain(LEAVE);
      // Nada muda na etapa nem na tramitação.
      expect(stored(processId).status).toBe('AWAITING_APPROVAL');

      // E o novo aprovador decide (E2E "redirecionar e decidir pelo novo aprovador").
      const decided = await decide(
        approvalId,
        { decision: 'APPROVE' },
        { subject: 'sub-fabio', version: 2 },
      );
      expect(decided.status, JSON.stringify(decided.body)).toBe(200);
      expectProblem(
        await decide(approvalId, { decision: 'APPROVE' }, { subject: 'sub-lucia', version: 3 }),
        409,
        'APPROVAL_NOT_PENDING',
      );
    });

    it('[FA-02] Redirecionar para outra unidade (DEPARTMENT_HEAD): o titular atual decide, com substituto', async () => {
      const { processId, approvalId } = await pendingApproval('APROVACAO_TECNICA');
      setDepartmentHead(api, UNITS_A.saude, FAKE_USERS.fabio.id, FAKE_USERS.marta.id);

      const response = await reassign(approvalId, {
        approverType: 'DEPARTMENT_HEAD',
        targetApproverDepartmentId: UNITS_A.saude,
        reason: LEAVE,
      });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(approvalOf(approvalId)).toMatchObject({
        approverType: 'DEPARTMENT_HEAD',
        approverDepartmentId: UNITS_A.saude,
        approverUserId: FAKE_USERS.fabio.id,
        allowDeputy: true,
      });
      expect(approverGrantsOf(processId, approvalId).sort()).toEqual(
        [FAKE_USERS.fabio.id, FAKE_USERS.marta.id].sort(),
      );
    });

    it('[FA-05] Novo redirecionamento em sequência: sem limite', async () => {
      const { approvalId } = await pendingApproval('APROVACAO_TECNICA');
      expect((await reassign(approvalId, toDiego)).status).toBe(200);

      const again = await reassign(
        approvalId,
        { approverType: 'USER', targetApproverUserId: FAKE_USERS.lucia.id, reason: LEAVE },
        { version: 2 },
      );

      expect(again.status, JSON.stringify(again.body)).toBe(200);
      expect(approvalOf(approvalId)).toMatchObject({
        approverUserId: FAKE_USERS.lucia.id,
        version: 3,
      });
    });

    it('[FA-01] Retirada de submissão avulsa (DOC-11): o documento volta a DRAFT, sem etapa nem tramitação', async () => {
      const { processId, approvalId, documentId, version } = await standaloneSubmission();
      const before = stored(processId);

      const response = await withdrawDocument(documentId, {}, { version });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const dto = documentSchema.parse(data<DocumentDto>(response));
      expect(dto).toMatchObject({ id: documentId, status: 'DRAFT' });
      expect(response.headers.etag).toBe(`"${String(dto.version)}"`);
      expect(approvalOf(approvalId)).toMatchObject({
        status: 'CANCELED',
        cancellationReason: 'WITHDRAWN',
      });
      expect(documentOf(processId, documentId)?.pendingApprovalId).toBeNull();
      expect(stored(processId)).toEqual(before);
      expect(eventsOf(processId, 'ProcessStageChanged')).toEqual([]);
      expect(eventsOf(processId, 'DocumentWithdrawn')).toHaveLength(1);
      expect(eventsOf(processId, 'ApprovalCanceled')).toHaveLength(1);
      expect(auditOf(processId, 'approval.withdraw')[0]?.metadata).toMatchObject({
        subjectType: 'DOCUMENT',
        documentCodes: ['DESPACHO 0001/2026'],
      });
    });

    it('[FA-01] A mesma retirada avulsa pelo APV-04 e a ação no APV-02', async () => {
      const { processId, approvalId, documentId } = await standaloneSubmission();
      const detail = await getApproval(approvalId, 'sub-ana');
      expect((detail.body as { meta: ApprovalMeta }).meta.allowedActions).toContain('WITHDRAW');

      const response = await withdraw(approvalId);

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(data<WithdrawnApprovalDto>(response)).toMatchObject({
        subjectType: 'DOCUMENT',
        status: 'CANCELED',
        processStage: null,
        processStatus: null,
      });
      expect(documentOf(processId, documentId)?.status).toBe('DRAFT');
    });
  });

  describe('[Validação]', () => {
    it('Redirecionar sem motivo: 422 VALIDATION_ERROR no campo reason', async () => {
      const { approvalId } = await pendingApproval('APROVACAO_TECNICA');

      const response = await reassign(approvalId, {
        approverType: 'USER',
        targetApproverUserId: FAKE_USERS.fabio.id,
      });

      const body = expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(body.errors).toEqual([
        expect.objectContaining({
          field: 'reason',
          message: 'Informe o motivo do redirecionamento (mín. 10 caracteres).',
        }),
      ]);
      expect(approvalOf(approvalId)).toMatchObject({
        approverUserId: FAKE_USERS.lucia.id,
        version: 1,
      });
    });

    it('Motivo curto: 422 TOO_SHORT; alvo de outro tipo: 422', async () => {
      const { approvalId } = await pendingApproval('APROVACAO_TECNICA');

      const short = await reassign(approvalId, { ...toDiego, reason: 'licença' });
      expect(expectProblem(short, 422, 'VALIDATION_ERROR').errors).toEqual([
        expect.objectContaining({ field: 'reason', code: 'TOO_SHORT' }),
      ]);
      const mixed = await reassign(approvalId, { ...toDiego, approverType: 'ROLE' });
      expect(expectProblem(mixed, 422, 'VALIDATION_ERROR').errors.map((e) => e.field)).toEqual([
        'targetApproverUserId',
        'targetApproverRoleId',
      ]);
    });

    it('Motivo da retirada acima de 2.000 caracteres: 422', async () => {
      const { approvalId } = await pendingApproval();

      expectProblem(
        await withdraw(approvalId, { reason: 'x'.repeat(2001) }),
        422,
        'VALIDATION_ERROR',
      );
      expect(approvalOf(approvalId).status).toBe('PENDING');
    });

    it.each([
      ['o mesmo aprovador', () => ({ targetApproverUserId: FAKE_USERS.lucia.id })],
      ['usuário sem vínculo ativo', () => ({ targetApproverUserId: FAKE_USERS.bruno.id })],
      ['usuário de outro tenant', () => ({ targetApproverUserId: FAKE_USERS.heitor.id })],
    ])('[V-02] Novo aprovador: %s → 422 APPROVER_NOT_ELIGIBLE', async (_label, target) => {
      const { approvalId } = await pendingApproval('APROVACAO_TECNICA');

      const response = await reassign(approvalId, { ...toDiego, ...target() });

      const body = expectProblem(response, 422, 'APPROVER_NOT_ELIGIBLE');
      expect(body.detail).toBe('Selecione um aprovador diferente e elegível para este processo.');
      expect(approvalOf(approvalId).approverUserId).toBe(FAKE_USERS.lucia.id);
    });

    it('[V-02] Perfil sem detentor competente ou sem APPROVAL_DECIDE, unidade sem titular: 422 APPROVER_NOT_ELIGIBLE', async () => {
      const { approvalId } = await pendingApproval('APROVACAO_TECNICA');

      for (const body of [
        { approverType: 'ROLE', targetApproverRoleId: roles.get('FISCAL_CONTRATO')?.id },
        { approverType: 'ROLE', targetApproverRoleId: roles.get('REQUISITANTE')?.id },
        { approverType: 'DEPARTMENT_HEAD', targetApproverDepartmentId: UNITS_A.posto },
      ]) {
        expectProblem(
          await reassign(approvalId, { ...body, reason: LEAVE }),
          422,
          'APPROVER_NOT_ELIGIBLE',
        );
      }
      // O perfil com detentores competentes é elegível.
      const authority = roles.get('AUTORIDADE_COMPETENTE')?.id;
      const ok = await reassign(approvalId, {
        approverType: 'ROLE',
        targetApproverRoleId: authority,
        reason: LEAVE,
      });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(approvalOf(approvalId)).toMatchObject({
        approverType: 'ROLE',
        approverRoleId: authority,
        approverUserId: null,
      });
    });

    it('[V-05] Novo aprovador autor de documento coberto: 403 SELF_APPROVAL_FORBIDDEN (access.denied)', async () => {
      const { approvalId } = await pendingApproval('APROVACAO_TECNICA', FAKE_USERS.fabio.id);

      const response = await reassign(approvalId, toDiego);

      const body = expectProblem(response, 403, 'SELF_APPROVAL_FORBIDDEN');
      expect(body.detail).toBe(
        'Este usuário não pode aprovar por ser autor de um dos documentos (segregação de funções).',
      );
      expect(
        api
          .auditRecords()
          .filter((row) => row.action === 'access.denied' && row.entityId === approvalId),
      ).toEqual([expect.objectContaining({ reasonCode: 'APPROVAL_REASSIGN' })]);
      expect(approvalOf(approvalId).approverUserId).toBe(FAKE_USERS.lucia.id);
    });

    it('Processo suspenso: 409 INVALID_PROCESS_STATUS na retirada e no redirecionamento', async () => {
      const { processId, approvalId } = await pendingApproval('APROVACAO_TECNICA');
      repository().seed({ ...stored(processId), status: 'SUSPENDED' });

      expectProblem(await withdraw(approvalId), 409, 'INVALID_PROCESS_STATUS');
      expectProblem(await reassign(approvalId, toDiego), 409, 'INVALID_PROCESS_STATUS');
      expect(approvalOf(approvalId)).toMatchObject({ status: 'PENDING', version: 1 });
    });
  });

  describe('[Permissão]', () => {
    it('Usuário sem custódia anterior tenta retirar: 403 PERMISSION_DENIED e access.denied', async () => {
      const { processId, approvalId } = await pendingApproval();
      const before = effects(processId, approvalId);

      const response = await withdraw(approvalId, {}, { subject: 'sub-otavio' });

      const body = expectProblem(response, 403, 'PERMISSION_DENIED');
      expect(body.detail).toBe('Você não pode retirar esta aprovação.');
      expect(
        api
          .auditRecords()
          .filter((row) => row.action === 'access.denied' && row.entityId === approvalId),
      ).toEqual([
        expect.objectContaining({ reasonCode: 'APPROVAL_WITHDRAW', entityType: 'Approval' }),
      ]);
      expect(effects(processId, approvalId)).toEqual(before);
    });

    it('O aprovador designado não retira (não é solicitante nem da unidade de origem); vê só DECIDE', async () => {
      const { approvalId } = await pendingApproval();

      expectProblem(
        await withdraw(approvalId, {}, { subject: 'sub-marta' }),
        403,
        'PERMISSION_DENIED',
      );
      const detail = await getApproval(approvalId, 'sub-marta');
      expect((detail.body as { meta: ApprovalMeta }).meta.allowedActions).toEqual([
        'DECIDE',
        'REASSIGN',
      ]);
    });

    it('[RN-TRAM-64] Colega lotado na unidade de origem com PROCESS_FORWARD também retira', async () => {
      const { processId, approvalId } = await pendingApproval();

      const response = await withdraw(approvalId, {}, { subject: 'sub-lucia' });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(stored(processId).status).toBe('RETURNED');
      expect(approvalOf(approvalId).canceledById).toBe(FAKE_USERS.lucia.id);
    });

    it('Sem APPROVAL_REASSIGN cobrindo o processo: 403 PERMISSION_DENIED (access.denied); sem a permissão em escopo algum, 403 no guard', async () => {
      const { approvalId } = await pendingApproval('APROVACAO_TECNICA');

      const scoped = await reassign(approvalId, toDiego, { subject: 'sub-otavio' });
      expectProblem(scoped, 403, 'PERMISSION_DENIED');
      const none = await reassign(approvalId, toDiego, { subject: 'sub-ana' });
      expectProblem(none, 403, 'PERMISSION_DENIED');
      expect(
        api
          .auditRecords()
          .filter((row) => row.action === 'access.denied' && row.reasonCode === 'APPROVAL_REASSIGN')
          .length,
      ).toBeGreaterThanOrEqual(2);
      expect(approvalOf(approvalId)).toMatchObject({
        approverUserId: FAKE_USERS.lucia.id,
        version: 1,
      });
    });

    it('[DOC-11] Sem a permissão de submissão do tipo: 403 PERMISSION_DENIED', async () => {
      const { processId, approvalId, documentId, version } = await standaloneSubmission();

      const response = await withdrawDocument(documentId, {}, { subject: 'sub-carla', version });

      expect([403, 404]).toContain(response.status);
      expect(approvalOf(approvalId).status).toBe('PENDING');
      expect(documentOf(processId, documentId)?.status).toBe('IN_REVIEW');
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Aprovação de outro tenant: 404 APPROVAL_NOT_FOUND na retirada e no redirecionamento', async () => {
      const foreign = newId();
      approvalRepositoryOf(api).seed({
        id: foreign,
        tenantId: B,
        processId: newId(),
        subjectType: 'PROCESS_STAGE',
        processStageId: newId(),
        documentId: null,
        title: 'AP-9',
        requestedById: FAKE_USERS.heitor.id,
        requestedAt: NOW,
        requestComment: null,
        approverType: 'USER',
        approverUserId: FAKE_USERS.marta.id,
        approverRoleId: null,
        approverDepartmentId: null,
        allowDeputy: false,
        dueAt: null,
        status: 'PENDING',
        createdAt: NOW,
        createdById: FAKE_USERS.heitor.id,
      });

      expectProblem(await withdraw(foreign), 404, 'APPROVAL_NOT_FOUND');
      expectProblem(await reassign(foreign, toDiego), 404, 'APPROVAL_NOT_FOUND');
      expect(approvalOf(foreign)).toMatchObject({ status: 'PENDING', version: 1 });
    });

    it('[DOC-11] Documento de outro tenant: 404', async () => {
      const { documentId } = await standaloneSubmission();

      const response = await withdrawDocument(documentId, {}, { subject: 'sub-heitor', tenant: B });

      expect(response.status).toBe(404);
    });
  });

  describe('[Duplicidade]', () => {
    it('Reenvio da retirada com a mesma chave: 200 com Idempotent-Replayed e uma única retirada', async () => {
      const { processId, approvalId } = await pendingApproval();
      const key = randomUUID();

      const first = await withdraw(approvalId, { reason: WITHDRAW_REASON }, { key });
      const replay = await withdraw(approvalId, { reason: WITHDRAW_REASON }, { key });

      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(replay.status).toBe(200);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toEqual(first.body);
      expect(auditOf(processId, 'approval.withdraw')).toHaveLength(1);
      expect(eventsOf(processId, 'ApprovalCanceled')).toHaveLength(1);
      expect(
        repository()
          .movementsOf(processId)
          .filter((movement) => movement.action === 'RETURN'),
      ).toHaveLength(1);
    });

    it('Mesma chave com outro corpo: 422 IDEMPOTENCY_KEY_REUSED; nova chave depois de retirada: 409', async () => {
      const { approvalId } = await pendingApproval();
      const key = randomUUID();
      await withdraw(approvalId, {}, { key });

      expectProblem(
        await withdraw(approvalId, { reason: WITHDRAW_REASON }, { key }),
        422,
        'IDEMPOTENCY_KEY_REUSED',
      );
      const again = expectProblem(
        await withdraw(approvalId, {}, { version: 2 }),
        409,
        'APPROVAL_NOT_PENDING',
      );
      expect(again.detail).toBe('Esta aprovação já foi decidida ou retirada.');
    });
  });

  describe('[Concorrência]', () => {
    it('Retirada após decisão já registrada (ETag antiga): 409 APPROVAL_NOT_PENDING e nenhum movimento de devolução', async () => {
      const { processId, approvalId } = await pendingApproval();
      expect((await decide(approvalId, { decision: 'APPROVE' })).status).toBe(200);

      const response = await withdraw(approvalId);

      expectProblem(response, 409, 'APPROVAL_NOT_PENDING');
      expect(approvalOf(approvalId).status).toBe('APPROVED');
      expect(
        repository()
          .movementsOf(processId)
          .filter((movement) => movement.action === 'RETURN'),
      ).toEqual([]);
    });

    it('Retirada e decisão simultâneas: exatamente uma vence', async () => {
      const { processId, approvalId } = await pendingApproval();

      const [withdrawn, decided] = await Promise.all([
        withdraw(approvalId),
        decide(approvalId, { decision: 'APPROVE' }),
      ]);

      expect([withdrawn.status, decided.status].sort()).toEqual([200, 409]);
      expect(
        auditOf(processId, 'approval.withdraw').length +
          auditOf(processId, 'approval.decide').length,
      ).toBe(1);
    });

    it('Redirecionamento com If-Match divergente: 412 VERSION_CONFLICT', async () => {
      const { approvalId } = await pendingApproval('APROVACAO_TECNICA');

      const body = expectProblem(
        await reassign(approvalId, toDiego, { version: 7 }),
        412,
        'VERSION_CONFLICT',
      );
      expect(body.detail).toBe('Esta aprovação foi atualizada por outra pessoa. Recarregue.');
      expect(approvalOf(approvalId).approverUserId).toBe(FAKE_USERS.lucia.id);
    });

    it('[DOC-11] If-Match divergente do documento: 412; documento já fora de análise: 409', async () => {
      const { approvalId, documentId, version } = await standaloneSubmission();

      expectProblem(
        await withdrawDocument(documentId, {}, { version: version + 5 }),
        412,
        'VERSION_CONFLICT',
      );
      expect(approvalOf(approvalId).status).toBe('PENDING');
      expect((await withdrawDocument(documentId, {}, { version })).status).toBe(200);
      expectProblem(
        await withdrawDocument(documentId, {}, { version: version + 1 }),
        409,
        'APPROVAL_NOT_PENDING',
      );
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível durante o redirecionamento: 503 DEPENDENCY_UNAVAILABLE e o aprovador original', async () => {
      const { processId, approvalId } = await pendingApproval('APROVACAO_TECNICA');
      const before = effects(processId, approvalId);
      approvalTx.down = true;

      const response = await reassign(approvalId, toDiego);

      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      expect(effects(processId, approvalId)).toEqual(before);
      expect(approvalOf(approvalId).approverUserId).toBe(FAKE_USERS.lucia.id);
    });
  });

  describe('[Falha de integração]', () => {
    it('Fila de notificação fora: o redirecionamento é aplicado (200) e o ApprovalReassigned fica no outbox', async () => {
      // Sem relay no teste em memória: o evento fica no outbox (o status PENDING até a fila voltar é
      // provado sobre o PostgreSQL em test/tenant-leak/approval-withdrawal.spec.ts).
      const { processId, approvalId } = await pendingApproval('APROVACAO_TECNICA');

      const response = await reassign(approvalId, toDiego);

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(eventsOf(processId, 'ApprovalReassigned')).toHaveLength(1);
      expect(approvalOf(approvalId).approverUserId).toBe(FAKE_USERS.fabio.id);
    });
  });
});
