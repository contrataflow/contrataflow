import { randomUUID } from 'node:crypto';

import {
  approvalMetaSchema,
  approvalSchema,
  decideApprovalMetaSchema,
  decidedApprovalSchema,
  problemDetailsSchema,
} from '@contrataflow/validation';
import type {
  ApprovalDecisionPolicy,
  ApprovalDto,
  ApprovalMeta,
  DecideApprovalMeta,
  DecidedApprovalDto,
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
import {
  deactivateWorkflow,
  setDepartmentHead,
} from '../../../../test/support/process-forward-fixtures.js';
import { seedPanelDocument } from '../../../../test/support/process-panel-fixtures.js';
import { renditionRepositoryOf } from '../../../../test/support/rendition-fixtures.js';
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
 * US-134 — decidir aprovação múltipla (APV-02/APV-03 por linha) pelo pipeline HTTP completo
 * (identidade fake, seeders reais, repositórios em memória): as 8 categorias do Gherkin e as regras
 * RN-APV-33..50. Background: o processo "0012/2026" em MINUTA_EDITAL (Ana responsável) é encaminhado
 * (PRC-19) a uma etapa `APPROVAL` com política e linhas (US-132/US-133), cobrindo o "EDITAL" "ED
 * 0003/2026" (tipo TR, autora Ana). Personagens: Roberto = Marta (titular da Secretaria de
 * Administração), Helena = Fábio (substituto), Marcos = Lúcia (usuário aprovador), Paula = Otávio e
 * os quatro detentores de AUTORIDADE_COMPETENTE (linhas `ROLE`); Ana encaminha e é a autora do
 * edital e faz o papel de "Bruno" (APPROVAL_DECIDE pelos perfis padrão, mas sem linha); na
 * segregação por linha, a autora é Paula, detentora do perfil da linha 1. A memória não tem
 * rollback nem `FOR UPDATE`: as corridas são serializadas pela fila de transações; o rollback real,
 * a trava, o gatilho de imutabilidade e o outbox `PENDING` ficam em
 * `test/tenant-leak/approval-votes.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-11-12T15:00:00.000Z');
const USER_AGENT = 'Vitest/US-134';
const RETURN_COMMENT = 'Faltam as cláusulas de reajuste do contrato';

const ORG_A = '0192d134-0000-7000-8000-0000000000a0';
const ORG_B = '0192d134-0000-7000-8000-0000000000b0';
const UNITS_A = {
  organizationId: ORG_A,
  obras: '0192d134-0000-7000-8000-0000000000a1',
  manutencao: '0192d134-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d134-0000-7000-8000-0000000000a3',
  saude: '0192d134-0000-7000-8000-0000000000a4',
  posto: '0192d134-0000-7000-8000-0000000000a5',
};
const UNITS_B = {
  organizationId: ORG_B,
  obras: '0192d134-0000-7000-8000-0000000000b1',
  manutencao: '0192d134-0000-7000-8000-0000000000b2',
  pavimentacao: '0192d134-0000-7000-8000-0000000000b3',
  saude: '0192d134-0000-7000-8000-0000000000b4',
  posto: '0192d134-0000-7000-8000-0000000000b5',
};
const ADMINISTRACAO = '0192d134-0000-7000-8000-0000000000a6';
const LICITACOES = '0192d134-0000-7000-8000-0000000000a7';
const FLOW_VERSION = '0192d134-0000-7000-8000-0000000000f1';

const ROBERTO = FAKE_USERS.marta;
const HELENA = FAKE_USERS.fabio;
const MARCOS = FAKE_USERS.lucia;
const PAULA = FAKE_USERS.otavio;
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

type LineSpec =
  | { readonly type: 'USER'; readonly userId: string }
  | { readonly type: 'HEAD'; readonly departmentId: string }
  | { readonly type: 'ROLE' };

type StageKey =
  | 'AUT_TODOS'
  | 'AUT_SEQUENCIAL'
  | 'AUT_QUALQUER'
  | 'AUT_PERFIL'
  | 'AUT_LINHA_PERFIL'
  | 'AUT_AUTORA';

describe('Feature: Decidir aprovação múltipla (US-134)', () => {
  let api: TestApi;
  let flow: DefinitionBuilder;
  let authorityRoleId: string;
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
  const lineAt = (approvalId: string, sequence: number) => {
    const line = linesOf(approvalId).find((candidate) => candidate.sequence === sequence);
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
  const stampsOf = (approvalId: string) =>
    renditionRepositoryOf(api)
      .all()
      .filter(
        (rendition) => rendition.kind === 'APPROVAL_STAMPED' && rendition.approvalId === approvalId,
      );
  /** O que o voto grava (para provar que nada foi gravado numa recusa). */
  const effects = (processId: string, approvalId: string) => ({
    process: stored(processId),
    approval: approvalOf(approvalId),
    lines: linesOf(approvalId),
    stages: repository().stagesOf(processId).length,
    movements: repository().movementsOf(processId).length,
    documents: documentsOf(processId).map((document) => ({
      status: document.status,
      pendingApprovalId: document.pendingApprovalId,
    })),
    events: api.outboxRows().filter((row) => row.processId === processId).length,
    stamps: stampsOf(approvalId).length,
  });

  const getApproval = (id: string, subject: string, tenant: string = A) =>
    auth(request(api.server).get(`/api/v1/approvals/${id}`), subject, tenant);
  /** APV-02 já validado: os dados e o `meta` (com `myLine`). */
  async function detail(id: string, subject: string) {
    const response = await getApproval(id, subject);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const body = response.body as { data: ApprovalDto; meta: ApprovalMeta };
    return {
      dto: approvalSchema.parse(body.data),
      meta: approvalMetaSchema.parse(body.meta),
      etag: response.headers.etag,
    };
  }
  const decide = (
    id: string,
    body: Record<string, unknown>,
    options: { subject: string; tenant?: string; key?: string; ifMatch: string },
  ) =>
    auth(
      request(api.server).post(`/api/v1/approvals/${id}/decide`),
      options.subject,
      options.tenant,
    )
      .set('Idempotency-Key', options.key ?? randomUUID())
      .set('If-Match', options.ifMatch)
      .send(body);
  /** O voto com o `If-Match` da linha de quem decide (`meta.myLine.etag` — RN-APV-41). */
  async function vote(
    id: string,
    subject: string,
    body: Record<string, unknown> = { decision: 'APPROVE' },
    key?: string,
  ) {
    const { meta } = await detail(id, subject);
    return decide(id, body, {
      subject,
      ifMatch: meta.myLine?.etag ?? '"1"',
      ...(key === undefined ? {} : { key }),
    });
  }
  const outcomeOf = (response: request.Response) => {
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const body = response.body as { data: DecidedApprovalDto; meta: DecideApprovalMeta };
    decidedApprovalSchema.parse(body.data);
    return { data: body.data, meta: decideApprovalMetaSchema.parse(body.meta) };
  };

  const transitionOf = (key: string): string => {
    const transition = flow.transitions.find((candidate) => candidate.key === key);
    if (!transition) throw new Error(`transição ${key} ausente`);
    return transition.id;
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
      approverType: line.type === 'HEAD' ? 'DEPARTMENT_HEAD' : line.type,
      approverUserId: line.type === 'USER' ? line.userId : null,
      approverRoleId: line.type === 'ROLE' ? authorityRoleId : null,
      approverDepartmentResolution: line.type === 'HEAD' ? 'FIXED' : null,
      approverFixedDepartmentId: line.type === 'HEAD' ? line.departmentId : null,
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
  async function pendingApproval(stageKey: StageKey, authorId: string = ANA.id) {
    const process = await processAtDraft();
    const editalId = await seedPanelDocument(api, {
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
    return { processId: process.id, approvalId, editalId };
  }

  const editalStatus = (processId: string, editalId: string) =>
    documentsOf(processId).find((document) => document.id === editalId)?.status;

  beforeAll(async () => {
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
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
    for (const [id, name] of [
      [ADMINISTRACAO, 'Secretaria de Administração'],
      [LICITACOES, 'Departamento de Licitações'],
    ] as const) {
      seedDepartment(api, { tenantId: A, organizationId: ORG_A, id, name });
    }
    authorityRoleId = seedDefaultRolesOf(api, A).get('AUTORIDADE_COMPETENTE')?.id ?? '';
    const approvalStage = (name: string) => ({
      name,
      departmentResolution: 'REQUESTING_SECRETARIAT' as const,
      approverType: 'DEPARTMENT_HEAD' as const,
      approverDepartmentResolution: 'REQUESTING_SECRETARIAT' as const,
      approvalDocumentTypeCodes: ['TR'],
      slaDays: 5,
    });
    const stages: readonly (readonly [StageKey, string])[] = [
      ['AUT_TODOS', 'Autorização da licitação'],
      ['AUT_SEQUENCIAL', 'Autorização em sequência'],
      ['AUT_QUALQUER', 'Autorização por qualquer aprovador'],
      ['AUT_PERFIL', 'Autorização com perfil'],
      ['AUT_LINHA_PERFIL', 'Autorização com linha de perfil'],
      ['AUT_AUTORA', 'Autorização com a autora no perfil'],
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
        .transition(key, 'ABERTURA', 'RETURN')
        .transition(key, 'ABERTURA', 'REJECT');
    }
    const head = { type: 'HEAD', departmentId: ADMINISTRACAO } as const;
    const marcos = { type: 'USER', userId: MARCOS.id } as const;
    withApprovers('AUT_TODOS', 'ALL', [head, marcos]);
    withApprovers('AUT_SEQUENCIAL', 'SEQUENTIAL', [head, marcos]);
    withApprovers('AUT_QUALQUER', 'ANY', [head, marcos]);
    withApprovers('AUT_PERFIL', 'ALL', [
      { type: 'USER', userId: ROBERTO.id },
      marcos,
      { type: 'ROLE' },
    ]);
    withApprovers('AUT_LINHA_PERFIL', 'ALL', [head, { type: 'ROLE' }]);
    withApprovers('AUT_AUTORA', 'ALL', [{ type: 'ROLE' }, marcos]);
    await seedPublishedInMemory(api, A, flow, 'TESTE_US134');
    await deactivateWorkflow(api, A, 'TESTE_US134');
    assignDepartment(api, membershipOf(ANA.id), UNITS_A.manutencao);
    assignDepartment(api, membershipOf(ANA.id), LICITACOES);
    // Roberto, Helena, Marcos e Paula: AUTORIDADE_COMPETENTE (APPROVAL_DECIDE) no tenant —
    // detentores competentes das linhas `ROLE`.
    for (const user of [ROBERTO, HELENA, MARCOS, PAULA]) {
      assignRole(api, {
        tenantId: A,
        membershipId: membershipOf(user.id),
        roleId: authorityRoleId,
      });
    }
    setDepartmentHead(api, ADMINISTRACAO, ROBERTO.id, HELENA.id);
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
    it('Em "ALL" o primeiro voto mantém a aprovação aberta e o último encerra', async () => {
      const { processId, approvalId, editalId } = await pendingApproval('AUT_TODOS');
      const covered = editalStatus(processId, editalId);

      // APV-02 de Roberto: a linha 1, If-Match da linha, opção APPROVE que não encerra.
      const before = await detail(approvalId, 'sub-marta');
      expect(before.meta).toMatchObject({
        allowedActions: expect.arrayContaining(['DECIDE']) as unknown,
        decisionBlocker: null,
        myLine: { sequence: 1, status: 'PENDING', etag: '"1"' },
        decidableLineIds: [lineAt(approvalId, 1).id],
      });
      expect(
        before.meta.decisionOptions.map((option) => [option.decision, option.closesApproval]),
      ).toEqual([
        ['APPROVE', false],
        ['RETURN', true],
        ['RETURN', true],
        ['REJECT', true],
      ]);
      expect(before.dto.approvers.map((line) => [line.sequence, line.version])).toEqual([
        [1, 1],
        [2, 1],
      ]);

      const first = outcomeOf(await vote(approvalId, 'sub-marta'));
      expect(first.meta).toEqual({
        outcome: 'VOTE_RECORDED',
        remainingPending: 1,
        remainingWaiting: 0,
        activatedApproverId: null,
        approvalApproverId: lineAt(approvalId, 1).id,
      });
      expect(first.data).toMatchObject({
        status: 'PENDING',
        processStage: null,
        processStatus: 'AWAITING_APPROVAL',
        chainedApprovalId: null,
        version: 2,
      });
      expect(approvalOf(approvalId)).toMatchObject({ status: 'PENDING', version: 2 });
      expect(lineAt(approvalId, 1)).toMatchObject({
        status: 'APPROVED',
        decidedById: ROBERTO.id,
        decidedAt: NOW,
        decidedAsDeputy: false,
        version: 2,
      });
      // RN-APV-38: o voto que não encerra não mexe no documento (segue como entrou na aprovação).
      expect(editalStatus(processId, editalId)).toBe(covered);
      expect(stored(processId).status).toBe('AWAITING_APPROVAL');
      expect(auditOf(processId, 'approval.vote')).toEqual([
        expect.objectContaining({
          entityType: 'ApprovalApprover',
          entityId: lineAt(approvalId, 1).id,
          changes: [{ path: 'status', old: 'PENDING', new: 'APPROVED' }],
          metadata: expect.objectContaining({
            approvalId,
            sequence: 1,
            decisionPolicy: 'ALL',
            decidedAsDeputy: false,
            activatedApproverId: null,
          }) as unknown,
        }),
      ]);
      expect(auditOf(processId, 'approval.decide')).toEqual([]);
      const voteEvents = eventsOf(processId, 'ApprovalVoteRecorded');
      expect(voteEvents).toHaveLength(1);
      expect(voteEvents[0]?.payload).toEqual({
        approvalId,
        approvalApproverId: lineAt(approvalId, 1).id,
        sequence: 1,
        decisionPolicy: 'ALL',
        decidedById: ROBERTO.id,
        decidedAsDeputy: false,
        remainingPending: 1,
        remainingWaiting: 0,
        approvedLines: 1,
        totalLines: 2,
      });
      // A notificação ao solicitante (Ana) sai do `ApprovalVoteRecorded` no worker.
      expect(
        timelineRowsOf(api).filter(
          (row) => row.processId === processId && row.type === 'APPROVAL_VOTE_RECORDED',
        ),
      ).toEqual([
        expect.objectContaining({
          params: expect.objectContaining({ votesLabel: '1 de 2', sequence: 1 }) as unknown,
        }),
      ]);
      expect(stampsOf(approvalId)).toEqual([]);

      // Marcos: If-Match da linha 2 (o voto de Roberto não a invalidou — RN-APV-41).
      const mine = await detail(approvalId, 'sub-lucia');
      expect(mine.meta.myLine).toMatchObject({ sequence: 2, etag: '"1"' });
      expect(
        mine.meta.decisionOptions.find((option) => option.decision === 'APPROVE'),
      ).toMatchObject({ closesApproval: true });
      const last = outcomeOf(await vote(approvalId, 'sub-lucia'));
      expect(last.meta).toMatchObject({ outcome: 'APPROVED', remainingPending: 0 });
      expect(last.data).toMatchObject({
        status: 'APPROVED',
        decidedBy: { id: MARCOS.id },
        processStage: { key: 'CONCLUSAO' },
        processStatus: 'COMPLETED',
      });
      expect(approvalOf(approvalId)).toMatchObject({
        status: 'APPROVED',
        decision: 'APPROVE',
        decidedById: MARCOS.id,
        // RN-APV-39: o espelho da linha que encerrou.
        approverType: 'USER',
        approverUserId: MARCOS.id,
        version: 3,
      });
      expect(editalStatus(processId, editalId)).toBe('APPROVED');
      expect(stored(processId)).toMatchObject({ status: 'COMPLETED' });
      const completed = eventsOf(processId, 'ApprovalCompleted');
      expect(completed).toHaveLength(1);
      expect(completed[0]?.payload).toMatchObject({
        decisionPolicy: 'ALL',
        decidingApprovalApproverId: lineAt(approvalId, 2).id,
        votes: [
          { sequence: 1, decision: 'APPROVE', decidedById: ROBERTO.id, decidedAsDeputy: false },
          { sequence: 2, decision: 'APPROVE', decidedById: MARCOS.id, decidedAsDeputy: false },
        ],
      });
      expect(JSON.stringify(completed[0]?.payload)).not.toContain('comment"');
      expect(auditOf(processId, 'approval.decide')).toEqual([
        expect.objectContaining({
          metadata: expect.objectContaining({
            decisionPolicy: 'ALL',
            approvalApproverId: lineAt(approvalId, 2).id,
            votes: [
              expect.objectContaining({ sequence: 1 }),
              expect.objectContaining({ sequence: 2 }),
            ],
          }) as unknown,
        }),
      ]);
      expect(stampsOf(approvalId)).toHaveLength(1);
    });

    it('Em "SEQUENTIAL" a vez passa de uma linha para a próxima', async () => {
      const { processId, approvalId } = await pendingApproval('AUT_SEQUENCIAL');
      expect(lineAt(approvalId, 2)).toMatchObject({ status: 'WAITING', activatedAt: null });

      const first = outcomeOf(await vote(approvalId, 'sub-marta'));

      expect(first.meta).toMatchObject({
        outcome: 'VOTE_RECORDED',
        remainingPending: 1,
        remainingWaiting: 0,
        activatedApproverId: lineAt(approvalId, 2).id,
      });
      expect(lineAt(approvalId, 2)).toMatchObject({ status: 'PENDING', activatedAt: NOW });
      // RN-APV-24: o espelho segue a linha corrente.
      expect(approvalOf(approvalId)).toMatchObject({
        status: 'PENDING',
        approverType: 'USER',
        approverUserId: MARCOS.id,
      });
      const activated = eventsOf(processId, 'ApprovalApproverActivated');
      expect(activated).toHaveLength(1);
      expect(activated[0]?.payload).toEqual({
        approvalId,
        approvalApproverId: lineAt(approvalId, 2).id,
        sequence: 2,
        approverType: 'USER',
        approverUserId: MARCOS.id,
        approverRoleId: null,
        approverDepartmentId: null,
        allowDeputy: false,
        dueAt: null,
      });
      expect(auditOf(processId, 'approval.vote')[0]?.metadata).toMatchObject({
        activatedApproverId: lineAt(approvalId, 2).id,
      });
      expect(
        timelineRowsOf(api).find(
          (row) => row.processId === processId && row.type === 'APPROVAL_TURN',
        )?.params,
      ).toMatchObject({ approverLabel: 'Lúcia Matos', sequence: 2 });

      const last = outcomeOf(await vote(approvalId, 'sub-lucia'));
      expect(last.meta.outcome).toBe('APPROVED');
      expect(approvalOf(approvalId).status).toBe('APPROVED');
      expect(stored(processId).status).toBe('COMPLETED');
    });

    it('Decisão negativa depois de voto favorável encerra a aprovação e mantém o voto', async () => {
      const { processId, approvalId, editalId } = await pendingApproval('AUT_TODOS');
      outcomeOf(await vote(approvalId, 'sub-marta'));

      const response = await vote(approvalId, 'sub-lucia', {
        decision: 'RETURN',
        comment: RETURN_COMMENT,
        transitionId: transitionOf('AUT_TODOS_RETURN_MINUTA_EDITAL'),
      });

      const result = outcomeOf(response);
      expect(result.meta).toMatchObject({ outcome: 'RETURNED', remainingPending: 0 });
      expect(result.data.processStage).toMatchObject({ key: 'MINUTA_EDITAL' });
      expect(approvalOf(approvalId)).toMatchObject({ status: 'RETURNED', decidedById: MARCOS.id });
      expect(stored(processId)).toMatchObject({ status: 'RETURNED' });
      expect(editalStatus(processId, editalId)).toBe('RETURNED');
      expect(linesOf(approvalId).map((line) => [line.status, line.decidedById])).toEqual([
        ['APPROVED', ROBERTO.id],
        ['RETURNED', MARCOS.id],
      ]);
      const returned = eventsOf(processId, 'ApprovalReturned');
      expect(returned).toHaveLength(1);
      expect(returned[0]?.payload).toMatchObject({
        decisionPolicy: 'ALL',
        votes: [
          { sequence: 1, decision: 'APPROVE' },
          { sequence: 2, decision: 'RETURN' },
        ],
      });
      expect(JSON.stringify(returned[0]?.payload)).not.toContain(RETURN_COMMENT);
    });

    it('Em "ANY" a primeira decisão encerra e as demais linhas são puladas', async () => {
      const { approvalId } = await pendingApproval('AUT_QUALQUER');
      const { meta } = await detail(approvalId, 'sub-marta');
      // RN-APV-41: em ANY o If-Match é o da aprovação (MVP 1).
      expect(meta.myLine?.etag).toBe(`"${String(approvalOf(approvalId).version)}"`);

      const result = outcomeOf(await vote(approvalId, 'sub-marta'));

      expect(result.meta.outcome).toBe('APPROVED');
      expect(approvalOf(approvalId).status).toBe('APPROVED');
      expect(lineAt(approvalId, 2)).toMatchObject({
        status: 'SKIPPED',
        skippedReason: 'ANY_DECIDED',
      });
    });

    it('[FA-01] Substituto decide a linha do titular: decidedAsDeputy na linha, no evento e na auditoria', async () => {
      const { processId, approvalId } = await pendingApproval('AUT_TODOS');
      const { meta } = await detail(approvalId, 'sub-fabio');
      expect(meta).toMatchObject({ decidesAsDeputy: true, myLine: { sequence: 1 } });

      outcomeOf(await vote(approvalId, 'sub-fabio'));

      expect(lineAt(approvalId, 1)).toMatchObject({
        status: 'APPROVED',
        decidedById: HELENA.id,
        decidedAsDeputy: true,
      });
      expect(eventsOf(processId, 'ApprovalVoteRecorded')[0]?.payload).toMatchObject({
        decidedAsDeputy: true,
      });
      expect(auditOf(processId, 'approval.vote')[0]?.metadata).toMatchObject({
        decidedAsDeputy: true,
      });
    });
  });

  describe('[Validação]', () => {
    it('Comentário curto, linha ambígua e etapa de devolução ausente', async () => {
      const { processId, approvalId } = await pendingApproval('AUT_PERFIL');
      const before = effects(processId, approvalId);

      const short = await vote(approvalId, 'sub-lucia', { decision: 'RETURN', comment: 'ok' });
      const shortBody = expectProblem(short, 422, 'VALIDATION_ERROR');
      expect(shortBody.errors).toEqual([
        expect.objectContaining({ field: 'comment', code: 'TOO_SHORT' }),
      ]);

      // Marcos cobre a linha 2 (usuário) e a 3 (perfil): precisa dizer qual.
      const { meta } = await detail(approvalId, 'sub-lucia');
      expect(meta.decidableLineIds).toEqual([lineAt(approvalId, 2).id, lineAt(approvalId, 3).id]);
      const ambiguous = await vote(approvalId, 'sub-lucia');
      const ambiguousBody = expectProblem(ambiguous, 422, 'VALIDATION_ERROR');
      expect(ambiguousBody.errors).toEqual([
        expect.objectContaining({ field: 'approvalApproverId', code: 'CONDITIONAL_REQUIRED' }),
      ]);
      expect(effects(processId, approvalId)).toEqual(before);

      // Com a linha escolhida, o voto passa (e a linha 3 segue PENDING para os demais).
      const chosen = await decide(
        approvalId,
        { decision: 'APPROVE', approvalApproverId: lineAt(approvalId, 3).id },
        { subject: 'sub-lucia', ifMatch: '"1"' },
      );
      expect(outcomeOf(chosen).meta.approvalApproverId).toBe(lineAt(approvalId, 3).id);
    });

    it('Devolver sem transitionId havendo mais de uma etapa de destino: 422 no campo transitionId', async () => {
      const { processId, approvalId } = await pendingApproval('AUT_TODOS');
      const before = effects(processId, approvalId);

      const response = await vote(approvalId, 'sub-lucia', {
        decision: 'RETURN',
        comment: RETURN_COMMENT,
      });

      const body = expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(body.errors).toEqual([expect.objectContaining({ field: 'transitionId' })]);
      expect(effects(processId, approvalId)).toEqual(before);
    });
  });

  describe('[Permissão]', () => {
    it('Linha em espera: 403 NOT_DESIGNATED_APPROVER com meta.reason LINE_WAITING e access.denied', async () => {
      const { processId, approvalId } = await pendingApproval('AUT_SEQUENCIAL');
      const { meta } = await detail(approvalId, 'sub-lucia');
      expect(meta.allowedActions).not.toContain('DECIDE');
      expect(meta).toMatchObject({
        decisionBlocker: 'NOT_DESIGNATED_APPROVER',
        myLine: { sequence: 2, status: 'WAITING' },
        decidableLineIds: [],
      });
      const before = effects(processId, approvalId);

      const response = await decide(
        approvalId,
        { decision: 'APPROVE' },
        { subject: 'sub-lucia', ifMatch: '"1"' },
      );

      const body = expectProblem(response, 403, 'NOT_DESIGNATED_APPROVER');
      expect(body).toMatchObject({ meta: { reason: 'LINE_WAITING' } });
      expect(deniedOf(approvalId)).toEqual([
        expect.objectContaining({
          reasonCode: 'APPROVAL_DECIDE',
          metadata: expect.objectContaining({
            approvalId,
            approvalApproverId: lineAt(approvalId, 2).id,
          }) as unknown,
        }),
      ]);
      expect(effects(processId, approvalId)).toEqual(before);
    });

    it('Autora do documento na linha de perfil: 403 SELF_APPROVAL_FORBIDDEN e a linha continua PENDING', async () => {
      const { processId, approvalId } = await pendingApproval('AUT_AUTORA', PAULA.id);
      const { meta } = await detail(approvalId, 'sub-otavio');
      expect(meta).toMatchObject({
        decisionBlocker: 'SELF_APPROVAL_FORBIDDEN',
        myLine: { sequence: 1 },
      });
      const before = effects(processId, approvalId);

      const response = await decide(
        approvalId,
        { decision: 'APPROVE' },
        { subject: 'sub-otavio', ifMatch: '"1"' },
      );

      expectProblem(response, 403, 'SELF_APPROVAL_FORBIDDEN');
      expect(lineAt(approvalId, 1).status).toBe('PENDING');
      expect(effects(processId, approvalId)).toEqual(before);
      // A linha segue para os demais detentores (Roberto decide).
      expect(outcomeOf(await vote(approvalId, 'sub-marta')).meta.outcome).toBe('VOTE_RECORDED');
    });

    it('"Bruno", sem designação, e linha de outra pessoa: 403 NOT_DESIGNATED_APPROVER', async () => {
      const { processId, approvalId } = await pendingApproval('AUT_TODOS');
      const before = effects(processId, approvalId);

      expectProblem(
        await decide(approvalId, { decision: 'APPROVE' }, { subject: 'sub-ana', ifMatch: '"1"' }),
        403,
        'NOT_DESIGNATED_APPROVER',
      );
      // V-04: Marcos informa a linha 1 (do titular).
      const foreignLine = await decide(
        approvalId,
        { decision: 'APPROVE', approvalApproverId: lineAt(approvalId, 1).id },
        { subject: 'sub-lucia', ifMatch: '"1"' },
      );
      expect(expectProblem(foreignLine, 403, 'NOT_DESIGNATED_APPROVER')).toMatchObject({
        meta: { reason: 'NOT_LINE_APPROVER' },
      });
      expect(deniedOf(approvalId)).toHaveLength(2);
      expect(effects(processId, approvalId)).toEqual(before);
    });

    it('Processo suspenso: 409 INVALID_PROCESS_STATUS no voto', async () => {
      const { processId, approvalId } = await pendingApproval('AUT_TODOS');
      repository().seed({ ...stored(processId), status: 'SUSPENDED' });

      expectProblem(await vote(approvalId, 'sub-marta'), 409, 'INVALID_PROCESS_STATUS');
      expect(lineAt(approvalId, 1).status).toBe('PENDING');
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Aprovação de outro tenant: 404 APPROVAL_NOT_FOUND sem revelar dados', async () => {
      const foreign = newId();
      approvalRepositoryOf(api).seed({
        id: foreign,
        tenantId: B,
        processId: newId(),
        subjectType: 'PROCESS_STAGE',
        processStageId: newId(),
        documentId: null,
        title: 'AP-134 Prefeitura B',
        requestedById: FAKE_USERS.heitor.id,
        requestedAt: NOW,
        requestComment: null,
        approverType: 'USER',
        approverUserId: ROBERTO.id,
        approverRoleId: null,
        approverDepartmentId: null,
        allowDeputy: false,
        dueAt: null,
        status: 'PENDING',
        createdAt: NOW,
        createdById: FAKE_USERS.heitor.id,
        decisionPolicy: 'ALL',
      });

      const read = await getApproval(foreign, 'sub-marta');
      expectProblem(read, 404, 'APPROVAL_NOT_FOUND');
      const decided = await decide(
        foreign,
        { decision: 'APPROVE' },
        { subject: 'sub-marta', ifMatch: '"1"' },
      );
      expectProblem(decided, 404, 'APPROVAL_NOT_FOUND');
      expect(JSON.stringify([read.body, decided.body])).not.toContain('AP-134');
      expect(approvalOf(foreign).status).toBe('PENDING');
    });
  });

  describe('[Duplicidade]', () => {
    it('Reenvio do voto com a mesma chave: 200 Idempotent-Replayed e um único voto', async () => {
      const { processId, approvalId } = await pendingApproval('AUT_TODOS');
      const key = randomUUID();

      const first = await vote(approvalId, 'sub-marta', { decision: 'APPROVE' }, key);
      const replay = await decide(
        approvalId,
        { decision: 'APPROVE' },
        { subject: 'sub-marta', key, ifMatch: '"1"' },
      );

      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(replay.status).toBe(200);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toEqual(first.body);
      expect(auditOf(processId, 'approval.vote')).toHaveLength(1);
      expect(eventsOf(processId, 'ApprovalVoteRecorded')).toHaveLength(1);

      // Nova chave na mesma linha: 409 APPROVAL_LINE_NOT_PENDING (o voto é imutável).
      const again = await decide(
        approvalId,
        { decision: 'REJECT', comment: RETURN_COMMENT },
        { subject: 'sub-marta', ifMatch: '"2"' },
      );
      expectProblem(again, 409, 'APPROVAL_LINE_NOT_PENDING');
      expect(lineAt(approvalId, 1).decision).toBe('APPROVE');
    });

    it('Segundo voto da mesma pessoa em outra linha: 409 APPROVER_ALREADY_VOTED', async () => {
      const { processId, approvalId } = await pendingApproval('AUT_PERFIL');
      // Roberto cobre a linha 1 (usuário) e a 3 (perfil): vota na 1.
      outcomeOf(
        await decide(
          approvalId,
          { decision: 'APPROVE', approvalApproverId: lineAt(approvalId, 1).id },
          { subject: 'sub-marta', ifMatch: '"1"' },
        ),
      );
      const { meta } = await detail(approvalId, 'sub-marta');
      expect(meta.decisionBlocker).toBe('ALREADY_VOTED');
      expect(meta.allowedActions).not.toContain('DECIDE');
      const before = effects(processId, approvalId);

      const response = await decide(
        approvalId,
        { decision: 'APPROVE', approvalApproverId: lineAt(approvalId, 3).id },
        { subject: 'sub-marta', ifMatch: '"1"' },
      );

      expectProblem(response, 409, 'APPROVER_ALREADY_VOTED');
      expect(lineAt(approvalId, 3).status).toBe('PENDING');
      expect(effects(processId, approvalId)).toEqual(before);
    });
  });

  describe('[Concorrência]', () => {
    it('Votos simultâneos em linhas diferentes de "ALL": aplicados em série, aprovação APPROVED uma vez', async () => {
      const { processId, approvalId } = await pendingApproval('AUT_TODOS');

      const [roberto, marcos] = await Promise.all([
        decide(approvalId, { decision: 'APPROVE' }, { subject: 'sub-marta', ifMatch: '"1"' }),
        decide(approvalId, { decision: 'APPROVE' }, { subject: 'sub-lucia', ifMatch: '"1"' }),
      ]);

      const outcomes = [outcomeOf(roberto), outcomeOf(marcos)].map((item) => item.meta.outcome);
      expect(outcomes.sort()).toEqual(['APPROVED', 'VOTE_RECORDED']);
      expect(approvalOf(approvalId).status).toBe('APPROVED');
      expect(eventsOf(processId, 'ApprovalCompleted')).toHaveLength(1);
      expect(auditOf(processId, 'approval.decide')).toHaveLength(1);
      expect(stored(processId).status).toBe('COMPLETED');
    });

    it('Dois detentores do perfil decidem a mesma linha: só a primeira efetiva, a outra 409 APPROVAL_LINE_NOT_PENDING', async () => {
      const { approvalId } = await pendingApproval('AUT_LINHA_PERFIL');
      const body = { decision: 'APPROVE', approvalApproverId: lineAt(approvalId, 2).id };

      const responses = await Promise.all([
        decide(approvalId, body, { subject: 'sub-lucia', ifMatch: '"1"' }),
        decide(approvalId, body, { subject: 'sub-otavio', ifMatch: '"1"' }),
      ]);

      expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
      const loser = responses.find((response) => response.status === 409);
      if (loser) expectProblem(loser, 409, 'APPROVAL_LINE_NOT_PENDING');
      expect(lineAt(approvalId, 2).status).toBe('APPROVED');
      expect(approvalOf(approvalId).status).toBe('PENDING');
      expect(linesOf(approvalId).filter((line) => line.decision !== null)).toHaveLength(1);
    });

    it('Devolução e aprovação ao mesmo tempo: a devolução efetivada primeiro deixa a outra em 409 APPROVAL_NOT_PENDING', async () => {
      const { processId, approvalId } = await pendingApproval('AUT_TODOS');
      const returnBody = {
        decision: 'RETURN',
        comment: RETURN_COMMENT,
        transitionId: transitionOf('AUT_TODOS_RETURN_MINUTA_EDITAL'),
      };

      const returned = await decide(approvalId, returnBody, {
        subject: 'sub-marta',
        ifMatch: '"1"',
      });
      const late = await decide(
        approvalId,
        { decision: 'APPROVE' },
        { subject: 'sub-lucia', ifMatch: '"1"' },
      );

      expect(outcomeOf(returned).meta.outcome).toBe('RETURNED');
      expect(expectProblem(late, 409, 'APPROVAL_NOT_PENDING')).toMatchObject({
        status: 409,
        decision: 'RETURN',
      });
      expect(approvalOf(approvalId).status).toBe('RETURNED');
      expect(lineAt(approvalId, 2)).toMatchObject({
        status: 'SKIPPED',
        skippedReason: 'NEGATIVE_DECISION',
      });
      expect(eventsOf(processId, 'ApprovalReturned')).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'approval.decide_conflict', reason: 'NOT_PENDING' }),
        'approval.decide_conflict',
      );
    });

    it('If-Match da aprovação (e não da linha) em "ALL": 412 VERSION_CONFLICT', async () => {
      const { approvalId } = await pendingApproval('AUT_TODOS');
      outcomeOf(await vote(approvalId, 'sub-marta'));

      const response = await decide(
        approvalId,
        { decision: 'APPROVE' },
        { subject: 'sub-lucia', ifMatch: `"${String(approvalOf(approvalId).version)}"` },
      );

      expect(expectProblem(response, 412, 'VERSION_CONFLICT')).toMatchObject({
        currentVersion: 1,
        sentVersion: 2,
      });
      expect(lineAt(approvalId, 2).status).toBe('PENDING');
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível no voto que encerraria: 503 DEPENDENCY_UNAVAILABLE e nada gravado', async () => {
      const { processId, approvalId, editalId } = await pendingApproval('AUT_TODOS');
      outcomeOf(await vote(approvalId, 'sub-marta'));
      const before = effects(processId, approvalId);
      approvalTx.down = true;

      const response = await decide(
        approvalId,
        { decision: 'APPROVE' },
        { subject: 'sub-lucia', ifMatch: '"1"' },
      );

      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      expect(effects(processId, approvalId)).toEqual(before);
      expect(lineAt(approvalId, 2).status).toBe('PENDING');
      expect(editalStatus(processId, editalId)).toBe(before.documents[0]?.status);
    });
  });

  describe('[Falha de integração]', () => {
    it('Fila de renderização indisponível: o voto final encerra (200) e o selo fica PENDING', async () => {
      const { processId, approvalId } = await pendingApproval('AUT_TODOS');
      outcomeOf(await vote(approvalId, 'sub-marta'));
      jobs().down = true;

      const result = outcomeOf(await vote(approvalId, 'sub-lucia'));

      expect(result.meta.outcome).toBe('APPROVED');
      expect(approvalOf(approvalId).status).toBe('APPROVED');
      const stamps = stampsOf(approvalId);
      expect(stamps).toHaveLength(1);
      expect(stamps.every((stamp) => stamp.status === 'PENDING')).toBe(true);
      // O relay é assíncrono: o evento fica gravado no outbox (no PostgreSQL, `PENDING`).
      expect(eventsOf(processId, 'ApprovalCompleted')).toHaveLength(1);
    });
  });
});
