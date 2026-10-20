import { problemDetailsSchema, processTimelineResponseSchema } from '@contrataflow/validation';
import type { ProcessTimelineResponse } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';

import { CACHE_STORE } from '#shared/cache/cache-store.js';
import type { CacheStore } from '#shared/cache/cache-store.js';
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
  workflowStagesOf,
} from '../../../../test/support/process-fixtures.js';
import {
  assignDepartment,
  assignRole,
  seedDefaultRolesOf,
  seedDepartment,
} from '../../../../test/support/structure-fixtures.js';
import { TIMELINE_TRANSACTIONS } from '../application/ports.js';
import type { TimelineTransactions } from '../application/ports.js';
import type { ProcessTimelineEntry } from '../domain/timeline-entry.js';

/*
 * US-060 — PRC-12 pelo pipeline HTTP completo (autenticação, tenant, vínculo, autorização com
 * escopo de processo, filtro RFC 9457) com a identidade fake, os seeders reais e a timeline em
 * memória. As 8 categorias do Gherkin; a mesma consulta sobre PostgreSQL (SQL, RLS, POL-09 no
 * WHERE, inserções concorrentes e isolamento) em `test/tenant-leak/process-timeline.spec.ts` e a
 * meta de p95 em `test/timeline/timeline-view.perf.ts`. Personas: Ana (REQUISITANTE, lotada no Setor de
 * Manutenção — vê o 0012 pela unidade solicitante, sem POL-09); Lúcia (GESTOR, TENANT — com
 * POL-09); "Bruno" = Marta só com CONSULTOR_EXTERNO (sem PROCESS_VIEW).
 */

/** Tipos do repositório em memória do `process` (sem importar o domínio de outro módulo). */
type SeedArgs = Parameters<ReturnType<typeof processRepositoryOf>['seed']>;
type Process = SeedArgs[0];
type AccessGrant = NonNullable<SeedArgs[1]>[number];

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-05T15:00:00.000Z');

const ORG_A = '0192d060-0000-7000-8000-0000000000a0';
const ORG_B = '0192d060-0000-7000-8000-0000000000b0';
const UNITS_A = {
  organizationId: ORG_A,
  obras: '0192d060-0000-7000-8000-0000000000a1',
  manutencao: '0192d060-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d060-0000-7000-8000-0000000000a3',
  saude: '0192d060-0000-7000-8000-0000000000a4',
  posto: '0192d060-0000-7000-8000-0000000000a5',
};
const COTACOES = '0192d060-0000-7000-8000-0000000000a6';
const UNITS_B = {
  organizationId: ORG_B,
  obras: '0192d060-0000-7000-8000-0000000000b1',
  manutencao: '0192d060-0000-7000-8000-0000000000b2',
  pavimentacao: '0192d060-0000-7000-8000-0000000000b3',
  saude: '0192d060-0000-7000-8000-0000000000b4',
  posto: '0192d060-0000-7000-8000-0000000000b5',
};

/** 0012/2026: orçamento sigiloso, na fila do Setor de Cotações (Ana não tem a custódia). */
const P12 = '0192d060-0000-7000-8000-000000000012';
/** 0031/2026: sigiloso, Ana é a responsável atual (custódia). */
const P31 = '0192d060-0000-7000-8000-000000000031';
const P_B = '0192d060-0000-7000-8000-0000000000ff';

const CARLOS = '0192d060-0000-7000-8000-00000000c001';
const PAULA = '0192d060-0000-7000-8000-00000000c002';

const membershipOf = (userId: string, tenantId = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

/** Transações do módulo que podem simular o banco fora do ar. */
class FlakyTransactions implements TimelineTransactions {
  failure: Error | null = null;

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.failure ? Promise.reject(this.failure) : runSimulatedTransaction(work);
  }
}

const dept = (departmentId: string, reason: 'REQUESTING' | 'CURRENT' | 'HISTORICAL') =>
  ({ principalType: 'DEPARTMENT', departmentId, reason }) as AccessGrant;
const user = (userId: string, reason: 'CREATOR' | 'RESPONSIBLE' | 'PARTICIPANT') =>
  ({ principalType: 'USER', userId, reason }) as AccessGrant;

let sequence = 0;

