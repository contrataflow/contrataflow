import { randomUUID } from 'node:crypto';

import { problemDetailsSchema, riskSchema, riskTreatmentSchema } from '@contrataflow/validation';
import type { ProcessDto, RiskDto, RiskTreatmentDto } from '@contrataflow/validation';
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
 * US-034 — RSK-06..08 (ações de tratamento) pelo pipeline HTTP completo (autenticação, tenant,
 * vínculo, autorização, `If-Match`, `Idempotency-Key`, filtro RFC 9457) com a identidade fake, os
 * seeders reais e o processo criado pelo PRC-02 na etapa "ETP e mapa de riscos", com o risco R01
 * registrado pelo RSK-02. As 8 categorias do Gherkin. Ana (REQUISITANTE — tem RISK_MANAGE) é a
 * responsável; Otávio (SOMENTE_LEITURA) não tem RISK_MANAGE; Heitor só tem vínculo com a Prefeitura B
 * ("Carlos" do cenário); Bruno tem vínculo SUSPENSO na Prefeitura A. Transação única, RLS e PENDING
 * no PostgreSQL: `test/tenant-leak/risk-treatments.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-18T15:00:00.000Z');

const UNITS_A = {
  organizationId: '0192d034-0000-7000-8000-0000000000a0',
  obras: '0192d034-0000-7000-8000-0000000000a1',
  manutencao: '0192d034-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d034-0000-7000-8000-0000000000a3',
  saude: '0192d034-0000-7000-8000-0000000000a4',
  posto: '0192d034-0000-7000-8000-0000000000a5',
};
const UNITS_B = {
  organizationId: '0192d034-0000-7000-8000-0000000000b0',
  obras: '0192d034-0000-7000-8000-0000000000b1',
  manutencao: '0192d034-0000-7000-8000-0000000000b2',
  pavimentacao: '0192d034-0000-7000-8000-0000000000b3',
  saude: '0192d034-0000-7000-8000-0000000000b4',
  posto: '0192d034-0000-7000-8000-0000000000b5',
};

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

const fieldErrors = (response: request.Response) =>
  problemDetailsSchema.parse(response.body).errors.map((error) => [error.field, error.code]);

describe('Feature: Gerenciar ações de tratamento de riscos (US-034)', () => {
  let api: TestApi;
  let log: MockInstance<Logger['log']>;
  const transactions = new FlakyTransactions();
  let catalog: { contractingType: string; origin: string; market: string };
  const words = (count: number) =>
    Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

  const auth = (call: request.Test, subject = 'sub-ana', tenant: string = A) =>
    call
      .set('Authorization', api.bearer(subject, { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', tenant);
  const create = (
    riskId: string,
    payload: Record<string, unknown>,
    options: { subject?: string; key?: string; tenant?: string } = {},
  ) =>
    auth(
      request(api.server).post(`/api/v1/risks/${riskId}/treatments`),
      options.subject,
      options.tenant,
    )
      .set('Idempotency-Key', options.key ?? randomUUID())
      .send(payload);
  const patch = (
    treatmentId: string,
    payload: Record<string, unknown>,
    ifMatch = '"1"',
    subject = 'sub-ana',
    tenant: string = A,
  ) =>
    auth(request(api.server).patch(`/api/v1/risk-treatments/${treatmentId}`), subject, tenant)
      .set('If-Match', ifMatch)
      .send(payload);
  const remove = (treatmentId: string, ifMatch = '"1"', subject = 'sub-ana', tenant: string = A) =>
    auth(request(api.server).delete(`/api/v1/risk-treatments/${treatmentId}`), subject, tenant).set(
      'If-Match',
      ifMatch,
    );
  const getRisk = async (riskId: string) => {
    const response = await auth(request(api.server).get(`/api/v1/risks/${riskId}`));
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return riskSchema.parse(data<RiskDto>(response));
  };

  const riskStore = () => api.app.get(InMemoryRiskRepository, { strict: false });
  const treatmentsOf = (riskId: string) =>
    riskStore()
      .treatmentRows()
      .filter((row) => row.riskId === riskId);
  const eventsOf = (processId: string) =>
    api
      .outboxRows()
      .filter((row) => row.processId === processId && row.eventType === 'RiskTreatmentChanged');
  const auditOf = (processId: string, action?: string) =>
    api
      .auditRecords()
      .filter(
        (row) =>
          row.processId === processId &&
          row.action.startsWith('risk.treatment_') &&
          (action === undefined || row.action === action),
      );
  const treatment = (body: Partial<Record<string, unknown>> = {}) => ({
    type: 'PREVENTIVE',
    description: 'Ampliar a divulgação do edital em jornais regionais',
    responsibleId: FAKE_USERS.ana.id,
    ...body,
  });

  /** Processo pelo PRC-02 (Ana responsável) na etapa "ETP e mapa de riscos", com o risco R01. */
  async function riskWith(
    fields: Partial<Process> = {},
  ): Promise<{ process: Process; risk: RiskDto }> {
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
        candidate.key === 'ESTUDOS_PRELIMINARES' &&
        candidate.workflowVersionId === created.workflowVersionId,
    );
    const process: Process = {
      ...created,
      status: 'IN_PROGRESS',
      currentWorkflowStageId: stage?.id ?? created.currentWorkflowStageId,
    };
    processRepositoryOf(api).replace(process);
    const risk = await auth(request(api.server).post(`/api/v1/processes/${process.id}/risks`))
      .set('Idempotency-Key', randomUUID())
      .send({
        title: 'Fornecedores insuficientes',
        categoryId: catalog.market,
        phase: 'PLANNING',
        cause: 'Mercado local com poucos fornecedores habilitados',
        consequence: 'Licitação deserta e atraso na contratação',
        probability: 4,
        impact: 4,
      });
    expect(risk.status, JSON.stringify(risk.body)).toBe(201);
    processRepositoryOf(api).replace({ ...process, ...fields });
    return { process: { ...process, ...fields }, risk: data<RiskDto>(risk) };
  }

  async function createOk(riskId: string, payload: Record<string, unknown> = {}) {
    const response = await create(riskId, treatment(payload));
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return riskTreatmentSchema.parse(data<RiskTreatmentDto>(response));
  }

  function seedRiskMap(process: Process, status: 'DRAFT' | 'FINALIZED') {
    const type = documentTypeRepositoryOf(api)
      .snapshot()
      .find((candidate) => candidate.tenantId === A && candidate.systemModule === 'RISK_MAP');
    if (!type) throw new Error('tipo RISK_MAP ausente');
    const document = buildDocument({
      tenantId: A,
      processId: process.id,
      documentTypeId: type.id,
      code: 'MR 0002/2026',
      title: 'Mapa de riscos',
      status,
      singletonKey: process.id,
    });
    documentRepositoryOf(api).seed(document);
    return document;
  }

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
    catalog = {
      contractingType: catalogItemId(api, A, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
      origin: catalogItemId(api, A, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
      market: catalogItemId(api, A, 'RISK_CATEGORY', 'MERCADO_FORNECEDOR'),
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
    it('Criar a primeira ação de um risco aberto: PLANNED, risco IN_TREATMENT, risk.treatment_create e CREATED', async () => {
      const { process, risk } = await riskWith();
      expect(risk.status).toBe('OPEN');
      const response = await create(
        risk.id,
        treatment({ responsibleDepartmentId: UNITS_A.manutencao, dueDate: '2026-10-23' }),
      );
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.headers.etag).toBe('"1"');
      const created = riskTreatmentSchema.parse(data<RiskTreatmentDto>(response));
      expect(created).toMatchObject({
        riskId: risk.id,
        processId: process.id,
        type: 'PREVENTIVE',
        status: 'PLANNED',
        completedAt: null,
        responsible: { id: FAKE_USERS.ana.id, name: 'Ana Souza' },
        responsibleDepartment: { id: UNITS_A.manutencao },
        dueDate: '2026-10-23',
        notes: null,
        sortOrder: 0,
        version: 1,
      });

      // RN-RISK-14 na mesma transação; o risco muda de versão (ETag novo).
      const after = await getRisk(risk.id);
      expect(after).toMatchObject({ status: 'IN_TREATMENT', version: 2 });
      expect(after.treatments).toEqual([created]);

      const [audit] = auditOf(process.id, 'risk.treatment_create');
      expect(audit).toMatchObject({
        category: 'DATA_CHANGE',
        entityType: 'RiskTreatment',
        entityId: created.id,
        metadata: { riskId: risk.id, type: 'PREVENTIVE' },
      });
      expect(audit?.changes).toEqual([{ path: 'risk.status', old: 'OPEN', new: 'IN_TREATMENT' }]);
      expect(eventsOf(process.id)).toMatchObject([
        {
          routingKey: 'risk.treatment_changed',
          aggregateId: risk.id,
          payload: {
            riskId: risk.id,
            treatmentId: created.id,
            change: 'CREATED',
            status: 'PLANNED',
          },
        },
      ]);
      // Sem projeção na timeline (events.md: consumo interno do módulo).
      expect(
        timelineRowsOf(api).filter(
          (row) => row.processId === process.id && row.type.startsWith('RISK_'),
        ),
      ).toHaveLength(1);
      // Logs sem a descrição (story · "Logs").
      const logged = JSON.stringify(log.mock.calls);
      expect(logged).toContain('risk.treatment_created');
      expect(logged).not.toContain('jornais regionais');

      // O segundo tratamento vai para o fim e não mexe mais no risco.
      const second = await createOk(risk.id, { type: 'CONTINGENCY', responsibleId: null });
      expect(second).toMatchObject({ sortOrder: 1, responsible: null });
      expect(await getRisk(risk.id)).toMatchObject({ status: 'IN_TREATMENT', version: 2 });
      expect(auditOf(process.id, 'risk.treatment_create')[1]?.changes ?? []).toEqual([]);
    });

    it('Concluir uma ação: completedAt = agora, STATUS_CHANGED e risk.treatment_update com fromStatus/toStatus', async () => {
      const { process, risk } = await riskWith();
      const created = await createOk(risk.id);
      const started = await patch(created.id, { status: 'IN_PROGRESS' });
      expect(started.status, JSON.stringify(started.body)).toBe(200);
      expect(started.headers.etag).toBe('"2"');

      const done = await patch(created.id, { status: 'DONE' }, '"2"');
      expect(done.status, JSON.stringify(done.body)).toBe(200);
      expect(data<RiskTreatmentDto>(done)).toMatchObject({
        status: 'DONE',
        completedAt: NOW.toISOString(),
        version: 3,
      });
      expect(eventsOf(process.id).map((row) => row.payload)).toEqual([
        expect.objectContaining({ change: 'CREATED', status: 'PLANNED' }),
        expect.objectContaining({ change: 'STATUS_CHANGED', status: 'IN_PROGRESS' }),
        expect.objectContaining({ change: 'STATUS_CHANGED', status: 'DONE' }),
      ]);
      expect(auditOf(process.id, 'risk.treatment_update').at(-1)).toMatchObject({
        metadata: { riskId: risk.id, fromStatus: 'IN_PROGRESS', toStatus: 'DONE', version: 3 },
      });
      expect(JSON.stringify(log.mock.calls)).toContain('risk.treatment_status_changed');
    });

    it('Edição de campos (UPDATED), textos só com hash na auditoria, PATCH sem mudança e reordenação (FA-02)', async () => {
      const { process, risk } = await riskWith();
      const first = await createOk(risk.id, { dueDate: '2026-12-01' });
      const second = await createOk(risk.id, { type: 'CONTINGENCY' });

      const edited = await patch(first.id, {
        description: 'Publicar o aviso em três jornais de grande circulação',
        notes: 'Combinar com a comunicação',
        dueDate: null,
        responsibleId: null,
      });
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      expect(data<RiskTreatmentDto>(edited)).toMatchObject({
        dueDate: null,
        responsible: null,
        notes: 'Combinar com a comunicação',
        status: 'PLANNED',
        version: 2,
      });
      expect(eventsOf(process.id).at(-1)?.payload).toMatchObject({ change: 'UPDATED' });
      const audit = auditOf(process.id, 'risk.treatment_update').at(-1);
      const auditText = JSON.stringify(audit);
      expect(auditText).not.toContain('grande circulação');
      expect(auditText).not.toContain('Combinar com a comunicação');
      expect(
        (audit?.changes as unknown as readonly { path: string }[]).map((change) => change.path),
      ).toEqual(['description', 'responsibleId', 'dueDate', 'notes']);

      // Mesmo conteúdo: 200 sem nova versão, auditoria nem evento.
      const before = eventsOf(process.id).length;
      const same = await patch(first.id, { dueDate: null }, '"2"');
      expect(same.status).toBe(200);
      expect(same.headers.etag).toBe('"2"');
      expect(eventsOf(process.id)).toHaveLength(before);

      // FA-02: o segundo sobe para o topo.
      expect((await patch(second.id, { sortOrder: 0 })).status).toBe(200);
      expect((await patch(first.id, { sortOrder: 1 }, '"2"')).status).toBe(200);
      expect((await getRisk(risk.id)).treatments.map((row) => row.id)).toEqual([
        second.id,
        first.id,
      ]);
    });

    it('FA-01/FA-04: cancelar e excluir não revertem o risco; exclusão lógica e DELETED', async () => {
      const { process, risk } = await riskWith();
      const only = await createOk(risk.id);
      const canceled = await patch(only.id, { status: 'CANCELED' });
      expect(data<RiskTreatmentDto>(canceled)).toMatchObject({
        status: 'CANCELED',
        completedAt: null,
      });
      expect((await getRisk(risk.id)).status).toBe('IN_TREATMENT');

      const removed = await remove(only.id, '"2"');
      expect(removed.status, JSON.stringify(removed.body)).toBe(204);
      expect(treatmentsOf(risk.id)).toMatchObject([{ id: only.id, deletedAt: NOW, version: 3 }]);
      expect(auditOf(process.id, 'risk.treatment_delete')).toMatchObject([
        { entityId: only.id, metadata: { riskId: risk.id } },
      ]);
      expect(eventsOf(process.id).at(-1)?.payload).toMatchObject({
        change: 'DELETED',
        treatmentId: only.id,
      });
      const after = await getRisk(risk.id);
      expect(after).toMatchObject({ status: 'IN_TREATMENT', code: 'R01', treatments: [] });
      expectProblem(await patch(only.id, { notes: 'x' }, '"3"'), 404, 'NOT_FOUND');
    });
  });

  describe('[Validação]', () => {
    it('Descrição ausente: 422 com erro em "description" e nenhum tratamento criado', async () => {
      const { risk } = await riskWith();
      const response = await create(risk.id, { type: 'PREVENTIVE' });
      expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(fieldErrors(response)).toEqual([['description', 'REQUIRED']]);
      expect(treatmentsOf(risk.id)).toEqual([]);
    });

    it('Limites, campos do sistema e data inválida', async () => {
      const { risk } = await riskWith();
      const short = await create(risk.id, treatment({ description: 'curta' }));
      expectProblem(short, 422, 'VALIDATION_ERROR');
      expect(problemDetailsSchema.parse(short.body).errors[0]?.message).toBe(
        'A descrição deve ter entre 10 e 1.000 caracteres.',
      );
      const fields = await create(
        risk.id,
        treatment({ status: 'DONE', notes: 'x'.repeat(1001), dueDate: '31/12/2026' }),
      );
      expectProblem(fields, 422, 'VALIDATION_ERROR');
      expect(
        fieldErrors(fields)
          .map(([field]) => field)
          .sort(),
      ).toEqual(['dueDate', 'notes', 'status']);
      expect(treatmentsOf(risk.id)).toEqual([]);
    });

    it('Transição de status não permitida: DONE → IN_PROGRESS e PLANNED → DONE dão 409 INVALID_STATE', async () => {
      const { risk } = await riskWith();
      const created = await createOk(risk.id);
      const skip = await patch(created.id, { status: 'DONE' });
      const problem = expectProblem(skip, 409, 'INVALID_STATE');
      expect(problem.detail).toBe('Não é possível mudar o status de Planejada para Concluída.');

      await patch(created.id, { status: 'IN_PROGRESS' });
      await patch(created.id, { status: 'DONE' }, '"2"');
      const reopen = await patch(created.id, { status: 'IN_PROGRESS' }, '"3"');
      expectProblem(reopen, 409, 'INVALID_STATE');
      expect(reopen.body).toMatchObject({ currentStatus: 'DONE', requestedStatus: 'IN_PROGRESS' });
      expect(treatmentsOf(risk.id)[0]).toMatchObject({ status: 'DONE', version: 3 });
    });

    it('Responsável suspenso: 422 REFERENCE_INACTIVE; sem If-Match: 428', async () => {
      const { risk } = await riskWith();
      const inactive = await create(risk.id, treatment({ responsibleId: FAKE_USERS.bruno.id }));
      expectProblem(inactive, 422, 'VALIDATION_ERROR');
      expect(fieldErrors(inactive)).toEqual([['responsibleId', 'REFERENCE_INACTIVE']]);
      const created = await createOk(risk.id);
      const missing = await auth(
        request(api.server).patch(`/api/v1/risk-treatments/${created.id}`),
      ).send({ notes: 'x' });
      expectProblem(missing, 428, 'PRECONDITION_REQUIRED');
    });
  });

  describe('[Permissão]', () => {
    it('Usuário sem RISK_MANAGE: 403 PERMISSION_DENIED com access.denied, nada criado', async () => {
      const { risk } = await riskWith();
      const created = await createOk(risk.id);
      const denied = await create(risk.id, treatment(), { subject: 'sub-otavio' });
      const problem = expectProblem(denied, 403, 'PERMISSION_DENIED');
      expect(problem.detail).toBe('Você não tem permissão para gerenciar tratamentos deste risco.');
      expect(api.auditRecords().at(-1)).toMatchObject({
        action: 'access.denied',
        reasonCode: 'RISK_MANAGE',
      });
      expectProblem(
        await patch(created.id, { notes: 'x' }, '"1"', 'sub-otavio'),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(await remove(created.id, '"1"', 'sub-otavio'), 403, 'PERMISSION_DENIED');
      expect(treatmentsOf(risk.id)).toMatchObject([
        { id: created.id, version: 1, deletedAt: null },
      ]);
    });

    it('FA-05/RN-RISK-16: RISK_MAP concluído bloqueia criar, editar e excluir (409); em DRAFT libera', async () => {
      const { process, risk } = await riskWith();
      const draft = seedRiskMap(process, 'DRAFT');
      const created = await createOk(risk.id);
      documentRepositoryOf(api).seed({ ...draft, status: 'FINALIZED' });
      const locked = await create(risk.id, treatment());
      const problem = expectProblem(locked, 409, 'DOCUMENT_NOT_EDITABLE');
      expect(problem.detail).toBe(
        'As ações de tratamento estão bloqueadas porque o Mapa de Riscos foi concluído.',
      );
      expectProblem(
        await patch(created.id, { status: 'IN_PROGRESS' }),
        409,
        'DOCUMENT_NOT_EDITABLE',
      );
      expectProblem(await remove(created.id), 409, 'DOCUMENT_NOT_EDITABLE');
      expect(treatmentsOf(risk.id)).toMatchObject([{ status: 'PLANNED', deletedAt: null }]);
    });

    it('Processo fora de status editável: 409 INVALID_PROCESS_STATUS', async () => {
      const { risk } = await riskWith({ status: 'AWAITING_APPROVAL' });
      expectProblem(await create(risk.id, treatment()), 409, 'INVALID_PROCESS_STATUS');
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Responsável de outro tenant: 422 REFERENCE_NOT_FOUND sem revelar; risco e tratamento de A vistos de B: 404', async () => {
      const { risk } = await riskWith();
      const foreign = await create(risk.id, treatment({ responsibleId: FAKE_USERS.heitor.id }));
      expectProblem(foreign, 422, 'VALIDATION_ERROR');
      expect(fieldErrors(foreign)).toEqual([['responsibleId', 'REFERENCE_NOT_FOUND']]);
      expect(JSON.stringify(foreign.body)).not.toContain('Heitor');
      expect(JSON.stringify(foreign.body)).not.toContain(B);
      const foreignUnit = await create(
        risk.id,
        treatment({ responsibleDepartmentId: UNITS_B.manutencao }),
      );
      expect(fieldErrors(foreignUnit)).toEqual([
        ['responsibleDepartmentId', 'REFERENCE_NOT_FOUND'],
      ]);
      expect(treatmentsOf(risk.id)).toEqual([]);

      const created = await createOk(risk.id);
      expectProblem(
        await create(risk.id, treatment(), { subject: 'sub-heitor', tenant: B }),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        await patch(created.id, { notes: 'LEAK-B' }, '"1"', 'sub-heitor', B),
        404,
        'NOT_FOUND',
      );
      expectProblem(await remove(created.id, '"1"', 'sub-heitor', B), 404, 'NOT_FOUND');
      expect(treatmentsOf(risk.id)).toMatchObject([{ id: created.id, version: 1, notes: null }]);
      expectProblem(await create(newId(), treatment()), 404, 'NOT_FOUND');
      expectProblem(await patch('abc', { notes: 'x' }), 400, 'MALFORMED_REQUEST');
    });
  });

  describe('[Duplicidade]', () => {
    it('Reenvio com a mesma chave: 201 com o mesmo tratamento e Idempotent-Replayed', async () => {
      const { risk } = await riskWith();
      const key = randomUUID();
      const first = await create(risk.id, treatment(), { key });
      const replay = await create(risk.id, treatment(), { key });
      expect(first.status).toBe(201);
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(data<RiskTreatmentDto>(replay).id).toBe(data<RiskTreatmentDto>(first).id);
      expect(treatmentsOf(risk.id)).toHaveLength(1);
      expectProblem(
        await create(risk.id, treatment({ type: 'CONTINGENCY' }), { key }),
        422,
        'IDEMPOTENCY_KEY_REUSED',
      );
    });
  });

  describe('[Concorrência]', () => {
    it('Edição concorrente: Ana salva com ETag "1"; Carla com o mesmo If-Match → 412 VERSION_CONFLICT', async () => {
      const { risk } = await riskWith();
      const created = await createOk(risk.id);
      expect((await patch(created.id, { notes: 'Ana primeiro' })).status).toBe(200);
      const stale = await patch(created.id, { notes: 'Carla depois' });
      const problem = expectProblem(stale, 412, 'VERSION_CONFLICT');
      expect(problem.detail).toBe(
        'Esta ação foi alterada por outra pessoa. Recarregue para ver a versão atual.',
      );
      expect(stale.body).toMatchObject({ currentVersion: 2 });
      expectProblem(await remove(created.id, '"1"'), 412, 'VERSION_CONFLICT');
      expect(treatmentsOf(risk.id)).toMatchObject([
        { notes: 'Ana primeiro', version: 2, deletedAt: null },
      ]);
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível ao atualizar o status: 503 DEPENDENCY_UNAVAILABLE com Retry-After, sem alterar', async () => {
      const { process, risk } = await riskWith();
      const created = await createOk(risk.id);
      const events = eventsOf(process.id).length;
      transactions.down = true;
      const response = await patch(created.id, { status: 'IN_PROGRESS' });
      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      expect(response.headers['retry-after']).toBeDefined();
      transactions.down = false;
      expect(treatmentsOf(risk.id)).toMatchObject([{ status: 'PLANNED', version: 1 }]);
      expect(eventsOf(process.id)).toHaveLength(events);
      expect(auditOf(process.id, 'risk.treatment_update')).toEqual([]);
    });
  });

  describe('[Falha de integração]', () => {
    it('Relay do outbox indisponível: 201 e RiskTreatmentChanged fica no outbox para publicação', async () => {
      // Sem relay no teste: a linha permanece para publicar (PENDING no PostgreSQL — tenant-leak).
      const { process, risk } = await riskWith();
      const created = await createOk(risk.id);
      expect(eventsOf(process.id)).toMatchObject([
        { aggregateId: risk.id, payload: { treatmentId: created.id, change: 'CREATED' } },
      ]);
    });
  });
});
