import { randomUUID } from 'node:crypto';

import {
  actionEntrySchema,
  problemDetailsSchema,
  processConflictCurrentSchema,
  processSchema,
} from '@contrataflow/validation';
import type { ActionEntry, ProcessDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { z } from 'zod';

import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
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
  tenantSettingsOf,
  timelineRowsOf,
} from '../../../../test/support/process-fixtures.js';
import {
  assignDepartment,
  assignRole,
  seedDefaultRolesOf,
} from '../../../../test/support/structure-fixtures.js';
import { PROCESS_CLOCK, PROCESS_TRANSACTIONS } from '../application/ports.js';
import type { ProcessTransactions } from '../application/ports.js';
import type { Process } from '../domain/process.js';

/*
 * US-005 — PRC-05 (editar dados do processo) pelo pipeline HTTP completo (autenticação, tenant,
 * vínculo, autorização, `If-Match`, filtro RFC 9457) com a identidade fake, os seeders reais
 * (catálogos, perfis, workflow padrão DEC-015) e o processo criado pelo PRC-02, com auditoria,
 * outbox e timeline em memória. As 8 categorias do Gherkin. Ana (REQUISITANTE, OWN_DEPARTMENTS,
 * lotada em Manutenção e Pavimentação) é a responsável; Juliana = Fábio (COMPRAS, sem custódia).
 * Trava de linha, transação única, `ProcessAccess` e RLS sobre o PostgreSQL:
 * `test/tenant-leak/process-update.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
/** "Hoje é 2026-10-05" — meio-dia em São Paulo. */
const NOW = new Date('2026-10-05T15:00:00.000Z');

const ORG_A = '0192d005-0000-7000-8000-0000000000a0';
const ORG_B = '0192d005-0000-7000-8000-0000000000b0';
const UNITS_A = {
  organizationId: ORG_A,
  obras: '0192d005-0000-7000-8000-0000000000a1',
  manutencao: '0192d005-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d005-0000-7000-8000-0000000000a3',
  saude: '0192d005-0000-7000-8000-0000000000a4',
  posto: '0192d005-0000-7000-8000-0000000000a5',
};
const UNITS_B = {
  organizationId: ORG_B,
  obras: '0192d005-0000-7000-8000-0000000000b1',
  manutencao: '0192d005-0000-7000-8000-0000000000b2',
  pavimentacao: '0192d005-0000-7000-8000-0000000000b3',
  saude: '0192d005-0000-7000-8000-0000000000b4',
  posto: '0192d005-0000-7000-8000-0000000000b5',
};

