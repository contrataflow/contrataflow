import { randomUUID } from 'node:crypto';

import {
  approvalMetaSchema,
  approvalSchema,
  problemDetailsSchema,
  reassignApprovalLineMetaSchema,
  withdrawnApprovalSchema,
} from '@contrataflow/validation';
import type {
  ApprovalDecisionPolicy,
  ApprovalDto,
  ApprovalMeta,
  ForwardedProcessDto,
  ProcessDto,
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

import { jobQueueOf } from '../../../../test/support/ai-fixtures.js';
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
 * US-135 — redirecionar linha de aprovação (APV-06) e retirar a aprovação múltipla (APV-04), com o
 * APV-05 do MVP 1 sobre a única linha, pelo pipeline HTTP completo (identidade fake, seeders reais,
 * repositórios em memória): as 8 categorias do Gherkin e as regras RN-APV-51..60. Background: Ana
 * encaminha (PRC-19) o processo "0012/2026" à "Autorização da licitação" `SEQUENTIAL` — linha 1
 * "Roberto" (Marta, USER), linha 2 "Marcos" (Fábio, USER) e linha 3 "Paula" (o perfil
 * AUTORIDADE_COMPETENTE) — cobrindo o edital "ED 0003/2026" (autora Ana = "Elisa"); Roberto aprova
 * a linha 1 e a 2 fica PENDING, a 3 WAITING. Personagens: Lúcia = a gestora "Marta"
 * (GESTOR_CONTRATACOES no tenant: `APPROVAL_REASSIGN` e `PROCESS_ASSIGN`), Otávio = "Diego" (novo
 * aprovador) e também "Bruno"/"Cléber" (AUTORIDADE_COMPETENTE só sobre a Saúde, sem custódia nem
 * `PROCESS_ASSIGN`), Heitor = a Prefeitura B. A memória não tem rollback nem `FOR UPDATE`: as
 * corridas são serializadas pela fila de transações; o rollback real, a trava, o índice único
 * parcial e o outbox `PENDING` ficam em `test/tenant-leak/approval-line-reassign.spec.ts`. POL-17.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-11-12T15:00:00.000Z');
const USER_AGENT = 'Vitest/US-135';
const LEAVE = 'Marcos está de licença médica';
const WITHDRAW_REASON = 'Edital precisa de nova análise de riscos';

const ORG_A = '0192d135-0000-7000-8000-0000000000a0';
const ORG_B = '0192d135-0000-7000-8000-0000000000b0';
const UNITS_A = {
  organizationId: ORG_A,
  obras: '0192d135-0000-7000-8000-0000000000a1',
  manutencao: '0192d135-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d135-0000-7000-8000-0000000000a3',
  saude: '0192d135-0000-7000-8000-0000000000a4',
  posto: '0192d135-0000-7000-8000-0000000000a5',
};
const UNITS_B = {
  organizationId: ORG_B,
  obras: '0192d135-0000-7000-8000-0000000000b1',
  manutencao: '0192d135-0000-7000-8000-0000000000b2',
  pavimentacao: '0192d135-0000-7000-8000-0000000000b3',
  saude: '0192d135-0000-7000-8000-0000000000b4',
  posto: '0192d135-0000-7000-8000-0000000000b5',
};
const LICITACOES = '0192d135-0000-7000-8000-0000000000a7';
const FLOW_VERSION = '0192d135-0000-7000-8000-0000000000f1';

const ROBERTO = FAKE_USERS.marta;
const MARCOS = FAKE_USERS.fabio;
const DIEGO = FAKE_USERS.otavio;
const GESTORA = FAKE_USERS.lucia;
const ANA = FAKE_USERS.ana;

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

/** Linha `WorkflowStageApprover` como o construtor de definições a guarda (US-132). */
type StageApproverLine = NonNullable<DefinitionBuilder['stages'][number]['approvers']>[number];

type LineSpec = { readonly type: 'USER'; readonly userId: string } | { readonly type: 'ROLE' };

type StageKey = 'AUT_SEQUENCIAL' | 'AUT_UNICA';

describe('Feature: Redirecionar linha de aprovação e retirar aprovação múltipla (US-135)', () => {
  let api: TestApi;
  let flow: DefinitionBuilder;
  let authorityRoleId: string;
  let managerRoleId: string;
  let log: MockInstance<Logger['log']>;
  let warn: MockInstance<Logger['warn']>;
  const processTx = new FlakyTransactions();
  const approvalTx = new FlakyTransactions();
  const jobs = () => jobQueueOf(api);
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
  const linesOf = (approvalId: string) => approvalRepositoryOf(api).linesOf(approvalId);
  /** A linha viva (ou a decidida) da posição — a cancelada por redirecionamento fica de fora. */
  const lineAt = (approvalId: string, sequence: number) => {
    const line = linesOf(approvalId).find(
      (candidate) => candidate.sequence === sequence && candidate.status !== 'CANCELED',
    );
    if (!line) throw new Error(`linha ${String(sequence)} ausente`);
    return line;
  };
  const documentsOf = (processId: string) =>
    documentRepositoryOf(api)
      .allDocuments()
      .filter((document) => document.processId === processId);
  const eventsOf = (processId: string, eventType: string) =>
    api.outboxRows().filter((row) => row.processId === processId && row.eventType === eventType);
  const auditOf = (processId: string, action: string) =>
    api.auditRecords().filter((row) => row.processId === processId && row.action === action);
  const deniedOf = (approvalId: string) =>
    api
      .auditRecords()
      .filter((row) => row.action === 'access.denied' && row.entityId === approvalId);
  /** Usuários com `ProcessAccess` `APPROVER` ativo vindo de uma linha da aprovação. */
  const approverGrantsOf = (processId: string, approvalId: string) => {
    const sources = new Set([approvalId, ...linesOf(approvalId).map((line) => line.id)]);
    return repository()
      .accessOf(processId)
      .filter(
        (row) => row.reason === 'APPROVER' && row.sourceId !== null && sources.has(row.sourceId),
      )
      .map((row) => [row.userId, row.sourceId]);
  };
  /** O que o redirecionamento grava (para provar que nada foi gravado numa recusa). */
  const effects = (processId: string, approvalId: string) => ({
    process: stored(processId),
    approval: approvalOf(approvalId),
    lines: linesOf(approvalId),
    access: repository().accessOf(processId).length,
    events: api.outboxRows().filter((row) => row.processId === processId).length,
    audits: auditOf(processId, 'approval.reassign').length,
  });

  const getApproval = (id: string, subject: string, tenant: string = A) =>
    auth(request(api.server).get(`/api/v1/approvals/${id}`), subject, tenant);
  async function detail(id: string, subject: string) {
    const response = await getApproval(id, subject);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const body = response.body as { data: ApprovalDto; meta: ApprovalMeta };
    return { dto: approvalSchema.parse(body.data), meta: approvalMetaSchema.parse(body.meta) };
  }
  interface CallOptions {
    readonly subject?: string;
    readonly tenant?: string;
    readonly key?: string;
    readonly ifMatch?: string;
  }
  /** APV-06 com o `If-Match` da linha (`approvers[].version`) por padrão. */
  const reassignLine = (
    approvalId: string,
    lineId: string,
    body: Record<string, unknown>,
    options: CallOptions = {},
  ) =>
    auth(
      request(api.server).post(`/api/v1/approvals/${approvalId}/approvers/${lineId}/reassign`),
      options.subject ?? 'sub-lucia',
      options.tenant,
    )
      .set('Idempotency-Key', options.key ?? randomUUID())
      .set(
        'If-Match',
        options.ifMatch ??
          `"${String(linesOf(approvalId).find((line) => line.id === lineId)?.version ?? 1)}"`,
      )
      .send(body);
  /** APV-04/APV-05/APV-03 com o `If-Match` da aprovação por padrão. */
  const post = (
    path: string,
    approvalId: string,
    body: Record<string, unknown>,
    options: CallOptions & { readonly subject: string },
  ) =>
    auth(
      request(api.server).post(`/api/v1/approvals/${approvalId}/${path}`),
      options.subject,
      options.tenant,
    )
      .set('Idempotency-Key', options.key ?? randomUUID())
      .set('If-Match', options.ifMatch ?? `"${String(approvalOf(approvalId).version)}"`)
      .send(body);
  const withdraw = (approvalId: string, body: Record<string, unknown>, options: CallOptions = {}) =>
    post('withdraw', approvalId, body, { ...options, subject: options.subject ?? 'sub-lucia' });
  const reassignSingle = (
    approvalId: string,
    body: Record<string, unknown>,
    options: CallOptions = {},
  ) => post('reassign', approvalId, body, { ...options, subject: options.subject ?? 'sub-lucia' });
  const toUser = (userId: string, reason: string = LEAVE) => ({
    approverType: 'USER',
    targetApproverUserId: userId,
    reason,
  });
  const reassignedOf = (response: request.Response) => {
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const body = response.body as { data: ApprovalDto; meta: unknown };
    return {
      dto: approvalSchema.parse(body.data),
      meta: reassignApprovalLineMetaSchema.parse(body.meta),
    };
  };

  /** Etapa `APPROVAL` com política e linhas (US-132), gravadas como o WF-65 grava. */
  function withApprovers(
    key: StageKey,
    policy: ApprovalDecisionPolicy,
    lines: readonly LineSpec[],
  ) {
    const index = flow.stages.findIndex((stage) => stage.key === key);
    const stage = flow.stages[index];
    if (!stage) throw new Error(`etapa ${key} ausente`);
    const approvers: StageApproverLine[] = lines.map((line, position) => ({
      id: newId(),
      tenantId: A,
      workflowVersionId: FLOW_VERSION,
      workflowStageId: stage.id,
      sequence: position + 1,
      approverType: line.type,
      approverUserId: line.type === 'USER' ? line.userId : null,
      approverRoleId: line.type === 'ROLE' ? authorityRoleId : null,
      approverDepartmentResolution: null,
      approverFixedDepartmentId: null,
      allowDeputy: true,
      label: null,
      applicabilityRule: null,
      createdAt: NOW,
      updatedAt: NOW,
      createdById: null,
      updatedById: null,
      version: 1,
    }));
    flow.stages[index] = { ...stage, decisionPolicy: policy, approvers };
  }

  const transitionOf = (key: string): string => {
    const transition = flow.transitions.find((candidate) => candidate.key === key);
    if (!transition) throw new Error(`transição ${key} ausente`);
    return transition.id;
  };

  /** Processo criado pelo PRC-02 (Ana) e levado a MINUTA_EDITAL com Ana responsável. */
  async function processAtDraft(): Promise<Process> {
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
      exitedAt: new Date('2026-11-01T12:00:00.000Z'),
    });
    const draft = newId();
    repository().seedStage({
      id: draft,
      tenantId: A,
      processId: created.id,
      workflowStageId: flow.stageId('MINUTA_EDITAL'),
      sequence: 2,
      status: 'ACTIVE',
      departmentId: LICITACOES,
      assigneeId: ANA.id,
      enteredAt: new Date('2026-11-01T12:00:00.000Z'),
      dueAt: null,
      slaDays: 10,
      slaType: 'BUSINESS',
      enteredViaMovementId: null,
    });
    repository().seedAssignment({
      id: newId(),
      tenantId: A,
      processId: created.id,
      processStageId: draft,
      departmentId: LICITACOES,
      assigneeId: ANA.id,
      type: 'STAGE_ENTRY',
      assignedById: null,
      startedAt: new Date('2026-11-01T12:00:00.000Z'),
    });
    const process: Process = {
      ...created,
      workflowVersionId: FLOW_VERSION,
      status: 'IN_PROGRESS',
      currentStageId: draft,
      currentWorkflowStageId: flow.stageId('MINUTA_EDITAL'),
      currentDepartmentId: LICITACOES,
      currentResponsibleId: ANA.id,
      number: 12,
      code: '0012/2026',
      openedAt: created.createdAt,
      version: 9,
    };
    repository().seed(process, [
      { principalType: 'DEPARTMENT', departmentId: LICITACOES, reason: 'CURRENT' },
    ]);
    return process;
  }

  /** Encaminha (PRC-19, Ana) à etapa e devolve o processo, a aprovação aberta e o edital. */
  async function pendingApproval(stageKey: StageKey) {
    const process = await processAtDraft();
    const editalId = await seedPanelDocument(api, {
      tenantId: A,
      processId: process.id,
      typeCode: 'TR',
      code: 'ED 0003/2026',
      title: 'Edital do pregão',
      status: 'FINALIZED',
      versionNumber: 1,
      createdById: ANA.id,
    });
    const response = await auth(
      request(api.server).post(`/api/v1/processes/${process.id}/forward`),
      'sub-ana',
    )
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', `"${String(process.version)}"`)
      .send({
        expectedStageId: process.currentStageId,
        transitionId: transitionOf(`MINUTA_EDITAL_FORWARD_${stageKey}`),
      });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const approvalId = data<ForwardedProcessDto>(response).approval?.id ?? '';
    return { processId: process.id, approvalId, editalId };
  }

  /** Background: SEQUENTIAL com a linha 1 de Roberto APPROVED, a 2 de Marcos PENDING e a 3 WAITING. */
  async function background() {
    const opened = await pendingApproval('AUT_SEQUENCIAL');
    const voted = await post(
      'decide',
      opened.approvalId,
      { decision: 'APPROVE' },
      { subject: 'sub-marta', ifMatch: `"${String(lineAt(opened.approvalId, 1).version)}"` },
    );
    expect(voted.status, JSON.stringify(voted.body)).toBe(200);
    expect(linesOf(opened.approvalId).map((line) => [line.sequence, line.status])).toEqual([
      [1, 'APPROVED'],
      [2, 'PENDING'],
      [3, 'WAITING'],
    ]);
    return opened;
  }

  beforeAll(async () => {
    log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
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
      id: LICITACOES,
      name: 'Departamento de Licitações',
    });
    const roles = seedDefaultRolesOf(api, A);
    authorityRoleId = roles.get('AUTORIDADE_COMPETENTE')?.id ?? '';
    managerRoleId = roles.get('GESTOR_CONTRATACOES')?.id ?? '';
    const approvalStage = (name: string) => ({
      name,
      departmentResolution: 'REQUESTING_SECRETARIAT' as const,
      approverType: 'USER' as const,
      approverUserId: MARCOS.id,
      approvalDocumentTypeCodes: ['TR'],
      slaDays: 5,
    });
    const stages: readonly (readonly [StageKey, string])[] = [
      ['AUT_SEQUENCIAL', 'Autorização da licitação'],
      ['AUT_UNICA', 'Autorização de um aprovador'],
    ];
    flow = new DefinitionBuilder(FLOW_VERSION)
      .stage('ABERTURA', 'START', { name: 'Formalização da demanda', assignmentPolicy: 'CREATOR' })
      .stage('MINUTA_EDITAL', 'TASK', {
        name: 'Minuta do edital',
        departmentResolution: 'CHOSEN_ON_FORWARD',
        slaDays: 10,
      });
    for (const [key, name] of stages) flow.stage(key, 'APPROVAL', approvalStage(name));
    flow
      .stage('CONCLUSAO', 'END', {
        name: 'Fase preparatória concluída',
        departmentResolution: 'REQUESTING_DEPARTMENT',
        assignmentPolicy: 'UNASSIGNED',
      })
      .transition('ABERTURA', 'MINUTA_EDITAL', 'FORWARD', { isPrimary: true });
    for (const [key] of stages) {
      flow
        .transition('MINUTA_EDITAL', key, 'FORWARD')
        .transition(key, 'CONCLUSAO', 'APPROVE')
        .transition(key, 'MINUTA_EDITAL', 'RETURN')
        .transition(key, 'ABERTURA', 'REJECT');
    }
    withApprovers('AUT_SEQUENCIAL', 'SEQUENTIAL', [
      { type: 'USER', userId: ROBERTO.id },
      { type: 'USER', userId: MARCOS.id },
      { type: 'ROLE' },
    ]);
    withApprovers('AUT_UNICA', 'ANY', [{ type: 'USER', userId: MARCOS.id }]);
    await seedPublishedInMemory(api, A, flow, 'TESTE_US135');
    await deactivateWorkflow(api, A, 'TESTE_US135');
    assignDepartment(api, membershipOf(ANA.id), UNITS_A.manutencao);
    assignDepartment(api, membershipOf(ANA.id), LICITACOES);
    // Roberto e Marcos: AUTORIDADE_COMPETENTE (APPROVAL_DECIDE) no tenant — detentores da linha 3.
    for (const user of [ROBERTO, MARCOS]) {
      assignRole(api, {
        tenantId: A,
        membershipId: membershipOf(user.id),
        roleId: authorityRoleId,
      });
    }
    // A gestora: GESTOR_CONTRATACOES atribuído (detentora do perfil-alvo do redirecionamento FA-02).
    assignRole(api, { tenantId: A, membershipId: membershipOf(GESTORA.id), roleId: managerRoleId });
    // "Cléber"/"Bruno" (Otávio): APPROVAL_REASSIGN só sobre a Saúde; sem custódia nem PROCESS_ASSIGN.
    assignRole(api, {
      tenantId: A,
      membershipId: membershipOf(DIEGO.id),
      roleId: authorityRoleId,
      scopeType: 'DEPARTMENT',
      scopeDepartmentId: UNITS_A.saude,
    });
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await api.close();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    processTx.down = false;
    approvalTx.down = false;
    jobs().down = false;
  });

  describe('[Sucesso]', () => {
    it('Redirecionar a linha pendente preservando prazo, ordem e votos (APV-06)', async () => {
      const { processId, approvalId } = await background();
      const old = lineAt(approvalId, 2);
      const roberto = lineAt(approvalId, 1);
      const waiting = lineAt(approvalId, 3);
      const before = approvalOf(approvalId);
      expect(approverGrantsOf(processId, approvalId)).toContainEqual([MARCOS.id, old.id]);
      // APV-02: a gestora vê REASSIGN (por linha) e WITHDRAW (PROCESS_ASSIGN amplo — RN-APV-56).
      const { meta, dto: shown } = await detail(approvalId, 'sub-lucia');
      expect(meta.allowedActions).toEqual(expect.arrayContaining(['WITHDRAW', 'REASSIGN']));
      expect(shown.approvers.find((line) => line.id === old.id)?.version).toBe(old.version);
      log.mockClear();

      const response = await reassignLine(approvalId, old.id, toUser(DIEGO.id));

      const { dto, meta: result } = reassignedOf(response);
      expect(response.headers.etag).toBe(`"${String(before.version + 1)}"`);
      const created = lineAt(approvalId, 2);
      expect(result.newApproverId).toBe(created.id);
      // A linha 2 de Marcos fica CANCELED (REASSIGNED); nasce outra no mesmo sequence, mesmo prazo.
      expect(linesOf(approvalId).find((line) => line.id === old.id)).toMatchObject({
        status: 'CANCELED',
        skippedReason: 'REASSIGNED',
        approverUserId: MARCOS.id,
      });
      expect(created).toMatchObject({
        sequence: 2,
        status: 'PENDING',
        approverType: 'USER',
        approverUserId: DIEGO.id,
        reassignedFromId: old.id,
        activatedAt: old.activatedAt,
        dueAt: old.dueAt,
        createdById: GESTORA.id,
      });
      // FA-03: o voto de Roberto e a linha em espera não mudam.
      expect(lineAt(approvalId, 1)).toEqual(roberto);
      expect(lineAt(approvalId, 3)).toEqual(waiting);
      expect(
        dto.approvers.map((line) => [line.sequence, line.status, line.reassignedFromId]),
      ).toEqual([
        [1, 'APPROVED', null],
        [2, 'CANCELED', null],
        [2, 'PENDING', old.id],
        [3, 'WAITING', null],
      ]);
      // RN-TRAM-70: título, prazo, solicitante e política preservados; espelho na linha corrente.
      expect(approvalOf(approvalId)).toMatchObject({
        status: 'PENDING',
        title: before.title,
        dueAt: before.dueAt,
        requestedById: before.requestedById,
        decisionPolicy: 'SEQUENTIAL',
        approverUserId: DIEGO.id,
      });
      // RN-APV-54: Marcos perde o APPROVER e Diego ganha (pela linha nova).
      const grants = approverGrantsOf(processId, approvalId);
      expect(grants).toContainEqual([DIEGO.id, created.id]);
      expect(grants.some(([userId]) => userId === MARCOS.id)).toBe(false);
      // Auditoria, evento (com sequence) e timeline; o motivo nunca é gravado.
      expect(auditOf(processId, 'approval.reassign')).toEqual([
        expect.objectContaining({
          category: 'WORKFLOW',
          metadata: expect.objectContaining({
            approvalApproverId: created.id,
            fromApprovalApproverId: old.id,
            sequence: 2,
            decisionPolicy: 'SEQUENTIAL',
            hasReason: true,
          }) as unknown,
        }),
      ]);
      expect(eventsOf(processId, 'ApprovalReassigned').map((row) => row.payload)).toEqual([
        expect.objectContaining({
          approvalId,
          approvalApproverId: created.id,
          fromApprovalApproverId: old.id,
          sequence: 2,
          fromApproverUserId: MARCOS.id,
          toApproverUserId: DIEGO.id,
          hasReason: true,
        }),
      ]);
      expect(
        timelineRowsOf(api).filter(
          (row) => row.processId === processId && row.type === 'APPROVAL_REASSIGNED',
        ),
      ).toHaveLength(1);
      expect(JSON.stringify(api.outboxRows())).not.toContain(LEAVE);
      expect(JSON.stringify(api.auditRecords())).not.toContain(LEAVE);
      expect(JSON.stringify(log.mock.calls)).not.toContain(LEAVE);
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'approval.line_reassigned',
          approvalApproverId: created.id,
          sequence: 2,
          fromType: 'USER',
          toType: 'USER',
        }),
        'approval.line_reassigned',
      );
      // Nada muda no processo; e Diego decide a linha 2 (a 3 é ativada — US-134).
      expect(stored(processId).status).toBe('AWAITING_APPROVAL');
      const decided = await post(
        'decide',
        approvalId,
        { decision: 'APPROVE' },
        { subject: 'sub-otavio', ifMatch: '"1"' },
      );
      expect(decided.status, JSON.stringify(decided.body)).toBe(200);
      expect(lineAt(approvalId, 3).status).toBe('PENDING');
    });

    it('Redirecionar uma linha ainda em espera para um perfil (FA-02)', async () => {
      const { processId, approvalId } = await background();
      const old = lineAt(approvalId, 3);
      const requestedBefore = eventsOf(processId, 'ApprovalRequested').length;

      const response = await reassignLine(approvalId, old.id, {
        approverType: 'ROLE',
        targetApproverRoleId: managerRoleId,
        reason: 'Paula será substituída no rito',
      });

      reassignedOf(response);
      expect(lineAt(approvalId, 3)).toMatchObject({
        status: 'WAITING',
        activatedAt: null,
        approverType: 'ROLE',
        approverRoleId: managerRoleId,
        reassignedFromId: old.id,
      });
      expect(linesOf(approvalId).find((line) => line.id === old.id)).toMatchObject({
        status: 'CANCELED',
        skippedReason: 'REASSIGNED',
      });
      // A nova aprovadora só recebe a pendência quando a linha for ativada (US-134).
      expect(eventsOf(processId, 'ApprovalRequested')).toHaveLength(requestedBefore);
      expect(eventsOf(processId, 'ApprovalApproverActivated')).toHaveLength(1);
      expect(approvalOf(approvalId).approverUserId).toBe(MARCOS.id);
    });

    it('Retirar a aprovação inteira com voto favorável já dado (gestora com PROCESS_ASSIGN)', async () => {
      const { processId, approvalId, editalId } = await background();
      const roberto = lineAt(approvalId, 1);
      const [two, three] = [lineAt(approvalId, 2), lineAt(approvalId, 3)];
      log.mockClear();

      const response = await withdraw(approvalId, { reason: WITHDRAW_REASON });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const dto = withdrawnApprovalSchema.parse(data(response));
      expect(dto).toMatchObject({ status: 'CANCELED', processStatus: 'RETURNED' });
      expect(approvalOf(approvalId)).toMatchObject({
        status: 'CANCELED',
        cancellationReason: 'WITHDRAWN',
        canceledById: GESTORA.id,
      });
      // RN-APV-57: o voto de Roberto fica; as linhas 2 e 3 viram CANCELED (WITHDRAWN).
      expect(lineAt(approvalId, 1)).toEqual(roberto);
      expect(
        linesOf(approvalId)
          .filter((line) => line.sequence > 1)
          .map((line) => [line.sequence, line.status, line.skippedReason]),
      ).toEqual([
        [2, 'CANCELED', 'WITHDRAWN'],
        [3, 'CANCELED', 'WITHDRAWN'],
      ]);
      // Documento e processo: DEC-018 e a etapa de origem com Ana responsável.
      expect(documentsOf(processId).find((document) => document.id === editalId)).toMatchObject({
        pendingApprovalId: null,
      });
      const process = stored(processId);
      expect(process).toMatchObject({ status: 'RETURNED', currentResponsibleId: ANA.id });
      expect(process.currentWorkflowStageId).toBe(flow.stageId('MINUTA_EDITAL'));
      expect(repository().movementsOf(processId).at(-1)).toMatchObject({
        action: 'RETURN',
        comment: WITHDRAW_REASON,
      });
      // Auditoria e eventos; os aprovadores das linhas canceladas perdem o APPROVER.
      expect(auditOf(processId, 'approval.withdraw')).toEqual([
        expect.objectContaining({
          metadata: expect.objectContaining({
            actorRole: 'MANAGER',
            decisionPolicy: 'SEQUENTIAL',
            linesCanceled: 2,
            votesKept: 1,
            hasReason: true,
          }) as unknown,
        }),
      ]);
      expect(eventsOf(processId, 'ApprovalCanceled').map((row) => row.payload)).toEqual([
        { approvalId, reason: 'WITHDRAWN', approvalApproverIds: [two.id, three.id] },
      ]);
      expect(eventsOf(processId, 'ProcessStageChanged').at(-1)?.payload).toMatchObject({
        cause: 'RETURN',
        approvalId,
      });
      const grants = approverGrantsOf(processId, approvalId);
      expect(grants.some(([userId]) => userId === MARCOS.id)).toBe(false);
      expect(grants).toContainEqual([ROBERTO.id, roberto.id]);
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'approval.withdrawn',
          actorRole: 'MANAGER',
          linesCanceled: 2,
          votesKept: 1,
        }),
        'approval.withdrawn',
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain(WITHDRAW_REASON);
    });

    it('Quem encaminhou também retira, sem PROCESS_ASSIGN (REQUESTER)', async () => {
      const { processId, approvalId } = await background();

      const response = await withdraw(approvalId, {}, { subject: 'sub-ana' });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(approvalOf(approvalId).status).toBe('CANCELED');
      expect(stored(processId)).toMatchObject({ status: 'RETURNED', currentResponsibleId: ANA.id });
      expect(auditOf(processId, 'approval.withdraw')[0]?.metadata).toMatchObject({
        actorRole: 'REQUESTER',
      });
    });

    it('FA-01: APV-05 numa aprovação de uma linha cancela e recria a linha; com várias linhas, 422 APPROVAL_LINE_REQUIRED', async () => {
      const single = await pendingApproval('AUT_UNICA');
      const [original] = linesOf(single.approvalId);

      const response = await reassignSingle(single.approvalId, toUser(DIEGO.id));

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(
        linesOf(single.approvalId).map((line) => [
          line.status,
          line.approverUserId,
          line.reassignedFromId,
        ]),
      ).toEqual([
        ['CANCELED', MARCOS.id, null],
        ['PENDING', DIEGO.id, original?.id],
      ]);
      // MVP 1: segue valendo um novo redirecionamento da (nova) linha única.
      const again = await reassignSingle(single.approvalId, toUser(MARCOS.id));
      expect(again.status, JSON.stringify(again.body)).toBe(200);

      const { processId, approvalId } = await background();
      const before = effects(processId, approvalId);
      const multi = await reassignSingle(approvalId, toUser(DIEGO.id));
      expect(expectProblem(multi, 422, 'APPROVAL_LINE_REQUIRED').detail).toBe(
        'Esta aprovação tem vários aprovadores. Redirecione a linha desejada.',
      );
      expect(effects(processId, approvalId)).toEqual(before);
    });
  });

  describe('[Validação]', () => {
    it('Motivo curto, aprovador igual e linha já decidida', async () => {
      const { processId, approvalId } = await background();
      const before = effects(processId, approvalId);

      const short = await reassignLine(approvalId, lineAt(approvalId, 2).id, {
        approverType: 'USER',
        targetApproverUserId: DIEGO.id,
      });
      const body = expectProblem(short, 422, 'VALIDATION_ERROR');
      expect(body.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: 'reason' })]),
      );
      const tooShort = await reassignLine(
        approvalId,
        lineAt(approvalId, 2).id,
        toUser(DIEGO.id, 'licença'),
      );
      expect(expectProblem(tooShort, 422, 'VALIDATION_ERROR').errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: 'reason', code: 'TOO_SHORT' })]),
      );

      const same = await reassignLine(approvalId, lineAt(approvalId, 2).id, toUser(MARCOS.id));
      expectProblem(same, 422, 'APPROVER_NOT_ELIGIBLE');

      const decided = await reassignLine(approvalId, lineAt(approvalId, 1).id, toUser(DIEGO.id));
      expect(expectProblem(decided, 409, 'APPROVAL_LINE_NOT_PENDING')).toMatchObject({
        meta: { approvalApproverId: lineAt(approvalId, 1).id, lineStatus: 'APPROVED' },
      });
      expect(lineAt(approvalId, 1).decision).toBe('APPROVE');
      expect(effects(processId, approvalId)).toEqual(before);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'approval.reassign_rejected',
          reason: 'LINE_NOT_PENDING',
        }),
        'approval.reassign_rejected',
      );
    });

    it('Novo aprovador autor do documento (403 SELF_APPROVAL_FORBIDDEN) ou já presente em outra linha (422 APPROVER_DUPLICATED)', async () => {
      const { processId, approvalId } = await background();
      const before = effects(processId, approvalId);

      const author = await reassignLine(approvalId, lineAt(approvalId, 2).id, toUser(ANA.id));
      expectProblem(author, 403, 'SELF_APPROVAL_FORBIDDEN');
      expect(deniedOf(approvalId)).toEqual([
        expect.objectContaining({
          reasonCode: 'APPROVAL_REASSIGN',
          metadata: expect.objectContaining({
            approvalApproverId: lineAt(approvalId, 2).id,
          }) as unknown,
        }),
      ]);

      const roberto = await reassignLine(approvalId, lineAt(approvalId, 2).id, toUser(ROBERTO.id));
      expect(expectProblem(roberto, 422, 'APPROVER_DUPLICATED')).toMatchObject({
        detail: 'Esta pessoa já participa desta aprovação em outra linha.',
        meta: { sequences: [1, 2] },
      });
      expect(effects(processId, approvalId)).toEqual(before);
    });

    it('V-10: motivo da retirada acima de 2.000 caracteres → 422 TOO_LONG', async () => {
      const { approvalId } = await background();
      const response = await withdraw(approvalId, { reason: 'x'.repeat(2001) });
      expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(approvalOf(approvalId).status).toBe('PENDING');
    });

    it('V-11: If-Match divergente (412) e ausente (428)', async () => {
      const { approvalId } = await background();
      const line = lineAt(approvalId, 2);
      const stale = await reassignLine(approvalId, line.id, toUser(DIEGO.id), { ifMatch: '"9"' });
      expect(expectProblem(stale, 412, 'VERSION_CONFLICT')).toMatchObject({
        currentVersion: line.version,
        sentVersion: 9,
      });
      const missing = await auth(
        request(api.server).post(`/api/v1/approvals/${approvalId}/approvers/${line.id}/reassign`),
        'sub-lucia',
      )
        .set('Idempotency-Key', randomUUID())
        .send(toUser(DIEGO.id));
      expectProblem(missing, 428, 'PRECONDITION_REQUIRED');
      // APV-04 usa a ETag da aprovação: a versão de antes do voto de Roberto já não vale.
      const outdated = await withdraw(approvalId, {}, { ifMatch: '"1"' });
      expectProblem(outdated, 412, 'VERSION_CONFLICT');
    });
  });

  describe('[Permissão]', () => {
    it('Sem custódia nem PROCESS_ASSIGN: retirar = 403 PERMISSION_DENIED com access.denied; APV-02 sem WITHDRAW', async () => {
      const { approvalId } = await background();

      const response = await withdraw(approvalId, {}, { subject: 'sub-otavio' });

      expectProblem(response, 403, 'PERMISSION_DENIED');
      expect(deniedOf(approvalId)).toEqual([
        expect.objectContaining({ reasonCode: 'APPROVAL_WITHDRAW', entityType: 'Approval' }),
      ]);
      expect(approvalOf(approvalId).status).toBe('PENDING');
    });

    it('APPROVAL_REASSIGN só para outra secretaria: redirecionar = 403 PERMISSION_DENIED; sem a permissão, 403 no guard', async () => {
      const { processId, approvalId } = await background();
      const before = effects(processId, approvalId);

      const scoped = await reassignLine(approvalId, lineAt(approvalId, 2).id, toUser(DIEGO.id), {
        subject: 'sub-otavio',
      });
      expectProblem(scoped, 403, 'PERMISSION_DENIED');
      const none = await reassignLine(approvalId, lineAt(approvalId, 2).id, toUser(DIEGO.id), {
        subject: 'sub-ana',
      });
      expectProblem(none, 403, 'PERMISSION_DENIED');
      expect(
        api
          .auditRecords()
          .filter(
            (row) => row.action === 'access.denied' && row.reasonCode === 'APPROVAL_REASSIGN',
          ),
      ).not.toHaveLength(0);
      expect(effects(processId, approvalId)).toEqual(before);
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Aprovação de outro tenant (404) e novo aprovador de outro tenant (422), sem revelar dados', async () => {
      const { processId, approvalId } = await background();
      const before = effects(processId, approvalId);
      const line = lineAt(approvalId, 2);

      const foreign = await reassignLine(approvalId, line.id, toUser(DIEGO.id), {
        subject: 'sub-heitor',
        tenant: B,
      });
      const body = expectProblem(foreign, 404, 'APPROVAL_NOT_FOUND');
      expect(JSON.stringify(body)).not.toContain('0012/2026');

      const outsider = await reassignLine(approvalId, line.id, toUser(FAKE_USERS.heitor.id));
      expectProblem(outsider, 422, 'APPROVER_NOT_ELIGIBLE');
      // Linha de outra aprovação: 404 (nada revela da outra).
      const other = await pendingApproval('AUT_UNICA');
      const [otherLine] = linesOf(other.approvalId);
      const mismatched = await reassignLine(approvalId, otherLine?.id ?? '', toUser(DIEGO.id), {
        ifMatch: '"1"',
      });
      expectProblem(mismatched, 404, 'APPROVAL_NOT_FOUND');
      expect(effects(processId, approvalId)).toEqual(before);
    });
  });

  describe('[Duplicidade]', () => {
    it('Reenvio do redirecionamento com a mesma chave: 200 Idempotent-Replayed, uma linha nova e um evento; segunda retirada = 409', async () => {
      const { processId, approvalId } = await background();
      const line = lineAt(approvalId, 2);
      const key = randomUUID();

      const first = await reassignLine(approvalId, line.id, toUser(DIEGO.id), {
        key,
        ifMatch: `"${String(line.version)}"`,
      });
      const replay = await reassignLine(approvalId, line.id, toUser(DIEGO.id), {
        key,
        ifMatch: `"${String(line.version)}"`,
      });

      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(replay.status).toBe(200);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toEqual(first.body);
      expect(linesOf(approvalId).filter((candidate) => candidate.sequence === 2)).toHaveLength(2);
      expect(eventsOf(processId, 'ApprovalReassigned')).toHaveLength(1);

      expect((await withdraw(approvalId, {}, { subject: 'sub-ana' })).status).toBe(200);
      const again = await withdraw(approvalId, {}, { subject: 'sub-ana', ifMatch: '"1"' });
      expectProblem(again, 409, 'APPROVAL_NOT_PENDING');
    });
  });

  describe('[Concorrência]', () => {
    it('Decisão do aprovador e redirecionamento da mesma linha ao mesmo tempo: só o primeiro vale; o outro 409 APPROVAL_LINE_NOT_PENDING', async () => {
      for (const decisionFirst of [true, false]) {
        const { approvalId } = await background();
        const line = lineAt(approvalId, 2);
        const voteCall = () =>
          post(
            'decide',
            approvalId,
            { decision: 'APPROVE', approvalApproverId: line.id },
            { subject: 'sub-fabio', ifMatch: `"${String(line.version)}"` },
          );
        const reassignCall = () =>
          reassignLine(approvalId, line.id, toUser(DIEGO.id), {
            ifMatch: `"${String(line.version)}"`,
          });

        const [vote, reassign] = decisionFirst
          ? await Promise.all([voteCall(), reassignCall()])
          : await Promise.all([reassignCall(), voteCall()]).then(([r, v]) => [v, r] as const);

        const winner = decisionFirst ? vote : reassign;
        const loser = decisionFirst ? reassign : vote;
        expect(winner.status, JSON.stringify(winner.body)).toBe(200);
        expectProblem(loser, 409, 'APPROVAL_LINE_NOT_PENDING');
        const live = linesOf(approvalId).filter(
          (candidate) => candidate.sequence === 2 && candidate.status !== 'CANCELED',
        );
        expect(live).toHaveLength(1);
        expect(live[0]?.approverUserId).toBe(decisionFirst ? MARCOS.id : DIEGO.id);
      }
    });

    it('Retirada simultânea a um voto (FA-09): vale o primeiro; o outro 409 APPROVAL_NOT_PENDING', async () => {
      const { approvalId } = await background();
      const line = lineAt(approvalId, 2);
      const version = approvalOf(approvalId).version;

      const [withdrawn, vote] = await Promise.all([
        withdraw(approvalId, {}, { ifMatch: `"${String(version)}"` }),
        post(
          'decide',
          approvalId,
          { decision: 'APPROVE', approvalApproverId: line.id },
          { subject: 'sub-fabio', ifMatch: `"${String(line.version)}"` },
        ),
      ]);

      expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200);
      expectProblem(vote, 409, 'APPROVAL_NOT_PENDING');
      expect(lineAt(approvalId, 1).status).toBe('APPROVED');
    });

    it('Dois redirecionamentos simultâneos da mesma linha: um efetiva, o outro 409 APPROVAL_LINE_NOT_PENDING', async () => {
      const { approvalId } = await background();
      const line = lineAt(approvalId, 2);
      const ifMatch = `"${String(line.version)}"`;

      const responses = await Promise.all([
        reassignLine(approvalId, line.id, toUser(DIEGO.id), { ifMatch }),
        reassignLine(approvalId, line.id, toUser(GESTORA.id), { ifMatch }),
      ]);

      expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
      const loser = responses.find((response) => response.status === 409);
      if (loser) expectProblem(loser, 409, 'APPROVAL_LINE_NOT_PENDING');
      expect(linesOf(approvalId).filter((candidate) => candidate.sequence === 2)).toHaveLength(2);
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível ao redirecionar: 503 DEPENDENCY_UNAVAILABLE e a linha 2 continua PENDING', async () => {
      const { processId, approvalId } = await background();
      const before = effects(processId, approvalId);
      approvalTx.down = true;

      const response = await reassignLine(approvalId, lineAt(approvalId, 2).id, toUser(DIEGO.id));

      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      approvalTx.down = false;
      expect(effects(processId, approvalId)).toEqual(before);
      expect(lineAt(approvalId, 2)).toMatchObject({ status: 'PENDING', approverUserId: MARCOS.id });
    });
  });

  describe('[Falha de integração]', () => {
    it('Fila indisponível ao redirecionar: 200 e o ApprovalReassigned gravado no outbox para o relay', async () => {
      const { processId, approvalId } = await background();
      jobs().down = true;

      const response = await reassignLine(approvalId, lineAt(approvalId, 2).id, toUser(DIEGO.id));

      reassignedOf(response);
      expect(lineAt(approvalId, 2).approverUserId).toBe(DIEGO.id);
      // O relay é assíncrono: o evento fica no outbox (no PostgreSQL, `PENDING`) — uma vez.
      expect(eventsOf(processId, 'ApprovalReassigned')).toHaveLength(1);
    });
  });
});