/** Entrada gravada pelo projetor (US-059) — id UUIDv7-like crescente. */
function timelineEntry(
  processId: string,
  occurredAt: string,
  type: ProcessTimelineEntry['type'],
  overrides: Partial<ProcessTimelineEntry> = {},
): ProcessTimelineEntry {
  sequence += 1;
  const suffix = sequence.toString(16).padStart(12, '0');
  return {
    id: `0192d060-0000-7000-8000-${suffix}`,
    tenantId: A,
    processId,
    occurredAt: new Date(occurredAt),
    type,
    actorType: 'USER',
    actorId: CARLOS,
    actorName: 'Carlos Lima',
    actorDepartmentName: 'Setor de Cotações',
    entityType: 'Process',
    entityId: processId,
    movementId: null,
    params: {},
    visibility: 'STANDARD',
    sourceEventId: `0192d060-0000-7000-8000-e${suffix.slice(1)}`,
    ...overrides,
  };
}

describe('Feature: Visualizar timeline com filtros (US-060)', () => {
  let api: TestApi;
  let warn: MockInstance<Logger['warn']>;
  let error: MockInstance<Logger['error']>;
  let log: MockInstance<Logger['log']>;
  const transactions = new FlakyTransactions();
  /** Entradas do Background no 0012 (ordem de gravação). */
  let background: ProcessTimelineEntry[] = [];
  let restricted: ProcessTimelineEntry;

  const get = (
    processId: string,
    query = '',
    subject = 'sub-ana',
    tenantId: string = A,
    target: TestApi = api,
  ) =>
    request(target.server)
      .get(`/api/v1/processes/${processId}/timeline${query}`)
      .set('Authorization', target.bearer(subject, { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', tenantId);
  const list = async (processId: string, query = '', subject = 'sub-ana') => {
    const response = await get(processId, query, subject);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return processTimelineResponseSchema.parse(response.body);
  };
  const ids = (body: ProcessTimelineResponse) => body.data.map((entry) => entry.id);
  const expectProblem = (response: request.Response, status: number, code: string) => {
    expect(response.status, JSON.stringify(response.body)).toBe(status);
    const body = problemDetailsSchema.parse(response.body);
    expect(body.code).toBe(code);
    return body;
  };
  /** Ids visíveis a quem NÃO atende POL-09, na ordem da timeline. */
  const visibleToAna = () =>
    background
      .filter((entry) => entry.visibility === 'STANDARD')
      .sort(
        (left, right) =>
          right.occurredAt.getTime() - left.occurredAt.getTime() || (left.id < right.id ? 1 : -1),
      )
      .map((entry) => entry.id);

  async function prepare(target: TestApi): Promise<void> {
    await runTenantSeeders(target, A);
    seedProcessStructure(target, A, { ...UNITS_A, shortName: 'PMSJ', cnpj: '11222333000181' });
    seedProcessStructure(target, B, { ...UNITS_B, shortName: 'PMB', cnpj: '60746948000112' });
    const obras = { id: UNITS_A.obras, path: `/${UNITS_A.obras}/`, depth: 0 };
    seedDepartment(target, {
      tenantId: A,
      organizationId: ORG_A,
      id: COTACOES,
      name: 'Setor de Cotações',
      parent: obras,
    });
    assignDepartment(target, membershipOf(FAKE_USERS.ana.id), UNITS_A.manutencao);
    const roles = seedDefaultRolesOf(target, A);
    assignRole(target, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.marta.id),
      roleId: roles.get('CONSULTOR_EXTERNO')?.id ?? '',
    });
    const stage = workflowStagesOf(target, A).find((candidate) => candidate.key === 'ABERTURA');
    if (!stage) throw new Error('etapa ABERTURA ausente');
    const base: Process = {
      id: P12,
      tenantId: A,
      organizationId: ORG_A,
      number: 12,
      year: 2026,
      code: '0012/2026',
      internalCode: null,
      title: 'Aquisição de cimento para manutenção de vias',
      object: 'Cimento CP-II para a manutenção das vias.',
      description: null,
      status: 'IN_PROGRESS',
      priority: 'HIGH',
      contractingTypeId: catalogItemId(target, A, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
      modalityId: null,
      isPriceRegistration: false,
      requestingSecretariatId: UNITS_A.obras,
      requestingDepartmentId: UNITS_A.manutencao,
      currentDepartmentId: COTACOES,
      currentResponsibleId: null,
      workflowVersionId: stage.workflowVersionId,
      currentStageId: null,
      currentWorkflowStageId: stage.id,
      currentStageDueAt: null,
      openedAt: null,
      targetDate: null,
      estimatedValue: '85000.00',
      estimatedValueSource: 'MANUAL',
      isBudgetConfidential: true,
      originId: catalogItemId(target, A, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
      creationChannel: 'WEB',
      pcaStatus: 'NOT_APPLICABLE',
      pcaYear: null,
      pcaItemCode: null,
      pcaJustification: null,
      notes: null,
      duplicatedFromId: null,
      createdAt: new Date('2026-09-14T13:02:11.000Z'),
      updatedAt: new Date('2026-10-02T18:40:00.000Z'),
      createdById: FAKE_USERS.ana.id,
      updatedById: null,
      version: 1,
    };
    const repository = processRepositoryOf(target);
    repository.seed(base, [dept(UNITS_A.manutencao, 'REQUESTING'), dept(COTACOES, 'CURRENT')]);
    repository.seed(
      {
        ...base,
        id: P31,
        number: 31,
        code: '0031/2026',
        currentDepartmentId: UNITS_A.manutencao,
        currentResponsibleId: FAKE_USERS.ana.id,
      },
      [dept(UNITS_A.manutencao, 'REQUESTING'), user(FAKE_USERS.ana.id, 'RESPONSIBLE')],
    );
    repository.seed(
      {
        ...base,
        id: P_B,
        tenantId: B,
        organizationId: ORG_B,
        number: 7,
        code: '0007/2026',
        title: 'Processo LEAK-B',
        requestingSecretariatId: UNITS_B.obras,
        requestingDepartmentId: UNITS_B.manutencao,
        currentDepartmentId: UNITS_B.manutencao,
      },
      [dept(UNITS_B.manutencao, 'CURRENT')],
    );

    restricted = timelineEntry(P12, '2026-10-04T12:00:00.000Z', 'PROCESS_UPDATED', {
      params: { fields: ['estimatedValue'] },
      visibility: 'BUDGET_RESTRICTED',
    });
    background = [
      timelineEntry(P12, '2026-09-14T13:02:11.000Z', 'PROCESS_CREATED', {
        actorId: FAKE_USERS.ana.id,
        actorName: 'Ana Souza',
        params: { code: '0012/2026', title: 'Aquisição de cimento' },
      }),
      timelineEntry(P12, '2026-09-20T10:00:00.000Z', 'APPROVAL_DECIDED', {
        entityType: 'Approval',
        params: { decision: 'APPROVED', title: 'Aprovação do DFD' },
      }),
      timelineEntry(P12, '2026-09-30T11:00:00.000Z', 'APPROVAL_REQUESTED', {
        actorType: 'SYSTEM',
        actorId: null,
        actorName: null,
        params: { approverLabel: 'Autoridade', dueAt: null },
      }),
      timelineEntry(P12, '2026-10-01T09:00:00.000Z', 'APPROVAL_DECIDED', {
        params: { decision: 'RETURNED', title: 'Aprovação do ETP' },
      }),
      timelineEntry(P12, '2026-10-02T18:40:00.000Z', 'APPROVAL_DECIDED', {
        actorId: PAULA,
        actorName: 'Paula Reis',
        params: { decision: 'APPROVED', title: 'Aprovação do TR' },
      }),
      timelineEntry(P12, '2026-10-03T08:00:00.000Z', 'PROCESS_FORWARDED', {
        params: { toStageName: 'Pesquisa de preços', toDepartmentName: 'Setor de Cotações' },
      }),
      restricted,
      timelineEntry(P12, '2026-10-05T14:00:00.000Z', 'COMMENT_ADDED', {
        entityType: 'Comment',
        params: { excerpt: 'Conferir item 3.' },
      }),
      // Mesmo instante: o desempate é o id (DESC).
      timelineEntry(P12, '2026-10-05T14:00:00.000Z', 'APPROVAL_DECIDED', {
        params: { decision: 'APPROVED', title: 'Aprovação final' },
      }),
    ];
    const rows = timelineRowsOf(target);
    rows.push(...background);
    rows.push(
      timelineEntry(P31, '2026-10-04T12:00:00.000Z', 'PROCESS_UPDATED', {
        params: { fields: ['estimatedValue'] },
        visibility: 'BUDGET_RESTRICTED',
      }),
      timelineEntry(P_B, '2026-10-04T12:00:00.000Z', 'PROCESS_CREATED', {
        tenantId: B,
        actorName: 'Operador LEAK-B',
        params: { code: '0007/2026', title: 'Processo LEAK-B' },
      }),
    );
  }

  beforeAll(async () => {
    log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    api = await createTestApi({
      providers: [
        { token: TIMELINE_TRANSACTIONS, value: transactions },
        { token: CATALOG_CLOCK, value: () => NOW },
      ],
    });
    await prepare(api);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await api.close();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    transactions.failure = null;
  });

  describe('[Sucesso]', () => {
    it('lista a timeline mais recente primeiro, com type + params e sem mensagem pronta', async () => {
      log.mockClear();
      const response = await get(P12);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const body = processTimelineResponseSchema.parse(response.body);
      expect(ids(body)).toEqual(visibleToAna());
      expect(body.data.length).toBeLessThanOrEqual(50);
      expect(body.meta).toEqual({ nextCursor: null, hasMore: false });
      const created = body.data.at(-1);
      expect(created).toEqual({
        id: background[0]?.id,
        occurredAt: '2026-09-14T13:02:11.000Z',
        type: 'PROCESS_CREATED',
        actorType: 'USER',
        actorId: FAKE_USERS.ana.id,
        actorName: 'Ana Souza',
        actorDepartmentName: 'Setor de Cotações',
        entityType: 'Process',
        entityId: P12,
        movementId: null,
        params: { code: '0012/2026', title: 'Aquisição de cimento' },
        visibility: 'STANDARD',
      });
      for (const entry of (response.body as { data: Record<string, unknown>[] }).data) {
        expect(entry).not.toHaveProperty('message');
        expect(entry).not.toHaveProperty('sourceEventId');
        expect(entry).not.toHaveProperty('tenantId');
      }
      const listed = log.mock.calls.find((args) => args[1] === 'timeline.listed');
      expect(listed?.[0]).toMatchObject({
        event: 'timeline.listed',
        processId: P12,
        filterKeys: [],
        count: visibleToAna().length,
      });
      expect(listed?.[0]).toHaveProperty('filtersHash');
      expect(JSON.stringify(listed?.[0])).not.toContain('Conferir');
    });

    it('ator de sistema vem sem nome (o front exibe "Sistema")', async () => {
      const body = await list(P12, '?group=APROVACOES');
      const system = body.data.find((entry) => entry.type === 'APPROVAL_REQUESTED');
      expect(system).toMatchObject({ actorType: 'SYSTEM', actorId: null, actorName: null });
    });

    it('filtra por grupo APROVACOES, autor Carlos e últimos 7 dias; o cursor continua no mesmo filtro', async () => {
      const filter =
        `?group=APROVACOES&actorId=${CARLOS}` +
        '&occurredFrom=2026-09-28T15:00:00.000Z&occurredTo=2026-10-05T15:00:00.000Z';
      const expected = background
        .filter(
          (entry) =>
            entry.type.startsWith('APPROVAL_') &&
            entry.actorId === CARLOS &&
            entry.occurredAt >= new Date('2026-09-28T15:00:00.000Z'),
        )
        .map((entry) => entry.id);
      expect(expected).toHaveLength(2);

      const all = await list(P12, filter);
      expect(new Set(ids(all))).toEqual(new Set(expected));

      const first = await list(P12, `${filter}&limit=1`);
      expect(first.meta.hasMore).toBe(true);
      expect(first.meta.nextCursor).not.toBeNull();
      const second = await list(
        P12,
        `${filter}&limit=1&cursor=${encodeURIComponent(first.meta.nextCursor ?? '')}`,
      );
      expect(second.meta).toEqual({ nextCursor: null, hasMore: false });
      expect([...ids(first), ...ids(second)]).toEqual(ids(all));
    });

    it('grupos combinam por OU e autores por OU; período inclusivo nas duas pontas', async () => {
      const both = await list(P12, '?group=TRAMITACAO,COMENTARIOS');
      expect(both.data.map((entry) => entry.type).sort()).toEqual([
        'COMMENT_ADDED',
        'PROCESS_FORWARDED',
      ]);
      const actors = await list(P12, `?actorId=${PAULA},${FAKE_USERS.ana.id}`);
      expect(actors.data.map((entry) => entry.actorName).sort()).toEqual([
        'Ana Souza',
        'Paula Reis',
      ]);
      const instant = await list(
        P12,
        '?occurredFrom=2026-10-03T08:00:00.000Z&occurredTo=2026-10-03T08:00:00.000Z',
      );
      expect(instant.data.map((entry) => entry.type)).toEqual(['PROCESS_FORWARDED']);
    });

    it('processo sem entradas: lista vazia (FA-01)', async () => {
      const body = await list(P31, '?group=COMENTARIOS');
      expect(body).toEqual({ data: [], meta: { nextCursor: null, hasMore: false } });
    });
  });

  describe('[Validação]', () => {
    it('V-01: occurredFrom posterior a occurredTo → 422 OUT_OF_RANGE em occurredTo', async () => {
      const response = await get(
        P12,
        '?occurredFrom=2026-10-05T00:00:00.000Z&occurredTo=2026-10-01T00:00:00.000Z',
      );
      const body = expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(body.errors).toEqual([
        {
          field: 'occurredTo',
          code: 'OUT_OF_RANGE',
          message: 'O período final deve ser igual ou posterior ao inicial.',
        },
      ]);
    });

    it('V-02: cursor corrompido → 422 INVALID_FORMAT em cursor, com a mensagem da story', async () => {
      const forged = Buffer.from(JSON.stringify({ o: 'ontem', i: 'x' })).toString('base64url');
      const body = expectProblem(await get(P12, `?cursor=${forged}`), 422, 'VALIDATION_ERROR');
      expect(body.errors).toEqual([
        {
          field: 'cursor',
          code: 'INVALID_FORMAT',
          message: 'Não foi possível continuar a listagem. Role novamente desde o início.',
        },
      ]);
      expectProblem(await get(P12, '?cursor=a%20b'), 422, 'VALIDATION_ERROR');
    });

    it('V-03: limit fora de 1–100 → 422 OUT_OF_RANGE em limit', async () => {
      for (const limit of ['0', '101']) {
        const body = expectProblem(await get(P12, `?limit=${limit}`), 422, 'VALIDATION_ERROR');
        expect(body.errors[0]).toMatchObject({ field: 'limit', code: 'OUT_OF_RANGE' });
      }
    });

    it('V-04: grupo fora da tabela → 422 INVALID_ENUM em group', async () => {
      const body = expectProblem(await get(P12, '?group=FINANCEIRO'), 422, 'VALIDATION_ERROR');
      expect(body.errors).toEqual([
        { field: 'group', code: 'INVALID_ENUM', message: 'Filtro de grupo inválido.' },
      ]);
    });
  });

  describe('[Permissão]', () => {
    it('entrada orçamentária sigilosa fica oculta para quem não atende POL-09, sem indicação', async () => {
      const body = await list(P12);
      expect(ids(body)).not.toContain(restricted.id);
      expect(JSON.stringify(body)).not.toContain('BUDGET_RESTRICTED');
      expect(body.meta).not.toHaveProperty('hiddenCount');
    });

    it('a paginação considera só as entradas visíveis', async () => {
      const visible = visibleToAna();
      const exact = await list(P12, `?limit=${visible.length}`);
      expect(exact.meta).toEqual({ nextCursor: null, hasMore: false });
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: ProcessTimelineResponse = await list(
          P12,
          `?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        );
        seen.push(...ids(page));
        cursor = page.meta.nextCursor;
      } while (cursor !== null);
      expect(seen).toEqual(visible);
    });

    it('com PROCESS_VIEW_CONFIDENTIAL_BUDGET (Lúcia) a entrada restrita aparece normalmente', async () => {
      const body = await list(P12, '', 'sub-lucia');
      expect(body.data).toHaveLength(background.length);
      expect(body.data.find((entry) => entry.id === restricted.id)).toMatchObject({
        type: 'PROCESS_UPDATED',
        visibility: 'BUDGET_RESTRICTED',
        params: { fields: ['estimatedValue'] },
      });
    });

    it('com a custódia atual (Ana responsável pelo 0031) a entrada restrita aparece', async () => {
      const body = await list(P31);
      expect(body.data.map((entry) => entry.visibility)).toEqual(['BUDGET_RESTRICTED']);
    });

    it('usuário sem PROCESS_VIEW sobre o processo → 404 PROCESS_NOT_FOUND', async () => {
      expectProblem(await get(P12, '', 'sub-marta'), 404, 'PROCESS_NOT_FOUND');
    });
  });

  describe('[Tenant incorreto]', () => {
    it('processo de outro tenant → 404 PROCESS_NOT_FOUND sem revelar nada', async () => {
      const response = await get(P_B);
      const leaked = expectProblem(response, 404, 'PROCESS_NOT_FOUND');
      const text = JSON.stringify(response.body);
      expect(text).not.toContain('LEAK-B');
      expect(text).not.toContain('0007/2026');
      // Mesmo corpo do processo inexistente.
      const missing = expectProblem(
        await get('0192d060-0000-7000-8000-0000000000ee'),
        404,
        'PROCESS_NOT_FOUND',
      );
      expect(missing.detail).toBe(leaked.detail);
    });

    it('X-Tenant-Id de B sem vínculo → 403, sem chegar à timeline', async () => {
      const response = await get(P_B, '', 'sub-ana', B);
      expect(response.status).toBe(403);
      expect(JSON.stringify(response.body)).not.toContain('LEAK-B');
    });
  });

  describe('[Duplicidade]', () => {
    it('repetir a mesma página devolve o mesmo conjunto e o mesmo nextCursor, sem duplicar entre páginas', async () => {
      const first = await list(P12, '?limit=3');
      const again = await list(P12, '?limit=3');
      expect(again).toEqual(first);
      expect(first.meta.nextCursor).not.toBeNull();
      const next = await list(
        P12,
        `?limit=3&cursor=${encodeURIComponent(first.meta.nextCursor ?? '')}`,
      );
      const overlap = ids(next).filter((id) => ids(first).includes(id));
      expect(overlap).toEqual([]);
    });
  });

  describe('[Concorrência]', () => {
    it('entrada projetada entre duas páginas só aparece numa nova primeira página', async () => {
      const before = visibleToAna();
      const first = await list(P12, '?limit=4');
      const fresh = timelineEntry(P12, '2026-10-05T14:59:00.000Z', 'PROCESS_CLAIMED');
      timelineRowsOf(api).push(fresh);
      try {
        const seen = [...ids(first)];
        let cursor = first.meta.nextCursor;
        while (cursor !== null) {
          const page = await list(P12, `?limit=4&cursor=${encodeURIComponent(cursor)}`);
          seen.push(...ids(page));
          cursor = page.meta.nextCursor;
        }
        expect(seen).toEqual(before);
        expect(ids(await list(P12, '?limit=4'))[0]).toBe(fresh.id);
      } finally {
        const rows = timelineRowsOf(api);
        rows.splice(rows.indexOf(fresh), 1);
      }
    });
  });

  describe('[Falha de banco]', () => {
    it('banco indisponível → 503 DEPENDENCY_UNAVAILABLE com Retry-After e error timeline.query_failed', async () => {
      error.mockClear();
      transactions.failure = new DatabaseUnavailableError(new Error('ECONNREFUSED'));
      const response = await get(P12);
      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      expect(response.headers['retry-after']).toBeDefined();
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'timeline.query_failed',
          errorCode: 'DEPENDENCY_UNAVAILABLE',
        }),
        'timeline.query_failed',
      );
    });

    it('conexão derrubada no meio da consulta → 503 (erro transitório)', async () => {
      transactions.failure = new Error('Connection terminated unexpectedly');
      const response = await get(P12, '?group=APROVACOES');
      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      expect(response.headers['retry-after']).toBeDefined();
    });

    it('erro inesperado → 500 INTERNAL_ERROR, logado sem params', async () => {
      error.mockClear();
      transactions.failure = new Error('bug');
      expectProblem(await get(P12), 500, 'INTERNAL_ERROR');
      const call = error.mock.calls.find((args) => args[1] === 'timeline.query_failed');
      expect(call?.[0]).toMatchObject({ errorCode: 'INTERNAL_ERROR' });
    });
  });

  describe('[Falha de integração]', () => {
    it('Redis indisponível: 200 com a permissão resolvida no banco e warn do cache', async () => {
      const unavailable = (): Promise<never> => Promise.reject(new Error('ECONNREFUSED'));
      const downStore: CacheStore = {
        get: unavailable,
        set: unavailable,
        delete: unavailable,
        getMany: unavailable,
      };
      warn.mockClear();
      const noRedis = await createTestApi({
        providers: [
          { token: CACHE_STORE, value: downStore },
          { token: CATALOG_CLOCK, value: () => NOW },
        ],
      });
      try {
        await prepare(noRedis);
        const response = await get(P12, '', 'sub-ana', A, noRedis);
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        expect(processTimelineResponseSchema.parse(response.body).data.length).toBe(
          visibleToAna().length,
        );
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ event: 'authorization.cache_unavailable' }),
          'authorization.cache_unavailable',
        );
      } finally {
        await noRedis.close();
      }
    });
  });
});