const membershipOf = (userId: string, tenantId = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

/** Transações do módulo que podem simular o banco fora do ar (Falha de banco). */
class FlakyTransactions implements ProcessTransactions {
  down = false;

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    if (this.down) return Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED')));
    return runSimulatedTransaction(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.run(work);
  }

  snapshot<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.run(work);
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

describe('Feature: Editar dados do processo (US-005)', () => {
  let api: TestApi;
  let warn: MockInstance<Logger['warn']>;
  let log: MockInstance<Logger['log']>;
  const transactions = new FlakyTransactions();
  let catalog: { contractingType: string; origin: string; modality: string; otherType: string };
  const words = (count: number) =>
    Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

  const auth = (call: request.Test, subject: string, tenant: string) =>
    call
      .set('Authorization', api.bearer(subject, { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', tenant);
  const patch = (
    id: string,
    payload: Record<string, unknown>,
    options: { subject?: string; ifMatch?: string | null; tenant?: string } = {},
  ) => {
    const call = auth(
      request(api.server).patch(`/api/v1/processes/${id}`),
      options.subject ?? 'sub-ana',
      options.tenant ?? A,
    );
    if (options.ifMatch !== null) call.set('If-Match', options.ifMatch ?? '"8"');
    return call.send(payload);
  };
  const repository = () => processRepositoryOf(api);
  const stored = (id: string): Process => {
    const process = repository()
      .allProcesses()
      .find((candidate) => candidate.id === id);
    if (!process) throw new Error(`processo ${id} ausente`);
    return process;
  };
  const auditOf = (action: string, processId: string) =>
    api.auditRecords().filter((row) => row.action === action && row.entityId === processId);
  const eventsOf = (processId: string) =>
    api
      .outboxRows()
      .filter((row) => row.aggregateId === processId && row.eventType === 'ProcessUpdated');
  const updatesOnTimeline = (processId: string) =>
    timelineRowsOf(api).filter(
      (row) => row.processId === processId && row.type === 'PROCESS_UPDATED',
    );

  /** Processo criado pelo PRC-02 (rascunho com Ana) e levado ao estado do cenário. */
  async function processWith(fields: Partial<Process> = {}): Promise<Process> {
    const response = await auth(request(api.server).post('/api/v1/processes'), 'sub-ana', A)
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
    const created = stored(data<ProcessDto>(response).id);
    const process: Process = {
      ...created,
      status: 'IN_PROGRESS',
      version: 8,
      title: 'Aquisição de cimento para manutenção de vias',
      ...fields,
    };
    repository().replace(process);
    return process;
  }

  beforeAll(async () => {
    log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    api = await createTestApi({
      providers: [
        { token: PROCESS_TRANSACTIONS, value: transactions },
        { token: PROCESS_CLOCK, value: () => NOW },
        { token: CATALOG_CLOCK, value: () => NOW },
      ],
    });
    await runTenantSeeders(api, A);
    await runTenantSeeders(api, B, ['catalog.items', 'access.defaultRoles']);
    seedProcessStructure(api, A, { ...UNITS_A, shortName: 'PMSJ', cnpj: '11222333000181' });
    seedProcessStructure(api, B, { ...UNITS_B, shortName: 'PMB', cnpj: '60746948000112' });
    // Ana lotada no Setor de Manutenção e no Setor de Pavimentação (mesma secretaria).
    assignDepartment(api, membershipOf(FAKE_USERS.ana.id), UNITS_A.manutencao);
    assignDepartment(api, membershipOf(FAKE_USERS.ana.id), UNITS_A.pavimentacao);
    // Otávio só com SOMENTE_LEITURA (sem PROCESS_UPDATE em nenhum escopo).
    assignRole(api, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.otavio.id),
      roleId: seedDefaultRolesOf(api, A).get('SOMENTE_LEITURA')?.id ?? '',
    });
    catalog = {
      contractingType: catalogItemId(api, A, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
      origin: catalogItemId(api, A, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
      modality: catalogItemId(api, A, 'MODALITY', 'PREGAO'),
      otherType: catalogItemId(api, B, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
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
    it('Alterar título, prioridade e prazo alvo: ETag "9", ProcessUpdated sem valores, timeline e auditoria com o diff', async () => {
      const process = await processWith();
      const response = await patch(process.id, {
        title: 'Aquisição de cimento CP-II para manutenção de vias',
        priority: 'HIGH',
        targetDate: '2026-11-30',
      });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers.etag).toBe('"9"');
      const updated = processSchema.parse(data<ProcessDto>(response));
      expect(updated).toMatchObject({
        title: 'Aquisição de cimento CP-II para manutenção de vias',
        priority: 'HIGH',
        targetDate: '2026-11-30',
        version: 9,
      });
      expect(stored(process.id)).toMatchObject({ version: 9, updatedById: FAKE_USERS.ana.id });

      const [event, ...others] = eventsOf(process.id);
      expect(others).toEqual([]);
      expect(event).toMatchObject({ routingKey: 'process.updated', processId: process.id });
      // Só nomes dos campos e a versão — nunca valores.
      expect(event?.payload).toEqual({
        changedFields: ['title', 'priority', 'targetDate'],
        version: 9,
      });

      expect(updatesOnTimeline(process.id)).toEqual([
        expect.objectContaining({
          params: { fields: ['title', 'priority', 'targetDate'] },
          visibility: 'STANDARD',
        }),
      ]);

      const [audit] = auditOf('process.update', process.id);
      expect(audit).toMatchObject({
        category: 'DATA_CHANGE',
        metadata: { processCode: process.code, version: 9, requestingAccessChanged: false },
      });
      expect(audit?.changes).toEqual([
        {
          path: 'title',
          old: { sha256: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown, length: 44 },
          new: { sha256: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown, length: 50 },
        },
        { path: 'priority', old: 'MEDIUM', new: 'HIGH' },
        { path: 'targetDate', old: null, new: '2026-11-30' },
      ]);
      // Log de negócio sem valores (story · Logs).
      const logged = log.mock.calls.find(([entry]) => {
        return (entry as { event?: string }).event === 'process.updated';
      });
      expect(logged?.[0]).toMatchObject({ changedFields: ['title', 'priority', 'targetDate'] });
      expect(JSON.stringify(logged?.[0])).not.toContain('cimento');
    });

    it('Informar valor estimado manual sem fonte documental: MANUAL; a versão do workflow não muda (RN-PROC-69)', async () => {
      const process = await processWith();
      const response = await patch(process.id, {
        estimatedValue: '85000.00',
        modalityId: catalog.modality,
        isPriceRegistration: true,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(data<ProcessDto>(response)).toMatchObject({
        estimatedValue: '85000.00',
        estimatedValueSource: 'MANUAL',
        modality: { id: catalog.modality, code: 'PREGAO' },
      });
      expect(stored(process.id)).toMatchObject({
        estimatedValue: '85000.00',
        estimatedValueSource: 'MANUAL',
        workflowVersionId: process.workflowVersionId,
      });

      const cleared = await patch(process.id, { estimatedValue: null }, { ifMatch: '"9"' });
      expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
      expect(stored(process.id)).toMatchObject({
        estimatedValue: null,
        estimatedValueSource: null,
      });
    });

    it('Trocar o setor solicitante em rascunho: REQUESTING revogado e concedido; etapa, unidade e responsável intactos', async () => {
      const process = await processWith({ status: 'DRAFT' });
      const response = await patch(process.id, { requestingDepartmentId: UNITS_A.pavimentacao });

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(data<ProcessDto>(response).requestingDepartment).toEqual({
        id: UNITS_A.pavimentacao,
        name: 'Setor de Pavimentação',
      });
      const requesting = repository()
        .accessOf(process.id)
        .filter((row) => row.reason === 'REQUESTING')
        .map((row) => row.departmentId)
        .sort();
      expect(requesting).toEqual([UNITS_A.obras, UNITS_A.pavimentacao].sort());
      expect(repository().revokedAccessOf(process.id)).toEqual([
        expect.objectContaining({
          departmentId: UNITS_A.manutencao,
          reason: 'REQUESTING',
          revokedAt: expect.any(Date) as unknown,
        }),
      ]);
      // A unidade atual (Manutenção) continua com a concessão CURRENT.
      expect(
        repository()
          .accessOf(process.id)
          .some((row) => row.reason === 'CURRENT' && row.departmentId === UNITS_A.manutencao),
      ).toBe(true);
      expect(stored(process.id)).toMatchObject({
        currentStageId: process.currentStageId,
        currentDepartmentId: process.currentDepartmentId,
        currentResponsibleId: FAKE_USERS.ana.id,
      });
      expect(auditOf('process.update', process.id)[0]?.metadata).toMatchObject({
        requestingAccessChanged: true,
      });
    });

    it('Valor estimado de processo sigiloso: entrada da timeline BUDGET_RESTRICTED (RN-PROC-68)', async () => {
      const process = await processWith({ isBudgetConfidential: true });
      const response = await patch(process.id, { estimatedValue: '120000.00' });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(updatesOnTimeline(process.id)).toEqual([
        expect.objectContaining({
          params: { fields: ['estimatedValue'] },
          visibility: 'BUDGET_RESTRICTED',
        }),
      ]);
    });
  });

  describe('[Validação]', () => {
    it('Campo bloqueado depois do primeiro encaminhamento: 422 NOT_ALLOWED e a versão continua 8', async () => {
      const process = await processWith();
      const problem = expectProblem(
        await patch(process.id, { requestingSecretariatId: UNITS_A.saude }),
        422,
        'VALIDATION_ERROR',
      );
      expect(problem.errors).toEqual([
        {
          field: 'requestingSecretariatId',
          code: 'NOT_ALLOWED',
          message: 'Este campo só pode ser alterado enquanto o processo é rascunho.',
        },
      ]);
      expect(stored(process.id).version).toBe(8);
      expect(eventsOf(process.id)).toEqual([]);
    });

    it('Valor estimado com fonte de maior precedência: 422 BUSINESS_RULE_VIOLATION com a fonte', async () => {
      const process = await processWith({
        estimatedValue: '92450.00',
        estimatedValueSource: 'PRICE_RESEARCH',
      });
      const problem = expectProblem(
        await patch(process.id, { estimatedValue: '90000.00' }),
        422,
        'BUSINESS_RULE_VIOLATION',
      );
      expect(problem.detail).toBe(
        'O valor estimado é obtido de Pesquisa de preços. Para alterá-lo, ajuste o documento de origem.',
      );
      expect(problem.violations[0]).toMatchObject({
        field: 'estimatedValue',
        ruleId: 'RN-PROC-63',
      });
      expect(stored(process.id).estimatedValue).toBe('92450.00');
    });

    it('Campo que nunca é editável por PATCH: 422 NOT_ALLOWED no campo "status"', async () => {
      const process = await processWith();
      const problem = expectProblem(
        await patch(process.id, { status: 'COMPLETED' }),
        422,
        'VALIDATION_ERROR',
      );
      expect(problem.errors).toEqual([
        expect.objectContaining({ field: 'status', code: 'NOT_ALLOWED' }),
      ]);
      expect(stored(process.id).status).toBe('IN_PROGRESS');
    });

    it('Revalidação: prazo no passado, PCA sem justificativa e limites de tamanho (V-01/V-09/V-10)', async () => {
      const process = await processWith();
      const past = expectProblem(
        await patch(process.id, { targetDate: '2026-10-01' }),
        422,
        'VALIDATION_ERROR',
      );
      expect(past.errors).toEqual([
        expect.objectContaining({ field: 'targetDate', code: 'DATE_IN_PAST' }),
      ]);
      const pca = expectProblem(
        await patch(process.id, { pcaStatus: 'NOT_PLANNED' }),
        422,
        'VALIDATION_ERROR',
      );
      expect(pca.errors).toEqual([
        expect.objectContaining({ field: 'pcaJustification', code: 'CONDITIONAL_REQUIRED' }),
      ]);
      const short = expectProblem(
        await patch(process.id, { title: 'abc' }),
        422,
        'VALIDATION_ERROR',
      );
      expect(short.errors[0]).toMatchObject({ field: 'title', code: 'TOO_SHORT' });
      expect(stored(process.id).version).toBe(8);
    });

    it('Código interno removido com process.requireInternalCode = true (V-12)', async () => {
      const process = await processWith({ internalCode: `PROT-${words(1)}` });
      const settings = tenantSettingsOf(api);
      settings.seed(A, 'process.requireInternalCode', true);
      try {
        const problem = expectProblem(
          await patch(process.id, { internalCode: '' }),
          422,
          'VALIDATION_ERROR',
        );
        expect(problem.errors).toEqual([
          {
            field: 'internalCode',
            code: 'REQUIRED',
            message: 'O código interno é obrigatório neste órgão.',
          },
        ]);
      } finally {
        settings.seed(A, 'process.requireInternalCode', false, 2);
      }
    });

    it('Sem If-Match: 428 PRECONDITION_REQUIRED', async () => {
      const process = await processWith();
      expectProblem(
        await patch(process.id, { priority: 'HIGH' }, { ifMatch: null }),
        428,
        'PRECONDITION_REQUIRED',
      );
    });
  });

  describe('[Permissão]', () => {
    it('Usuário com permissão, mas sem custódia: 403 NOT_PROCESS_CUSTODIAN e access.denied', async () => {
      const process = await processWith();
      expectProblem(
        await patch(process.id, { priority: 'URGENT' }, { subject: 'sub-fabio' }),
        403,
        'NOT_PROCESS_CUSTODIAN',
      );
      expect(
        auditOf('access.denied', process.id).at(-1) ?? api.auditRecords().at(-1),
      ).toMatchObject({
        action: 'access.denied',
        reasonCode: 'NOT_PROCESS_CUSTODIAN',
      });
      expect(stored(process.id)).toMatchObject({ priority: 'MEDIUM', version: 8 });
    });

    it('Processo aguardando aprovação: "Editar dados" desabilitada com o motivo e PATCH 409 INVALID_PROCESS_STATUS', async () => {
      const process = await processWith({ status: 'AWAITING_APPROVAL' });
      const actions = await auth(
        request(api.server).get(`/api/v1/processes/${process.id}/available-actions`),
        'sub-ana',
        A,
      );
      expect(actions.status, JSON.stringify(actions.body)).toBe(200);
      const entries = z.array(actionEntrySchema).parse(data<ActionEntry[]>(actions));
      expect(entries.find((entry) => entry.action === 'EDIT')).toEqual({
        action: 'EDIT',
        label: 'Editar dados',
        enabled: false,
        reasons: [
          {
            code: 'INVALID_PROCESS_STATUS',
            message: 'Não é possível editar enquanto o processo aguarda aprovação.',
          },
        ],
      });
      const problem = expectProblem(
        await patch(process.id, { priority: 'HIGH' }),
        409,
        'INVALID_PROCESS_STATUS',
      );
      expect(problem.detail).toBe('Não é possível editar enquanto o processo aguarda aprovação.');
    });

    it('PRC-08: "Editar dados" habilitada para a responsável e desabilitada (sem custódia) para Juliana', async () => {
      const process = await processWith();
      const actionsOf = async (subject: string) =>
        z
          .array(actionEntrySchema)
          .parse(
            data<ActionEntry[]>(
              await auth(
                request(api.server).get(`/api/v1/processes/${process.id}/available-actions`),
                subject,
                A,
              ),
            ),
          )
          .find((entry) => entry.action === 'EDIT');
      expect(await actionsOf('sub-ana')).toMatchObject({ enabled: true, reasons: [] });
      expect(await actionsOf('sub-fabio')).toMatchObject({
        enabled: false,
        reasons: [{ code: 'NOT_PROCESS_CUSTODIAN' }],
      });
    });

    it('Sem PROCESS_UPDATE em nenhum escopo: 403 PERMISSION_DENIED no guard', async () => {
      const process = await processWith();
      expectProblem(
        await patch(process.id, { priority: 'HIGH' }, { subject: 'sub-otavio' }),
        403,
        'PERMISSION_DENIED',
      );
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Processo de outro tenant: 404 PROCESS_NOT_FOUND; tipo de contratação de outro tenant: 422 REFERENCE_NOT_FOUND', async () => {
      const process = await processWith();
      const foreign: Process = {
        ...process,
        id: randomUUID(),
        tenantId: B,
        organizationId: ORG_B,
        requestingSecretariatId: UNITS_B.obras,
        requestingDepartmentId: UNITS_B.manutencao,
        currentDepartmentId: UNITS_B.manutencao,
        code: '0099/2026',
      };
      repository().seed(foreign);
      expectProblem(await patch(foreign.id, { priority: 'HIGH' }), 404, 'PROCESS_NOT_FOUND');
      expect(stored(foreign.id).priority).toBe('MEDIUM');

      const problem = expectProblem(
        await patch(process.id, { contractingTypeId: catalog.otherType }),
        422,
        'VALIDATION_ERROR',
      );
      expect(problem.errors).toEqual([
        expect.objectContaining({ field: 'contractingTypeId', code: 'REFERENCE_NOT_FOUND' }),
      ]);
    });
  });

  describe('[Duplicidade]', () => {
    it('Código interno já utilizado: 409 DUPLICATE_INTERNAL_CODE; PATCH repetido: 200 sem nova versão, evento, timeline nem auditoria', async () => {
      await processWith({ internalCode: 'PROT-2026-0457' });
      const process = await processWith();
      expectProblem(
        await patch(process.id, { internalCode: 'PROT-2026-0457' }),
        409,
        'DUPLICATE_INTERNAL_CODE',
      );

      const first = await patch(process.id, { priority: 'HIGH', notes: 'Observação inicial' });
      expect(first.status, JSON.stringify(first.body)).toBe(200);
      const counts = {
        events: eventsOf(process.id).length,
        timeline: updatesOnTimeline(process.id).length,
        audit: auditOf('process.update', process.id).length,
      };
      // Reenvio idêntico (inclusive com o If-Match antigo — retentativa depois do sucesso).
      const repeated = await patch(process.id, {
        priority: 'HIGH',
        notes: '  Observação inicial ',
      });
      expect(repeated.status, JSON.stringify(repeated.body)).toBe(200);
      expect(repeated.headers.etag).toBe('"9"');
      expect(stored(process.id).version).toBe(9);
      expect({
        events: eventsOf(process.id).length,
        timeline: updatesOnTimeline(process.id).length,
        audit: auditOf('process.update', process.id).length,
      }).toEqual(counts);
      expect(
        log.mock.calls.some(
          ([entry]) => (entry as { event?: string }).event === 'process.update_noop',
        ),
      ).toBe(true);
    });
  });

  describe('[Concorrência]', () => {
    it('Valor derivado por documento durante a edição: 412 com currentVersion e meta.current; reaplicação preserva o valor', async () => {
      const process = await processWith();
      repository().replace({
        ...stored(process.id),
        estimatedValue: '92450.00',
        estimatedValueSource: 'PRICE_RESEARCH',
        updatedById: FAKE_USERS.fabio.id,
        version: 9,
      });

      const problem = expectProblem(
        await patch(process.id, { priority: 'HIGH' }),
        412,
        'VERSION_CONFLICT',
      );
      const body = response412Schema.parse(problem);
      expect(body.currentVersion).toBe(9);
      expect(body.meta.current).toMatchObject({
        id: process.id,
        priority: 'MEDIUM',
        estimatedValue: '92450.00',
        estimatedValueSource: 'PRICE_RESEARCH',
        version: 9,
        updatedBy: { id: FAKE_USERS.fabio.id, name: expect.stringContaining('Nunes') as unknown },
      });
      expect(
        warn.mock.calls.some(
          ([entry]) => (entry as { event?: string }).event === 'process.update_conflict',
        ),
      ).toBe(true);

      const reapplied = await patch(process.id, { priority: 'HIGH' }, { ifMatch: '"9"' });
      expect(reapplied.status, JSON.stringify(reapplied.body)).toBe(200);
      expect(stored(process.id)).toMatchObject({
        priority: 'HIGH',
        estimatedValue: '92450.00',
        estimatedValueSource: 'PRICE_RESEARCH',
        version: 10,
      });
    });

    it('Encaminhamento confirmado antes da gravação: 403 NOT_PROCESS_CUSTODIAN (ou 412 com o ETag antigo)', async () => {
      const process = await processWith();
      repository().replace({
        ...stored(process.id),
        currentDepartmentId: UNITS_A.saude,
        currentResponsibleId: FAKE_USERS.lucia.id,
        version: 9,
      });
      expectProblem(await patch(process.id, { priority: 'HIGH' }), 412, 'VERSION_CONFLICT');
      const problem = expectProblem(
        await patch(process.id, { priority: 'HIGH' }, { ifMatch: '"9"' }),
        403,
        'NOT_PROCESS_CUSTODIAN',
      );
      expect(problem.detail).toBe(
        'O processo saiu da sua responsabilidade. Suas alterações não foram salvas.',
      );
    });

    it('Duas edições com o mesmo If-Match: uma 200, a outra 412', async () => {
      const process = await processWith();
      const statuses = (
        await Promise.all([
          patch(process.id, { priority: 'HIGH' }),
          patch(process.id, { priority: 'LOW' }),
        ])
      )
        .map((response) => response.status)
        .sort();
      expect(statuses).toEqual([200, 412]);
      expect(stored(process.id).version).toBe(9);
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível ao salvar: 503 DEPENDENCY_UNAVAILABLE e nada persistido', async () => {
      const process = await processWith();
      const before = { events: api.outboxRows().length, audit: api.auditRecords().length };
      transactions.down = true;
      expectProblem(await patch(process.id, { priority: 'HIGH' }), 503, 'DEPENDENCY_UNAVAILABLE');
      transactions.down = false;
      expect(stored(process.id)).toMatchObject({ priority: 'MEDIUM', version: 8 });
      expect({ events: api.outboxRows().length, audit: api.auditRecords().length }).toEqual(before);
      expect(updatesOnTimeline(process.id)).toEqual([]);
    });
  });

  describe('[Falha de integração]', () => {
    it('Relay do outbox indisponível: 200 e o evento fica no outbox para publicação', async () => {
      // Sem relay no teste: a linha permanece para publicar (PENDING no PostgreSQL — tenant-leak).
      const process = await processWith();
      const response = await patch(process.id, { notes: 'Ajuste de observações' });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(eventsOf(process.id)).toHaveLength(1);
    });
  });
});

const response412Schema = z.looseObject({
  currentVersion: z.number().int(),
  meta: z.object({ current: processConflictCurrentSchema }),
});
