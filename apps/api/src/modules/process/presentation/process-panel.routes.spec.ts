import {
  actionEntrySchema,
  problemDetailsSchema,
  processDetailMetaSchema,
  processSchema,
  processStageEntrySchema,
  processSummarySchema,
  RULE_EVALUATION_FAILED_MESSAGE,
} from '@contrataflow/validation';
import type {
  ActionEntry,
  ProcessStageEntryDto,
  ProcessSummaryDto,
} from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { z } from 'zod';

import { CACHE_STORE } from '#shared/cache/cache-store.js';
import type { CacheStore } from '#shared/cache/cache-store.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
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
  seedPanelApproval,
  seedPanelDocument,
} from '../../../../test/support/process-panel-fixtures.js';
import {
  assignDepartment,
  assignRole,
  seedDefaultRolesOf,
  seedDepartment,
} from '../../../../test/support/structure-fixtures.js';
import {
  ETP_MESSAGE,
  RISK_MAP_MESSAGE,
  dec015Workflow,
  seedPublishedInMemory,
} from '../../../../test/support/workflow-engine-fixtures.js';
import { DefinitionBuilder } from '../../../../test/support/workflow-fixtures.js';
import { PROCESS_CLOCK, PROCESS_TRANSACTIONS } from '../application/ports.js';
import type { ProcessTransactions } from '../application/ports.js';
import type { AccessGrant } from '../domain/process-runtime-records.js';
import type { Process } from '../domain/process.js';
import type { StoredStage } from '../infrastructure/in-memory-process.repository.js';

/*
 * US-004 — painel situacional (PRC-04 `meta`, PRC-07 `summary`, PRC-10 `stages` e a coerência com
 * PRC-08) pelo pipeline HTTP completo com a identidade fake, os seeders reais, o workflow DEC-015
 * das fixtures do motor (regras do Background) e o processo, os documentos e as aprovações em
 * memória. As 8 categorias do Gherkin e os fluxos alternativos de API. Personas: Marcos = Lúcia
 * (GESTOR_CONTRATACOES, TENANT — responsável); Juliana = Fábio (COMPRAS, sem custódia); Roberto =
 * Ana (aprovadora designada); Tatiane = Otávio (SOMENTE_LEITURA, ORGANIZATION); Luciana = Lúcia.
 * O isolamento sobre o PostgreSQL está em `test/tenant-leak/process-panel.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
/** "Hoje é 2026-10-05" (segunda-feira) — meio-dia em São Paulo. */
const NOW = new Date('2026-10-05T15:00:00.000Z');

const ORG_A = '0192d004-0000-7000-8000-0000000000a0';
const ORG_B = '0192d004-0000-7000-8000-0000000000b0';
const UNITS_A = {
  organizationId: ORG_A,
  obras: '0192d004-0000-7000-8000-0000000000a1',
  manutencao: '0192d004-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d004-0000-7000-8000-0000000000a3',
  saude: '0192d004-0000-7000-8000-0000000000a4',
  posto: '0192d004-0000-7000-8000-0000000000a5',
};
const UNITS_B = {
  organizationId: ORG_B,
  obras: '0192d004-0000-7000-8000-0000000000b1',
  manutencao: '0192d004-0000-7000-8000-0000000000b2',
  pavimentacao: '0192d004-0000-7000-8000-0000000000b3',
  saude: '0192d004-0000-7000-8000-0000000000b4',
  posto: '0192d004-0000-7000-8000-0000000000b5',
};
const PLANEJAMENTO = '0192d004-0000-7000-8000-0000000000a8';

const P12 = '0192d004-0000-7000-8000-000000000012';
const P31 = '0192d004-0000-7000-8000-000000000031';
const P_SUSPENSO = '0192d004-0000-7000-8000-000000000041';
const P_CONCLUIDO = '0192d004-0000-7000-8000-000000000051';
const P_RASCUNHO = '0192d004-0000-7000-8000-000000000061';
const P_QUEBRADO = '0192d004-0000-7000-8000-000000000071';
const P_B = '0192d004-0000-7000-8000-0000000000ff';
const INEXISTENTE = '0192d004-0000-7000-8000-0000000000ee';

const membershipOf = (userId: string, tenantId = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

/** Transações do módulo que podem simular o banco fora do ar; contam as leituras em snapshot. */
class FlakyTransactions implements ProcessTransactions {
  down = false;
  snapshots = 0;

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    if (this.down) return Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED')));
    return runSimulatedTransaction(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.run(work);
  }

  snapshot<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    this.snapshots += 1;
    return this.run(work);
  }

  longRead<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.read(work);
  }
}

const dept = (departmentId: string, reason: 'REQUESTING' | 'CURRENT' | 'HISTORICAL') =>
  ({ principalType: 'DEPARTMENT', departmentId, reason }) as AccessGrant;
