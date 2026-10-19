import { randomUUID } from 'node:crypto';

import {
  approvalMetaSchema,
  approvalSchema,
  decidedApprovalSchema,
  problemDetailsSchema,
} from '@contrataflow/validation';
import type {
  ApprovalDto,
  ApprovalMeta,
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
 * US-052 — decidir aprovação (APV-02/APV-03) pelo pipeline HTTP completo (identidade fake, seeders
 * reais, repositórios em memória): as 8 categorias do Gherkin e as regras RN-TRAM-54..63.
 * Background: o processo "0012/2026" chega à etapa "Aprovação da autoridade competente"
 * (`DEPARTMENT_HEAD` da Secretaria de Obras) pelo encaminhamento (PRC-19), cobrindo o ETP (já
 * aprovado numa etapa anterior) e o TR na versão atual. Marta = "Carla" (titular, decide), Fábio =
 * "Diego" (substituto), Otávio = "Bruno" (não designado, com `APPROVAL_DECIDE` só sobre a Saúde),
 * Lúcia = aprovadora `USER` da etapa técnica
 * (encadeamento) e Ana = quem encaminha e autora dos documentos. O rollback real (nenhuma linha
 * órfã) e a corrida no PostgreSQL ficam em `test/tenant-leak/approval-decision.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-05T15:00:00.000Z');
const USER_AGENT = 'Vitest/US-052';
const COMMENT = 'Ajustar a estimativa de quantidades do item 2.';

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

describe('Feature: Decidir aprovação (US-052)', () => {
  let api: TestApi;
  let flow: DefinitionBuilder;
  let log: MockInstance<Logger['log']>;
  let warn: MockInstance<Logger['warn']>;
  const processTx = new FlakyTransactions();
  const approvalTx = new FlakyTransactions();
  /** Fila em memória da aplicação (modo fake): `down` simula a fila `document-render` fora. */
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
  const documentsOf = (processId: string) =>
    documentRepositoryOf(api)
      .allDocuments()
      .filter((document) => document.processId === processId);
  const eventsOf = (processId: string, eventType: string) =>
    api.outboxRows().filter((row) => row.processId === processId && row.eventType === eventType);
  const auditOf = (processId: string, action: string) =>
    api.auditRecords().filter((row) => row.processId === processId && row.action === action);
  const stampsOf = (approvalId: string) =>
    renditionRepositoryOf(api)
      .all()
      .filter(
        (rendition) => rendition.kind === 'APPROVAL_STAMPED' && rendition.approvalId === approvalId,
      );
  /** O que a decisão grava (para provar que nada foi gravado numa recusa). */
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
    stamps: stampsOf(approvalId).length,
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
      id: PLANEJAMENTO,
      name: 'Coordenadoria de Planejamento',
    });
    const authorityRoleId = seedDefaultRolesOf(api, A).get('AUTORIDADE_COMPETENTE')?.id ?? '';
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
    await seedPublishedInMemory(api, A, flow, 'TESTE_US052');
    await deactivateWorkflow(api, A, 'TESTE_US052');
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
    setDepartmentHead(api, UNITS_A.obras, FAKE_USERS.marta.id, FAKE_USERS.fabio.id);
  });

  describe('[Sucesso]', () => {
    it('Aprovar leva o processo para a próxima etapa: aprovação APPROVED, documentos APPROVED, selos enfileirados, processo COMPLETED, evento e auditoria', async () => {
      const { processId, approvalId, documents } = await pendingApproval();
      log.mockClear();

      const response = await decide(approvalId, { decision: 'APPROVE' });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers.etag).toBe('"2"');
      const dto = decidedApprovalSchema.parse(data<DecidedApprovalDto>(response));
      expect(dto).toMatchObject({
        status: 'APPROVED',
        decision: 'APPROVE',
        decidedBy: { id: FAKE_USERS.marta.id },
        decidedAsDeputy: false,
        processStage: { key: 'CONCLUSAO', name: 'Planejamento da contratação concluído' },
        processStatus: 'COMPLETED',
        chainedApprovalId: null,
        version: 2,
      });
      expect(approvalOf(approvalId)).toMatchObject({
        status: 'APPROVED',
        decidedById: FAKE_USERS.marta.id,
        decidedAt: NOW,
        decisionComment: null,
      });
      // DEC-018 / RN-TRAM-57: os dois cobertos (o ETP já aprovado continua APPROVED).
      for (const document of documentsOf(processId)) {
        expect(document).toMatchObject({ status: 'APPROVED', pendingApprovalId: null });
      }
      // RN-TRAM-58: um selo APPROVAL_STAMPED PENDING por documento aprovado, já na fila.
      const stamps = stampsOf(approvalId);
      expect(stamps.map((stamp) => stamp.documentId).sort()).toEqual(
        [...documents.values()].sort(),
      );
      expect(stamps.every((stamp) => stamp.status === 'PENDING')).toBe(true);
      for (const stamp of stamps) {
        expect(jobs().find('document-render', stamp.id)).toBeDefined();
      }
      // DEC-013 · DOM-09: etapa END registrada já encerrada e o processo concluído.
      const process = stored(processId);
      expect(process).toMatchObject({ status: 'COMPLETED', currentResponsibleId: null });
      const end = repository()
        .stagesOf(processId)
        .find((stage) => stage.id === process.currentStageId);
      expect(end).toMatchObject({
        workflowStageId: flow.stageId('CONCLUSAO'),
        status: 'COMPLETED',
        exitedAt: NOW,
      });
      const movement = repository().movementsOf(processId).at(-1);
      expect(movement).toMatchObject({
        action: 'APPROVE',
        approvalId,
        statusFrom: 'AWAITING_APPROVAL',
        statusTo: 'COMPLETED',
        actorId: FAKE_USERS.marta.id,
      });
      expect(eventsOf(processId, 'ApprovalCompleted')).toHaveLength(1);
      expect(eventsOf(processId, 'ApprovalCompleted')[0]?.payload).toMatchObject({
        approvalId,
        decidedById: FAKE_USERS.marta.id,
        decidedAsDeputy: false,
        hasComment: false,
      });
      expect(eventsOf(processId, 'ProcessStageChanged').at(-1)?.routingKey).toBe(
        'process.stage_changed.approval_approved',
      );
      expect(eventsOf(processId, 'ProcessStatusChanged').at(-1)?.routingKey).toBe(
        'process.status_changed.completed',
      );
      const [audit, ...moreAudit] = auditOf(processId, 'approval.decide');
      expect(moreAudit).toEqual([]);
      expect(audit).toMatchObject({
        entityId: approvalId,
        changes: [
          { path: 'status', old: 'PENDING', new: 'APPROVED' },
          { path: 'decision', old: null, new: 'APPROVE' },
        ],
        metadata: {
          processCode: '0012/2026',
          fromStatus: 'AWAITING_APPROVAL',
          toStatus: 'COMPLETED',
          decidedAsDeputy: false,
          warningsAcknowledged: [],
        },
      });
      expect(
        timelineRowsOf(api).filter(
          (row) => row.processId === processId && row.type === 'APPROVAL_DECIDED',
        ),
      ).toHaveLength(1);
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'approval.decided', decision: 'APPROVE' }),
        'approval.decided',
      );
    });

    it('APV-02: o detalhe traz os documentos na versão analisada, DECIDE e as opções do workflow (devolução por etapa)', async () => {
      const { approvalId, documents } = await pendingApproval();

      const response = await getApproval(approvalId, 'sub-marta');

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers.etag).toBe('"1"');
      const body = response.body as { data: ApprovalDto; meta: ApprovalMeta };
      const dto = approvalSchema.parse(body.data);
      const meta = approvalMetaSchema.parse(body.meta);
      expect(dto).toMatchObject({
        status: 'PENDING',
        process: { code: '0012/2026' },
        requestedBy: { id: FAKE_USERS.ana.id },
        approver: { type: 'DEPARTMENT_HEAD', label: expect.stringContaining('titular') as string },
        allowDeputy: true,
      });
      expect(dto.documents.map((document) => document.documentId).sort()).toEqual(
        [...documents.values()].sort(),
      );
      expect(dto.documents.every((document) => document.versionNumber === 1)).toBe(true);
      expect(meta).toMatchObject({
        allowedActions: ['DECIDE'],
        decidesAsDeputy: false,
        decisionBlocker: null,
      });
      expect(meta.decisionOptions.map((option) => [option.decision, option.toStage?.key])).toEqual([
        ['APPROVE', 'CONCLUSAO'],
        ['RETURN', 'TERMO_REFERENCIA'],
        ['RETURN', 'ABERTURA'],
        ['REJECT', 'ABERTURA'],
      ]);
    });

    it('[FA-02] Substituto decide: decidedAsDeputy gravado na aprovação, no evento e na auditoria', async () => {
      const { processId, approvalId } = await pendingApproval();
      const detail = await getApproval(approvalId, 'sub-fabio');
      expect((detail.body as { meta: ApprovalMeta }).meta.decidesAsDeputy).toBe(true);

      const response = await decide(approvalId, { decision: 'APPROVE' }, { subject: 'sub-fabio' });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(approvalOf(approvalId)).toMatchObject({
        decidedById: FAKE_USERS.fabio.id,
        decidedAsDeputy: true,
      });
      expect(eventsOf(processId, 'ApprovalCompleted')[0]?.payload).toMatchObject({
        decidedAsDeputy: true,
      });
      expect(auditOf(processId, 'approval.decide')[0]?.metadata).toMatchObject({
        decidedAsDeputy: true,
      });
    });

    it('Devolver para ajuste: volta à etapa escolhida com o responsável anterior, documentos RETURNED e status RETURNED', async () => {
      const { processId, approvalId } = await pendingApproval();

      const response = await decide(approvalId, {
        decision: 'RETURN',
        comment: COMMENT,
        transitionId: transitionOf('APROVACAO_AUTORIDADE_RETURN_TERMO_REFERENCIA'),
      });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(data<DecidedApprovalDto>(response)).toMatchObject({
        status: 'RETURNED',
        decisionComment: COMMENT,
        processStage: { key: 'TERMO_REFERENCIA' },
        processStatus: 'RETURNED',
      });
      expect(stored(processId)).toMatchObject({
        status: 'RETURNED',
        currentWorkflowStageId: flow.stageId('TERMO_REFERENCIA'),
        currentDepartmentId: PLANEJAMENTO,
        // RN-TRAM-61: o responsável individual mais recente na etapa (Ana).
        currentResponsibleId: FAKE_USERS.ana.id,
      });
      for (const document of documentsOf(processId)) {
        expect(document).toMatchObject({ status: 'RETURNED', pendingApprovalId: null });
      }
      expect(stampsOf(approvalId)).toEqual([]);
      expect(repository().movementsOf(processId).at(-1)).toMatchObject({
        action: 'RETURN',
        comment: COMMENT,
        approvalId,
      });
      expect(eventsOf(processId, 'ApprovalReturned')[0]?.payload).toMatchObject({
        hasComment: true,
      });
      expect(eventsOf(processId, 'ProcessStageChanged').at(-1)?.routingKey).toBe(
        'process.stage_changed.approval_returned',
      );
      // Nunca logar o comentário da decisão.
      expect(JSON.stringify(log.mock.calls)).not.toContain(COMMENT);
    });

    it('[FA-04] Indeferir: o ETP já aprovado passa a REJECTED e o processo volta à abertura como RETURNED', async () => {
      const { processId, approvalId, documents } = await pendingApproval();

      const response = await decide(approvalId, { decision: 'REJECT', comment: COMMENT });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(approvalOf(approvalId).status).toBe('REJECTED');
      const etp = documentsOf(processId).find((document) => document.id === documents.get('ETP'));
      expect(etp).toMatchObject({ status: 'REJECTED', pendingApprovalId: null });
      expect(stored(processId)).toMatchObject({
        status: 'RETURNED',
        currentWorkflowStageId: flow.stageId('ABERTURA'),
      });
      expect(eventsOf(processId, 'ApprovalRejected')).toHaveLength(1);
      expect(repository().movementsOf(processId).at(-1)?.action).toBe('REJECT');
    });

    it('[RN-TRAM-60] Destino também APPROVAL: a próxima aprovação é solicitada no mesmo comando (AWAITING_APPROVAL)', async () => {
      const { processId, approvalId } = await pendingApproval('APROVACAO_TECNICA');

      const response = await decide(approvalId, { decision: 'APPROVE' }, { subject: 'sub-lucia' });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const dto = data<DecidedApprovalDto>(response);
      expect(dto).toMatchObject({
        processStage: { key: 'APROVACAO_AUTORIDADE' },
        processStatus: 'AWAITING_APPROVAL',
      });
      const chained = approvalOf(dto.chainedApprovalId ?? '');
      expect(chained).toMatchObject({
        status: 'PENDING',
        approverType: 'DEPARTMENT_HEAD',
        approverUserId: FAKE_USERS.marta.id,
        processStageId: stored(processId).currentStageId,
      });
      // RN-TRAM-57: os documentos aprovados ficam APPROVED e passam a ser cobertos pela nova.
      for (const document of documentsOf(processId)) {
        expect(document).toMatchObject({ status: 'APPROVED', pendingApprovalId: chained.id });
      }
      expect(eventsOf(processId, 'ApprovalRequested')).toHaveLength(2);
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'approval.chained', chainedApprovalId: chained.id }),
        'approval.chained',
      );
    });

    it('[FA-03] Avisos reconhecidos: com o aviso confirmado a decisão passa e o aviso fica como evidência', async () => {
      const { processId, approvalId } = await pendingApproval('APROVACAO_AVISO');
      const detail = await getApproval(approvalId, 'sub-marta');
      const approve = (detail.body as { meta: ApprovalMeta }).meta.decisionOptions.find(
        (option) => option.decision === 'APPROVE',
      );
      const warning = approve?.violations.find((violation) => violation.severity === 'WARNING');
      expect(approve?.enabled).toBe(true);
      expect(warning?.message).toBe('O mapa de riscos não foi atualizado desde a última versão.');

      const response = await decide(approvalId, {
        decision: 'APPROVE',
        acknowledgedWarnings: [warning?.ruleId],
      });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const evidence = [{ ruleId: warning?.ruleId, message: warning?.message }];
      expect(repository().movementsOf(processId).at(-1)?.metadata).toMatchObject({
        warningsAcknowledged: evidence,
      });
      expect(auditOf(processId, 'approval.decide')[0]?.metadata).toMatchObject({
        warningsAcknowledged: evidence,
      });
    });

    it('[FA-01] Submissão avulsa: só o documento muda — sem etapa, status, transição ou nova aprovação', async () => {
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
      const before = stored(process.id);

      const response = await decide(approvalId, { decision: 'APPROVE' }, { subject: 'sub-lucia' });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(data<DecidedApprovalDto>(response)).toMatchObject({
        subjectType: 'DOCUMENT',
        processStage: null,
        processStatus: null,
        chainedApprovalId: null,
      });
      expect(
        documentsOf(process.id).find((candidate) => candidate.id === documentId),
      ).toMatchObject({ status: 'APPROVED', pendingApprovalId: null });
      expect(stored(process.id)).toEqual(before);
      expect(eventsOf(process.id, 'ProcessStageChanged')).toEqual([]);
      expect(stampsOf(approvalId)).toHaveLength(1);
    });
  });

  describe('[Validação]', () => {
    it('Devolver sem comentário: 422 VALIDATION_ERROR no campo comment e a aprovação continua PENDING', async () => {
      const { processId, approvalId } = await pendingApproval();
      const before = effects(processId, approvalId);

      const response = await decide(approvalId, {
        decision: 'RETURN',
        transitionId: transitionOf('APROVACAO_AUTORIDADE_RETURN_TERMO_REFERENCIA'),
      });

      const body = expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(body.errors).toEqual([
        expect.objectContaining({
          field: 'comment',
          code: 'REQUIRED',
          message: 'Informe o motivo (mín. 10 caracteres).',
        }),
      ]);
      expect(effects(processId, approvalId)).toEqual(before);
    });

    it('Comentário curto, decisão fora do enum e campo desconhecido: 422 com o código de cada campo', async () => {
      const { approvalId } = await pendingApproval();

      const short = await decide(approvalId, { decision: 'REJECT', comment: 'curto' });
      expect(expectProblem(short, 422, 'VALIDATION_ERROR').errors[0]).toMatchObject({
        field: 'comment',
        code: 'TOO_SHORT',
      });
      const invalid = await decide(approvalId, { decision: 'TALVEZ' });
      expect(expectProblem(invalid, 422, 'VALIDATION_ERROR').errors[0]).toMatchObject({
        field: 'decision',
        code: 'INVALID_ENUM',
        message: 'Selecione uma decisão.',
      });
      const unknown = await decide(approvalId, { decision: 'APPROVE', extra: true });
      expect(expectProblem(unknown, 422, 'VALIDATION_ERROR').errors[0]?.code).toBe('NOT_ALLOWED');
      expect(approvalOf(approvalId).status).toBe('PENDING');
    });

    it('[RN-TRAM-56] Mais de uma devolução sem transitionId: 422 no campo transitionId', async () => {
      const { approvalId } = await pendingApproval();

      const response = await decide(approvalId, { decision: 'RETURN', comment: COMMENT });

      expect(expectProblem(response, 422, 'VALIDATION_ERROR').errors[0]).toMatchObject({
        field: 'transitionId',
        code: 'REQUIRED',
      });
      expect(approvalOf(approvalId).status).toBe('PENDING');
    });

    it('[V-03] Aviso não reconhecido: 422 WARNINGS_NOT_ACKNOWLEDGED com o aviso e nada gravado', async () => {
      const { processId, approvalId } = await pendingApproval('APROVACAO_AVISO');
      const before = effects(processId, approvalId);

      const response = await decide(approvalId, { decision: 'APPROVE' });

      const body = expectProblem(response, 422, 'WARNINGS_NOT_ACKNOWLEDGED');
      expect(body.detail).toBe('Confirme que está ciente dos avisos para continuar.');
      expect(body.violations).toHaveLength(1);
      expect(effects(processId, approvalId)).toEqual(before);
    });

    it('[V-06] Aprovador da próxima etapa não resolvido: 422 APPROVER_UNRESOLVED e a aprovação original segue PENDING', async () => {
      const { processId, approvalId } = await pendingApproval('APROVACAO_TECNICA');
      setDepartmentHead(api, UNITS_A.obras, null, null);
      const before = effects(processId, approvalId);

      const response = await decide(approvalId, { decision: 'APPROVE' }, { subject: 'sub-lucia' });

      expect(expectProblem(response, 422, 'APPROVER_UNRESOLVED').detail).toBe(
        'Não foi possível determinar quem deve aprovar a próxima etapa. Contate o administrador.',
      );
      expect(effects(processId, approvalId)).toEqual(before);
    });

    it('[V-01] If-Match ausente: 428 PRECONDITION_REQUIRED', async () => {
      const { approvalId } = await pendingApproval();

      const response = await auth(
        request(api.server).post(`/api/v1/approvals/${approvalId}/decide`),
        'sub-marta',
      )
        .set('Idempotency-Key', randomUUID())
        .send({ decision: 'APPROVE' });

      expectProblem(response, 428, 'PRECONDITION_REQUIRED');
    });
  });

  describe('[Permissão]', () => {
    it('Usuário não designado tenta decidir: 403 NOT_DESIGNATED_APPROVER e access.denied', async () => {
      const { processId, approvalId } = await pendingApproval();
      const before = effects(processId, approvalId);

      const response = await decide(approvalId, { decision: 'APPROVE' }, { subject: 'sub-otavio' });

      expectProblem(response, 403, 'NOT_DESIGNATED_APPROVER');
      const denied = api
        .auditRecords()
        .filter((row) => row.action === 'access.denied' && row.entityId === approvalId);
      expect(denied).toEqual([
        expect.objectContaining({ reasonCode: 'APPROVAL_DECIDE', entityType: 'Approval' }),
      ]);
      expect(effects(processId, approvalId)).toEqual(before);
    });

    it('Autor do documento tenta aprovar o próprio trabalho: 403 SELF_APPROVAL_FORBIDDEN (e o detalhe explica o motivo)', async () => {
      const { processId, approvalId } = await pendingApproval(
        'APROVACAO_AUTORIDADE',
        FAKE_USERS.marta.id,
      );
      const before = effects(processId, approvalId);

      const response = await decide(approvalId, { decision: 'APPROVE' });

      expectProblem(response, 403, 'SELF_APPROVAL_FORBIDDEN');
      expect(effects(processId, approvalId)).toEqual(before);
      const detail = await getApproval(approvalId, 'sub-marta');
      expect((detail.body as { meta: ApprovalMeta }).meta).toMatchObject({
        allowedActions: [],
        decisionOptions: [],
        decisionBlocker: 'SELF_APPROVAL_FORBIDDEN',
      });
    });

    it('Quem solicitou (APPROVAL_DECIDE pelo perfil) não decide a própria solicitação: 403 NOT_DESIGNATED_APPROVER', async () => {
      const { approvalId } = await pendingApproval();

      const response = await decide(approvalId, { decision: 'APPROVE' }, { subject: 'sub-ana' });

      expectProblem(response, 403, 'NOT_DESIGNATED_APPROVER');
      expect(approvalOf(approvalId).status).toBe('PENDING');
    });

    it('APV-02 para a solicitante: vê o detalhe sem DECIDE, com o motivo (SCR-015 oculta as ações)', async () => {
      const { approvalId } = await pendingApproval();

      const response = await getApproval(approvalId, 'sub-ana');

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect((response.body as { meta: ApprovalMeta }).meta).toEqual({
        allowedActions: [],
        decisionOptions: [],
        decidesAsDeputy: false,
        decisionBlocker: 'NOT_DESIGNATED_APPROVER',
      });
    });

    it('APV-02 para quem não é designado nem vê o processo: 404 APPROVAL_NOT_FOUND', async () => {
      const { approvalId } = await pendingApproval();

      expectProblem(await getApproval(approvalId, 'sub-otavio'), 404, 'APPROVAL_NOT_FOUND');
    });

    it('[POL-03] Processo suspenso: 409 INVALID_PROCESS_STATUS', async () => {
      const { processId, approvalId } = await pendingApproval();
      repository().seed({ ...stored(processId), status: 'SUSPENDED' });

      const response = await decide(approvalId, { decision: 'APPROVE' });

      expectProblem(response, 409, 'INVALID_PROCESS_STATUS');
      expect(approvalOf(approvalId).status).toBe('PENDING');
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Aprovação de outro tenant: 404 APPROVAL_NOT_FOUND no detalhe e na decisão', async () => {
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

      expectProblem(await getApproval(foreign, 'sub-marta'), 404, 'APPROVAL_NOT_FOUND');
      expectProblem(await decide(foreign, { decision: 'APPROVE' }), 404, 'APPROVAL_NOT_FOUND');
      expect(approvalOf(foreign).status).toBe('PENDING');
    });
  });

  describe('[Duplicidade]', () => {
    it('Reenvio com a mesma chave de idempotência: 200 com Idempotent-Replayed e uma única decisão', async () => {
      const { processId, approvalId } = await pendingApproval();
      const key = randomUUID();

      const first = await decide(approvalId, { decision: 'APPROVE' }, { key });
      const replay = await decide(approvalId, { decision: 'APPROVE' }, { key });

      expect(first.status, JSON.stringify(first.body)).toBe(200);
      expect(replay.status).toBe(200);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toEqual(first.body);
      expect(auditOf(processId, 'approval.decide')).toHaveLength(1);
      expect(eventsOf(processId, 'ApprovalCompleted')).toHaveLength(1);
    });

    it('Mesma chave com outra decisão: 422 IDEMPOTENCY_KEY_REUSED', async () => {
      const { approvalId } = await pendingApproval();
      const key = randomUUID();
      await decide(approvalId, { decision: 'APPROVE' }, { key });

      const reused = await decide(approvalId, { decision: 'REJECT', comment: COMMENT }, { key });

      expectProblem(reused, 422, 'IDEMPOTENCY_KEY_REUSED');
    });

    it('Nova chave depois de decidida: 409 APPROVAL_NOT_PENDING com a decisão registrada', async () => {
      const { approvalId } = await pendingApproval();
      await decide(approvalId, { decision: 'APPROVE' });

      const again = await decide(approvalId, { decision: 'APPROVE' }, { version: 2 });

      const body = expectProblem(again, 409, 'APPROVAL_NOT_PENDING');
      expect(body.detail).toBe('Esta aprovação já foi decidida.');
      expect((again.body as { decision: string }).decision).toBe('APPROVE');
      const detail = await getApproval(approvalId, 'sub-marta');
      expect((detail.body as { meta: ApprovalMeta }).meta.decisionBlocker).toBe('NOT_PENDING');
    });
  });

  describe('[Concorrência]', () => {
    it('Titular e substituto decidem quase ao mesmo tempo: uma 200 e a outra 409 APPROVAL_NOT_PENDING', async () => {
      const { processId, approvalId } = await pendingApproval();

      const [marta, fabio] = await Promise.all([
        decide(approvalId, { decision: 'APPROVE' }, { subject: 'sub-marta' }),
        decide(approvalId, { decision: 'APPROVE' }, { subject: 'sub-fabio' }),
      ]);

      const statuses = [marta.status, fabio.status].sort();
      expect(statuses).toEqual([200, 409]);
      const loser = marta.status === 409 ? marta : fabio;
      expectProblem(loser, 409, 'APPROVAL_NOT_PENDING');
      expect(auditOf(processId, 'approval.decide')).toHaveLength(1);
      expect(
        repository()
          .movementsOf(processId)
          .filter((m) => m.action === 'APPROVE'),
      ).toHaveLength(1);
    });

    it('If-Match divergente com a aprovação ainda pendente: 412 VERSION_CONFLICT', async () => {
      const { approvalId } = await pendingApproval();

      const response = await decide(approvalId, { decision: 'APPROVE' }, { version: 7 });

      const body = expectProblem(response, 412, 'VERSION_CONFLICT');
      expect(body.detail).toBe('Esta aprovação foi atualizada por outra pessoa. Recarregue.');
      expect(approvalOf(approvalId).status).toBe('PENDING');
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível durante a decisão: 503 DEPENDENCY_UNAVAILABLE e nenhum efeito persistido', async () => {
      const { processId, approvalId } = await pendingApproval();
      const before = effects(processId, approvalId);
      approvalTx.down = true;

      const response = await decide(approvalId, { decision: 'APPROVE' });

      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      expect(effects(processId, approvalId)).toEqual(before);
    });
  });

  describe('[Falha de integração]', () => {
    it('Fila de renderização indisponível: a decisão é aplicada (200) e o selo fica PENDING para nova tentativa', async () => {
      const { approvalId } = await pendingApproval();
      jobs().down = true;
      warn.mockClear();

      const response = await decide(approvalId, { decision: 'APPROVE' });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(approvalOf(approvalId).status).toBe('APPROVED');
      const stamps = stampsOf(approvalId);
      expect(stamps).toHaveLength(2);
      expect(stamps.every((stamp) => stamp.status === 'PENDING')).toBe(true);
      for (const stamp of stamps) expect(jobs().find('document-render', stamp.id)).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'rendition.enqueue_failed', approvalId }),
        'rendition.enqueue_failed',
      );
    });
  });
});
