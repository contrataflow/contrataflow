import { randomUUID } from 'node:crypto';

import {
  approvalLinesResponseSchema,
  approvalMetaSchema,
  approvalSchema,
  problemDetailsSchema,
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

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import {
  APPROVAL_CLOCK,
  APPROVAL_TRANSACTIONS,
} from '../../../../test/support/approval-fixtures.js';
import type { ApprovalTransactions } from '../../../../test/support/approval-fixtures.js';
import { approvalRepositoryOf } from '../../../../test/support/document-fixtures.js';
import {
  CATALOG_CLOCK,
  catalogItemId,
  processRepositoryOf,
  runTenantSeeders,
  seedProcessStructure,
} from '../../../../test/support/process-fixtures.js';
import { deactivateWorkflow } from '../../../../test/support/process-forward-fixtures.js';
import { seedPanelDocument } from '../../../../test/support/process-panel-fixtures.js';
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
 * US-136 — aprovação múltipla no detalhe (APV-02) e no histórico de linhas (APV-31), pelo pipeline
 * HTTP completo (identidade fake, seeders reais, repositórios em memória), com as linhas criadas
 * pelos comandos reais da US-133/134/135. Background: Ana encaminha (PRC-19) o processo "0012/2026"
 * à etapa de aprovação; "Marcos Lima" = Marta (linha 1, USER), "Paula Reis" = Fábio (linha 2,
 * USER), ambos AUTORIDADE_COMPETENTE; Lúcia é a gestora (GESTOR_CONTRATACOES — APPROVAL_REASSIGN);
 * "Bruno" = Otávio com um perfil só de consulta de processos (sem APPROVAL_VIEW e sem linha);
 * Heitor é a Prefeitura B. A caixa (TSK-01/02) e a lista (APV-01) leem views publicadas: o SQL está
 * em `test/tenant-leak/approval-lines-views.spec.ts` e as rotas em `tasks.routes.spec.ts` e
 * `approvals.routes.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-11-12T15:00:00.000Z');
const RETURN_COMMENT = 'Rever a planilha de custos do edital';

const ORG_A = '0192d136-0000-7000-8000-0000000000a0';
const ORG_B = '0192d136-0000-7000-8000-0000000000b0';
const UNITS_A = {
  organizationId: ORG_A,
  obras: '0192d136-0000-7000-8000-0000000000a1',
  manutencao: '0192d136-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d136-0000-7000-8000-0000000000a3',
  saude: '0192d136-0000-7000-8000-0000000000a4',
  posto: '0192d136-0000-7000-8000-0000000000a5',
};
const UNITS_B = {
  organizationId: ORG_B,
  obras: '0192d136-0000-7000-8000-0000000000b1',
  manutencao: '0192d136-0000-7000-8000-0000000000b2',
  pavimentacao: '0192d136-0000-7000-8000-0000000000b3',
  saude: '0192d136-0000-7000-8000-0000000000b4',
  posto: '0192d136-0000-7000-8000-0000000000b5',
};
const LICITACOES = '0192d136-0000-7000-8000-0000000000a7';
const FLOW_VERSION = '0192d136-0000-7000-8000-0000000000f1';

const MARCOS_LIMA = FAKE_USERS.marta;
const PAULA_REIS = FAKE_USERS.fabio;
const BRUNO = FAKE_USERS.otavio;
const GESTORA = FAKE_USERS.lucia;
const ANA = FAKE_USERS.ana;

const membershipOf = (userId: string, tenantId: string = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

/** Transações em fila (corridas serializadas) e banco fora. */
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

type StageKey = 'AUT_CONJUNTA' | 'AUT_SEQUENCIAL' | 'AUT_PERFIL' | 'AUT_UNICA';

describe('Feature: Aprovação múltipla na caixa de tarefas, na lista e no detalhe (US-136)', () => {
  let api: TestApi;
  let flow: DefinitionBuilder;
  let authorityRoleId: string;
  let log: MockInstance<Logger['log']>;
  const processTx = new FlakyTransactions();
  const approvalTx = new FlakyTransactions();
  const words = (count: number) =>
    Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

  const auth = (call: request.Test, subject: string, tenant: string = A) =>
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
  const linesOf = (approvalId: string) => approvalRepositoryOf(api).linesOf(approvalId);
  const lineAt = (approvalId: string, sequence: number) => {
    const line = linesOf(approvalId).find(
      (candidate) => candidate.sequence === sequence && candidate.status !== 'CANCELED',
    );
    if (!line) throw new Error(`linha ${String(sequence)} ausente`);
    return line;
  };
  /** O que uma leitura não pode produzir: eventos e auditoria. */
  const sideEffects = () => ({
    events: api.outboxRows().length,
    audits: api.auditRecords().length,
  });
  const deniedOf = (approvalId: string) =>
    api
      .auditRecords()
      .filter((row) => row.action === 'access.denied' && row.entityId === approvalId);

  const getApproval = (id: string, subject: string, tenant: string = A) =>
    auth(request(api.server).get(`/api/v1/approvals/${id}`), subject, tenant);
  async function detail(id: string, subject: string) {
    const response = await getApproval(id, subject);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const body = response.body as { data: ApprovalDto; meta: ApprovalMeta };
    return { dto: approvalSchema.parse(body.data), meta: approvalMetaSchema.parse(body.meta) };
  }
  const getLines = (id: string, subject: string, query = '', tenant: string = A) =>
    auth(request(api.server).get(`/api/v1/approvals/${id}/approvers${query}`), subject, tenant);
  async function history(id: string, subject: string, query = '') {
    const response = await getLines(id, subject, query);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    return approvalLinesResponseSchema.parse(response.body);
  }
  /** APV-03 com o `If-Match` da linha (ALL/SEQUENTIAL — `meta.myLine.etag`). */
  const vote = (
    approvalId: string,
    subject: string,
    sequence: number,
    body: Record<string, unknown>,
  ) =>
    auth(request(api.server).post(`/api/v1/approvals/${approvalId}/decide`), subject)
      .set('Idempotency-Key', randomUUID())
      .set('If-Match', `"${String(lineAt(approvalId, sequence).version)}"`)
      .send(body);

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

  /** Encaminha (PRC-19, Ana) à etapa; o edital coberto é de `authorId`. */
  async function pendingApproval(stageKey: StageKey, authorId: string = ANA.id) {
    const process = await processAtDraft();
    await seedPanelDocument(api, {
      tenantId: A,
      processId: process.id,
      typeCode: 'TR',
      code: 'ED 0003/2026',
      title: 'Edital do pregão',
      status: 'FINALIZED',
      versionNumber: 1,
      createdById: authorId,
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
    return { processId: process.id, approvalId };
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
      id: LICITACOES,
      name: 'Departamento de Licitações',
    });
    const roles = seedDefaultRolesOf(api, A);
    authorityRoleId = roles.get('AUTORIDADE_COMPETENTE')?.id ?? '';
    const approvalStage = (name: string) => ({
      name,
      departmentResolution: 'REQUESTING_SECRETARIAT' as const,
      approverType: 'USER' as const,
      approverUserId: PAULA_REIS.id,
      approvalDocumentTypeCodes: ['TR'],
      slaDays: 5,
    });
    const stages: readonly (readonly [StageKey, string])[] = [
      ['AUT_CONJUNTA', 'Aprovação da demanda'],
      ['AUT_SEQUENCIAL', 'Aprovação em sequência'],
      ['AUT_PERFIL', 'Aprovação com perfil'],
      ['AUT_UNICA', 'Aprovação de um aprovador'],
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
    const marcos = { type: 'USER', userId: MARCOS_LIMA.id } as const;
    const paula = { type: 'USER', userId: PAULA_REIS.id } as const;
    withApprovers('AUT_CONJUNTA', 'ALL', [marcos, paula]);
    withApprovers('AUT_SEQUENCIAL', 'SEQUENTIAL', [marcos, paula]);
    withApprovers('AUT_PERFIL', 'ALL', [paula, { type: 'ROLE' }]);
    withApprovers('AUT_UNICA', 'ANY', [paula]);
    await seedPublishedInMemory(api, A, flow, 'TESTE_US136');
    await deactivateWorkflow(api, A, 'TESTE_US136');
    assignDepartment(api, membershipOf(ANA.id), UNITS_A.manutencao);
    assignDepartment(api, membershipOf(ANA.id), LICITACOES);
    for (const user of [MARCOS_LIMA, PAULA_REIS]) {
      assignRole(api, {
        tenantId: A,
        membershipId: membershipOf(user.id),
        roleId: authorityRoleId,
      });
    }
    // "Bruno": vê processos, mas não tem APPROVAL_VIEW nem linha.
    const viewOnly = seedCustomRole(api, A, 'Somente processos', ['PROCESS_VIEW']);
    assignRole(api, { tenantId: A, membershipId: membershipOf(BRUNO.id), roleId: viewOnly.id });
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await api.close();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    processTx.down = false;
    approvalTx.down = false;
  });

  describe('[Sucesso]', () => {
    it('Detalhe da aprovação mostra linhas, votos e ações da minha linha (ALL)', async () => {
      const { approvalId } = await pendingApproval('AUT_CONJUNTA');
      expect((await vote(approvalId, 'sub-marta', 1, { decision: 'APPROVE' })).status).toBe(200);
      const before = sideEffects();

      const { dto, meta } = await detail(approvalId, 'sub-fabio');

      expect(dto.decisionPolicy).toBe('ALL');
      expect(dto.approvers.map((line) => [line.sequence, line.status])).toEqual([
        [1, 'APPROVED'],
        [2, 'PENDING'],
      ]);
      expect(dto.approvers[0]?.decidedBy).toEqual({ id: MARCOS_LIMA.id, name: MARCOS_LIMA.name });
      expect(dto.progress).toEqual({
        totalLines: 2,
        approvedLines: 1,
        pendingLines: 1,
        waitingLines: 0,
        label: '1 de 2 aprovaram',
      });
      const line2 = lineAt(approvalId, 2).id;
      expect(meta.myApproverLineId).toBe(line2);
      expect(meta.allowedActions).toContain('DECIDE');
      expect(meta.lineActions).toEqual([
        { approvalApproverId: lineAt(approvalId, 1).id, actions: [] },
        // A autoridade competente também redireciona (APPROVAL_REASSIGN — US-135).
        { approvalApproverId: line2, actions: ['DECIDE', 'REASSIGN'] },
      ]);
      expect(meta.waitingFor).toBeNull();
      // Marcos já votou: a linha dele está decidida e o detalhe explica (US-134).
      const marcos = await detail(approvalId, 'sub-marta');
      expect(marcos.meta.decisionBlocker).toBe('ALREADY_VOTED');
      expect(marcos.meta.allowedActions).not.toContain('DECIDE');
      // Leituras não geram auditoria nem evento.
      expect(sideEffects()).toEqual(before);
    });

    it('SEQUENTIAL: a linha em espera explica de quem é a vez e o andamento traz a etapa', async () => {
      const { approvalId } = await pendingApproval('AUT_SEQUENCIAL');

      const { dto, meta } = await detail(approvalId, 'sub-fabio');

      expect(meta.decisionBlocker).toBe('NOT_DESIGNATED_APPROVER');
      expect(meta.myLine).toMatchObject({ sequence: 2, status: 'WAITING' });
      expect(meta.waitingFor).toEqual({ sequence: 1, label: dto.approvers[0]?.label });
      expect(dto.approvers[0]?.label).toContain('Marta');
      expect(meta.lineActions?.every((line) => !line.actions.includes('DECIDE'))).toBe(true);
      expect(dto.progress?.label).toBe(`Etapa 1 de 2 — ${dto.approvers[0]?.label ?? ''}`);

      expect((await vote(approvalId, 'sub-marta', 1, { decision: 'APPROVE' })).status).toBe(200);
      const after = await detail(approvalId, 'sub-fabio');
      expect(after.meta.decisionBlocker).toBeNull();
      const paulaLabel = after.dto.approvers[1]?.label ?? '';
      expect(after.meta.waitingFor).toEqual({ sequence: 2, label: paulaLabel });
      expect(after.dto.progress?.label).toBe(`Etapa 2 de 2 — ${paulaLabel}`);
    });

    it('Histórico de linhas inclui a linha substituída por redirecionamento (APV-31)', async () => {
      const { approvalId } = await pendingApproval('AUT_CONJUNTA');
      const old = lineAt(approvalId, 2);
      const reassigned = await auth(
        request(api.server).post(`/api/v1/approvals/${approvalId}/approvers/${old.id}/reassign`),
        'sub-lucia',
      )
        .set('Idempotency-Key', randomUUID())
        .set('If-Match', `"${String(old.version)}"`)
        .send({
          approverType: 'USER',
          targetApproverUserId: GESTORA.id,
          reason: 'Paula está de licença médica',
        });
      expect(reassigned.status, JSON.stringify(reassigned.body)).toBe(200);
      const before = sideEffects();
      log.mockClear();

      const body = await history(approvalId, 'sub-ana');

      expect(body.data.map((line) => [line.sequence, line.status])).toEqual([
        [1, 'PENDING'],
        [2, 'CANCELED'],
        [2, 'PENDING'],
      ]);
      expect(body.data[1]).toMatchObject({ id: old.id, skippedReason: 'REASSIGNED' });
      expect(body.data[2]).toMatchObject({ reassignedFromId: old.id, sequence: 2 });
      expect(body.meta).toEqual({
        decisionPolicy: 'ALL',
        totalLines: 2,
        approvalStatus: 'PENDING',
      });
      // APV-02: só a composição vigente (RN-APV-68).
      const { dto } = await detail(approvalId, 'sub-ana');
      expect(dto.approvers).toHaveLength(2);
      expect(dto.approvers.some((line) => line.status === 'CANCELED')).toBe(false);
      // `includeHistory=false` omite as substituídas.
      expect((await history(approvalId, 'sub-ana', '?includeHistory=false')).data).toHaveLength(2);
      // Log sem nomes nem rótulos; nada gravado.
      const logged = log.mock.calls.find((call) => call[1] === 'approvals.lines_query');
      expect(logged?.[0]).toMatchObject({ approvalId, includeHistory: true, linesCount: 3 });
      expect(JSON.stringify(logged)).not.toContain('Paula está de licença');
      expect(sideEffects()).toEqual(before);
    });

    it('Aprovação de uma linha (ANY) continua como no MVP 1: sem texto de andamento', async () => {
      const { approvalId } = await pendingApproval('AUT_UNICA');
      const { dto, meta } = await detail(approvalId, 'sub-fabio');
      expect(dto.decisionPolicy).toBe('ANY');
      expect(dto.approvers).toHaveLength(1);
      expect(dto.progress).toEqual({
        totalLines: 1,
        approvedLines: 0,
        pendingLines: 1,
        waitingLines: 0,
      });
      expect(meta.allowedActions).toContain('DECIDE');
      expect(meta.waitingFor).toBeNull();
      expect(meta.myApproverLineId).toBe(lineAt(approvalId, 1).id);
    });
  });

  describe('[Validação]', () => {
    it('includeHistory fora de true/false → 422 VALIDATION_ERROR no campo', async () => {
      const { approvalId } = await pendingApproval('AUT_CONJUNTA');
      const response = await getLines(approvalId, 'sub-ana', '?includeHistory=talvez');
      const body = expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(body.errors[0]).toMatchObject({ field: 'includeHistory', code: 'INVALID_FORMAT' });
    });
  });

  describe('[Permissão]', () => {
    it('Sem linha, sem APPROVAL_VIEW e sem ser solicitante: 403 com access.denied (APV-02 e APV-31)', async () => {
      const { approvalId } = await pendingApproval('AUT_CONJUNTA');
      expectProblem(await getApproval(approvalId, 'sub-otavio'), 403, 'PERMISSION_DENIED');
      expectProblem(await getLines(approvalId, 'sub-otavio'), 403, 'PERMISSION_DENIED');
      expect(deniedOf(approvalId)).toEqual([
        expect.objectContaining({
          reasonCode: 'APPROVAL_VIEW',
          metadata: expect.objectContaining({ approvalId }) as unknown,
        }),
        expect.objectContaining({ reasonCode: 'APPROVAL_VIEW' }),
      ]);
    });

    it('Autor de documento coberto não pode aprovar a própria linha (SELF_APPROVAL_FORBIDDEN)', async () => {
      // Linha 2 por perfil: Marcos é detentor e autor do edital (outros detentores existem).
      const { approvalId } = await pendingApproval('AUT_PERFIL', MARCOS_LIMA.id);
      const { meta } = await detail(approvalId, 'sub-marta');
      expect(meta.decisionBlocker).toBe('SELF_APPROVAL_FORBIDDEN');
      expect(meta.allowedActions).not.toContain('DECIDE');
      expect(meta.myApproverLineId).toBe(lineAt(approvalId, 2).id);
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Aprovação de outro tenant: 404 APPROVAL_NOT_FOUND no detalhe e no histórico', async () => {
      const { approvalId } = await pendingApproval('AUT_CONJUNTA');
      expectProblem(await getApproval(approvalId, 'sub-heitor', B), 404, 'APPROVAL_NOT_FOUND');
      expectProblem(await getLines(approvalId, 'sub-heitor', '', B), 404, 'APPROVAL_NOT_FOUND');
    });
  });

  describe('[Duplicidade]', () => {
    it('Pessoa em duas linhas da mesma aprovação: as duas decidíveis, uma ação por linha', async () => {
      // Paula é a linha 1 (USER) e detentora do perfil da linha 2.
      const { approvalId } = await pendingApproval('AUT_PERFIL');
      const { meta } = await detail(approvalId, 'sub-fabio');
      const ids = [lineAt(approvalId, 1).id, lineAt(approvalId, 2).id];
      expect(meta.decidableLineIds).toEqual(ids);
      expect(meta.myApproverLineId).toBe(ids[0]);
      expect(meta.lineActions).toEqual(
        ids.map((id) => ({ approvalApproverId: id, actions: ['DECIDE', 'REASSIGN'] })),
      );
    });
  });

  describe('[Concorrência]', () => {
    it('Aprovação encerrada por outro aprovador com a tela aberta: revalidação mostra o encerramento', async () => {
      const { approvalId } = await pendingApproval('AUT_CONJUNTA');
      const open = await detail(approvalId, 'sub-fabio');
      expect(open.meta.allowedActions).toContain('DECIDE');

      const returned = await vote(approvalId, 'sub-marta', 1, {
        decision: 'RETURN',
        comment: RETURN_COMMENT,
        transitionId: transitionOf('AUT_CONJUNTA_RETURN_MINUTA_EDITAL'),
      });
      expect(returned.status, JSON.stringify(returned.body)).toBe(200);

      const { dto, meta } = await detail(approvalId, 'sub-fabio');
      expect(dto.status).toBe('RETURNED');
      expect(dto.approvers[1]).toMatchObject({
        status: 'SKIPPED',
        skippedReason: 'NEGATIVE_DECISION',
      });
      expect(dto.approvers[0]).toMatchObject({
        status: 'RETURNED',
        decisionComment: RETURN_COMMENT,
      });
      expect(dto.progress?.label).toBe('Encerrada — devolvida');
      expect(meta.allowedActions).not.toContain('DECIDE');
      expect(meta.decisionBlocker).toBe('NOT_PENDING');
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível ao consultar o histórico: 503 DEPENDENCY_UNAVAILABLE com Retry-After', async () => {
      const { approvalId } = await pendingApproval('AUT_CONJUNTA');
      approvalTx.down = true;
      const response = await getLines(approvalId, 'sub-ana');
      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      expect(response.headers['retry-after']).toBeDefined();
    });
  });
});