const user = (userId: string, reason: 'CREATOR' | 'RESPONSIBLE' | 'APPROVER') =>
  ({ principalType: 'USER', userId, reason }) as AccessGrant;

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

describe('Feature: Painel situacional do processo (US-004)', () => {
  let api: TestApi;
  let log: MockInstance<Logger['log']>;
  let warn: MockInstance<Logger['warn']>;
  let error: MockInstance<Logger['error']>;
  const transactions = new FlakyTransactions();
  const builderA = dec015Workflow(new DefinitionBuilder(newId()));
  const brokenA = dec015Workflow(new DefinitionBuilder(newId())).rule(
    'CONDITION',
    { expression: { '*': [] } },
    { stage: 'ESTUDOS_PRELIMINARES' },
    { name: 'Valor compatível', message: 'Confira o valor estimado.' },
  );
  const builderB = dec015Workflow(new DefinitionBuilder(newId()));
  let base: Omit<Process, 'id' | 'number' | 'code' | 'status' | 'currentWorkflowStageId'>;
  let documents: { dfd: string; etp: string; pp: string };

  const at = (builder: DefinitionBuilder, stageKey: string) => ({
    workflowVersionId: builder.versionId,
    currentWorkflowStageId: builder.stageId(stageKey),
  });
  const processOf = (
    id: string,
    number: number | null,
    fields: Partial<Process> & Pick<Process, 'status' | 'currentWorkflowStageId'>,
  ): Process => ({
    ...base,
    id,
    number,
    code: number === null ? null : `${String(number).padStart(4, '0')}/2026`,
    ...fields,
  });
  const passOf = (
    processId: string,
    builder: DefinitionBuilder,
    stageKey: string,
    sequence: number,
    overrides: Partial<StoredStage> = {},
  ): StoredStage => ({
    id: newId(),
    tenantId: A,
    processId,
    workflowStageId: builder.stageId(stageKey),
    sequence,
    status: 'COMPLETED',
    departmentId: PLANEJAMENTO,
    assigneeId: FAKE_USERS.lucia.id,
    enteredAt: new Date(`2026-09-${String(10 + sequence).padStart(2, '0')}T12:00:00.000Z`),
    exitedAt: new Date(`2026-09-${String(11 + sequence).padStart(2, '0')}T12:00:00.000Z`),
    dueAt: null,
    slaDays: 5,
    slaType: 'BUSINESS',
    enteredViaMovementId: null,
    ...overrides,
  });

  /** Background: 0012/2026 em ESTUDOS_PRELIMINARES com Lúcia (Marcos) desde 01/10. */
  async function seedBackground(): Promise<void> {
    const repository = processRepositoryOf(api);
    const studies = passOf(P12, builderA, 'ESTUDOS_PRELIMINARES', 5, {
      status: 'ACTIVE',
      exitedAt: null,
      enteredAt: new Date('2026-10-01T12:10:00.000Z'),
      // Prazo 07/10 (fim do dia em São Paulo).
      dueAt: new Date('2026-10-08T02:59:59.999Z'),
    });
    repository.seed(
      processOf(P12, 12, {
        ...at(builderA, 'ESTUDOS_PRELIMINARES'),
        status: 'IN_PROGRESS',
        title: 'Aquisição de cimento para manutenção de vias',
        priority: 'HIGH',
        currentStageId: studies.id,
        currentDepartmentId: PLANEJAMENTO,
        currentResponsibleId: FAKE_USERS.lucia.id,
        currentStageDueAt: studies.dueAt,
        estimatedValue: '85000.00',
        estimatedValueSource: 'DFD',
        targetDate: '2026-11-30',
        version: 9,
      }),
      [
        dept(UNITS_A.manutencao, 'REQUESTING'),
        dept(PLANEJAMENTO, 'CURRENT'),
        user(FAKE_USERS.lucia.id, 'RESPONSIBLE'),
      ],
    );
    // Devolvido uma vez de APROVACAO_DFD para ABERTURA e depois aprovado.
    repository.seedStage(passOf(P12, builderA, 'ABERTURA', 1));
    repository.seedStage(passOf(P12, builderA, 'APROVACAO_DFD', 2, { status: 'RETURNED' }));
    repository.seedStage(passOf(P12, builderA, 'ABERTURA', 3, { dueDateOverridden: true }));
    repository.seedStage(passOf(P12, builderA, 'APROVACAO_DFD', 4));
    repository.seedStage(studies);
    repository.setSituation(P12, { assignmentSince: new Date('2026-10-01T12:10:00.000Z') });

    const dfd = await seedPanelDocument(api, {
      tenantId: A,
      processId: P12,
      typeCode: 'DFD',
      code: 'DFD 0005/2026',
      title: 'DFD — cimento',
      status: 'APPROVED',
      versionNumber: 2,
      createdById: FAKE_USERS.lucia.id,
    });
    const etp = await seedPanelDocument(api, {
      tenantId: A,
      processId: P12,
      typeCode: 'ETP',
      code: 'ETP 0003/2026',
      title: 'ETP — cimento',
      status: 'DRAFT',
      createdById: FAKE_USERS.lucia.id,
    });

    // 0031/2026: sigiloso, aguardando a aprovação da autoridade designada a Ana (Roberto).
    const approvalPass = passOf(P31, builderA, 'APROVACAO_AUTORIDADE', 6, {
      status: 'ACTIVE',
      exitedAt: null,
      assigneeId: null,
    });
    repository.seed(
      processOf(P31, 31, {
        ...at(builderA, 'APROVACAO_AUTORIDADE'),
        status: 'AWAITING_APPROVAL',
        title: 'Contratação de limpeza hospitalar',
        currentStageId: approvalPass.id,
        currentDepartmentId: UNITS_A.obras,
        isBudgetConfidential: true,
        estimatedValue: '1200000.00',
        estimatedValueSource: 'PRICE_RESEARCH',
      }),
      [dept(UNITS_A.obras, 'CURRENT'), user(FAKE_USERS.ana.id, 'APPROVER')],
    );
    repository.seedStage(approvalPass);
    seedPanelApproval(api, {
      tenantId: A,
      processId: P31,
      title: 'Aprovação do planejamento da contratação',
      approverType: 'USER',
      approverUserId: FAKE_USERS.ana.id,
      processStageId: approvalPass.id,
      dueAt: new Date('2026-10-09T02:59:59.999Z'),
    });
    const pp = await seedPanelDocument(api, {
      tenantId: A,
      processId: P31,
      typeCode: 'PRICE_RESEARCH',
      code: 'PP 0002/2026',
      title: 'Pesquisa de preços — limpeza',
      status: 'APPROVED',
      versionNumber: 1,
      confidentiality: 'RESTRICTED',
      createdById: FAKE_USERS.lucia.id,
    });
    documents = { dfd, etp, pp };

    // Suspenso (FA-06), concluído (FA-07) e rascunho sem número (FA-08).
    const suspendedPass = passOf(P_SUSPENSO, builderA, 'ESTUDOS_PRELIMINARES', 1, {
      status: 'ACTIVE',
      exitedAt: null,
      pausedAt: new Date('2026-10-03T12:00:00.000Z'),
    });
    repository.seed(
      processOf(P_SUSPENSO, 41, {
        ...at(builderA, 'ESTUDOS_PRELIMINARES'),
        status: 'SUSPENDED',
        title: 'Aquisição suspensa',
        currentStageId: suspendedPass.id,
        currentDepartmentId: PLANEJAMENTO,
        currentResponsibleId: FAKE_USERS.lucia.id,
        currentStageDueAt: new Date('2026-10-08T02:59:59.999Z'),
      }),
      [dept(PLANEJAMENTO, 'CURRENT')],
    );
    repository.seedStage(suspendedPass);
    repository.setSituation(P_SUSPENSO, {
      statusBeforeSuspension: 'IN_PROGRESS',
      suspensionReason: 'Aguardando definição orçamentária.',
      suspendedAt: new Date('2026-10-03T12:00:00.000Z'),
    });

    repository.seed(
      processOf(P_CONCLUIDO, 51, {
        ...at(builderA, 'CONCLUSAO'),
        status: 'COMPLETED',
        title: 'Planejamento concluído',
        currentDepartmentId: PLANEJAMENTO,
        targetDate: '2026-09-01',
      }),
      [dept(PLANEJAMENTO, 'CURRENT')],
    );
    repository.seedStage(
      passOf(P_CONCLUIDO, builderA, 'CONCLUSAO', 1, { status: 'ACTIVE', exitedAt: null }),
    );
    repository.setSituation(P_CONCLUIDO, { completedAt: new Date('2026-10-02T17:00:00.000Z') });

    const draftPass = passOf(P_RASCUNHO, builderA, 'ABERTURA', 1, {
      status: 'ACTIVE',
      exitedAt: null,
    });
    repository.seed(
      processOf(P_RASCUNHO, null, {
        ...at(builderA, 'ABERTURA'),
        status: 'DRAFT',
        title: 'Rascunho',
        currentStageId: draftPass.id,
        currentDepartmentId: PLANEJAMENTO,
        currentResponsibleId: FAKE_USERS.lucia.id,
      }),
      [dept(PLANEJAMENTO, 'CURRENT')],
    );
    repository.seedStage(draftPass);

    // Regra com expressão JSON Logic que falha na avaliação.
    const brokenPass = passOf(P_QUEBRADO, brokenA, 'ESTUDOS_PRELIMINARES', 1, {
      status: 'ACTIVE',
      exitedAt: null,
    });
    repository.seed(
      processOf(P_QUEBRADO, 71, {
        ...at(brokenA, 'ESTUDOS_PRELIMINARES'),
        status: 'IN_PROGRESS',
        title: 'Processo com regra quebrada',
        currentStageId: brokenPass.id,
        currentDepartmentId: PLANEJAMENTO,
        currentResponsibleId: FAKE_USERS.lucia.id,
      }),
      [dept(PLANEJAMENTO, 'CURRENT')],
    );
    repository.seedStage(brokenPass);

    // 0099/2026 da Prefeitura B.
    repository.seed(
      {
        ...processOf(P_B, 99, { ...at(builderB, 'ABERTURA'), status: 'IN_PROGRESS' }),
        tenantId: B,
        organizationId: ORG_B,
        requestingSecretariatId: UNITS_B.obras,
        requestingDepartmentId: UNITS_B.manutencao,
        currentDepartmentId: UNITS_B.manutencao,
      },
      [dept(UNITS_B.manutencao, 'CURRENT')],
    );
  }

  beforeAll(async () => {
    log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    api = await createTestApi({
      providers: [
        { token: PROCESS_TRANSACTIONS, value: transactions },
        { token: PROCESS_CLOCK, value: () => NOW },
        { token: CATALOG_CLOCK, value: () => NOW },
      ],
    });
    await runTenantSeeders(api, A);
    await runTenantSeeders(api, B);
    seedProcessStructure(api, A, { ...UNITS_A, shortName: 'PMSJ', cnpj: '11222333000181' });
    seedProcessStructure(api, B, { ...UNITS_B, shortName: 'PMB', cnpj: '60746948000112' });
    seedDepartment(api, {
      tenantId: A,
      organizationId: ORG_A,
      id: PLANEJAMENTO,
      name: 'Setor de Planejamento',
      parent: { id: UNITS_A.obras, path: `/${UNITS_A.obras}/`, depth: 0 },
    });
    await seedPublishedInMemory(api, A, builderA, 'FASE_PREPARATORIA_PAINEL');
    await seedPublishedInMemory(api, A, brokenA, 'FASE_PREPARATORIA_QUEBRADA');
    await seedPublishedInMemory(api, B, builderB, 'FASE_PREPARATORIA_PAINEL');
    const roles = seedDefaultRolesOf(api, A);
    assignRole(api, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.otavio.id),
      roleId: roles.get('SOMENTE_LEITURA')?.id ?? '',
      scopeType: 'ORGANIZATION',
      scopeOrganizationId: ORG_A,
    });
    assignRole(api, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.fabio.id),
      roleId: roles.get('COMPRAS')?.id ?? '',
      scopeType: 'TENANT',
    });
    assignDepartment(api, membershipOf(FAKE_USERS.ana.id), UNITS_A.manutencao);
    base = {
      tenantId: A,
      organizationId: ORG_A,
      year: 2026,
      internalCode: null,
      title: 'Processo de teste',
      object: 'Objeto do processo de teste.',
      description: null,
      contractingTypeId: catalogItemId(api, A, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
      modalityId: null,
      isPriceRegistration: false,
      requestingSecretariatId: UNITS_A.obras,
      requestingDepartmentId: UNITS_A.manutencao,
      currentDepartmentId: UNITS_A.manutencao,
      currentResponsibleId: null,
      priority: 'MEDIUM',
      workflowVersionId: builderA.versionId,
      currentStageId: null,
      currentStageDueAt: null,
      openedAt: null,
      targetDate: null,
      estimatedValue: null,
      estimatedValueSource: 'MANUAL',
      isBudgetConfidential: false,
      originId: catalogItemId(api, A, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
      creationChannel: 'WEB',
      pcaStatus: 'NOT_APPLICABLE',
      pcaYear: null,
      pcaItemCode: null,
      pcaJustification: null,
      notes: null,
      duplicatedFromId: null,
      createdAt: new Date('2026-09-14T13:02:11.000Z'),
      updatedAt: new Date('2026-10-02T18:40:00.000Z'),
      createdById: FAKE_USERS.lucia.id,
      updatedById: null,
      version: 1,
    };
    await seedBackground();
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await api.close();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    transactions.down = false;
  });

  const get = (path: string, subject = 'sub-lucia', tenant = A) =>
    request(api.server)
      .get(`/api/v1${path}`)
      .set('Authorization', api.bearer(subject, { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', tenant);
  const summaryOf = async (id: string, subject = 'sub-lucia') => {
    const response = await get(`/processes/${id}/summary`, subject);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return processSummarySchema.parse(data<ProcessSummaryDto>(response));
  };
  const actionsOf = async (id: string, subject = 'sub-lucia') => {
    const response = await get(`/processes/${id}/available-actions`, subject);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return z.array(actionEntrySchema).parse(data<ActionEntry[]>(response));
  };
  const auditOf = (action: string) => api.auditRecords().filter((row) => row.action === action);

  it('[Sucesso] painel responde às 7 perguntas sem cliques (PRC-07 · 200)', async () => {
    const response = await get(`/processes/${P12}/summary`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const summary = processSummarySchema.parse(data<ProcessSummaryDto>(response));

    expect(summary.header).toMatchObject({
      code: '0012/2026',
      title: 'Aquisição de cimento para manutenção de vias',
      status: 'IN_PROGRESS',
      priority: 'HIGH',
      isBudgetConfidential: false,
      estimatedValue: '85000.00',
      estimatedValueMasked: false,
      estimatedValueSource: 'DFD',
      organization: { id: ORG_A, shortName: 'PMSJ' },
      showOrganization: false,
    });
    // (1) Onde está.
    expect(summary.where).toMatchObject({
      stage: {
        key: 'ESTUDOS_PRELIMINARES',
        name: 'Estudos preliminares e mapa de riscos',
        type: 'TASK',
      },
      department: { id: PLANEJAMENTO, name: 'Setor de Planejamento' },
      status: 'IN_PROGRESS',
      statusBeforeSuspension: null,
    });
    // (2) Responsável desde 01/10.
    expect(summary.responsible).toEqual({
      user: { id: FAKE_USERS.lucia.id, name: FAKE_USERS.lucia.name, jobTitle: null },
      queueDepartment: null,
      since: '2026-10-01T12:10:00.000Z',
      approver: null,
    });
    // (3) O que falta: 1 obrigatória e 1 recomendação, com os textos das regras.
    expect(summary.pending.blockingCount).toBe(1);
    expect(summary.pending.warningCount).toBe(1);
    expect(summary.pending.items.map((item) => [item.severity, item.message])).toEqual([
      ['BLOCKING', ETP_MESSAGE],
      ['WARNING', RISK_MAP_MESSAGE],
    ]);
    // (4) Próximo passo: a transição principal e as instruções da etapa.
    expect(summary.nextStep).toEqual({
      action: {
        action: 'FORWARD',
        transitionKey: expect.any(String) as string,
        label: 'Encaminhar para pesquisa de preços',
        enabled: false,
        reasons: [
          { code: 'TRANSITION_BLOCKED', message: 'Há 1 pendência obrigatória nesta etapa.' },
        ],
      },
      instructions: 'Orientação de ESTUDOS_PRELIMINARES.',
    });
    // (5) Prazos: "Vence em 2 dias úteis" e o prazo alvo.
    expect(summary.deadline).toMatchObject({
      slaType: 'BUSINESS',
      daysLeft: 2,
      isDueSoon: true,
      isOverdue: false,
      isPaused: false,
    });
    expect(summary.target).toEqual({
      targetDate: '2026-11-30',
      isOverdue: false,
      overdueDays: null,
    });
    // (6) Documentos.
    expect(
      summary.documents.map((document) => [document.code, document.status, document.versionNumber]),
    ).toEqual([
      ['DFD 0005/2026', 'APPROVED', 2],
      ['ETP 0003/2026', 'DRAFT', null],
    ]);
    // (7) Aprovações pendentes: nenhuma.
    expect(summary.approvals).toEqual([]);
    expect(summary.counts).toEqual({ documents: 2, items: 0, comments: 0, participants: 0 });
    expect(summary.version).toBe(9);
  });

  it('[Sucesso] RN-PROC-56: o resumo é lido numa transação de instantâneo único e logado sem dados sensíveis', async () => {
    const before = transactions.snapshots;
    log.mockClear();
    await summaryOf(P12);
    expect(transactions.snapshots).toBe(before + 1);
    const call = log.mock.calls.find(([, event]) => event === 'process.summary');
    expect(call?.[0]).toMatchObject({
      event: 'process.summary',
      processId: P12,
      documentsCount: 2,
      pendingApprovalsCount: 0,
      rulesEvaluated: 2,
    });
    expect(JSON.stringify(call?.[0])).not.toContain('cimento');
    expect(JSON.stringify(call?.[0])).not.toContain('85000');
  });

  it('[Sucesso] aprovador designado vê "Decidir aprovação" como ação primária', async () => {
    const summary = await summaryOf(P31, 'sub-ana');
    expect(summary.nextStep.action).toMatchObject({
      action: 'DECIDE_APPROVAL',
      label: 'Decidir aprovação',
      enabled: true,
      approvalId: summary.approvals[0]?.id,
    });
    expect(summary.responsible.approver).toEqual({
      approvalId: summary.approvals[0]?.id,
      label: FAKE_USERS.ana.name,
      isMine: true,
    });
    expect(summary.approvals).toEqual([
      {
        id: expect.any(String) as string,
        title: 'Aprovação do planejamento da contratação',
        approverLabel: FAKE_USERS.ana.name,
        requestedAt: '2026-10-04T12:00:00.000Z',
        dueAt: '2026-10-09T02:59:59.999Z',
        isOverdue: false,
        isMine: true,
      },
    ]);
    // Para quem não é o aprovador, a mesma aprovação aparece sem "sua decisão".
    const other = await summaryOf(P31);
    expect(other.approvals[0]?.isMine).toBe(false);
    expect(other.nextStep.action?.action).not.toBe('DECIDE_APPROVAL');
  });

  it('[Sucesso] stepper mostra etapas percorridas e devolução (PRC-10)', async () => {
    const response = await get(`/processes/${P12}/stages`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const stages = z.array(processStageEntrySchema).parse(data<ProcessStageEntryDto[]>(response));
    expect(stages.map((stage) => stage.key)).toEqual([
      'ABERTURA',
      'APROVACAO_DFD',
      'ESTUDOS_PRELIMINARES',
      'PESQUISA_PRECOS',
      'TERMO_REFERENCIA',
      'APROVACAO_AUTORIDADE',
      'CONCLUSAO',
    ]);
    const byKey = new Map(stages.map((stage) => [stage.key, stage]));
    expect(byKey.get('ABERTURA')?.passes.map((pass) => pass.sequence)).toEqual([1, 3]);
    expect(byKey.get('ABERTURA')?.passes[1]).toMatchObject({
      department: { id: PLANEJAMENTO, name: 'Setor de Planejamento' },
      assignee: { id: FAKE_USERS.lucia.id, name: FAKE_USERS.lucia.name },
      dueDateOverridden: true,
    });
    expect(byKey.get('APROVACAO_DFD')?.passes.map((pass) => pass.status)).toEqual([
      'RETURNED',
      'COMPLETED',
    ]);
    expect(byKey.get('ESTUDOS_PRELIMINARES')).toMatchObject({
      isCurrent: true,
      lastPassStatus: 'ACTIVE',
    });
    expect(byKey.get('CONCLUSAO')).toMatchObject({
      type: 'END',
      lastPassStatus: null,
      isCurrent: false,
      passes: [],
    });
    expect(byKey.get('PESQUISA_PRECOS')).toMatchObject({ slaType: 'BUSINESS', passes: [] });
  });

  it('[Validação] pendência bloqueante desabilita a ação primária e a pendência leva ao ETP', async () => {
    const entries = await actionsOf(P12);
    expect(entries.find((entry) => entry.action === 'FORWARD')).toMatchObject({
      enabled: false,
      reasons: [expect.objectContaining({ code: 'TRANSITION_BLOCKED', message: ETP_MESSAGE })],
    });
    const summary = await summaryOf(P12);
    const [etp, riskMap] = summary.pending.items;
    expect(etp).toMatchObject({
      message: ETP_MESSAGE,
      link: { documentId: documents.etp, restricted: false },
    });
    expect(riskMap?.link).toEqual({ createDocumentTypeCode: 'RISK_MAP' });
  });

  it('[Permissão] leitura sem ações, valor sigiloso mascarado e documento restrito sem link', async () => {
    const summary = await summaryOf(P31, 'sub-otavio');
    expect(summary.header).toMatchObject({
      isBudgetConfidential: true,
      estimatedValue: null,
      estimatedValueMasked: true,
    });
    expect(summary.documents).toEqual([
      expect.objectContaining({
        id: documents.pp,
        code: 'PP 0002/2026',
        confidentiality: 'RESTRICTED',
        restricted: true,
      }),
    ]);
    expect(summary.nextStep.action).toBeNull();
    // Nenhuma ação de tramitação: sem a permissão em nenhum escopo, a ação é omitida.
    expect(await actionsOf(P31, 'sub-otavio')).toEqual([]);
    const detail = await get(`/processes/${P31}`, 'sub-otavio');
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    const body = z
      .object({ data: processSchema, meta: processDetailMetaSchema })
      .parse(detail.body);
    expect(body.data).toMatchObject({ estimatedValue: null, estimatedValueMasked: true });
    expect(body.meta.allowedActions).toEqual([]);
    expect(
      auditOf('process.confidential_view').filter(
        (row) => row.actorUserId === FAKE_USERS.otavio.id,
      ),
    ).toEqual([]);
  });

  it('[Permissão] usuário com permissão, mas sem custódia: "Com Marcos — Setor de Planejamento"', async () => {
    const summary = await summaryOf(P12, 'sub-fabio');
    expect(summary.nextStep.action).toBeNull();
    expect(summary.responsible.user?.name).toBe(FAKE_USERS.lucia.name);
    expect(summary.where.department.name).toBe('Setor de Planejamento');
    const forward = (await actionsOf(P12, 'sub-fabio')).find((entry) => entry.action === 'FORWARD');
    expect(forward).toMatchObject({
      enabled: false,
      reasons: expect.arrayContaining([
        {
          code: 'NOT_PROCESS_CUSTODIAN',
          message: 'Somente quem está com o processo pode encaminhá-lo.',
        },
      ]) as unknown,
    });
  });

  it('[Permissão] PRC-04 traz `meta.allowedActions` coerente com PRC-08', async () => {
    const response = await get(`/processes/${P_SUSPENSO}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const body = z
      .object({ data: processSchema, meta: processDetailMetaSchema })
      .parse(response.body);
    const enabled = (await actionsOf(P_SUSPENSO))
      .filter((entry) => entry.enabled)
      .map((entry) => entry.action);
    expect(body.meta.allowedActions).toEqual([...new Set(enabled)]);
    expect(body.meta.allowedActions).toContain('RESUME');
  });

  it('[Tenant incorreto] processo de outro tenant: 404 idêntico ao inexistente em PRC-04/07/08/09/10', async () => {
    const strip = (body: unknown) => {
      const {
        instance: _instance,
        correlationId: _correlation,
        ...rest
      } = body as Record<string, unknown>;
      return rest;
    };
    for (const [suffix, code] of [
      ['', 'PROCESS_NOT_FOUND'],
      ['/summary', 'PROCESS_NOT_FOUND'],
      ['/stages', 'PROCESS_NOT_FOUND'],
      ['/available-actions', 'NOT_FOUND'],
      ['/checklist', 'NOT_FOUND'],
    ] as const) {
      const other = expectProblem(await get(`/processes/${P_B}${suffix}`), 404, code);
      const missing = expectProblem(await get(`/processes/${INEXISTENTE}${suffix}`), 404, code);
      expect(strip(other)).toEqual(strip(missing));
      expect(JSON.stringify(other)).not.toContain('0099');
    }
  });

  it('[Duplicidade] acesso repetido a valores sigilosos é auditado uma vez por sessão e processo', async () => {
    // Duas abas ao mesmo tempo, três recargas e o detalhe (PRC-04), na mesma sessão.
    const calls = await Promise.all([
      get(`/processes/${P31}/summary`),
      get(`/processes/${P31}/summary`),
    ]);
    for (let reload = 0; reload < 3; reload += 1) {
      calls.push(await get(`/processes/${P31}/summary`));
    }
    calls.push(await get(`/processes/${P31}`));
    for (const response of calls) {
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(data<ProcessSummaryDto['header']>(response)).toBeDefined();
    }
    const summary = processSummarySchema.parse(data<ProcessSummaryDto>(calls[0]));
    expect(summary.header).toMatchObject({
      estimatedValue: '1200000.00',
      estimatedValueMasked: false,
    });
    expect(summary.documents[0]?.restricted).toBe(false);
    // Sessão do BFF (sem proxy confiável nos testes, a do usuário) — inclui as leituras anteriores.
    const records = auditOf('process.confidential_view').filter(
      (row) => row.actorUserId === FAKE_USERS.lucia.id && row.entityId === P31,
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      category: 'ACCESS',
      entityId: P31,
      metadata: expect.objectContaining({ processCode: '0031/2026', source: 'PRC-07' }) as unknown,
    });
  });

  it('[Concorrência] processo reatribuído enquanto o painel está aberto: a releitura mostra o novo responsável', async () => {
    const repository = processRepositoryOf(api);
    const original = repository.allProcesses().find((process) => process.id === P12);
    if (!original) throw new Error('0012/2026 ausente');
    const before = await summaryOf(P12);
    expect(before.nextStep.action?.action).toBe('FORWARD');
    try {
      repository.replace({
        ...original,
        currentResponsibleId: FAKE_USERS.otavio.id,
        version: original.version + 1,
      });
      const after = await summaryOf(P12);
      expect(after.responsible.user?.name).toBe(FAKE_USERS.otavio.name);
      expect(after.version).toBe(original.version + 1);
      // Quem perdeu a custódia não tem mais ação primária; o encaminhamento explica o motivo.
      expect(after.nextStep.action).toBeNull();
      const forward = (await actionsOf(P12)).find((entry) => entry.action === 'FORWARD');
      expect(forward?.reasons.map((reason) => reason.code)).toContain('NOT_PROCESS_CUSTODIAN');
    } finally {
      repository.replace(original);
    }
  });

  it('[Falha de banco] banco indisponível: 503 DEPENDENCY_UNAVAILABLE no resumo e no stepper', async () => {
    transactions.down = true;
    expectProblem(await get(`/processes/${P12}/summary`), 503, 'DEPENDENCY_UNAVAILABLE');
    expectProblem(await get(`/processes/${P12}/stages`), 503, 'DEPENDENCY_UNAVAILABLE');
  });

  it('[Falha de integração] regra com expressão que não pode ser avaliada: pendência com a mensagem padrão e log error', async () => {
    error.mockClear();
    const summary = await summaryOf(P_QUEBRADO);
    const broken = summary.pending.items.find((item) => item.name === 'Valor compatível');
    expect(broken).toMatchObject({
      severity: 'BLOCKING',
      evaluationFailed: true,
      message: RULE_EVALUATION_FAILED_MESSAGE,
    });
    expect(summary.pending.blockingCount).toBe(2);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'workflow.rule_evaluation_failed',
        ruleId: broken?.ruleId,
        workflowVersionId: brokenA.versionId,
      }),
      'workflow.rule_evaluation_failed',
    );
  });

  it('FA-06: processo suspenso — prazo pausado, motivo e "Retomar" como ação primária', async () => {
    const summary = await summaryOf(P_SUSPENSO);
    expect(summary.where).toMatchObject({
      status: 'SUSPENDED',
      statusBeforeSuspension: 'IN_PROGRESS',
      suspensionReason: 'Aguardando definição orçamentária.',
      suspendedAt: '2026-10-03T12:00:00.000Z',
    });
    expect(summary.deadline).toMatchObject({ isPaused: true, isOverdue: false, daysLeft: null });
    expect(summary.nextStep.action).toMatchObject({ action: 'RESUME', enabled: true });
  });

  it('FA-07: processo concluído em modo leitura — sem badges de prazo e END concluída', async () => {
    const summary = await summaryOf(P_CONCLUIDO);
    expect(summary.where.completedAt).toBe('2026-10-02T17:00:00.000Z');
    expect(summary.deadline).toBeNull();
    expect(summary.target).toEqual({
      targetDate: '2026-09-01',
      isOverdue: false,
      overdueDays: null,
    });
    expect(summary.nextStep.action).toBeNull();
    expect(summary.responsible.queueDepartment).toBeNull();
    const stages = data<ProcessStageEntryDto[]>(await get(`/processes/${P_CONCLUIDO}/stages`));
    expect(stages.find((stage) => stage.key === 'CONCLUSAO')).toMatchObject({
      lastPassStatus: 'COMPLETED',
      isCurrent: false,
    });
  });

  it('FA-08: rascunho sem número — cabeçalho sem código', async () => {
    const summary = await summaryOf(P_RASCUNHO);
    expect(summary.header).toMatchObject({ code: null, status: 'DRAFT' });
  });

  describe('[Falha de integração] Redis indisponível', () => {
    it('a definição do workflow é lida do banco, o resumo responde 200 e há warn', async () => {
      const unavailable = (): Promise<never> => Promise.reject(new Error('ECONNREFUSED'));
      const downStore: CacheStore = {
        get: unavailable,
        set: unavailable,
        delete: unavailable,
        getMany: unavailable,
      };
      const previous = api;
      api = await createTestApi({
        providers: [
          { token: CACHE_STORE, value: downStore },
          { token: PROCESS_TRANSACTIONS, value: transactions },
          { token: PROCESS_CLOCK, value: () => NOW },
          { token: CATALOG_CLOCK, value: () => NOW },
        ],
      });
      try {
        await runTenantSeeders(api, A);
        seedProcessStructure(api, A, { ...UNITS_A, shortName: 'PMSJ', cnpj: '11222333000181' });
        seedDepartment(api, {
          tenantId: A,
          organizationId: ORG_A,
          id: PLANEJAMENTO,
          name: 'Setor de Planejamento',
          parent: { id: UNITS_A.obras, path: `/${UNITS_A.obras}/`, depth: 0 },
        });
        await seedPublishedInMemory(api, A, builderA, 'FASE_PREPARATORIA_PAINEL');
        await seedPublishedInMemory(api, A, brokenA, 'FASE_PREPARATORIA_QUEBRADA');
        await seedPublishedInMemory(api, B, builderB, 'FASE_PREPARATORIA_PAINEL');
        await seedBackground();
        warn.mockClear();
        const summary = await summaryOf(P12);
        expect(summary.where.stage?.key).toBe('ESTUDOS_PRELIMINARES');
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({
            event: 'workflow.definition_cache_unavailable',
            workflowVersionId: builderA.versionId,
          }),
          'workflow.definition_cache_unavailable',
        );
      } finally {
        await api.close();
        api = previous;
      }
    });
  });
});
