import { randomUUID } from 'node:crypto';

import {
  actionEntrySchema,
  problemDetailsSchema,
  processItemSchema,
} from '@contrataflow/validation';
import type { ActionEntry, ProcessDto, ProcessItemDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { z } from 'zod';

import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { ProcessItemUsageRegistry } from '#shared/process/process-item-usage.js';
import type { ProcessItemUsage } from '#shared/process/process-item-usage.js';
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
  assignDepartment,
  assignRole,
  seedDefaultRolesOf,
} from '../../../../test/support/structure-fixtures.js';
import { PROCESS_CLOCK, PROCESS_TRANSACTIONS } from '../application/ports.js';
import type { ProcessTransactions } from '../application/ports.js';
import type { Process } from '../domain/process.js';
import { InMemoryProcessItemRepository } from '../infrastructure/process-item.repositories.js';

/*
 * US-006 — PRC-13..17 (itens da contratação) pelo pipeline HTTP completo (autenticação, tenant,
 * vínculo, autorização, `If-Match`, `Idempotency-Key`, filtro RFC 9457) com a identidade fake, os
 * seeders reais (catálogos — `UNIT_OF_MEASURE` — perfis e workflow padrão) e o processo criado pelo
 * PRC-02, com auditoria, outbox e timeline em memória. As 8 categorias do Gherkin. Ana
 * (REQUISITANTE, lotada em Manutenção) é a responsável; Juliana = Fábio (COMPRAS, escopo TENANT, sem
 * custódia); Tatiane = Otávio (só SOMENTE_LEITURA: sem PROCESS_UPDATE nem POL-09). O uso dos itens
 * por documentos vem de um leitor de teste registrado na `ProcessItemUsageRegistry`. Trava do
 * processo (20 inclusões paralelas), renumeração em duas fases, RLS e rollback no PostgreSQL:
 * `test/tenant-leak/process-items.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-05T15:00:00.000Z');

const UNITS_A = {
  organizationId: '0192d006-0000-7000-8000-0000000000a0',
  obras: '0192d006-0000-7000-8000-0000000000a1',
  manutencao: '0192d006-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d006-0000-7000-8000-0000000000a3',
  saude: '0192d006-0000-7000-8000-0000000000a4',
  posto: '0192d006-0000-7000-8000-0000000000a5',
};
const UNITS_B = {
  organizationId: '0192d006-0000-7000-8000-0000000000b0',
  obras: '0192d006-0000-7000-8000-0000000000b1',
  manutencao: '0192d006-0000-7000-8000-0000000000b2',
  pavimentacao: '0192d006-0000-7000-8000-0000000000b3',
  saude: '0192d006-0000-7000-8000-0000000000b4',
  posto: '0192d006-0000-7000-8000-0000000000b5',
};

const membershipOf = (userId: string, tenantId = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

/** Transações que podem simular o banco fora do ar (Falha de banco). */
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

/** Documentos que referenciam itens (o papel de `DocumentItem`/`PriceItem` — US-014/US-024). */
class FakeUsageReader {
  usages: ProcessItemUsage[] = [];

