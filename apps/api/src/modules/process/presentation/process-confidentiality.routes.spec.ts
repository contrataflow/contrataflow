import { randomUUID } from 'node:crypto';

import { problemDetailsSchema, processSchema } from '@contrataflow/validation';
import type { ProcessDto } from '@contrataflow/validation';
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
  timelineRowsOf,
} from '../../../../test/support/process-fixtures.js';
import {
  seedPanelDocument,
  storedPanelDocument,
} from '../../../../test/support/process-panel-fixtures.js';
import {
  assignDepartment,
  assignRole,
  seedDefaultRolesOf,
} from '../../../../test/support/structure-fixtures.js';
import { PROCESS_CLOCK, PROCESS_TRANSACTIONS } from '../application/ports.js';
import type { ProcessTransactions } from '../application/ports.js';
import type { Process } from '../domain/process.js';

/*
 * US-013 — PRC-33 (sigilo do orçamento estimado) pelo pipeline HTTP completo (autenticação, tenant,
 * vínculo, autorização por processo, `If-Match`, filtro RFC 9457) com a identidade fake, os seeders
 * reais e o processo criado pelo PRC-02, com auditoria, outbox, timeline e documentos em memória.
 * As 8 categorias do Gherkin e os fluxos alternativos. Personas (só os vínculos ativos do diretório
 * fake): Carla = Lúcia (GESTOR_CONTRATACOES); Breno = Fábio (+ AUTORIDADE_COMPETENTE); Hugo = Otávio
 * (ADMIN_ORGAO + SOMENTE_LEITURA — só PROCESS_VIEW); Iris = Marta (ADMIN_ORGAO + CONTROLE_INTERNO);
 * Ana = custodiante (REQUISITANTE, sem PROCESS_VIEW_CONFIDENTIAL_BUDGET). O AUDITOR está na matriz
 * de `access/domain/default-roles.spec.ts`. Trava de linha, cascata e RLS sobre o PostgreSQL:
 * `test/tenant-leak/process-confidentiality.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-05T15:00:00.000Z');
const VALUE = '150000.00';

const ORG_A = '0192d013-0000-7000-8000-0000000000a0';
const ORG_B = '0192d013-0000-7000-8000-0000000000b0';
const UNITS_A = {
  organizationId: ORG_A,
  obras: '0192d013-0000-7000-8000-0000000000a1',
  manutencao: '0192d013-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d013-0000-7000-8000-0000000000a3',
  saude: '0192d013-0000-7000-8000-0000000000a4',
  posto: '0192d013-0000-7000-8000-0000000000a5',
};
const UNITS_B = {
  organizationId: ORG_B,
  obras: '0192d013-0000-7000-8000-0000000000b1',
  manutencao: '0192d013-0000-7000-8000-0000000000b2',
  pavimentacao: '0192d013-0000-7000-8000-0000000000b3',
  saude: '0192d013-0000-7000-8000-0000000000b4',
  posto: '0192d013-0000-7000-8000-0000000000b5',
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

describe('Feature: Sigilo do orçamento estimado (US-013)', () => {
  let api: TestApi;
  let log: MockInstance<Logger['log']>;
  const transactions = new FlakyTransactions();
  let catalog: { contractingType: string; origin: string };
  const words = (count: number) =>
    Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

  const auth = (call: request.Test, subject: string, tenant: string = A) =>
    call
      .set('Authorization', api.bearer(subject, { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', tenant);
  const put = (
    id: string,
    payload: Record<string, unknown>,
    options: { subject?: string; ifMatch?: string | null; tenant?: string } = {},
  ) => {
    const call = auth(
      request(api.server).put(`/api/v1/processes/${id}/confidentiality`),
      options.subject ?? 'sub-lucia',
      options.tenant ?? A,
    );
    if (options.ifMatch !== null) call.set('If-Match', options.ifMatch ?? '"1"');
    return call.send(payload);
  };
  const getProcess = async (id: string, subject: string) => {
    const response = await auth(request(api.server).get(`/api/v1/processes/${id}`), subject);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return processSchema.parse(data<ProcessDto>(response));
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
      .filter(
        (row) => row.aggregateId === processId && row.eventType === 'ProcessConfidentialityChanged',
      );

  /** "0012/2026" com valor estimado 150000.00 e version 1 (Background), sob custódia de Ana. */
  async function processWith(fields: Partial<Process> = {}): Promise<Process> {
    const response = await auth(request(api.server).post('/api/v1/processes'), 'sub-ana')
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
      estimatedValue: VALUE,
      estimatedValueSource: 'MANUAL',
      version: 1,
      ...fields,
    };
    repository().replace(process);
    return process;
  }

  /** Pesquisa de preços aprovada e um ETP (fora da cascata) no processo. */
  async function documentsOf(processId: string, confidentiality: 'INTERNAL' | 'RESTRICTED') {
    const priceResearch = await seedPanelDocument(api, {
      tenantId: A,
      processId,
      typeCode: 'PRICE_RESEARCH',
      code: 'PP 0002/2026',
      title: 'Pesquisa de preços',
      status: 'APPROVED',
      versionNumber: 1,
      confidentiality,
      createdById: FAKE_USERS.ana.id,
    });
    const etp = await seedPanelDocument(api, {
      tenantId: A,
      processId,
      typeCode: 'ETP',
      code: null,
      title: 'Estudo técnico preliminar',
      status: 'DRAFT',
      createdById: FAKE_USERS.ana.id,
    });
    return { priceResearch, etp };
  }

  beforeAll(async () => {
    log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
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
    assignDepartment(api, membershipOf(FAKE_USERS.ana.id), UNITS_A.manutencao);
    const roles = seedDefaultRolesOf(api, A);
    const grant = (membershipId: string, roleKey: string) => {
      assignRole(api, {
        tenantId: A,
        membershipId,
        roleId: roles.get(roleKey)?.id ?? '',
      });
    };
    grant(membershipOf(FAKE_USERS.lucia.id), 'GESTOR_CONTRATACOES');
    grant(membershipOf(FAKE_USERS.fabio.id), 'AUTORIDADE_COMPETENTE');
    grant(membershipOf(FAKE_USERS.otavio.id), 'SOMENTE_LEITURA');
    grant(membershipOf(FAKE_USERS.marta.id), 'CONTROLE_INTERNO');
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
    it('Marcar o orçamento como sigiloso: version 2, pesquisa RESTRICTED, auditoria, evento e máscara por perfil', async () => {
      const process = await processWith();
      const docs = await documentsOf(process.id, 'INTERNAL');

      const response = await put(process.id, { isBudgetConfidential: true });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers.etag).toBe('"2"');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(processSchema.parse(data<ProcessDto>(response))).toMatchObject({
        isBudgetConfidential: true,
        version: 2,
        // Carla tem PROCESS_VIEW_CONFIDENTIAL_BUDGET.
        estimatedValue: VALUE,
        estimatedValueMasked: false,
      });
      expect(stored(process.id)).toMatchObject({
        isBudgetConfidential: true,
        version: 2,
        updatedById: FAKE_USERS.lucia.id,
      });

      // RN-PROC-139: pesquisa de preços (mesmo APPROVED) passa a RESTRICTED; o ETP não muda.
      expect(storedPanelDocument(api, docs.priceResearch)).toMatchObject({
        confidentiality: 'RESTRICTED',
        status: 'APPROVED',
        version: 2,
      });
      expect(storedPanelDocument(api, docs.etp)).toMatchObject({
        confidentiality: 'INTERNAL',
        version: 1,
      });

      const [audit, ...moreAudit] = auditOf('process.confidentiality_change', process.id);
      expect(moreAudit).toEqual([]);
      expect(audit).toMatchObject({
        category: 'DATA_CHANGE',
        changes: [{ path: 'isBudgetConfidential', old: false, new: true }],
        metadata: { processCode: process.code, version: 2, documentsChanged: 1 },
      });
      const [event, ...moreEvents] = eventsOf(process.id);
      expect(moreEvents).toEqual([]);
      expect(event).toMatchObject({
        routingKey: 'process.confidentiality_changed',
        payload: { isBudgetConfidential: true },
      });
      // Projeção síncrona: o fato de ser sigiloso não é segredo (STANDARD).
      expect(
        timelineRowsOf(api).filter(
          (row) => row.processId === process.id && row.type === 'CONFIDENTIALITY_CHANGED',
        ),
      ).toEqual([
        expect.objectContaining({
          params: { isBudgetConfidential: true },
          visibility: 'STANDARD',
        }),
      ]);

      // Hugo (só PROCESS_VIEW): nulo + marca; o campo nunca é omitido (api.md §1.4).
      const hugo = await getProcess(process.id, 'sub-otavio');
      expect(hugo).toHaveProperty('estimatedValue', null);
      expect(hugo).toHaveProperty('estimatedValueMasked', true);

      // Iris (CONTROLE_INTERNO — RN-PROC-142): vê o valor e a leitura é auditada.
      const iris = await getProcess(process.id, 'sub-marta');
      expect(iris).toMatchObject({ estimatedValue: VALUE, estimatedValueMasked: false });
      expect(
        auditOf('process.confidential_view', process.id).filter(
          (row) => row.actorUserId === FAKE_USERS.marta.id,
        ),
      ).toEqual([expect.objectContaining({ category: 'ACCESS' })]);
      expect(
        auditOf('process.confidential_view', process.id).filter(
          (row) => row.actorUserId === FAKE_USERS.otavio.id,
        ),
      ).toEqual([]);

      // Log de negócio sem o valor estimado (story · Logs).
      const logged = log.mock.calls.find(
        ([entry]) => (entry as { event?: string }).event === 'process.confidentiality_changed',
      );
      expect(logged?.[0]).toMatchObject({ processId: process.id, isBudgetConfidential: true });
      expect(JSON.stringify(log.mock.calls)).not.toContain('150000');
    });

    it('Reverter o sigilo: pesquisa volta à confidencialidade padrão do tipo e Hugo vê o valor', async () => {
      const process = await processWith({ isBudgetConfidential: true, version: 2 });
      const docs = await documentsOf(process.id, 'RESTRICTED');

      const response = await put(process.id, { isBudgetConfidential: false }, { ifMatch: '"2"' });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers.etag).toBe('"3"');
      expect(stored(process.id)).toMatchObject({ isBudgetConfidential: false, version: 3 });
      expect(storedPanelDocument(api, docs.priceResearch).confidentiality).toBe('INTERNAL');
      expect(eventsOf(process.id).at(-1)?.payload).toEqual({ isBudgetConfidential: false });
      expect(auditOf('process.confidentiality_change', process.id)[0]?.changes).toEqual([
        { path: 'isBudgetConfidential', old: true, new: false },
      ]);

      expect(await getProcess(process.id, 'sub-otavio')).toMatchObject({
        estimatedValue: VALUE,
        estimatedValueMasked: false,
      });
    });

    it('Flag já no estado pedido: 200 com o processo atual, sem nova versão, evento nem auditoria', async () => {
      const process = await processWith();
      const response = await put(process.id, { isBudgetConfidential: false });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers.etag).toBe('"1"');
      expect(stored(process.id).version).toBe(1);
      expect(eventsOf(process.id)).toEqual([]);
      expect(auditOf('process.confidentiality_change', process.id)).toEqual([]);
    });
  });

  describe('[Validação]', () => {
    it('Corpo sem isBudgetConfidential: 422 VALIDATION_ERROR (REQUIRED) e o sigilo não muda', async () => {
      const process = await processWith();
      const problem = expectProblem(await put(process.id, {}), 422, 'VALIDATION_ERROR');
      expect(problem.errors).toEqual([
        {
          field: 'isBudgetConfidential',
          code: 'REQUIRED',
          message: 'Informe se o orçamento é sigiloso.',
        },
      ]);
      expect(stored(process.id)).toMatchObject({ isBudgetConfidential: false, version: 1 });
    });

    it('Valor não booleano: 422 INVALID_FORMAT; campo extra: 422', async () => {
      const process = await processWith();
      const problem = expectProblem(
        await put(process.id, { isBudgetConfidential: 'sim' }),
        422,
        'VALIDATION_ERROR',
      );
      expect(problem.errors).toEqual([
        expect.objectContaining({ field: 'isBudgetConfidential', code: 'INVALID_FORMAT' }),
      ]);
      expectProblem(
        await put(process.id, { isBudgetConfidential: true, estimatedValue: '1.00' }),
        422,
        'VALIDATION_ERROR',
      );
      expect(stored(process.id).isBudgetConfidential).toBe(false);
    });

    it('Sem If-Match: 428 PRECONDITION_REQUIRED', async () => {
      const process = await processWith();
      expectProblem(
        await put(process.id, { isBudgetConfidential: true }, { ifMatch: null }),
        428,
        'PRECONDITION_REQUIRED',
      );
      expect(stored(process.id).isBudgetConfidential).toBe(false);
    });

    it('RN-PROC-137: o PATCH genérico não altera o sigilo (422)', async () => {
      const process = await processWith();
      const response = await auth(
        request(api.server).patch(`/api/v1/processes/${process.id}`),
        'sub-ana',
      )
        .set('If-Match', '"1"')
        .send({ isBudgetConfidential: true });
      expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(stored(process.id).isBudgetConfidential).toBe(false);
    });
  });

  describe('[Permissão]', () => {
    it('Hugo sem PROCESS_SET_CONFIDENTIAL_BUDGET: 403 PERMISSION_DENIED e access.denied', async () => {
      const process = await processWith();
      const problem = expectProblem(
        await put(process.id, { isBudgetConfidential: true }, { subject: 'sub-otavio' }),
        403,
        'PERMISSION_DENIED',
      );
      expect(problem.detail).toBe('Você não tem permissão para definir o sigilo deste processo.');
      expect(
        api
          .auditRecords()
          .filter(
            (row) => row.action === 'access.denied' && row.actorUserId === FAKE_USERS.otavio.id,
          )
          .at(-1),
      ).toMatchObject({ reasonCode: 'PROCESS_SET_CONFIDENTIAL_BUDGET' });
      expect(stored(process.id)).toMatchObject({ isBudgetConfidential: false, version: 1 });
    });

    it('FA-01: custodiante sem a permissão de visualização vê o valor, mas não altera o sigilo', async () => {
      const process = await processWith({ isBudgetConfidential: true });
      expect(await getProcess(process.id, 'sub-ana')).toMatchObject({
        estimatedValue: VALUE,
        estimatedValueMasked: false,
      });
      expectProblem(
        await put(process.id, { isBudgetConfidential: false }, { subject: 'sub-ana' }),
        403,
        'PERMISSION_DENIED',
      );
      expect(stored(process.id).isBudgetConfidential).toBe(true);
    });

    it('Matriz: GESTOR_CONTRATACOES e AUTORIDADE_COMPETENTE alteram; CONTROLE_INTERNO e leitura não', async () => {
      const process = await processWith();
      expect((await put(process.id, { isBudgetConfidential: true })).status).toBe(200);
      expect(
        (
          await put(
            process.id,
            { isBudgetConfidential: false },
            { subject: 'sub-fabio', ifMatch: '"2"' },
          )
        ).status,
      ).toBe(200);
      for (const subject of ['sub-marta', 'sub-otavio']) {
        expectProblem(
          await put(process.id, { isBudgetConfidential: true }, { subject, ifMatch: '"3"' }),
          403,
          'PERMISSION_DENIED',
        );
      }
      expect(stored(process.id)).toMatchObject({ isBudgetConfidential: false, version: 3 });
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Processo de outro tenant: 404 PROCESS_NOT_FOUND idêntico ao inexistente', async () => {
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
      const strip = (body: unknown) => {
        const {
          instance: _instance,
          correlationId: _correlation,
          ...rest
        } = body as Record<string, unknown>;
        return rest;
      };
      const other = expectProblem(
        await put(foreign.id, { isBudgetConfidential: true }),
        404,
        'PROCESS_NOT_FOUND',
      );
      const missing = expectProblem(
        await put(randomUUID(), { isBudgetConfidential: true }),
        404,
        'PROCESS_NOT_FOUND',
      );
      expect(strip(other)).toEqual(strip(missing));
      expect(JSON.stringify(other)).not.toContain('0099');
      expect(stored(foreign.id).isBudgetConfidential).toBe(false);
    });
  });

  describe('[Duplicidade]', () => {
    it('Reenvio da ativação com If-Match desatualizado: 412 com currentVersion 2 e nenhum novo evento', async () => {
      const process = await processWith();
      expect((await put(process.id, { isBudgetConfidential: true })).status).toBe(200);
      const retry = await put(process.id, { isBudgetConfidential: true }, { ifMatch: '"1"' });
      expectProblem(retry, 412, 'VERSION_CONFLICT');
      const body = z
        .looseObject({
          currentVersion: z.number(),
          meta: z.looseObject({ current: processSchema }),
        })
        .parse(retry.body);
      expect(body.currentVersion).toBe(2);
      // `meta.current` também segue a POL-09 para quem pediu.
      expect(body.meta.current).toMatchObject({ isBudgetConfidential: true, version: 2 });
      expect(stored(process.id).version).toBe(2);
      expect(eventsOf(process.id)).toHaveLength(1);
      expect(auditOf('process.confidentiality_change', process.id)).toHaveLength(1);
    });
  });

  describe('[Concorrência]', () => {
    it('Duas alterações simultâneas com o mesmo If-Match: uma 200 (version 2), a outra 412', async () => {
      const process = await processWith();
      const statuses = (
        await Promise.all([
          put(process.id, { isBudgetConfidential: true }),
          put(process.id, { isBudgetConfidential: true }, { subject: 'sub-fabio' }),
        ])
      )
        .map((response) => response.status)
        .sort();
      expect(statuses).toEqual([200, 412]);
      expect(stored(process.id)).toMatchObject({ isBudgetConfidential: true, version: 2 });
      expect(eventsOf(process.id)).toHaveLength(1);
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível: 503 DEPENDENCY_UNAVAILABLE e nada persistido', async () => {
      const process = await processWith();
      const before = { events: api.outboxRows().length, audit: api.auditRecords().length };
      transactions.down = true;
      expectProblem(
        await put(process.id, { isBudgetConfidential: true }),
        503,
        'DEPENDENCY_UNAVAILABLE',
      );
      transactions.down = false;
      expect(stored(process.id)).toMatchObject({ isBudgetConfidential: false, version: 1 });
      expect({ events: api.outboxRows().length, audit: api.auditRecords().length }).toEqual(before);
    });
  });

  describe('[Falha de integração]', () => {
    it('Relay do outbox indisponível: 200 e o evento fica no outbox para publicação', async () => {
      // Sem relay no teste: a linha permanece para publicar (PENDING no PostgreSQL — tenant-leak).
      const process = await processWith();
      const response = await put(process.id, { isBudgetConfidential: true });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(eventsOf(process.id)).toHaveLength(1);
      expect(stored(process.id).isBudgetConfidential).toBe(true);
    });
  });
});
