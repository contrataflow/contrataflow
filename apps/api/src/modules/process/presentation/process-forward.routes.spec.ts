import { randomUUID } from 'node:crypto';

import {
  actionEntrySchema,
  forwardedProcessSchema,
  problemDetailsSchema,
} from '@contrataflow/validation';
import type {
  ActionEntry,
  DfdDto,
  ForwardedProcessDto,
  ProcessDto,
  ProcessItemDto,
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
import type { IdempotencyRecord, IdempotencyStorePort } from '#shared/idempotency/idempotency.js';
import { InMemoryIdempotencyStore } from '#shared/idempotency/in-memory-idempotency.store.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import {
  approvalRepositoryOf,
  documentRepositoryOf,
} from '../../../../test/support/document-fixtures.js';
import {
  CATALOG_CLOCK,
  catalogItemId,
  numberSequencesOf,
  processRepositoryOf,
  runTenantSeeders,
  seedProcessStructure,
  tenantSettingsOf,
  timelineRowsOf,
} from '../../../../test/support/process-fixtures.js';
import {
  deactivateWorkflow,
  fillDfdDraft,
  registerTestDocumentFacts,
  setDepartmentHead,
} from '../../../../test/support/process-forward-fixtures.js';
import type { TestDocumentFacts } from '../../../../test/support/process-forward-fixtures.js';
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
 * US-047 — PRC-19 (encaminhar processo) pelo pipeline HTTP completo (autenticação, tenant,
 * vínculo, autorização, `If-Match`, `Idempotency-Key`, filtro RFC 9457) com a identidade fake, os
 * seeders reais e repositórios em memória — as 8 categorias do Gherkin. O fluxo de tarefa usa um
 * workflow publicado em memória espelhando o Background (PESQUISA_PRECOS na unidade fixa
 * "Departamento de Compras", SLA de 10 dias úteis, política UNASSIGNED); o de aprovação, o workflow
 * padrão semeado (ABERTURA → APROVACAO_DFD) com um DFD real. Ana = "Paula" (responsável), Fábio =
 * "Marcos" (lotado na Coordenadoria sem ser o responsável), Lúcia = pessoa lotada em Compras,
 * Marta = "Carlos" (titular da Secretaria de Obras). Atomicidade com rollback real, RLS e
 * concorrência sobre o PostgreSQL: `test/tenant-leak/process-forward.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
/** "Hoje é 05/10/2026" — meio-dia em São Paulo. */
const NOW = new Date('2026-10-05T15:00:00.000Z');
/** 20/10/2026 23:59:59 em São Paulo: 10 dias úteis sem fins de semana e o feriado de 12/10. */
const DUE_20_10 = '2026-10-21T02:59:59.999Z';
const ETP_MESSAGE = 'O ETP deve estar completo.';
const RISK_MESSAGE = 'Recomenda-se elaborar o mapa de riscos.';
const USER_AGENT = 'Vitest/US-047';

const ORG_A = '0192d047-0000-7000-8000-0000000000a0';
const ORG_B = '0192d047-0000-7000-8000-0000000000b0';
const UNITS_A = {
  organizationId: ORG_A,
  obras: '0192d047-0000-7000-8000-0000000000a1',
  manutencao: '0192d047-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d047-0000-7000-8000-0000000000a3',
  saude: '0192d047-0000-7000-8000-0000000000a4',
  posto: '0192d047-0000-7000-8000-0000000000a5',
};
const UNITS_B = {
  organizationId: ORG_B,
  obras: '0192d047-0000-7000-8000-0000000000b1',
  manutencao: '0192d047-0000-7000-8000-0000000000b2',
  pavimentacao: '0192d047-0000-7000-8000-0000000000b3',
  saude: '0192d047-0000-7000-8000-0000000000b4',
  posto: '0192d047-0000-7000-8000-0000000000b5',
};
const PLANEJAMENTO = '0192d047-0000-7000-8000-0000000000a6';
const COMPRAS = '0192d047-0000-7000-8000-0000000000a7';
const INATIVA = '0192d047-0000-7000-8000-0000000000a8';
const FLOW_VERSION = '0192d047-0000-7000-8000-0000000000f1';

const membershipOf = (userId: string, tenantId = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

/**
 * Workflow do Background: ESTUDOS_PRELIMINARES (ETP completo — BLOCKING; mapa de riscos —
 * WARNING) → PESQUISA_PRECOS (unidade fixa, SLA 10 dias úteis, fila, prazo não alterável) ou →
 * COTACAO (unidade escolhida, titular, comentário obrigatório, prazo alterável) ou → ANALISE (unidade
 * fixa inativa).
 */
const flow = new DefinitionBuilder(FLOW_VERSION)
  .stage('ABERTURA', 'START', { name: 'Formalização da demanda', assignmentPolicy: 'CREATOR' })
  .stage('ESTUDOS_PRELIMINARES', 'TASK', {
    name: 'ETP e mapa de riscos',
    departmentResolution: 'CHOSEN_ON_FORWARD',
    documentTypeCodes: ['ETP', 'RISK_MAP'],
    slaDays: 15,
  })
  .stage('PESQUISA_PRECOS', 'TASK', {
    name: 'Pesquisa de preços',
    departmentResolution: 'FIXED',
    fixedDepartmentId: COMPRAS,
    assignmentPolicy: 'UNASSIGNED',
    slaDays: 10,
    slaType: 'BUSINESS',
  })
  .stage('COTACAO', 'TASK', {
    name: 'Cotação',
    departmentResolution: 'CHOSEN_ON_FORWARD',
    assignmentPolicy: 'DEPARTMENT_HEAD',
    slaDays: 3,
  })
  .stage('ANALISE', 'TASK', {
    name: 'Análise técnica',
    departmentResolution: 'FIXED',
    fixedDepartmentId: INATIVA,
    slaDays: null,
  })
  .stage('CONCLUSAO', 'END', { name: 'Concluído' })
  .transition('ABERTURA', 'ESTUDOS_PRELIMINARES', 'FORWARD', { isPrimary: true })
  .transition('ESTUDOS_PRELIMINARES', 'PESQUISA_PRECOS', 'FORWARD', {
    name: 'Encaminhar para pesquisa de preços',
    isPrimary: true,
    allowDueDateOverride: false,
  })
  .transition('ESTUDOS_PRELIMINARES', 'COTACAO', 'FORWARD', {
    name: 'Encaminhar para cotação',
    requiresComment: true,
    allowDueDateOverride: true,
  })
  .transition('ESTUDOS_PRELIMINARES', 'ANALISE', 'FORWARD', { name: 'Encaminhar para análise' })
  .transition('ESTUDOS_PRELIMINARES', 'ABERTURA', 'RETURN')
  .rule(
    'REQUIRED_DOCUMENT',
    { documentTypeCode: 'ETP', minStatus: 'COMPLETE' },
    { stage: 'ESTUDOS_PRELIMINARES' },
    { name: 'ETP completo', message: ETP_MESSAGE },
  )
  .rule(
    'REQUIRED_DOCUMENT',
    { documentTypeCode: 'RISK_MAP', minStatus: 'EXISTS' },
    { stage: 'ESTUDOS_PRELIMINARES' },
    { name: 'Mapa de riscos', message: RISK_MESSAGE, severity: 'WARNING' },
  );

const transitionOf = (key: string): string => {
  const transition = flow.transitions.find((candidate) => candidate.key === key);
  if (!transition) throw new Error(`transição ${key} ausente`);
  return transition.id;
};
const TO_PESQUISA = transitionOf('ESTUDOS_PRELIMINARES_FORWARD_PESQUISA_PRECOS');
const TO_COTACAO = transitionOf('ESTUDOS_PRELIMINARES_FORWARD_COTACAO');
const TO_ANALISE = transitionOf('ESTUDOS_PRELIMINARES_FORWARD_ANALISE');
const RETURN_ABERTURA = transitionOf('ESTUDOS_PRELIMINARES_RETURN_ABERTURA');
const WARNING_RULE = flow.rules.find((rule) => rule.severity === 'WARNING')?.id ?? '';

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

/** Idempotência que pode ficar indisponível (Redis fora — Falha de integração). */
class ToggleIdempotencyStore implements IdempotencyStorePort {
  down = false;
  private readonly inner = new InMemoryIdempotencyStore();

  begin(key: string, bodyHash: string, ttlMs: number): Promise<IdempotencyRecord | null> {
    if (this.down) return Promise.reject(new Error('ECONNREFUSED redis'));
    return this.inner.begin(key, bodyHash, ttlMs);
  }

  complete(key: string, record: IdempotencyRecord & { state: 'DONE' }, ttlMs: number) {
    if (this.down) return Promise.reject(new Error('ECONNREFUSED redis'));
    return this.inner.complete(key, record, ttlMs);
  }

  release(key: string): Promise<void> {
    if (this.down) return Promise.reject(new Error('ECONNREFUSED redis'));
    return this.inner.release(key);
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

describe('Feature: Encaminhar processo (US-047)', () => {
  let api: TestApi;
  let facts: TestDocumentFacts;
  let warn: MockInstance<Logger['warn']>;
  const transactions = new FlakyTransactions();
  const idempotency = new ToggleIdempotencyStore();
  let catalog: { contractingType: string; origin: string; unit: string };
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
  const forward = (
    process: Pick<Process, 'id' | 'currentStageId' | 'version'>,
    body: Record<string, unknown>,
    options: { subject?: string; tenant?: string; ifMatch?: string | null; key?: string } = {},
  ) => {
    const call = auth(
      request(api.server).post(`/api/v1/processes/${process.id}/forward`),
      options.subject,
      options.tenant,
    ).set('Idempotency-Key', options.key ?? randomUUID());
    if (options.ifMatch !== null) {
      call.set('If-Match', options.ifMatch ?? `"${String(process.version)}"`);
    }
    return call.send({ expectedStageId: process.currentStageId, ...body });
  };
  const actionsOf = async (processId: string, subject = 'sub-ana') => {
    const response = await auth(
      request(api.server).get(`/api/v1/processes/${processId}/available-actions`),
      subject,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return z.array(actionEntrySchema).parse(data<ActionEntry[]>(response));
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
  const timelineOf = (processId: string, type: string) =>
    timelineRowsOf(api).filter((row) => row.processId === processId && row.type === type);
  /** Efeitos gravados do processo (para provar que nada foi gravado numa recusa). */
  const effects = (processId: string) => ({
    process: stored(processId),
    stages: repository().stagesOf(processId).length,
    movements: repository().movementsOf(processId).length,
    events: eventsOf(processId).length,
    audit: api.auditRecords().filter((row) => row.processId === processId).length,
  });

  /** Processo criado pelo PRC-02 (Ana responsável, na ABERTURA do workflow padrão). */
  async function createProcess(): Promise<Process> {
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
  }

  /**
   * Background: o processo "0012/2026" na etapa ESTUDOS_PRELIMINARES da Coordenadoria de
   * Planejamento, IN_PROGRESS, versão 14, com Paula (Ana) responsável — ETP finalizado e mapa de
   * riscos existente, salvo indicação.
   */
  async function processAtStudies(
    options: {
      readonly responsible?: string | null;
      readonly numbered?: boolean;
      readonly status?: Process['status'];
      readonly etpComplete?: boolean;
      readonly riskMap?: boolean;
    } = {},
  ): Promise<Process> {
    const created = await createProcess();
    const responsible = options.responsible === undefined ? FAKE_USERS.ana.id : options.responsible;
    const [opening] = repository().stagesOf(created.id);
    if (!opening) throw new Error('passagem de abertura ausente');
    repository().seedStage({
      ...opening,
      workflowStageId: flow.stageId('ABERTURA'),
      status: 'COMPLETED',
      exitedAt: new Date('2026-10-01T12:00:00.000Z'),
    });
    const studies = newId();
    repository().seedStage({
      id: studies,
      tenantId: A,
      processId: created.id,
      workflowStageId: flow.stageId('ESTUDOS_PRELIMINARES'),
      sequence: 2,
      status: 'ACTIVE',
      departmentId: PLANEJAMENTO,
      assigneeId: responsible,
      enteredAt: new Date('2026-10-01T12:00:00.000Z'),
      dueAt: null,
      slaDays: 15,
      slaType: 'BUSINESS',
      enteredViaMovementId: null,
    });
    const numbered = options.numbered ?? true;
    const process: Process = {
      ...created,
      workflowVersionId: FLOW_VERSION,
      status: options.status ?? 'IN_PROGRESS',
      currentStageId: studies,
      currentWorkflowStageId: flow.stageId('ESTUDOS_PRELIMINARES'),
      currentDepartmentId: PLANEJAMENTO,
      currentResponsibleId: responsible,
      number: numbered ? 12 : null,
      code: numbered ? '0012/2026' : null,
      openedAt: numbered ? created.createdAt : null,
      version: 14,
    };
    repository().seed(process, [
      { principalType: 'DEPARTMENT', departmentId: PLANEJAMENTO, reason: 'CURRENT' },
    ]);
    facts.set(process.id, [
      {
        documentTypeCode: 'ETP',
        status: options.etpComplete === false ? 'DRAFT' : 'FINALIZED',
        isComplete: options.etpComplete !== false,
        versionNumber: 2,
        approvedAt: null,
      },
      ...(options.riskMap === false
        ? []
        : [
            {
              documentTypeCode: 'RISK_MAP',
              status: 'DRAFT' as const,
              isComplete: false,
              versionNumber: null,
              approvedAt: null,
            },
          ]),
    ]);
    return process;
  }

  /** DFD completo em DRAFT (itens, seções e cabeçalho — US-014) no processo. */
  async function completeDfd(processId: string): Promise<DfdDto> {
    const item = await auth(request(api.server).post(`/api/v1/processes/${processId}/items`))
      .set('Idempotency-Key', randomUUID())
      .send({ kind: 'GOOD', description: 'Cimento CP II 50 kg', unitOfMeasureId: catalog.unit });
    expect(item.status, JSON.stringify(item.body)).toBe(201);
    const created = await auth(request(api.server).post(`/api/v1/processes/${processId}/dfds`))
      .set('Idempotency-Key', randomUUID())
      .send({});
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const dfd = data<DfdDto>(created);
    const saved = await auth(request(api.server).put(`/api/v1/documents/${dfd.documentId}/items`))
      .set('If-Match', '"1"')
      .send({ items: [{ processItemId: data<ProcessItemDto>(item).id, quantity: '100' }] });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    fillDfdDraft(
      api,
      dfd,
      {
        JUSTIFICATION: 'x'.repeat(380),
        EXPECTED_RESULTS: 'Manutenção contínua das vias do bairro Centro.',
      },
      { expectedDate: '2026-12-15', pcaStatus: 'PLANNED', pcaYear: 2026 },
    );
    return dfd;
  }

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    api = await createTestApi({
      providers: [
        { token: PROCESS_TRANSACTIONS, value: transactions },
        { token: PROCESS_CLOCK, value: () => NOW },
        { token: CATALOG_CLOCK, value: () => NOW },
        { token: IDEMPOTENCY_STORE, value: idempotency },
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
    const base = { tenantId: A, organizationId: ORG_A };
    seedDepartment(api, { ...base, id: PLANEJAMENTO, name: 'Coordenadoria de Planejamento' });
    seedDepartment(api, { ...base, id: COMPRAS, name: 'Departamento de Compras' });
    seedDepartment(api, { ...base, id: INATIVA, name: 'Unidade extinta', isActive: false });
    await seedPublishedInMemory(api, A, flow, 'TESTE_US047');
    await deactivateWorkflow(api, A, 'TESTE_US047');
    facts = registerTestDocumentFacts(api);
    assignDepartment(api, membershipOf(FAKE_USERS.ana.id), UNITS_A.manutencao);
    assignDepartment(api, membershipOf(FAKE_USERS.ana.id), PLANEJAMENTO);
    assignDepartment(api, membershipOf(FAKE_USERS.fabio.id), PLANEJAMENTO);
    assignDepartment(api, membershipOf(FAKE_USERS.lucia.id), COMPRAS);
    assignDepartment(api, membershipOf(FAKE_USERS.otavio.id), UNITS_A.saude);
    // Otávio só com SOMENTE_LEITURA (sem PROCESS_FORWARD em nenhum escopo).
    assignRole(api, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.otavio.id),
      roleId: seedDefaultRolesOf(api, A).get('SOMENTE_LEITURA')?.id ?? '',
    });
    setDepartmentHead(api, UNITS_A.obras, FAKE_USERS.marta.id);
    catalog = {
      contractingType: catalogItemId(api, A, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
      origin: catalogItemId(api, A, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
      unit: catalogItemId(api, A, 'UNIT_OF_MEASURE', 'UN'),
    };
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await api.close();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    transactions.down = false;
    idempotency.down = false;
  });

  describe('[Sucesso]', () => {
    it('Encaminhar para etapa de tarefa com registro completo: etapa, prazo, tramitação, acessos, timeline, auditoria, evento e ETag "15"', async () => {
      const process = await processAtStudies();
      const etp = await seedPanelDocument(api, {
        tenantId: A,
        processId: process.id,
        typeCode: 'ETP',
        code: 'ETP 0003/2026',
        title: 'Estudo técnico preliminar',
        status: 'FINALIZED',
        versionNumber: 2,
        createdById: FAKE_USERS.ana.id,
      });
      const riskMap = await seedPanelDocument(api, {
        tenantId: A,
        processId: process.id,
        typeCode: 'RISK_MAP',
        code: null,
        title: 'Mapa de riscos',
        status: 'DRAFT',
        createdById: FAKE_USERS.ana.id,
      });

      const response = await forward(process, {
        transitionId: TO_PESQUISA,
        comment: 'ETP concluído; seguem ETP e mapa de riscos',
        documentIds: [etp, riskMap],
      });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers.etag).toBe('"15"');
      const dto = forwardedProcessSchema.parse(data<ForwardedProcessDto>(response));
      expect(dto).toMatchObject({
        status: 'IN_PROGRESS',
        statusFrom: 'IN_PROGRESS',
        currentStage: { key: 'PESQUISA_PRECOS', name: 'Pesquisa de preços', dueAt: DUE_20_10 },
        currentDepartment: { id: COMPRAS, name: 'Departamento de Compras' },
        currentResponsible: null,
        movement: { sequence: 2 },
        numberAssigned: false,
        version: 15,
      });
      expect(dto.approval).toBeUndefined();

      const movement = repository().movementsOf(process.id).at(-1);
      expect(movement).toMatchObject({
        id: dto.movement.id,
        action: 'FORWARD',
        workflowTransitionId: TO_PESQUISA,
        fromProcessStageId: process.currentStageId,
        fromDepartmentId: PLANEJAMENTO,
        toDepartmentId: COMPRAS,
        fromUserId: FAKE_USERS.ana.id,
        toUserId: null,
        statusFrom: 'IN_PROGRESS',
        statusTo: 'IN_PROGRESS',
        actorType: 'USER',
        actorId: FAKE_USERS.ana.id,
        actorDepartmentId: PLANEJAMENTO,
        comment: 'ETP concluído; seguem ETP e mapa de riscos',
        dueAt: new Date(DUE_20_10),
        userAgent: USER_AGENT,
        occurredAt: NOW,
        documents: [
          {
            documentId: etp,
            versionNumber: 2,
            code: 'ETP 0003/2026',
            documentTypeCode: 'ETP',
            status: 'FINALIZED',
          },
          { documentId: riskMap, versionNumber: null, documentTypeCode: 'RISK_MAP' },
        ],
        metadata: {
          computedDueAt: DUE_20_10,
          dueDateOverridden: false,
          labels: {
            fromStage: 'ETP e mapa de riscos',
            toStage: 'Pesquisa de preços',
            fromDepartment: 'Coordenadoria de Planejamento',
            toDepartment: 'Departamento de Compras',
            fromUser: 'Ana Souza',
          },
          clientChannel: 'WEB',
        },
      });
      expect(movement?.ip).toEqual(expect.any(String));
      expect(movement?.correlationId).toEqual(expect.any(String));

      const stages = repository().stagesOf(process.id);
      expect(stages.filter((stage) => stage.status === 'ACTIVE')).toEqual([
        expect.objectContaining({
          sequence: 3,
          departmentId: COMPRAS,
          assigneeId: null,
          slaDays: 10,
          dueAt: new Date(DUE_20_10),
        }),
      ]);
      expect(stages.find((stage) => stage.id === process.currentStageId)).toMatchObject({
        status: 'COMPLETED',
        exitedAt: NOW,
      });
      expect(stored(process.id)).toMatchObject({
        currentDepartmentId: COMPRAS,
        currentResponsibleId: null,
        currentStageDueAt: new Date(DUE_20_10),
        version: 15,
      });

      // DEC-024: a Coordenadoria mantém acesso HISTORICAL; Compras recebe o CURRENT.
      const access = repository()
        .accessOf(process.id)
        .map((row) => [row.reason, row.departmentId ?? row.userId]);
      expect(access).toContainEqual(['HISTORICAL', PLANEJAMENTO]);
      expect(access).toContainEqual(['CURRENT', COMPRAS]);
      expect(access).not.toContainEqual(['CURRENT', PLANEJAMENTO]);

      expect(timelineOf(process.id, 'PROCESS_FORWARDED')).toEqual([
        expect.objectContaining({
          movementId: dto.movement.id,
          params: expect.objectContaining({
            toStageName: 'Pesquisa de preços',
            toDepartmentName: 'Departamento de Compras',
            dueAt: DUE_20_10,
            hasComment: true,
          }) as unknown,
        }),
      ]);
      const [audit] = auditOf(process.id, 'process.forward');
      expect(audit).toMatchObject({
        action: 'process.forward',
        category: 'WORKFLOW',
        metadata: {
          processCode: '0012/2026',
          movementId: dto.movement.id,
          transitionKey: 'ESTUDOS_PRELIMINARES_FORWARD_PESQUISA_PRECOS',
          fromStatus: 'IN_PROGRESS',
          toStatus: 'IN_PROGRESS',
          dueDateOverridden: false,
        },
      });
      expect(audit?.changes).toContainEqual({
        path: 'currentDepartmentId',
        old: PLANEJAMENTO,
        new: COMPRAS,
      });

      const [stageChanged, ...others] = eventsOf(process.id, 'ProcessStageChanged');
      expect(others).toEqual([]);
      expect(stageChanged).toMatchObject({
        routingKey: 'process.stage_changed.forward',
        payload: {
          cause: 'FORWARD',
          movementId: dto.movement.id,
          toStage: { key: 'PESQUISA_PRECOS', type: 'TASK' },
          fromDepartmentId: PLANEJAMENTO,
          toDepartmentId: COMPRAS,
          toUserId: null,
          dueAt: DUE_20_10,
          documentIds: [etp, riskMap],
          hasComment: true,
          approvalId: null,
        },
      });
      // Status igual (IN_PROGRESS) e fila da unidade: sem ProcessStatusChanged nem ProcessAssigned.
      expect(eventsOf(process.id, 'ProcessStatusChanged')).toEqual([]);
      expect(eventsOf(process.id, 'ProcessAssigned')).toEqual([]);
      // RN-TRAM-22: nada de comentário nem valores no payload.
      expect(JSON.stringify(stageChanged?.payload)).not.toContain('ETP concluído');
    });

    it('Encaminhar para aprovação submete o DFD automaticamente: IN_REVIEW v1 SUBMISSION, aprovação PENDING do titular, AWAITING_APPROVAL', async () => {
      const process = await createProcess();
      const dfd = await completeDfd(process.id);
      const [entry] = (await actionsOf(process.id)).filter((action) => action.action === 'FORWARD');
      expect(entry).toMatchObject({
        transitionKey: 'ENVIAR_APROVACAO_DFD',
        toStageKey: 'APROVACAO_DFD',
        toStageType: 'APPROVAL',
        enabled: true,
        approverPreview: {
          type: 'DEPARTMENT_HEAD',
          label: 'Marta Ribeiro (titular da Secretaria de Obras)',
          userId: FAKE_USERS.marta.id,
          departmentId: UNITS_A.obras,
        },
      });
      const current = stored(process.id);

      const response = await forward(current, { transitionId: entry?.transitionId });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const dto = forwardedProcessSchema.parse(data<ForwardedProcessDto>(response));
      expect(dto).toMatchObject({
        status: 'AWAITING_APPROVAL',
        statusFrom: 'DRAFT',
        currentStage: { key: 'APROVACAO_DFD' },
        currentDepartment: { id: UNITS_A.obras },
        currentResponsible: null,
        approval: { approverLabel: 'Marta Ribeiro (titular da Secretaria de Obras)' },
      });
      const approvalId = dto.approval?.id ?? '';

      const document = documentRepositoryOf(api)
        .allDocuments()
        .find((candidate) => candidate.id === dfd.documentId);
      expect(document).toMatchObject({ status: 'IN_REVIEW', pendingApprovalId: approvalId });
      const [version, ...moreVersions] = documentRepositoryOf(api).versionsOf(dfd.documentId);
      expect(moreVersions).toEqual([]);
      expect(version).toMatchObject({ versionNumber: 1, reason: 'SUBMISSION' });
      expect(version?.contentHash).toMatch(/^[0-9a-f]{64}$/);

      const approval = approvalRepositoryOf(api)
        .approvals()
        .find((candidate) => candidate.id === approvalId);
      const entered = repository()
        .stagesOf(process.id)
        .find((stage) => stage.status === 'ACTIVE');
      expect(approval).toMatchObject({
        status: 'PENDING',
        subjectType: 'PROCESS_STAGE',
        processStageId: entered?.id,
        approverType: 'DEPARTMENT_HEAD',
        approverUserId: FAKE_USERS.marta.id,
        approverDepartmentId: UNITS_A.obras,
        allowDeputy: true,
        requestedById: FAKE_USERS.ana.id,
        dueAt: entered?.dueAt,
      });
      // Exatamente a versão 1 do DFD.
      expect(approvalRepositoryOf(api).coverageOf(approvalId)).toEqual([
        expect.objectContaining({ documentId: dfd.documentId, documentVersionId: version?.id }),
      ]);
      expect(repository().movementsOf(process.id).at(-1)).toMatchObject({
        statusFrom: 'DRAFT',
        statusTo: 'AWAITING_APPROVAL',
        documents: [
          {
            documentId: dfd.documentId,
            status: 'IN_REVIEW',
            versionNumber: 1,
            documentTypeCode: 'DFD',
          },
        ],
        metadata: { approvalRequestedId: approvalId },
      });

      // O aviso ao aprovador sai do ApprovalRequested; a etapa APPROVAL não gera PROCESS_RECEIVED.
      expect(eventsOf(process.id, 'ApprovalRequested')).toEqual([
        expect.objectContaining({
          routingKey: 'approval.requested',
          payload: expect.objectContaining({
            approvalId,
            subjectType: 'PROCESS_STAGE',
            approverUserId: FAKE_USERS.marta.id,
            documentVersionIds: [version?.id],
          }) as unknown,
        }),
      ]);
      expect(eventsOf(process.id, 'ProcessStageChanged').at(-1)?.payload).toMatchObject({
        toStage: { key: 'APROVACAO_DFD', type: 'APPROVAL' },
        approvalId,
      });
      expect(eventsOf(process.id, 'ProcessStatusChanged').at(-1)).toMatchObject({
        routingKey: 'process.status_changed.awaiting_approval',
        payload: { fromStatus: 'DRAFT', toStatus: 'AWAITING_APPROVAL', cause: 'FORWARD' },
      });
      expect(eventsOf(process.id, 'DocumentSubmitted')).toHaveLength(1);
      expect(auditOf(process.id, 'approval.request')).toHaveLength(1);
      expect(
        repository()
          .accessOf(process.id)
          .map((row) => [row.reason, row.userId]),
      ).toContainEqual(['APPROVER', FAKE_USERS.marta.id]);
      expect(timelineOf(process.id, 'APPROVAL_REQUESTED')).toHaveLength(1);
    });

    it('Autuação no primeiro encaminhamento: código "0012/2026", openedAt, ProcessNumberAssigned e process.number_assign', async () => {
      const settings = tenantSettingsOf(api);
      settings.seed(A, 'numbering.process.assignOn', 'START');
      numberSequencesOf(api).seed(A, 'PROCESS:*:2026', 11);
      try {
        const process = await processAtStudies({ numbered: false });
        const response = await forward(process, { transitionId: TO_PESQUISA });
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        expect(data<ForwardedProcessDto>(response)).toMatchObject({
          code: '0012/2026',
          number: 12,
          numberAssigned: true,
        });
        expect(stored(process.id)).toMatchObject({ code: '0012/2026', openedAt: NOW });
        expect(eventsOf(process.id, 'ProcessNumberAssigned')).toEqual([
          expect.objectContaining({
            routingKey: 'process.number_assigned',
            payload: { number: 12, year: 2026, code: '0012/2026' },
          }),
        ]);
        expect(auditOf(process.id, 'process.number_assign')).toEqual([
          expect.objectContaining({ metadata: { number: 12, year: 2026, code: '0012/2026' } }),
        ]);
        expect(timelineOf(process.id, 'PROCESS_NUMBER_ASSIGNED')).toHaveLength(1);
      } finally {
        settings.seed(A, 'numbering.process.assignOn', 'CREATE', 2);
      }
    });

    it('FA-03/FA-04: atribuição direta a quem está lotado no destino e prazo alterado com motivo', async () => {
      const process = await processAtStudies();
      const response = await forward(process, {
        transitionId: TO_COTACAO,
        toDepartmentId: COMPRAS,
        toUserId: FAKE_USERS.lucia.id,
        dueAt: '2026-10-30',
        dueDateOverrideReason: 'Volume alto de itens',
        comment: 'Cotação com prioridade para itens de obra.',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(data<ForwardedProcessDto>(response)).toMatchObject({
        currentStage: { key: 'COTACAO', dueAt: '2026-10-31T02:59:59.999Z' },
        currentResponsible: { id: FAKE_USERS.lucia.id },
      });
      const entered = repository()
        .stagesOf(process.id)
        .find((stage) => stage.status === 'ACTIVE');
      expect(entered).toMatchObject({
        assigneeId: FAKE_USERS.lucia.id,
        dueDateOverridden: true,
        dueDateOverrideReason: 'Volume alto de itens',
      });
      expect(repository().assignmentsOf(process.id).at(-1)).toMatchObject({
        assigneeId: FAKE_USERS.lucia.id,
        assignedById: FAKE_USERS.ana.id,
        type: 'STAGE_ENTRY',
        isActive: true,
      });
      // O prazo calculado (3 dias úteis) fica na metadata.
      expect(repository().movementsOf(process.id).at(-1)?.metadata).toMatchObject({
        computedDueAt: '2026-10-09T02:59:59.999Z',
        dueDateOverridden: true,
        dueDateOverrideReason: 'Volume alto de itens',
      });
      expect(eventsOf(process.id, 'ProcessAssigned')).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            assignmentType: 'STAGE_ENTRY',
            toUserId: FAKE_USERS.lucia.id,
            fromUserId: FAKE_USERS.ana.id,
          }) as unknown,
        }),
      ]);
      expect(
        repository()
          .accessOf(process.id)
          .map((row) => [row.reason, row.userId]),
      ).toContainEqual(['RESPONSIBLE', FAKE_USERS.lucia.id]);
    });

    it('FA-10: titular inelegível (não lotado no destino) → fila da unidade, sem erro', async () => {
      setDepartmentHead(api, COMPRAS, FAKE_USERS.marta.id);
      try {
        const process = await processAtStudies();
        const response = await forward(process, {
          transitionId: TO_COTACAO,
          toDepartmentId: COMPRAS,
          comment: 'Cotação dos itens de obra.',
        });
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        expect(data<ForwardedProcessDto>(response).currentResponsible).toBeNull();
      } finally {
        setDepartmentHead(api, COMPRAS, null);
      }
    });

    it('PRC-08: prévia de cada transição — unidade, prazo, comentário e sobrescrita; transição primária primeiro', async () => {
      const process = await processAtStudies();
      const forwards = (await actionsOf(process.id)).filter((entry) => entry.action === 'FORWARD');
      expect(forwards.map((entry) => entry.transitionId)).toEqual([
        TO_PESQUISA,
        TO_COTACAO,
        TO_ANALISE,
      ]);
      expect(forwards[0]).toMatchObject({
        primary: true,
        enabled: true,
        toStageName: 'Pesquisa de preços',
        toStageType: 'TASK',
        departmentResolution: {
          mode: 'FIXED',
          departmentId: COMPRAS,
          departmentName: 'Departamento de Compras',
        },
        requiresComment: false,
        allowDueDateOverride: false,
        dueAtPreview: DUE_20_10,
        approverPreview: null,
      });
      expect(forwards[1]).toMatchObject({
        departmentResolution: { mode: 'CHOSEN_ON_FORWARD' },
        requiresComment: true,
        allowDueDateOverride: true,
      });
    });
  });

  describe('[Validação]', () => {
    it('Etapa com unidade escolhida no encaminhamento sem unidade: 422 DEPARTMENT_REQUIRED e nada gravado', async () => {
      const process = await processAtStudies();
      const before = effects(process.id);
      const response = await forward(process, {
        transitionId: TO_COTACAO,
        comment: 'Segue.' + 'x'.repeat(10),
      });
      expectProblem(response, 422, 'DEPARTMENT_REQUIRED');
      expect(effects(process.id)).toEqual(before);
    });

    it('Pendência obrigatória impede o encaminhamento: 422 TRANSITION_BLOCKED com a violação WORKFLOW_RULE BLOCKING', async () => {
      const process = await processAtStudies({ etpComplete: false });
      const before = effects(process.id);
      const body = expectProblem(
        await forward(process, { transitionId: TO_PESQUISA }),
        422,
        'TRANSITION_BLOCKED',
      );
      expect(body.violations).toContainEqual(
        expect.objectContaining({
          code: 'WORKFLOW_RULE',
          severity: 'BLOCKING',
          message: ETP_MESSAGE,
        }),
      );
      expect(body.detail).toBe('Há 1 pendência obrigatória na etapa.');
      expect(effects(process.id)).toEqual(before);
    });

    it('Aviso precisa ser reconhecido e fica registrado com id e mensagem na tramitação e na auditoria', async () => {
      const process = await processAtStudies({ riskMap: false });
      const refused = expectProblem(
        await forward(process, { transitionId: TO_PESQUISA }),
        422,
        'WARNINGS_NOT_ACKNOWLEDGED',
      );
      expect(refused.violations).toEqual([
        expect.objectContaining({
          ruleId: WARNING_RULE,
          severity: 'WARNING',
          message: RISK_MESSAGE,
        }),
      ]);

      const response = await forward(process, {
        transitionId: TO_PESQUISA,
        acknowledgedWarnings: [WARNING_RULE, newId()],
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const acknowledged = [{ ruleId: WARNING_RULE, message: RISK_MESSAGE }];
      expect(repository().movementsOf(process.id).at(-1)?.metadata).toMatchObject({
        warningsAcknowledged: acknowledged,
      });
      expect(auditOf(process.id, 'process.forward').at(-1)?.metadata).toMatchObject({
        warningsAcknowledged: acknowledged,
      });
    });

    it('Prazo alterado sem autorização da transição: 422 DUE_DATE_OVERRIDE_NOT_ALLOWED', async () => {
      const process = await processAtStudies();
      expectProblem(
        await forward(process, {
          transitionId: TO_PESQUISA,
          dueAt: '2026-10-30',
          dueDateOverrideReason: 'Volume alto de itens',
        }),
        422,
        'DUE_DATE_OVERRIDE_NOT_ALLOWED',
      );
    });

    it('Prazo sobrescrito no passado, além de 365 dias ou sem motivo: 422 VALIDATION_ERROR', async () => {
      const process = await processAtStudies();
      const errorsOf = async (body: Record<string, unknown>) =>
        expectProblem(
          await forward(process, {
            transitionId: TO_COTACAO,
            toDepartmentId: COMPRAS,
            comment: 'Cotação dos itens de obra.',
            ...body,
          }),
          422,
          'VALIDATION_ERROR',
        ).errors.map((error) => [error.field, error.code]);
      expect(
        await errorsOf({ dueAt: '2026-10-01', dueDateOverrideReason: 'Antecipar a cotação' }),
      ).toEqual([['dueAt', 'DATE_IN_PAST']]);
      expect(
        await errorsOf({ dueAt: '2027-12-01', dueDateOverrideReason: 'Prazo muito longo' }),
      ).toEqual([['dueAt', 'OUT_OF_RANGE']]);
      expect(await errorsOf({ dueAt: '2026-10-30' })).toEqual([
        ['dueDateOverrideReason', 'CONDITIONAL_REQUIRED'],
      ]);
    });

    it('Atribuição direta a pessoa não lotada no destino: 422 ASSIGNEE_NOT_ELIGIBLE', async () => {
      const process = await processAtStudies();
      expectProblem(
        await forward(process, { transitionId: TO_PESQUISA, toUserId: FAKE_USERS.otavio.id }),
        422,
        'ASSIGNEE_NOT_ELIGIBLE',
      );
    });

    it('Comentário obrigatório, corpo inválido, documentos repetidos ou de outro processo e atribuição em aprovação: 422 VALIDATION_ERROR', async () => {
      const process = await processAtStudies();
      const fields = async (body: Record<string, unknown>) =>
        expectProblem(await forward(process, body), 422, 'VALIDATION_ERROR').errors.map((error) => [
          error.field,
          error.code,
        ]);
      expect(await fields({ transitionId: TO_COTACAO, toDepartmentId: COMPRAS })).toEqual([
        ['comment', 'CONDITIONAL_REQUIRED'],
      ]);
      expect(
        await fields({ transitionId: TO_COTACAO, toDepartmentId: COMPRAS, comment: 'curto' }),
      ).toEqual([['comment', 'TOO_SHORT']]);
      expect(await fields({ transitionId: 'nao-e-uuid' })).toEqual([
        ['transitionId', 'INVALID_FORMAT'],
      ]);
      const repeated = newId();
      expect(
        await fields({ transitionId: TO_PESQUISA, documentIds: [repeated, repeated] }),
      ).toEqual([['documentIds', 'DUPLICATE_IN_LIST']]);
      expect(await fields({ transitionId: TO_PESQUISA, documentIds: [newId()] })).toEqual([
        ['documentIds[0]', 'REFERENCE_NOT_FOUND'],
      ]);
      expect(await fields({ transitionId: TO_PESQUISA, comment: 'x'.repeat(5001) })).toEqual([
        ['comment', 'TOO_LONG'],
      ]);
      expect(await fields({ transitionId: TO_PESQUISA, toDepartmentId: PLANEJAMENTO })).toEqual([
        ['toDepartmentId', 'NOT_ALLOWED'],
      ]);
    });

    it('Transição de outra ação, inexistente ou com unidade de destino inativa: 422 TRANSITION_NOT_AVAILABLE', async () => {
      const process = await processAtStudies();
      for (const transitionId of [RETURN_ABERTURA, newId()]) {
        expectProblem(await forward(process, { transitionId }), 422, 'TRANSITION_NOT_AVAILABLE');
      }
      const inactive = expectProblem(
        await forward(process, { transitionId: TO_ANALISE }),
        422,
        'TRANSITION_NOT_AVAILABLE',
      );
      expect(inactive.detail).toContain('inativa');
      expect(
        expectProblem(
          await forward(process, {
            transitionId: TO_COTACAO,
            toDepartmentId: INATIVA,
            comment: 'Cotação dos itens de obra.',
          }),
          422,
          'VALIDATION_ERROR',
        ).errors.map((error) => [error.field, error.code]),
      ).toEqual([['toDepartmentId', 'REFERENCE_INACTIVE']]);
    });

    it('Aprovador não resolvido: 422 APPROVER_UNRESOLVED, DFD continua em DRAFT e nada gravado', async () => {
      setDepartmentHead(api, UNITS_A.obras, null);
      try {
        const process = await createProcess();
        const dfd = await completeDfd(process.id);
        const [entry] = (await actionsOf(process.id)).filter(
          (action) => action.action === 'FORWARD',
        );
        expect(entry).toMatchObject({
          enabled: false,
          approverPreview: null,
          reasons: [expect.objectContaining({ code: 'APPROVER_UNRESOLVED' })],
        });
        const current = stored(process.id);
        const before = effects(process.id);
        expectProblem(
          await forward(current, { transitionId: entry?.transitionId }),
          422,
          'APPROVER_UNRESOLVED',
        );
        expect(effects(process.id)).toEqual(before);
        expect(
          documentRepositoryOf(api)
            .allDocuments()
            .find((candidate) => candidate.id === dfd.documentId)?.status,
        ).toBe('DRAFT');
        expect(documentRepositoryOf(api).versionsOf(dfd.documentId)).toEqual([]);
      } finally {
        setDepartmentHead(api, UNITS_A.obras, FAKE_USERS.marta.id);
      }
    });
  });

  describe('[Permissão]', () => {
    it('Usuário sem custódia: "Encaminhar" desabilitado com o motivo e POST 403 NOT_PROCESS_CUSTODIAN com access.denied', async () => {
      const process = await processAtStudies();
      const [entry] = (await actionsOf(process.id, 'sub-fabio')).filter(
        (action) => action.action === 'FORWARD',
      );
      expect(entry).toMatchObject({
        enabled: false,
        reasons: [expect.objectContaining({ code: 'NOT_PROCESS_CUSTODIAN' })],
      });
      const before = effects(process.id);
      expectProblem(
        await forward(process, { transitionId: TO_PESQUISA }, { subject: 'sub-fabio' }),
        403,
        'NOT_PROCESS_CUSTODIAN',
      );
      expect(api.auditRecords().at(-1)).toMatchObject({
        action: 'access.denied',
        reasonCode: 'NOT_PROCESS_CUSTODIAN',
      });
      expect(effects(process.id).movements).toBe(before.movements);
    });

    it('Lotado na unidade com o processo na fila tem a custódia (POL-01)', async () => {
      const process = await processAtStudies({ responsible: null });
      const response = await forward(
        process,
        { transitionId: TO_PESQUISA },
        { subject: 'sub-fabio' },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
    });

    it('Sem PROCESS_FORWARD em nenhum escopo: 403 PERMISSION_DENIED', async () => {
      const process = await processAtStudies();
      expectProblem(
        await forward(process, { transitionId: TO_PESQUISA }, { subject: 'sub-otavio' }),
        403,
        'PERMISSION_DENIED',
      );
    });

    it('Processo suspenso não pode ser encaminhado: 409 INVALID_PROCESS_STATUS', async () => {
      const process = await processAtStudies({ status: 'SUSPENDED' });
      repository().setSituation(process.id, { statusBeforeSuspension: 'IN_PROGRESS' });
      const body = expectProblem(
        await forward(process, { transitionId: TO_PESQUISA }),
        409,
        'INVALID_PROCESS_STATUS',
      );
      expect(body.detail).toBe('O processo está suspenso e não pode ser encaminhado.');
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Processo de outro tenant = 404 PROCESS_NOT_FOUND; unidade de outro tenant = 422 REFERENCE_NOT_FOUND', async () => {
      const process = await processAtStudies();
      expectProblem(
        await forward(process, { transitionId: TO_PESQUISA }, { subject: 'sub-heitor', tenant: B }),
        404,
        'PROCESS_NOT_FOUND',
      );
      const body = expectProblem(
        await forward(process, {
          transitionId: TO_COTACAO,
          toDepartmentId: UNITS_B.obras,
          comment: 'Cotação dos itens de obra.',
        }),
        422,
        'VALIDATION_ERROR',
      );
      expect(body.errors).toEqual([
        expect.objectContaining({ field: 'toDepartmentId', code: 'REFERENCE_NOT_FOUND' }),
      ]);
      expect(stored(process.id).version).toBe(14);
    });
  });

  describe('[Duplicidade]', () => {
    it('Reenvio com a mesma chave de idempotência: 200 com Idempotent-Replayed e uma única tramitação e etapa ativa', async () => {
      const process = await processAtStudies();
      const key = randomUUID();
      const first = await forward(process, { transitionId: TO_PESQUISA }, { key });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      const replay = await forward(process, { transitionId: TO_PESQUISA }, { key });
      expect(replay.status, JSON.stringify(replay.body)).toBe(200);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toEqual(first.body);
      expect(
        repository()
          .movementsOf(process.id)
          .filter((movement) => movement.action === 'FORWARD'),
      ).toHaveLength(1);
      expect(
        repository()
          .stagesOf(process.id)
          .filter((stage) => stage.status === 'ACTIVE'),
      ).toHaveLength(1);

      expectProblem(
        await forward(
          process,
          { transitionId: TO_PESQUISA, comment: 'Outro corpo qualquer.' },
          { key },
        ),
        422,
        'IDEMPOTENCY_KEY_REUSED',
      );
    });
  });

  describe('[Concorrência]', () => {
    it('Dois custodiantes encaminham ao mesmo tempo: um 200, o outro 409 STAGE_CHANGED; uma etapa ativa e uma tramitação nova', async () => {
      const process = await processAtStudies({ responsible: null });
      const [paula, marcos] = await Promise.all([
        forward(process, { transitionId: TO_PESQUISA }),
        forward(process, { transitionId: TO_PESQUISA }, { subject: 'sub-fabio' }),
      ]);
      const statuses = [paula.status, marcos.status].sort();
      expect(statuses).toEqual([200, 409]);
      const loser = paula.status === 409 ? paula : marcos;
      const body = expectProblem(loser, 409, 'STAGE_CHANGED');
      expect(body.detail).toBe('O processo acabou de ser movimentado por outra pessoa.');
      expect(
        repository()
          .stagesOf(process.id)
          .filter((stage) => stage.status === 'ACTIVE'),
      ).toHaveLength(1);
      expect(
        repository()
          .movementsOf(process.id)
          .filter((movement) => movement.action === 'FORWARD'),
      ).toHaveLength(1);
    });

    it('Versão desatualizada: 412 VERSION_CONFLICT; etapa esperada diferente vem antes (409 STAGE_CHANGED); sem If-Match 428', async () => {
      const process = await processAtStudies();
      repository().replace({ ...stored(process.id), version: 15 });
      const conflict = await forward(process, { transitionId: TO_PESQUISA }, { ifMatch: '"14"' });
      expectProblem(conflict, 412, 'VERSION_CONFLICT');
      expect(conflict.body).toMatchObject({ currentVersion: 15, sentVersion: 14 });
      expectProblem(
        await forward(
          { ...process, currentStageId: newId() },
          { transitionId: TO_PESQUISA },
          { ifMatch: '"14"' },
        ),
        409,
        'STAGE_CHANGED',
      );
      expectProblem(
        await forward(process, { transitionId: TO_PESQUISA }, { ifMatch: null }),
        428,
        'PRECONDITION_REQUIRED',
      );
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível durante o encaminhamento: 503 DEPENDENCY_UNAVAILABLE e nada gravado', async () => {
      const process = await processAtStudies();
      const before = effects(process.id);
      transactions.down = true;
      expectProblem(
        await forward(process, { transitionId: TO_PESQUISA }),
        503,
        'DEPENDENCY_UNAVAILABLE',
      );
      transactions.down = false;
      expect(effects(process.id)).toEqual(before);
    });
  });

  describe('[Falha de integração]', () => {
    it('Redis indisponível para idempotência: o encaminhamento é concluído e registra idempotency.store_unavailable', async () => {
      const process = await processAtStudies();
      idempotency.down = true;
      const response = await forward(process, { transitionId: TO_PESQUISA });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^idempotency\.store_unavailable/));
    });
  });
});