  findItemReferences(_tx: TenantTx, itemIds: readonly string[]): Promise<ProcessItemUsage[]> {
    return Promise.resolve(this.usages.filter((usage) => itemIds.includes(usage.itemId)));
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

describe('Feature: Gerenciar itens da contratação (US-006)', () => {
  let api: TestApi;
  let log: MockInstance<Logger['log']>;
  const transactions = new FlakyTransactions();
  const usage = new FakeUsageReader();
  let units: { un: string; m3: string; foreign: string };
  let catalog: { contractingType: string; origin: string };
  const words = (count: number) =>
    Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

  const auth = (call: request.Test, subject = 'sub-ana', tenant: string = A) =>
    call
      .set('Authorization', api.bearer(subject, { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', tenant);
  const list = (processId: string, subject = 'sub-ana', tenant: string = A) =>
    auth(request(api.server).get(`/api/v1/processes/${processId}/items`), subject, tenant);
  const add = (
    processId: string,
    payload: Record<string, unknown>,
    options: { subject?: string; key?: string; tenant?: string } = {},
  ) =>
    auth(
      request(api.server).post(`/api/v1/processes/${processId}/items`),
      options.subject,
      options.tenant,
    )
      .set('Idempotency-Key', options.key ?? randomUUID())
      .send(payload);
  const patch = (
    itemId: string,
    payload: Record<string, unknown>,
    ifMatch: string | null = '"1"',
    subject = 'sub-ana',
  ) => {
    const call = auth(request(api.server).patch(`/api/v1/process-items/${itemId}`), subject);
    if (ifMatch !== null) call.set('If-Match', ifMatch);
    return call.send(payload);
  };
  const remove = (itemId: string, ifMatch = '"1"', subject = 'sub-ana', tenant: string = A) =>
    auth(request(api.server).delete(`/api/v1/process-items/${itemId}`), subject, tenant).set(
      'If-Match',
      ifMatch,
    );
  const reorder = (processId: string, itemIds: readonly string[], ifMatch: string) =>
    auth(request(api.server).post(`/api/v1/processes/${processId}/items/reorder`))
      .set('If-Match', ifMatch)
      .send({ itemIds });

  const repository = () => processRepositoryOf(api);
  const itemStore = () => api.app.get(InMemoryProcessItemRepository);
  const stored = (id: string): Process => {
    const process = repository()
      .allProcesses()
      .find((candidate) => candidate.id === id);
    if (!process) throw new Error(`processo ${id} ausente`);
    return process;
  };
  const eventsOf = (processId: string) =>
    api
      .outboxRows()
      .filter((row) => row.aggregateId === processId && row.eventType === 'ProcessItemsChanged');
  const auditOf = (processId: string) =>
    api
      .auditRecords()
      .filter((row) => row.action === 'process.items_update' && row.entityId === processId);
  const itemsOnTimeline = (processId: string) =>
    timelineRowsOf(api).filter(
      (row) => row.processId === processId && row.type === 'ITEMS_CHANGED',
    );
  const item = (body: Partial<Record<string, unknown>> = {}) => ({
    description: 'Cimento CP-II 50 kg',
    kind: 'GOOD',
    unitOfMeasureId: units.un,
    ...body,
  });

  /** Processo criado pelo PRC-02 (Ana responsável) e levado ao estado do cenário. */
  async function processWith(fields: Partial<Process> = {}): Promise<Process> {
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
    const created = stored(data<ProcessDto>(response).id);
    const process: Process = { ...created, status: 'IN_PROGRESS', version: 14, ...fields };
    repository().replace(process);
    return process;
  }

  async function addOk(processId: string, payload: Record<string, unknown> = {}) {
    const response = await add(processId, item(payload));
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return processItemSchema.parse(data<ProcessItemDto>(response));
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
    assignRole(api, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.otavio.id),
      roleId: seedDefaultRolesOf(api, A).get('SOMENTE_LEITURA')?.id ?? '',
    });
    api.app.get(ProcessItemUsageRegistry).register(usage);
    units = {
      un: catalogItemId(api, A, 'UNIT_OF_MEASURE', 'UN'),
      m3: catalogItemId(api, A, 'UNIT_OF_MEASURE', 'M3'),
      foreign: catalogItemId(api, B, 'UNIT_OF_MEASURE', 'UN'),
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
    usage.usages = [];
  });

  describe('[Sucesso]', () => {
    it('Adicionar itens com lote: números 1 e 2, mesmo nome de lote, versão do processo a cada inclusão, evento, timeline e auditoria', async () => {
      const process = await processWith();
      const first = await add(
        process.id,
        item({ lotNumber: 1, lotName: 'Materiais de construção' }),
      );
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      const cimento = processItemSchema.parse(data<ProcessItemDto>(first));
      expect(first.headers.location).toBe(`/api/v1/process-items/${cimento.id}`);
      expect(first.headers.etag).toBe('"1"');
      expect(stored(process.id).version).toBe(15);

      const areia = await addOk(process.id, {
        description: 'Areia média',
        unitOfMeasureId: units.m3,
        lotNumber: 1,
      });
      expect(stored(process.id).version).toBe(16);
      expect(cimento).toMatchObject({
        sequence: 1,
        lotNumber: 1,
        lotName: 'Materiais de construção',
        kind: 'GOOD',
        unitOfMeasure: { id: units.un, label: 'Unidade' },
        referenceQuantity: null,
        referenceUnitPriceMasked: false,
        references: [],
        version: 1,
      });
      expect(areia).toMatchObject({ sequence: 2, lotName: 'Materiais de construção' });

      const events = eventsOf(process.id);
      expect(events.map((row) => row.payload)).toEqual([
        { added: [cimento.id], updated: [], removed: [], itemsCount: 1 },
        { added: [areia.id], updated: [], removed: [], itemsCount: 2 },
      ]);
      expect(events[0]).toMatchObject({ routingKey: 'process.items_changed' });
      expect(itemsOnTimeline(process.id).at(-1)).toMatchObject({
        params: expect.objectContaining({ itemsCount: 2, addedCount: 1 }) as unknown,
      });
      const [audit] = auditOf(process.id);
      expect(audit).toMatchObject({
        category: 'DATA_CHANGE',
        metadata: { processCode: process.code, operation: 'ADD', itemsCount: 1, version: 15 },
      });
      // Descrição como hash + tamanho (story · Auditoria).
      expect(audit?.changes).toContainEqual({
        path: `items[${cimento.id}].description`,
        old: null,
        new: { sha256: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown, length: 19 },
      });
      expect(JSON.stringify(audit)).not.toContain('Cimento');

      const listed = await list(process.id);
      expect(listed.status, JSON.stringify(listed.body)).toBe(200);
      expect(listed.headers.etag).toBe('"16"');
      expect(listed.headers['cache-control']).toBe('no-store');
      expect(
        z
          .array(processItemSchema)
          .parse(data<ProcessItemDto[]>(listed))
          .map((entry) => [entry.sequence, entry.description]),
      ).toEqual([
        [1, 'Cimento CP-II 50 kg'],
        [2, 'Areia média'],
      ]);
      // Log de negócio sem textos.
      const logged = log.mock.calls.find(
        ([entry]) => (entry as { event?: string }).event === 'process.items_changed',
      );
      expect(logged?.[0]).toMatchObject({ processId: process.id, added: 1 });
      expect(JSON.stringify(logged?.[0])).not.toContain('Cimento');
      // O resumo do painel conta os itens (RN-PROC-57).
      const summary = await auth(
        request(api.server).get(`/api/v1/processes/${process.id}/summary`),
      );
      expect((summary.body as { data: { counts: { items: number } } }).data.counts.items).toBe(2);
    });

    it('Nome diferente de lote renomeia o lote inteiro (RN-PROC-75) e PATCH altera descrição', async () => {
      const process = await processWith();
      const one = await addOk(process.id, { lotNumber: 3, lotName: 'Lote A' });
      const two = await addOk(process.id, { lotNumber: 3, lotName: 'Lote B' });
      expect(two.lotName).toBe('Lote B');
      const stored1 = itemStore()
        .all()
        .find((row) => row.id === one.id);
      expect(stored1).toMatchObject({ lotName: 'Lote B', version: 2 });
      expect(eventsOf(process.id).at(-1)?.payload).toEqual({
        added: [two.id],
        updated: [one.id],
        removed: [],
        itemsCount: 2,
      });

      const response = await patch(two.id, {
        description: 'Cimento CP-IV 50 kg',
        notes: 'Ensacado',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers.etag).toBe('"2"');
      expect(data<ProcessItemDto>(response)).toMatchObject({
        description: 'Cimento CP-IV 50 kg',
        notes: 'Ensacado',
        version: 2,
      });
      expect(auditOf(process.id).at(-1)).toMatchObject({ metadata: { operation: 'UPDATE' } });
      // PATCH idêntico: sem nova versão nem evento.
      const before = eventsOf(process.id).length;
      const same = await patch(two.id, { description: 'Cimento CP-IV 50 kg' }, '"2"');
      expect(same.status).toBe(200);
      expect(eventsOf(process.id)).toHaveLength(before);
    });

    it('Renumerar após exclusão: lacunas 1 e 3; "Renumerar" passa a 1 e 2 mantendo a ordem', async () => {
      const process = await processWith();
      const one = await addOk(process.id);
      const two = await addOk(process.id);
      const three = await addOk(process.id);
      const deleted = await remove(two.id);
      expect(deleted.status, JSON.stringify(deleted.body)).toBe(204);
      expect(eventsOf(process.id).at(-1)?.payload).toEqual({
        added: [],
        updated: [],
        removed: [two.id],
        itemsCount: 2,
      });

      const listed = await list(process.id);
      const items = data<ProcessItemDto[]>(listed);
      expect(items.map((entry) => entry.sequence)).toEqual([1, 3]);
      const etag = listed.headers.etag ?? '';

      const renumbered = await reorder(
        process.id,
        items.map((entry) => entry.id),
        etag,
      );
      expect(renumbered.status, JSON.stringify(renumbered.body)).toBe(200);
      expect(data<ProcessItemDto[]>(renumbered).map((entry) => [entry.id, entry.sequence])).toEqual(
        [
          [one.id, 1],
          [three.id, 2],
        ],
      );
      expect(renumbered.headers.etag).toBe(`"${String(Number(etag.replaceAll('"', '')) + 1)}"`);
      expect(eventsOf(process.id).at(-1)?.payload).toEqual({
        added: [],
        updated: [three.id],
        removed: [],
        itemsCount: 2,
      });
      expect(auditOf(process.id).at(-1)?.changes).toEqual([
        { path: `items[${three.id}].sequence`, old: 3, new: 2 },
      ]);

      // Arrastar: nova ordem completa.
      const swapped = await reorder(process.id, [three.id, one.id], renumbered.headers.etag ?? '');
      expect(data<ProcessItemDto[]>(swapped).map((entry) => entry.id)).toEqual([three.id, one.id]);
    });
  });

  describe('[Validação]', () => {
    it('Código de catálogo inválido e campos somente leitura: 422 INVALID_FORMAT e NOT_ALLOWED', async () => {
      const process = await processWith();
      const invalid = await add(process.id, item({ catalogSystem: 'CATMAT', catalogCode: 'AB12' }));
      expectProblem(invalid, 422, 'VALIDATION_ERROR');
      expect(fieldErrors(invalid)).toEqual([['catalogCode', 'INVALID_FORMAT']]);

      const created = await addOk(process.id, {
        catalogSystem: 'OTHER',
        catalogCode: 'MAT-12.3/A',
      });
      const readOnly = await patch(created.id, { referenceUnitPrice: '35.0000' });
      expectProblem(readOnly, 422, 'VALIDATION_ERROR');
      expect(fieldErrors(readOnly)).toEqual([['referenceUnitPrice', 'NOT_ALLOWED']]);
      expect(fieldErrors(await patch(created.id, { sequence: 9 }))).toEqual([
        ['sequence', 'NOT_ALLOWED'],
      ]);
    });

    it('Descrição curta, natureza inválida, nome de lote sem número, código sem sistema e lote fora da faixa', async () => {
      const process = await processWith();
      const response = await add(process.id, {
        description: 'ab',
        kind: 'FOOD',
        unitOfMeasureId: units.un,
        lotName: 'Sem número',
        catalogCode: '123',
      });
      expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(fieldErrors(response)).toEqual(
        expect.arrayContaining([
          ['description', 'TOO_SHORT'],
          ['kind', 'INVALID_ENUM'],
        ]),
      );
      const conditional = await add(
        process.id,
        item({ lotName: 'Sem número', catalogCode: '123' }),
      );
      expect(fieldErrors(conditional)).toEqual([
        ['lotNumber', 'CONDITIONAL_REQUIRED'],
        ['catalogSystem', 'CONDITIONAL_REQUIRED'],
      ]);
      expect(fieldErrors(await add(process.id, item({ lotNumber: 1000 })))).toEqual([
        ['lotNumber', 'OUT_OF_RANGE'],
      ]);
      // Regras cruzadas no estado resultante do PATCH (código sem sistema ao limpar o sistema).
      const created = await addOk(process.id, { catalogSystem: 'CATSER', catalogCode: '4471' });
      expect(fieldErrors(await patch(created.id, { catalogSystem: null }))).toEqual([
        ['catalogSystem', 'CONDITIONAL_REQUIRED'],
      ]);
    });

    it('Reordenação inválida: repetido, inexistente e ausente em itemIds; If-Match obrigatório', async () => {
      const process = await processWith();
      const one = await addOk(process.id);
      const two = await addOk(process.id);
      const etag = (await list(process.id)).headers.etag ?? '';
      const invalid = await reorder(process.id, [one.id, one.id, randomUUID()], etag);
      expectProblem(invalid, 422, 'VALIDATION_ERROR');
      expect(fieldErrors(invalid)).toEqual([
        ['itemIds', 'DUPLICATE_IN_LIST'],
        ['itemIds', 'REFERENCE_NOT_FOUND'],
        ['itemIds', 'REQUIRED'],
      ]);
      expect(two.sequence).toBe(2);
      expectProblem(
        await auth(request(api.server).post(`/api/v1/processes/${process.id}/items/reorder`)).send({
          itemIds: [one.id, two.id],
        }),
        428,
        'PRECONDITION_REQUIRED',
      );
      expectProblem(await patch(one.id, { notes: 'x' }, null), 428, 'PRECONDITION_REQUIRED');
    });

    it('Limite de 1.000 itens ativos: 422 OUT_OF_RANGE', async () => {
      const process = await processWith();
      const first = await addOk(process.id);
      const store = itemStore();
      const base = store.all().find((row) => row.id === first.id);
      if (!base) throw new Error('item ausente');
      // Carga direta dos outros 999 itens (o limite é de domínio, não de desempenho).
      for (let sequence = 2; sequence <= 1000; sequence += 1) {
        store.seed({ ...base, id: randomUUID(), sequence });
      }
      const response = await add(process.id, item());
      expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(problemDetailsSchema.parse(response.body).errors).toEqual([
        expect.objectContaining({
          code: 'OUT_OF_RANGE',
          message: 'O processo atingiu o limite de 1.000 itens.',
        }),
      ]);
    });
  });

  describe('[Permissão]', () => {
    it('Sem custódia: 403 NOT_PROCESS_CUSTODIAN e access.denied; sem PROCESS_UPDATE: 403 no guard', async () => {
      const process = await processWith();
      expectProblem(
        await add(process.id, item(), { subject: 'sub-fabio' }),
        403,
        'NOT_PROCESS_CUSTODIAN',
      );
      expect(api.auditRecords().at(-1)).toMatchObject({
        action: 'access.denied',
        reasonCode: 'NOT_PROCESS_CUSTODIAN',
      });
      expectProblem(
        await add(process.id, item(), { subject: 'sub-otavio' }),
        403,
        'PERMISSION_DENIED',
      );
      expect(eventsOf(process.id)).toEqual([]);
    });

    it('PRC-08: "Gerenciar itens" habilitada para a responsável, desabilitada para Juliana e ausente sem PROCESS_UPDATE; aguardando aprovação = 409', async () => {
      const process = await processWith();
      const actionOf = async (subject: string) =>
        z
          .array(actionEntrySchema)
          .parse(
            data<ActionEntry[]>(
              await auth(
                request(api.server).get(`/api/v1/processes/${process.id}/available-actions`),
                subject,
              ),
            ),
          )
          .find((entry) => entry.action === 'MANAGE_ITEMS');
      expect(await actionOf('sub-ana')).toMatchObject({ enabled: true, reasons: [] });
      expect(await actionOf('sub-fabio')).toMatchObject({
        enabled: false,
        reasons: [
          {
            code: 'NOT_PROCESS_CUSTODIAN',
            message: 'Somente quem está com o processo pode alterar os itens.',
          },
        ],
      });

      const awaiting = await processWith({ status: 'AWAITING_APPROVAL' });
      const problem = expectProblem(await add(awaiting.id, item()), 409, 'INVALID_PROCESS_STATUS');
      expect(problem.detail).toBe(
        'Itens não podem ser alterados com o processo aguardando aprovação.',
      );
    });

    it('Preço de referência sigiloso: nulo e mascarado para quem não atende POL-09; quantidade visível', async () => {
      const process = await processWith({ isBudgetConfidential: true });
      const created = await addOk(process.id);
      itemStore().setReferences(created.id, {
        referenceQuantity: '120.0000',
        referenceUnitPrice: '32.5000',
      });
      const masked = data<ProcessItemDto[]>(await list(process.id, 'sub-otavio'));
      expect(masked[0]).toMatchObject({
        referenceQuantity: '120.0000',
        referenceUnitPrice: null,
        referenceUnitPriceMasked: true,
      });
      // A responsável (custódia — POL-09) vê o preço.
      const visible = data<ProcessItemDto[]>(await list(process.id));
      expect(visible[0]).toMatchObject({
        referenceUnitPrice: '32.5000',
        referenceUnitPriceMasked: false,
      });
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Item de outro tenant: PATCH/DELETE 404 NOT_FOUND; unidade de outro tenant: 422 REFERENCE_NOT_FOUND', async () => {
      const process = await processWith();
      const created = await addOk(process.id);
      // Heitor (tenant B) pede o item de A.
      expectProblem(
        await auth(
          request(api.server).patch(`/api/v1/process-items/${created.id}`),
          'sub-heitor',
          B,
        )
          .set('If-Match', '"1"')
          .send({ notes: 'x' }),
        404,
        'NOT_FOUND',
      );
      expectProblem(await remove(created.id, '"1"', 'sub-heitor', B), 404, 'NOT_FOUND');
      expectProblem(await list(process.id, 'sub-heitor', B), 404, 'PROCESS_NOT_FOUND');
      expect(
        itemStore()
          .all()
          .find((row) => row.id === created.id),
      ).toMatchObject({
        deletedAt: null,
        version: 1,
      });

      const foreign = await add(process.id, item({ unitOfMeasureId: units.foreign }));
      expectProblem(foreign, 422, 'VALIDATION_ERROR');
      expect(fieldErrors(foreign)).toEqual([['unitOfMeasureId', 'REFERENCE_NOT_FOUND']]);
      expectProblem(await patch(newId(), { notes: 'x' }), 404, 'NOT_FOUND');
      expectProblem(await list('abc'), 400, 'MALFORMED_REQUEST');
    });
  });

  describe('[Duplicidade]', () => {
    it('Item em uso: 409 ITEM_IN_USE com meta.references; troca de unidade também; reenvio idempotente', async () => {
      const process = await processWith();
      const created = await addOk(process.id);
      const documentId = randomUUID();
      usage.usages = [
        {
          itemId: created.id,
          documentId,
          code: 'DFD 0005/2026',
          typeCode: 'DFD',
          status: 'DRAFT',
          editable: true,
        },
      ];
      const inUse = await remove(created.id);
      expectProblem(inUse, 409, 'ITEM_IN_USE');
      expect((inUse.body as { meta: unknown }).meta).toEqual({
        references: [
          { documentId, code: 'DFD 0005/2026', typeCode: 'DFD', status: 'DRAFT', editable: true },
        ],
      });
      expectProblem(await patch(created.id, { unitOfMeasureId: units.m3 }), 409, 'ITEM_IN_USE');
      // Descrição de item em uso pode mudar (RN-PROC-80).
      expect((await patch(created.id, { description: 'Cimento CP-III' })).status).toBe(200);
      // A lista traz as referências (unidade travada na UI — FA-04).
      expect(data<ProcessItemDto[]>(await list(process.id))[0]?.references).toHaveLength(1);

      const key = randomUUID();
      const payload = item({ description: 'Brita 1' });
      const first = await add(process.id, payload, { key });
      const replay = await add(process.id, payload, { key });
      expect(first.status).toBe(201);
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(data<ProcessItemDto>(replay).id).toBe(data<ProcessItemDto>(first).id);
      expect(
        itemStore()
          .all()
          .filter((row) => row.processId === process.id && row.description === 'Brita 1'),
      ).toHaveLength(1);
    });
  });

  describe('[Concorrência]', () => {
    it('Ordem com If-Match desatualizado: 412 VERSION_CONFLICT; item com versão divergente: 412', async () => {
      const process = await processWith();
      const one = await addOk(process.id);
      const loaded = await list(process.id);
      const etag = loaded.headers.etag ?? '';
      expect(etag).toBe('"15"');
      // Carla adiciona um item em seguida (a versão do processo passa a 16).
      const two = await addOk(process.id);
      const stale = await reorder(process.id, [two.id, one.id], etag);
      expectProblem(stale, 412, 'VERSION_CONFLICT');
      expect(stale.body).toMatchObject({ currentVersion: 16 });
      expectProblem(await patch(one.id, { notes: 'x' }, '"7"'), 412, 'VERSION_CONFLICT');
      expectProblem(await remove(one.id, '"7"'), 412, 'VERSION_CONFLICT');
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível: 503 DEPENDENCY_UNAVAILABLE sem item, evento, timeline nem auditoria', async () => {
      const process = await processWith();
      transactions.down = true;
      expectProblem(await add(process.id, item()), 503, 'DEPENDENCY_UNAVAILABLE');
      transactions.down = false;
      expect(
        itemStore()
          .all()
          .filter((row) => row.processId === process.id),
      ).toEqual([]);
      expect(eventsOf(process.id)).toEqual([]);
      expect(itemsOnTimeline(process.id)).toEqual([]);
      expect(auditOf(process.id)).toEqual([]);
    });
  });

  describe('[Falha de integração]', () => {
    it('Relay do outbox indisponível: PATCH responde 200 e o evento fica no outbox para publicação', async () => {
      // Sem relay no teste: a linha permanece para publicar (PENDING no PostgreSQL — tenant-leak).
      const process = await processWith();
      const created = await addOk(process.id);
      const response = await patch(created.id, { description: 'Cimento CP-V' });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(eventsOf(process.id).at(-1)).toMatchObject({
        payload: { added: [], updated: [created.id], removed: [], itemsCount: 1 },
      });
    });
  });
});
