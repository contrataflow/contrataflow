import { randomUUID } from 'node:crypto';

import { problemDetailsSchema, riskListMetaSchema, riskSchema } from '@contrataflow/validation';
import type { ProcessDto, RiskDto, RiskListMetaDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { z } from 'zod';

import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import {
  buildDocument,
  documentRepositoryOf,
  documentTypeRepositoryOf,
} from '../../../../test/support/document-fixtures.js';
import {
  CATALOG_CLOCK,
  catalogItemId,
  processRepositoryOf,
  runTenantSeeders,
  seedProcessStructure,
  tenantSettingsOf,
  timelineRowsOf,
  workflowStagesOf,
} from '../../../../test/support/process-fixtures.js';
import {
  assignDepartment,
  assignRole,
  seedDefaultRolesOf,
} from '../../../../test/support/structure-fixtures.js';
import { RISK_CLOCK, RISK_TRANSACTIONS } from '../application/ports.js';
import type { RiskTransactions } from '../application/ports.js';
import { InMemoryRiskRepository } from '../infrastructure/in-memory-risk.repository.js';

/*
 * US-033 — RSK-01..05 (registrar e avaliar riscos) pelo pipeline HTTP completo (autenticação,
 * tenant, vínculo, autorização, `If-Match`, `Idempotency-Key`, filtro RFC 9457) com a identidade
 * fake, os seeders reais (catálogo `RISK_CATEGORY`, perfis, tipos de documento e workflow padrão)
 * e o processo criado pelo PRC-02 e levado à etapa "ETP e mapa de riscos". As 8 categorias do
 * Gherkin. Ana (REQUISITANTE — tem RISK_MANAGE) é a responsável; Fábio (COMPRAS, sem RISK_MANAGE);
 * Otávio (SOMENTE_LEITURA); Lúcia recebe PLANEJAMENTO (RISK_MANAGE, escopo TENANT) sem custódia.
 * Trava de numeração, RLS e rollback no PostgreSQL: `test/tenant-leak/risks.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-17T15:00:00.000Z');

const UNITS_A = {
  organizationId: '0192d033-0000-7000-8000-0000000000a0',
  obras: '0192d033-0000-7000-8000-0000000000a1',
  manutencao: '0192d033-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d033-0000-7000-8000-0000000000a3',
  saude: '0192d033-0000-7000-8000-0000000000a4',
  posto: '0192d033-0000-7000-8000-0000000000a5',
};
const UNITS_B = {
  organizationId: '0192d033-0000-7000-8000-0000000000b0',
  obras: '0192d033-0000-7000-8000-0000000000b1',
  manutencao: '0192d033-0000-7000-8000-0000000000b2',
  pavimentacao: '0192d033-0000-7000-8000-0000000000b3',
  saude: '0192d033-0000-7000-8000-0000000000b4',
  posto: '0192d033-0000-7000-8000-0000000000b5',
};

/** O agregado do processo como o repositório em memória o guarda (sem importar o domínio de `process`). */
type Process = Parameters<ReturnType<typeof processRepositoryOf>['replace']>[0];

const membershipOf = (userId: string, tenantId = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

/** Transações em fila (como as do módulo) que podem simular o banco fora do ar. */
class FlakyTransactions implements RiskTransactions {
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

const pathsOf = (changes: unknown) =>
  ((changes ?? []) as readonly { readonly path: string }[]).map((change) => change.path);

const fieldErrors = (response: request.Response) =>
  problemDetailsSchema.parse(response.body).errors.map((error) => [error.field, error.code]);

describe('Feature: Registrar e avaliar riscos (US-033)', () => {
  let api: TestApi;
  let log: MockInstance<Logger['log']>;
  const transactions = new FlakyTransactions();
  let categories: { market: string; deadline: string; foreign: string };
  let catalog: { contractingType: string; origin: string };
  const words = (count: number) =>
    Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

  const auth = (call: request.Test, subject = 'sub-ana', tenant: string = A) =>
    call
      .set('Authorization', api.bearer(subject, { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', tenant);
  const list = (processId: string, subject = 'sub-ana', tenant: string = A, query = '') =>
    auth(request(api.server).get(`/api/v1/processes/${processId}/risks${query}`), subject, tenant);
  const create = (
    processId: string,
    payload: Record<string, unknown>,
    options: { subject?: string; key?: string; tenant?: string } = {},
  ) =>
    auth(
      request(api.server).post(`/api/v1/processes/${processId}/risks`),
      options.subject,
      options.tenant,
    )
      .set('Idempotency-Key', options.key ?? randomUUID())
      .send(payload);
  const getRisk = (riskId: string, subject = 'sub-ana', tenant: string = A) =>
    auth(request(api.server).get(`/api/v1/risks/${riskId}`), subject, tenant);
  const patch = (
    riskId: string,
    payload: Record<string, unknown>,
    ifMatch = '"1"',
    subject = 'sub-ana',
    tenant: string = A,
  ) =>
    auth(request(api.server).patch(`/api/v1/risks/${riskId}`), subject, tenant)
      .set('If-Match', ifMatch)
      .send(payload);
  const remove = (riskId: string, ifMatch = '"1"', subject = 'sub-ana', tenant: string = A) =>
    auth(request(api.server).delete(`/api/v1/risks/${riskId}`), subject, tenant).set(
      'If-Match',
      ifMatch,
    );

  const riskStore = () => api.app.get(InMemoryRiskRepository, { strict: false });
  const risksOf = (processId: string) =>
    riskStore()
      .snapshot()
      .filter((risk) => risk.processId === processId);
  const eventsOf = (processId: string, eventType?: string) =>
    api
      .outboxRows()
      .filter(
        (row) =>
          row.processId === processId &&
          row.eventType.startsWith('Risk') &&
          (eventType === undefined || row.eventType === eventType),
      );
  const auditOf = (processId: string, action?: string) =>
    api
      .auditRecords()
      .filter(
        (row) =>
          row.processId === processId &&
          row.action.startsWith('risk.') &&
          (action === undefined || row.action === action),
      );
  const timelineOf = (processId: string) =>
    timelineRowsOf(api).filter(
      (row) => row.processId === processId && row.type.startsWith('RISK_'),
    );
  const risk = (body: Partial<Record<string, unknown>> = {}) => ({
    title: 'Fornecedores insuficientes',
    categoryId: categories.market,
    phase: 'PLANNING',
    cause: 'Mercado local com poucos fornecedores habilitados',
    consequence: 'Licitação deserta e atraso na contratação',
    probability: 4,
    impact: 4,
    ...body,
  });

  /** Processo criado pelo PRC-02 (Ana responsável) na etapa "ETP e mapa de riscos". */
  async function processWith(
    fields: Partial<Process> = {},
    stageKey = 'ESTUDOS_PRELIMINARES',
  ): Promise<Process> {
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
    const created = processRepositoryOf(api)
      .allProcesses()
      .find((candidate) => candidate.id === data<ProcessDto>(response).id);
    if (!created) throw new Error('processo ausente');
    const stage = workflowStagesOf(api, A).find(
      (candidate) =>
        candidate.key === stageKey && candidate.workflowVersionId === created.workflowVersionId,
    );
    const process: Process = {
      ...created,
      status: 'IN_PROGRESS',
      currentWorkflowStageId: stage?.id ?? created.currentWorkflowStageId,
      ...fields,
    };
    processRepositoryOf(api).replace(process);
    return process;
  }

  async function createOk(processId: string, payload: Record<string, unknown> = {}) {
    const response = await create(processId, risk(payload));
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return riskSchema.parse(data<RiskDto>(response));
  }

  /** O `RISK_MAP` do processo, no status do cenário (FA-04). */
  function seedRiskMap(process: Process, status: 'DRAFT' | 'FINALIZED' | 'RETURNED' | 'CANCELED') {
    const type = documentTypeRepositoryOf(api)
      .snapshot()
      .find((candidate) => candidate.tenantId === A && candidate.systemModule === 'RISK_MAP');
    if (!type) throw new Error('tipo RISK_MAP ausente');
    const document = buildDocument({
      tenantId: A,
      processId: process.id,
      documentTypeId: type.id,
      code: 'MR 0001/2026',
      title: 'Mapa de riscos',
      status,
      singletonKey: status === 'CANCELED' ? null : process.id,
    });
    documentRepositoryOf(api).seed(document);
    return document;
  }

  const metaOf = (response: request.Response): RiskListMetaDto =>
    riskListMetaSchema.parse((response.body as { meta: unknown }).meta);

  beforeAll(async () => {
    log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    api = await createTestApi({
      providers: [
        { token: RISK_TRANSACTIONS, value: transactions },
        { token: RISK_CLOCK, value: () => NOW },
        { token: CATALOG_CLOCK, value: () => NOW },
      ],
    });
    await runTenantSeeders(api, A);
    await runTenantSeeders(api, B, ['catalog.items', 'access.defaultRoles']);
    seedProcessStructure(api, A, { ...UNITS_A, shortName: 'PMSJ', cnpj: '11222333000181' });
    seedProcessStructure(api, B, { ...UNITS_B, shortName: 'PMB', cnpj: '60746948000112' });
    assignDepartment(api, membershipOf(FAKE_USERS.ana.id), UNITS_A.manutencao);
    const roles = seedDefaultRolesOf(api, A);
    assignRole(api, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.otavio.id),
      roleId: roles.get('SOMENTE_LEITURA')?.id ?? '',
    });
    assignRole(api, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.lucia.id),
      roleId: roles.get('PLANEJAMENTO')?.id ?? '',
    });
    categories = {
      market: catalogItemId(api, A, 'RISK_CATEGORY', 'MERCADO_FORNECEDOR'),
      deadline: catalogItemId(api, A, 'RISK_CATEGORY', 'PRAZO'),
      foreign: catalogItemId(api, B, 'RISK_CATEGORY', 'MERCADO_FORNECEDOR'),
    };
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
    it('Registrar um novo risco: R01, score 16, HIGH, scaleSnapshot, risk.create, RiskCreated e timeline', async () => {
      const process = await processWith();
      const response = await create(
        process.id,
        risk({
          ownerId: FAKE_USERS.ana.id,
          ownerDepartmentId: UNITS_A.manutencao,
          description: '  ',
        }),
      );
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const created = riskSchema.parse(data<RiskDto>(response));
      expect(response.headers.location).toBe(`/api/v1/risks/${created.id}`);
      expect(response.headers.etag).toBe('"1"');
      expect(created).toMatchObject({
        code: 'R01',
        score: 16,
        level: 'HIGH',
        status: 'OPEN',
        description: null,
        category: { id: categories.market, code: 'MERCADO_FORNECEDOR' },
        owner: { id: FAKE_USERS.ana.id, name: 'Ana Souza' },
        ownerDepartment: { id: UNITS_A.manutencao },
        residualScore: null,
        treatments: [],
        version: 1,
      });
      expect(created.scaleSnapshot).toEqual({
        scale: {
          max: 5,
          probabilityLabels: ['Muito baixa', 'Baixa', 'Média', 'Alta', 'Muito alta'],
          impactLabels: ['Muito baixo', 'Baixo', 'Médio', 'Alto', 'Muito alto'],
        },
        levelThresholds: [
          { level: 'LOW', minScore: 1, maxScore: 4 },
          { level: 'MEDIUM', minScore: 5, maxScore: 9 },
          { level: 'HIGH', minScore: 10, maxScore: 16 },
          { level: 'EXTREME', minScore: 17, maxScore: 25 },
        ],
      });

      const [audit] = auditOf(process.id, 'risk.create');
      expect(audit).toMatchObject({
        category: 'DATA_CHANGE',
        entityType: 'Risk',
        entityId: created.id,
        metadata: { code: 'R01', level: 'HIGH' },
      });
      expect(pathsOf(audit?.changes)).toEqual(['categoryId', 'phase', 'probability', 'impact']);
      const [event] = eventsOf(process.id, 'RiskCreated');
      expect(event).toMatchObject({
        routingKey: 'risk.created',
        aggregateId: created.id,
        payload: {
          riskId: created.id,
          code: 'R01',
          level: 'HIGH',
          phase: 'PLANNING',
          categoryCode: 'MERCADO_FORNECEDOR',
        },
      });
      expect(timelineOf(process.id)).toEqual([
        expect.objectContaining({
          type: 'RISK_ADDED',
          params: { code: 'R01', title: 'Fornecedores insuficientes', level: 'HIGH' },
        }),
      ]);
      // Logs sem título, causa nem consequência (story · "Logs").
      const logged = JSON.stringify(log.mock.calls);
      expect(logged).toContain('risk.created');
      expect(logged).not.toContain('Fornecedores insuficientes');
      expect(logged).not.toContain('poucos fornecedores');

      const listed = await list(process.id);
      expect(listed.status, JSON.stringify(listed.body)).toBe(200);
      expect(listed.headers['cache-control']).toBe('no-store');
      expect(
        z
          .array(riskSchema)
          .parse(data<RiskDto[]>(listed))
          .map((row) => row.code),
      ).toEqual(['R01']);
      expect(metaOf(listed)).toMatchObject({
        scale: { max: 5 },
        riskMap: null,
        canManage: true,
        lockReason: null,
      });
      const fetched = await getRisk(created.id);
      expect(fetched.status).toBe(200);
      expect(fetched.headers.etag).toBe('"1"');
    });

    it('Reavaliar um risco existente: 4×4 HIGH → 2×4 MEDIUM, RiskAssessed e risk.assess', async () => {
      const process = await processWith();
      const created = await createOk(process.id);
      const response = await patch(created.id, { probability: 2 });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers.etag).toBe('"2"');
      expect(data<RiskDto>(response)).toMatchObject({
        probability: 2,
        impact: 4,
        score: 8,
        level: 'MEDIUM',
        version: 2,
      });
      expect(eventsOf(process.id, 'RiskAssessed').map((row) => row.payload)).toEqual([
        { riskId: created.id, fromLevel: 'HIGH', toLevel: 'MEDIUM', score: 8 },
      ]);
      const [audit] = auditOf(process.id, 'risk.assess');
      expect(audit?.metadata).toMatchObject({
        fromScore: 16,
        toScore: 8,
        fromLevel: 'HIGH',
        toLevel: 'MEDIUM',
      });
      expect(timelineOf(process.id).at(-1)).toMatchObject({
        type: 'RISK_LEVEL_CHANGED',
        params: { code: 'R01', level: 'MEDIUM', fromLevel: 'HIGH' },
      });
    });

    it('FA-01: mesmo nível ainda emite RiskAssessed; edição sem P×I grava risk.update e nenhum evento', async () => {
      const process = await processWith();
      const created = await createOk(process.id);
      expect((await patch(created.id, { impact: 3 })).status).toBe(200);
      expect(eventsOf(process.id, 'RiskAssessed').map((row) => row.payload)).toEqual([
        { riskId: created.id, fromLevel: 'HIGH', toLevel: 'HIGH', score: 12 },
      ]);

      const edited = await patch(
        created.id,
        { title: 'Poucos fornecedores', categoryId: categories.deadline, status: 'IN_TREATMENT' },
        '"2"',
      );
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      expect(data<RiskDto>(edited)).toMatchObject({ score: 12, status: 'IN_TREATMENT' });
      expect(eventsOf(process.id, 'RiskAssessed')).toHaveLength(1);
      const [update] = auditOf(process.id, 'risk.update');
      expect(pathsOf(update?.changes)).toEqual(['title', 'categoryId', 'status']);
      // Títulos só como hash + tamanho na auditoria.
      expect(JSON.stringify(update)).not.toContain('Poucos fornecedores');

      // Sem alteração efetiva: 200 sem nova versão nem auditoria.
      const noop = await patch(created.id, { impact: 3 }, '"3"');
      expect(data<RiskDto>(noop).version).toBe(3);
      expect(auditOf(process.id, 'risk.update')).toHaveLength(1);
    });

    it('FA-05: residual calculado pela mesma regra; FA-02: escala nova vale só na reavaliação', async () => {
      const process = await processWith();
      const created = await createOk(process.id);
      const residual = await patch(created.id, { residualProbability: 2, residualImpact: 2 });
      expect(data<RiskDto>(residual)).toMatchObject({
        residualProbability: 2,
        residualImpact: 2,
        residualScore: 4,
        residualLevel: 'LOW',
      });

      tenantSettingsOf(api).seed(A, 'risk.levelThresholds', [
        { level: 'LOW', minScore: 1, maxScore: 9 },
        { level: 'EXTREME', minScore: 10, maxScore: 25 },
      ]);
      try {
        const listed = data<RiskDto[]>(await list(process.id));
        // Sem recálculo retroativo: o risco mantém o nível e o snapshot da última avaliação.
        expect(listed[0]).toMatchObject({ level: 'HIGH', score: 16 });
        expect(listed[0]?.scaleSnapshot.levelThresholds).toHaveLength(4);
        const reassessed = data<RiskDto>(await patch(created.id, { impact: 3 }, '"2"'));
        expect(reassessed).toMatchObject({ score: 12, level: 'EXTREME' });
        expect(reassessed.scaleSnapshot.levelThresholds).toHaveLength(2);
      } finally {
        tenantSettingsOf(api).seed(A, 'risk.levelThresholds', [
          { level: 'LOW', minScore: 1, maxScore: 4 },
          { level: 'MEDIUM', minScore: 5, maxScore: 9 },
          { level: 'HIGH', minScore: 10, maxScore: 16 },
          { level: 'EXTREME', minScore: 17, maxScore: 25 },
        ]);
      }
    });

    it('Excluir: cascata lógica dos tratamentos, risk.delete, RiskDeleted, RISK_REMOVED e código não reaproveitado', async () => {
      const process = await processWith();
      const first = await createOk(process.id);
      riskStore().seedTreatments(
        {
          id: newId(),
          tenantId: A,
          riskId: first.id,
          type: 'PREVENTIVE',
          description: 'Ampliar a divulgação do edital',
          status: 'PLANNED',
          deletedAt: null,
        },
        {
          id: newId(),
          tenantId: A,
          riskId: first.id,
          type: 'CONTINGENCY',
          description: 'Contratação emergencial',
          status: 'IN_PROGRESS',
          deletedAt: null,
        },
      );
      // O diálogo de exclusão lista os tratamentos vinculados (RN-RISK-10).
      expect(data<RiskDto>(await getRisk(first.id)).treatments).toHaveLength(2);

      const removed = await remove(first.id);
      expect(removed.status, JSON.stringify(removed.body)).toBe(204);
      expect(risksOf(process.id)[0]?.deletedAt).toEqual(NOW);
      expect(
        riskStore()
          .treatmentRows()
          .filter((row) => row.riskId === first.id)
          .every((row) => row.deletedAt !== null),
      ).toBe(true);
      expect(auditOf(process.id, 'risk.delete')[0]?.metadata).toMatchObject({
        code: 'R01',
        treatmentsRemoved: 2,
      });
      expect(eventsOf(process.id, 'RiskDeleted').map((row) => row.payload)).toEqual([
        { riskId: first.id, code: 'R01' },
      ]);
      expect(timelineOf(process.id).at(-1)).toMatchObject({
        type: 'RISK_REMOVED',
        params: { code: 'R01', title: 'Fornecedores insuficientes' },
      });
      expectProblem(await getRisk(first.id), 404, 'NOT_FOUND');
      expect(data<RiskDto[]>(await list(process.id))).toEqual([]);

      const second = await createOk(process.id);
      expect(second.code).toBe('R02');
    });

    it('Filtros de RSK-01 e ordem por código', async () => {
      const process = await processWith();
      await createOk(process.id);
      await createOk(process.id, { phase: 'SELECTION', categoryId: categories.deadline });
      const bySelection = data<RiskDto[]>(await list(process.id, 'sub-ana', A, '?phase=SELECTION'));
      expect(bySelection.map((row) => row.code)).toEqual(['R02']);
      const byCategory = data<RiskDto[]>(
        await list(process.id, 'sub-ana', A, `?categoryId=${categories.market}`),
      );
      expect(byCategory.map((row) => row.code)).toEqual(['R01']);
      expectProblem(await list(process.id, 'sub-ana', A, '?phase=X'), 422, 'VALIDATION_ERROR');
    });
  });

  describe('[Validação]', () => {
    it('Campos obrigatórios ausentes: 422 com erro em "cause" e nenhum risco criado', async () => {
      const process = await processWith();
      const { cause: _cause, ...withoutCause } = risk();
      const response = await create(process.id, withoutCause);
      expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(fieldErrors(response)).toEqual([['cause', 'REQUIRED']]);
      expect(risksOf(process.id)).toEqual([]);
      expect(eventsOf(process.id)).toEqual([]);
    });

    it('Probabilidade fora da escala: 7 com 5×5 e 4 com a escala 3×3 do tenant → OUT_OF_RANGE', async () => {
      const process = await processWith();
      const response = await create(process.id, risk({ probability: 7 }));
      expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(fieldErrors(response)).toEqual([['probability', 'OUT_OF_RANGE']]);

      tenantSettingsOf(api).seed(A, 'risk.scale', {
        max: 3,
        probabilityLabels: ['Baixa', 'Média', 'Alta'],
        impactLabels: ['Baixo', 'Médio', 'Alto'],
      });
      try {
        const small = await create(process.id, risk({ probability: 4, impact: 2 }));
        expectProblem(small, 422, 'VALIDATION_ERROR');
        expect(problemDetailsSchema.parse(small.body).errors).toEqual([
          {
            field: 'probability',
            code: 'OUT_OF_RANGE',
            message: 'Selecione um valor entre 1 e 3.',
          },
        ]);
        expect(metaOf(await list(process.id)).scale.max).toBe(3);
      } finally {
        tenantSettingsOf(api).seed(A, 'risk.scale', {
          max: 5,
          probabilityLabels: ['Muito baixa', 'Baixa', 'Média', 'Alta', 'Muito alta'],
          impactLabels: ['Muito baixo', 'Baixo', 'Médio', 'Alto', 'Muito alto'],
        });
      }
      expect(risksOf(process.id)).toEqual([]);
    });

    it('Limites, campos calculados, residual sem par e responsável inválido', async () => {
      const process = await processWith();
      const short = await create(process.id, risk({ title: 'ab', consequence: 'curta' }));
      expect(fieldErrors(short)).toEqual([
        ['title', 'TOO_SHORT'],
        ['consequence', 'TOO_SHORT'],
      ]);
      expect(fieldErrors(await create(process.id, risk({ code: 'R09' })))).toEqual([
        ['code', 'NOT_ALLOWED'],
      ]);
      const unknownOwner = await create(process.id, risk({ ownerId: newId() }));
      expectProblem(unknownOwner, 422, 'VALIDATION_ERROR');
      expect(fieldErrors(unknownOwner)).toEqual([['ownerId', 'REFERENCE_NOT_FOUND']]);
      const unknownUnit = await create(process.id, risk({ ownerDepartmentId: newId() }));
      expect(fieldErrors(unknownUnit)).toEqual([['ownerDepartmentId', 'REFERENCE_NOT_FOUND']]);

      const created = await createOk(process.id);
      const half = await patch(created.id, { residualProbability: 2 });
      expectProblem(half, 422, 'VALIDATION_ERROR');
      expect(fieldErrors(half)).toEqual([['residualImpact', 'CONDITIONAL_REQUIRED']]);
      expectProblem(await patch(created.id, { title: 'x' }), 422, 'VALIDATION_ERROR');
    });
  });

  describe('[Permissão]', () => {
    it('Usuário sem RISK_MANAGE: lista com canManage = false; POST 403 PERMISSION_DENIED e access.denied', async () => {
      const process = await processWith();
      const created = await createOk(process.id);
      const listed = await list(process.id, 'sub-otavio');
      expect(listed.status, JSON.stringify(listed.body)).toBe(200);
      expect(metaOf(listed)).toMatchObject({ canManage: false, lockReason: 'PERMISSION_DENIED' });

      const denied = await create(process.id, risk(), { subject: 'sub-otavio' });
      const problem = expectProblem(denied, 403, 'PERMISSION_DENIED');
      expect(problem.detail).toBe('Você não tem permissão para gerenciar riscos deste processo.');
      expect(api.auditRecords().at(-1)).toMatchObject({
        action: 'access.denied',
        reasonCode: 'RISK_MANAGE',
      });
      expectProblem(
        await create(process.id, risk(), { subject: 'sub-fabio' }),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(
        await patch(created.id, { impact: 1 }, '"1"', 'sub-otavio'),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(await remove(created.id, '"1"', 'sub-otavio'), 403, 'PERMISSION_DENIED');
      expect(risksOf(process.id)).toHaveLength(1);
    });

    it('RISK_MANAGE sem custódia nem participação: 403 (POL-02) e lockReason NOT_CUSTODIAN', async () => {
      const process = await processWith();
      expect(metaOf(await list(process.id, 'sub-lucia'))).toMatchObject({
        canManage: false,
        lockReason: 'NOT_CUSTODIAN',
      });
      expectProblem(
        await create(process.id, risk(), { subject: 'sub-lucia' }),
        403,
        'PERMISSION_DENIED',
      );
      expect(api.auditRecords().at(-1)).toMatchObject({
        action: 'access.denied',
        reasonCode: 'POL-02',
      });
    });

    it('FA-04: RISK_MAP concluído bloqueia (409 DOCUMENT_NOT_EDITABLE); em DRAFT ou cancelado, libera', async () => {
      const process = await processWith();
      const created = await createOk(process.id);
      const draft = seedRiskMap(process, 'DRAFT');
      expect(metaOf(await list(process.id))).toMatchObject({
        riskMap: { id: draft.id, code: 'MR 0001/2026', status: 'DRAFT' },
        canManage: true,
      });
      expect((await patch(created.id, { impact: 2 })).status).toBe(200);

      documentRepositoryOf(api).seed({ ...draft, status: 'FINALIZED' });
      const locked = await create(process.id, risk());
      const problem = expectProblem(locked, 409, 'DOCUMENT_NOT_EDITABLE');
      expect(problem.detail).toBe(
        'Os riscos estão bloqueados porque o Mapa de Riscos foi concluído. Reabra o documento para editar.',
      );
      expectProblem(await patch(created.id, { impact: 3 }, '"2"'), 409, 'DOCUMENT_NOT_EDITABLE');
      expectProblem(await remove(created.id, '"2"'), 409, 'DOCUMENT_NOT_EDITABLE');
      expect(metaOf(await list(process.id))).toMatchObject({
        riskMap: { id: draft.id, status: 'FINALIZED' },
        canManage: false,
        lockReason: 'DOCUMENT_NOT_EDITABLE',
      });

      documentRepositoryOf(api).seed({ ...draft, status: 'CANCELED', singletonKey: null });
      expect((await create(process.id, risk())).status).toBe(201);
    });

    it('Processo fora de status editável: 409 INVALID_PROCESS_STATUS; etapa sem RISK_MAP: 422', async () => {
      const awaiting = await processWith({ status: 'AWAITING_APPROVAL' });
      expectProblem(await create(awaiting.id, risk()), 409, 'INVALID_PROCESS_STATUS');
      expect(metaOf(await list(awaiting.id)).lockReason).toBe('INVALID_PROCESS_STATUS');

      const opening = await processWith({}, 'ABERTURA');
      expectProblem(await create(opening.id, risk()), 422, 'DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE');
      expect(metaOf(await list(opening.id)).lockReason).toBe('DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE');
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Categoria de outro tenant: 422 REFERENCE_NOT_FOUND sem revelar; risco e processo de A vistos de B: 404', async () => {
      const process = await processWith();
      const foreign = await create(process.id, risk({ categoryId: categories.foreign }));
      expectProblem(foreign, 422, 'VALIDATION_ERROR');
      expect(fieldErrors(foreign)).toEqual([['categoryId', 'REFERENCE_NOT_FOUND']]);
      expect(JSON.stringify(foreign.body)).not.toContain('Mercado e fornecedor');
      expect(JSON.stringify(foreign.body)).not.toContain(B);
      expect(risksOf(process.id)).toEqual([]);

      const created = await createOk(process.id);
      expectProblem(await getRisk(created.id, 'sub-heitor', B), 404, 'NOT_FOUND');
      expectProblem(
        await patch(created.id, { impact: 1 }, '"1"', 'sub-heitor', B),
        404,
        'NOT_FOUND',
      );
      expectProblem(await remove(created.id, '"1"', 'sub-heitor', B), 404, 'NOT_FOUND');
      expectProblem(await list(process.id, 'sub-heitor', B), 404, 'NOT_FOUND');
      expectProblem(
        await create(process.id, risk(), { subject: 'sub-heitor', tenant: B }),
        404,
        'NOT_FOUND',
      );
      expect(risksOf(process.id)).toMatchObject([{ id: created.id, version: 1, deletedAt: null }]);
      expectProblem(await getRisk(newId()), 404, 'NOT_FOUND');
      expectProblem(await getRisk('abc'), 400, 'MALFORMED_REQUEST');
    });
  });

  describe('[Duplicidade]', () => {
    it('Reenvio com a mesma chave: 201 com o mesmo R02 e Idempotent-Replayed; corpo diferente: 422', async () => {
      const process = await processWith();
      await createOk(process.id);
      const key = randomUUID();
      const payload = risk({ title: 'Atraso na entrega' });
      const first = await create(process.id, payload, { key });
      const replay = await create(process.id, payload, { key });
      expect(first.status).toBe(201);
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(data<RiskDto>(replay)).toMatchObject({ id: data<RiskDto>(first).id, code: 'R02' });
      expect(risksOf(process.id).filter((row) => row.code === 'R02')).toHaveLength(1);
      expectProblem(
        await create(process.id, risk({ title: 'Outro risco' }), { key }),
        422,
        'IDEMPOTENCY_KEY_REUSED',
      );
    });
  });

  describe('[Concorrência]', () => {
    it('Duas criações simultâneas recebem R01 e R02, sem repetição', async () => {
      const process = await processWith();
      const responses = await Promise.all([
        create(process.id, risk()),
        create(process.id, risk({ title: 'Atraso na entrega' })),
      ]);
      expect(responses.map((response) => response.status)).toEqual([201, 201]);
      expect(responses.map((response) => data<RiskDto>(response).code).sort()).toEqual([
        'R01',
        'R02',
      ]);
    });

    it('Edição concorrente: If-Match "2" depois da versão 3 → 412 VERSION_CONFLICT com currentVersion 3', async () => {
      const process = await processWith();
      const created = await createOk(process.id);
      expect((await patch(created.id, { impact: 3 })).status).toBe(200);
      // Ana e Carla abriram o risco com ETag "2"; Ana salva primeiro.
      expect((await patch(created.id, { impact: 2 }, '"2"')).status).toBe(200);
      const stale = await patch(created.id, { impact: 5 }, '"2"');
      expectProblem(stale, 412, 'VERSION_CONFLICT');
      expect(stale.body).toMatchObject({ currentVersion: 3 });
      expectProblem(await remove(created.id, '"2"'), 412, 'VERSION_CONFLICT');
      expect(risksOf(process.id)[0]).toMatchObject({ impact: 2, version: 3, deletedAt: null });
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível: 503 DEPENDENCY_UNAVAILABLE com Retry-After e nada persistido', async () => {
      const process = await processWith();
      transactions.down = true;
      const response = await create(process.id, risk());
      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      expect(response.headers['retry-after']).toBeDefined();
      transactions.down = false;
      expect(risksOf(process.id)).toEqual([]);
      expect(eventsOf(process.id)).toEqual([]);
      expect(auditOf(process.id)).toEqual([]);
      expect(timelineOf(process.id)).toEqual([]);
    });
  });

  describe('[Falha de integração]', () => {
    it('Relay do outbox indisponível: 201 e RiskCreated fica no outbox para publicação', async () => {
      // Sem relay no teste: a linha permanece para publicar (PENDING no PostgreSQL — tenant-leak).
      const process = await processWith();
      const created = await createOk(process.id);
      expect(eventsOf(process.id, 'RiskCreated')).toMatchObject([
        { aggregateId: created.id, payload: { code: 'R01' } },
      ]);
    });
  });
});
