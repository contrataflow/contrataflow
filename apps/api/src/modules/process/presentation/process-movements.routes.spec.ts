import { problemDetailsSchema, processMovementsResponseSchema } from '@contrataflow/validation';
import type { MovementItemDto, ProcessMovementsResponse } from '@contrataflow/validation';
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
  workflowStagesOf,
} from '../../../../test/support/process-fixtures.js';
import { seedPanelApproval } from '../../../../test/support/process-panel-fixtures.js';
import {
  assignDepartment,
  assignRole,
  seedDefaultRolesOf,
  seedDepartment,
} from '../../../../test/support/structure-fixtures.js';
import { PROCESS_TRANSACTIONS } from '../application/ports.js';
import type { ProcessTransactions } from '../application/ports.js';

/*
 * US-054 — PRC-11 pelo pipeline HTTP completo (autenticação, tenant, vínculo, autorização com
 * escopo de processo, filtro RFC 9457) com a identidade fake, os seeders reais e o processo em
 * memória. As 8 categorias do Gherkin; o SQL sobre PostgreSQL (RLS, ordem, cursor sob inserções
 * concorrentes, índice) em `test/tenant-leak/process-movements.spec.ts`. Personas: Ana (REQUISITANTE
 * lotada no Setor de Manutenção — vê o 0012 pela unidade solicitante, sem AUDIT_VIEW); "Rafael" =
 * Otávio (ADMIN_ORGAO — PROCESS_VIEW e AUDIT_VIEW no tenant); Lúcia (GESTOR, sem AUDIT_VIEW);
 * Marta só com CONSULTOR_EXTERNO (sem visibilidade do processo).
 */

/** Tipos do repositório em memória do `process` (sem importar o domínio de outro módulo). */
type SeedArgs = Parameters<ReturnType<typeof processRepositoryOf>['seed']>;
type Process = SeedArgs[0];
type AccessGrant = NonNullable<SeedArgs[1]>[number];
type Movement = Parameters<ReturnType<typeof processRepositoryOf>['seedMovements']>[number];

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-05T15:00:00.000Z');

const ORG_A = '0192d054-0000-7000-8000-0000000000a0';
const ORG_B = '0192d054-0000-7000-8000-0000000000b0';
const UNITS_A = {
  organizationId: ORG_A,
  obras: '0192d054-0000-7000-8000-0000000000a1',
  manutencao: '0192d054-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d054-0000-7000-8000-0000000000a3',
  saude: '0192d054-0000-7000-8000-0000000000a4',
  posto: '0192d054-0000-7000-8000-0000000000a5',
};
const COTACOES = '0192d054-0000-7000-8000-0000000000a6';
/** Unidade inativada depois da tramitação (FA-05). */
const ALMOXARIFADO = '0192d054-0000-7000-8000-0000000000a7';
const UNITS_B = {
  organizationId: ORG_B,
  obras: '0192d054-0000-7000-8000-0000000000b1',
  manutencao: '0192d054-0000-7000-8000-0000000000b2',
  pavimentacao: '0192d054-0000-7000-8000-0000000000b3',
  saude: '0192d054-0000-7000-8000-0000000000b4',
  posto: '0192d054-0000-7000-8000-0000000000b5',
};

/** 0012/2026: 5 tramitações (CREATE, FORWARD, RETURN, FORWARD, APPROVE). */
const P12 = '0192d054-0000-7000-8000-000000000012';
/** 0013/2026: ainda em DRAFT — só o CREATE (FA-04). */
const P13 = '0192d054-0000-7000-8000-000000000013';
/** 0040/2026: processo das tramitações concorrentes. */
const P40 = '0192d054-0000-7000-8000-000000000040';
const P_B = '0192d054-0000-7000-8000-0000000000ff';
const APPROVAL = '0192d054-0000-7000-8000-000000000a01';

const IP_ANA = '200.10.20.30';
const IP_OTAVIO = '177.1.2.3';

const membershipOf = (userId: string, tenantId = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

/** Transações do módulo que podem simular o banco fora do ar. */
class FlakyTransactions implements ProcessTransactions {
  failure: Error | null = null;

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.failure ? Promise.reject(this.failure) : runSimulatedTransaction(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.run(work);
  }

  snapshot<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.run(work);
  }

  longRead<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.run(work);
  }
}

const dept = (departmentId: string, reason: 'REQUESTING' | 'CURRENT' | 'HISTORICAL') =>
  ({ principalType: 'DEPARTMENT', departmentId, reason }) as AccessGrant;

let counter = 0;

/** Tramitação já gravada pelas stories de escrita (US-001/047/048/052). */
function movement(
  processId: string,
  sequence: number,
  action: Movement['action'],
  patch: Partial<Movement> = {},
): Movement {
  counter += 1;
  const suffix = counter.toString(16).padStart(12, '0');
  return {
    id: `0192d054-0000-7000-8000-${suffix.replace(/^0/, 'e')}`,
    tenantId: A,
    processId,
    sequence,
    action,
    workflowTransitionId: null,
    fromProcessStageId: null,
    toProcessStageId: `0192d054-0000-7000-8000-${suffix.replace(/^0/, 'f')}`,
    fromWorkflowStageId: null,
    toWorkflowStageId: '',
    fromDepartmentId: null,
    toDepartmentId: UNITS_A.manutencao,
    fromUserId: null,
    toUserId: null,
    statusFrom: null,
    statusTo: 'IN_PROGRESS',
    actorType: 'USER',
    actorId: FAKE_USERS.ana.id,
    actorDepartmentId: null,
    comment: null,
    dueAt: null,
    documents: [],
    approvalId: null,
    ip: IP_ANA,
    userAgent: 'Mozilla/5.0',
    correlationId: `corr-${suffix}`,
    metadata: {},
    occurredAt: new Date(Date.UTC(2026, 8, sequence, 12)),
    ...patch,
  };
}

describe('Feature: Histórico de tramitações (US-054)', () => {
  let api: TestApi;
  let log: MockInstance<Logger['log']>;
  let warn: MockInstance<Logger['warn']>;
  let error: MockInstance<Logger['error']>;
  const transactions = new FlakyTransactions();
  let stages: ReturnType<typeof workflowStagesOf>;

  const get = (
    processId: string,
    query = '',
    subject = 'sub-ana',
    tenantId: string = A,
    target: TestApi = api,
  ) =>
    request(target.server)
      .get(`/api/v1/processes/${processId}/movements${query}`)
      .set('Authorization', target.bearer(subject, { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', tenantId);
  const list = async (processId: string, query = '', subject = 'sub-ana') => {
    const response = await get(processId, query, subject);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return processMovementsResponseSchema.parse(response.body);
  };
  const sequences = (body: ProcessMovementsResponse) => body.data.map((item) => item.sequence);
  const expectProblem = (response: request.Response, status: number, code: string) => {
    expect(response.status, JSON.stringify(response.body)).toBe(status);
    const body = problemDetailsSchema.parse(response.body);
    expect(body.code).toBe(code);
    return body;
  };
  const stage = (key: string) => {
    const found = stages.find((candidate) => candidate.key === key);
    if (!found) throw new Error(`etapa ${key} ausente`);
    return found;
  };

  async function prepare(target: TestApi): Promise<void> {
    await runTenantSeeders(target, A);
    seedProcessStructure(target, A, { ...UNITS_A, shortName: 'PMSJ', cnpj: '11222333000181' });
    seedProcessStructure(target, B, { ...UNITS_B, shortName: 'PMB', cnpj: '60746948000112' });
    const obras = { id: UNITS_A.obras, path: `/${UNITS_A.obras}/`, depth: 0 };
    const base = { tenantId: A, organizationId: ORG_A, parent: obras };
    seedDepartment(target, { ...base, id: COTACOES, name: 'Setor de Cotações' });
    seedDepartment(target, { ...base, id: ALMOXARIFADO, name: 'Almoxarifado', isActive: false });
    assignDepartment(target, membershipOf(FAKE_USERS.ana.id), UNITS_A.manutencao);
    const roles = seedDefaultRolesOf(target, A);
    assignRole(target, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.marta.id),
      roleId: roles.get('CONSULTOR_EXTERNO')?.id ?? '',
    });
    stages = workflowStagesOf(target, A);
    const abertura = stage('ABERTURA');
    const next = stages.find(
      (candidate) =>
        candidate.workflowVersionId === abertura.workflowVersionId && candidate.key !== 'ABERTURA',
    );
    if (!next) throw new Error('segunda etapa ausente');

    const process: Process = {
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
      workflowVersionId: abertura.workflowVersionId,
      currentStageId: null,
      currentWorkflowStageId: next.id,
      currentStageDueAt: null,
      openedAt: null,
      targetDate: null,
      estimatedValue: null,
      estimatedValueSource: null,
      isBudgetConfidential: false,
      originId: catalogItemId(target, A, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
      creationChannel: 'WEB',
      pcaStatus: 'NOT_APPLICABLE',
      pcaYear: null,
      pcaItemCode: null,
      pcaJustification: null,
      notes: null,
      duplicatedFromId: null,
      createdAt: new Date('2026-09-01T12:00:00.000Z'),
      updatedAt: new Date('2026-09-05T12:00:00.000Z'),
      createdById: FAKE_USERS.ana.id,
      updatedById: null,
      version: 1,
    };
    const repository = processRepositoryOf(target);
    const requesting = [dept(UNITS_A.manutencao, 'REQUESTING')];
    repository.seed(process, [...requesting, dept(COTACOES, 'CURRENT')]);
    repository.seed(
      { ...process, id: P13, number: 13, code: '0013/2026', status: 'DRAFT' },
      requesting,
    );
    repository.seed({ ...process, id: P40, number: 40, code: '0040/2026' }, requesting);
    repository.seed(
      {
        ...process,
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
    seedPanelApproval(target, {
      id: APPROVAL,
      tenantId: A,
      processId: P12,
      title: 'Aprovação da autoridade',
      approverType: 'USER',
      approverUserId: FAKE_USERS.otavio.id,
      status: 'APPROVED',
    });

    const create = (processId: string, statusTo: Movement['statusTo'] = 'DRAFT') =>
      movement(processId, 1, 'CREATE', { toWorkflowStageId: abertura.id, statusTo });
    const forward = { fromWorkflowStageId: abertura.id, toWorkflowStageId: next.id };
    repository.seedMovements(
      create(P12),
      movement(P12, 2, 'FORWARD', {
        ...forward,
        fromDepartmentId: UNITS_A.manutencao,
        toDepartmentId: COTACOES,
        actorDepartmentId: UNITS_A.manutencao,
        statusFrom: 'DRAFT',
        comment: 'Segue para cotação.',
        dueAt: new Date('2026-09-10T20:59:59.000Z'),
        documents: [
          {
            documentId: '0192d054-0000-7000-8000-0000000d0c01',
            documentVersionId: '0192d054-0000-7000-8000-0000000d0c02',
            versionNumber: 2,
            code: 'DFD 0003/2026',
            title: 'DFD — cimento',
            documentTypeCode: 'DFD',
            status: 'FINALIZED',
          },
        ],
      }),
      movement(P12, 3, 'RETURN', {
        fromWorkflowStageId: next.id,
        toWorkflowStageId: abertura.id,
        fromDepartmentId: COTACOES,
        toDepartmentId: UNITS_A.manutencao,
        actorId: FAKE_USERS.lucia.id,
        actorDepartmentId: COTACOES,
        statusFrom: 'IN_PROGRESS',
        statusTo: 'RETURNED',
        comment: 'Falta a especificação do item 3.',
      }),
      movement(P12, 4, 'FORWARD', {
        ...forward,
        fromDepartmentId: UNITS_A.manutencao,
        toDepartmentId: ALMOXARIFADO,
        toUserId: FAKE_USERS.bruno.id,
        statusFrom: 'RETURNED',
      }),
      movement(P12, 5, 'APPROVE', {
        fromWorkflowStageId: next.id,
        toWorkflowStageId: next.id,
        fromDepartmentId: ALMOXARIFADO,
        toDepartmentId: COTACOES,
        actorId: FAKE_USERS.otavio.id,
        approvalId: APPROVAL,
        ip: IP_OTAVIO,
      }),
      create(P13),
      ...[1, 2, 3, 4, 5].map((sequence) =>
        sequence === 1
          ? create(P40)
          : movement(P40, sequence, 'FORWARD', { ...forward, toDepartmentId: COTACOES }),
      ),
      { ...create(P_B), tenantId: B, toDepartmentId: UNITS_B.manutencao, comment: 'LEAK-B' },
    );
  }

  beforeAll(async () => {
    log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    api = await createTestApi({
      providers: [
        { token: PROCESS_TRANSACTIONS, value: transactions },
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
    it('lista as 5 tramitações da mais recente para a mais antiga, com origem, destino, ator e data', async () => {
      log.mockClear();
      const response = await get(P12);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const body = processMovementsResponseSchema.parse(response.body);
      expect(sequences(body)).toEqual([5, 4, 3, 2, 1]);
      expect(body.data.map((item) => item.action)).toEqual([
        'APPROVE',
        'FORWARD',
        'RETURN',
        'FORWARD',
        'CREATE',
      ]);
      expect(body.meta).toEqual({ nextCursor: null, hasMore: false, canViewIp: false });
      const forwarded = body.data.find((item) => item.sequence === 2);
      expect(forwarded).toMatchObject({
        action: 'FORWARD',
        fromStage: { id: stage('ABERTURA').id, name: stage('ABERTURA').name },
        fromDepartment: { id: UNITS_A.manutencao, name: 'Setor de Manutenção', isActive: true },
        toDepartment: { id: COTACOES, name: 'Setor de Cotações', isActive: true },
        statusFrom: 'DRAFT',
        statusTo: 'IN_PROGRESS',
        actor: {
          type: 'USER',
          id: FAKE_USERS.ana.id,
          name: 'Ana Souza',
          departmentName: 'Setor de Manutenção',
        },
        comment: 'Segue para cotação.',
        dueAt: '2026-09-10T20:59:59.000Z',
        occurredAt: '2026-09-02T12:00:00.000Z',
        userAgent: 'Mozilla/5.0',
      });
      expect(forwarded?.documents).toEqual([
        expect.objectContaining({ code: 'DFD 0003/2026', versionNumber: 2, status: 'FINALIZED' }),
      ]);
      expect(body.data.find((item) => item.sequence === 3)?.actor.name).toBe('Lúcia Matos');
      const listed = log.mock.calls.find((args) => args[1] === 'process.movements_listed');
      expect(listed?.[0]).toMatchObject({ processId: P12, itemCount: 5 });
      expect(JSON.stringify(listed?.[0])).not.toContain('cotação');
    });

    it('FA-01: filtros combinados (ação por OU; unidade, ator e período por E)', async () => {
      expect(sequences(await list(P12, '?action=FORWARD'))).toEqual([4, 2]);
      expect(sequences(await list(P12, '?action=RETURN&action=APPROVE'))).toEqual([5, 3]);
      expect(
        sequences(await list(P12, `?action=FORWARD,RETURN&fromDepartmentId=${COTACOES}`)),
      ).toEqual([3]);
      expect(sequences(await list(P12, `?toDepartmentId=${COTACOES}`))).toEqual([5, 2]);
      expect(sequences(await list(P12, `?actorId=${FAKE_USERS.lucia.id}`))).toEqual([3]);
      expect(
        sequences(
          await list(
            P12,
            '?occurredFrom=2026-09-02T12:00:00.000Z&occurredTo=2026-09-04T12:00:00.000Z',
          ),
        ),
      ).toEqual([4, 3, 2]);
    });

    it('FA-03: tramitação de decisão traz o resumo da aprovação para o link "Ver decisão"', async () => {
      const body = await list(P12, '?action=APPROVE');
      expect(body.data[0]).toMatchObject({
        approvalId: APPROVAL,
        approvalSummary: {
          title: 'Aprovação da autoridade',
          status: 'APPROVED',
          decision: 'APPROVE',
        },
      });
    });

    it('FA-04: processo em DRAFT mostra só o CREATE', async () => {
      const body = await list(P13);
      expect(body.data.map((item) => [item.action, item.statusTo])).toEqual([['CREATE', 'DRAFT']]);
      expect(body.data[0]?.toStage).toEqual({
        id: stage('ABERTURA').id,
        name: stage('ABERTURA').name,
      });
    });

    it('FA-05: unidade e usuário inativados mantêm o nome histórico, marcados como inativos', async () => {
      const item = (await list(P12, '?action=FORWARD')).data.find((entry) => entry.sequence === 4);
      expect(item?.toDepartment).toEqual({
        id: ALMOXARIFADO,
        name: 'Almoxarifado',
        isActive: false,
      });
      expect(item?.toUser).toEqual({
        id: FAKE_USERS.bruno.id,
        name: 'Bruno Lima',
        isActive: false,
      });
    });

    it('FA-06: nenhum item para os filtros → lista vazia', async () => {
      const body = await list(P12, `?action=CANCEL&actorId=${FAKE_USERS.ana.id}`);
      expect(body).toEqual({
        data: [],
        meta: { nextCursor: null, hasMore: false, canViewIp: false },
      });
    });

    it('paginação por cursor: páginas de 2 cobrem as 5 tramitações sem repetir', async () => {
      const seen: number[] = [];
      let cursor: string | null = null;
      do {
        const page: ProcessMovementsResponse = await list(
          P12,
          `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        );
        seen.push(...sequences(page));
        cursor = page.meta.nextCursor;
        expect(page.meta.hasMore).toBe(cursor !== null);
      } while (cursor !== null);
      expect(seen).toEqual([5, 4, 3, 2, 1]);
    });
  });

  describe('[Validação]', () => {
    it('V-01: ação fora do enum → 422 VALIDATION_ERROR no campo action', async () => {
      const body = expectProblem(await get(P12, '?action=TELEPORT'), 422, 'VALIDATION_ERROR');
      expect(body.errors).toEqual([
        { field: 'action', code: 'INVALID_ENUM', message: 'Filtro de ação inválido.' },
      ]);
    });

    it('V-02: período inicial posterior ao final → 422 OUT_OF_RANGE', async () => {
      const body = expectProblem(
        await get(
          P12,
          '?occurredFrom=2026-09-05T00:00:00.000Z&occurredTo=2026-09-01T00:00:00.000Z',
        ),
        422,
        'VALIDATION_ERROR',
      );
      expect(body.errors).toEqual([
        {
          field: 'occurredFrom',
          code: 'OUT_OF_RANGE',
          message: 'O período inicial deve ser anterior ao final.',
        },
      ]);
    });

    it('V-03: limit acima de 100 → 422 OUT_OF_RANGE em limit', async () => {
      const body = expectProblem(await get(P12, '?limit=101'), 422, 'VALIDATION_ERROR');
      expect(body.errors[0]).toMatchObject({ field: 'limit', code: 'OUT_OF_RANGE' });
    });

    it('V-04: cursor inválido → 422 INVALID_FORMAT em cursor, com a mensagem da story', async () => {
      const forged = Buffer.from(JSON.stringify({ s: 'ontem' })).toString('base64url');
      const body = expectProblem(await get(P12, `?cursor=${forged}`), 422, 'VALIDATION_ERROR');
      expect(body.errors).toEqual([
        {
          field: 'cursor',
          code: 'INVALID_FORMAT',
          message: 'Não foi possível continuar a lista. Recarregue.',
        },
      ]);
    });

    it('unidade ou ator que não é UUID → 422', async () => {
      expectProblem(await get(P12, '?actorId=ana'), 422, 'VALIDATION_ERROR');
    });
  });

  describe('[Permissão]', () => {
    it('Ana sem AUDIT_VIEW: ip nulo em todos os itens e meta.canViewIp = false', async () => {
      const body = await list(P12);
      expect(body.data.map((item) => item.ip)).toEqual([null, null, null, null, null]);
      expect(body.meta.canViewIp).toBe(false);
      expect(JSON.stringify(body)).not.toContain(IP_ANA);
      // userAgent e correlationId seguem a visibilidade do processo (RN-TRAM-74).
      expect(body.data.every((item) => item.correlationId.startsWith('corr-'))).toBe(true);
    });

    it('Lúcia (GESTOR, sem AUDIT_VIEW) também não vê o ip', async () => {
      const body = await list(P12, '', 'sub-lucia');
      expect(body.data.every((item) => item.ip === null)).toBe(true);
    });

    it('"Rafael" com AUDIT_VIEW vê o ip registrado em cada tramitação', async () => {
      const body = await list(P12, '', 'sub-otavio');
      expect(body.meta.canViewIp).toBe(true);
      expect(body.data.map((item) => item.ip)).toEqual([IP_OTAVIO, IP_ANA, IP_ANA, IP_ANA, IP_ANA]);
    });

    it('sem visibilidade do processo → 404 PROCESS_NOT_FOUND', async () => {
      expectProblem(await get(P12, '', 'sub-marta'), 404, 'PROCESS_NOT_FOUND');
    });
  });

  describe('[Tenant incorreto]', () => {
    it('processo de outro tenant → 404 PROCESS_NOT_FOUND, igual ao inexistente, sem revelar nada', async () => {
      const response = await get(P_B);
      const leaked = expectProblem(response, 404, 'PROCESS_NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toContain('LEAK-B');
      const missing = expectProblem(
        await get('0192d054-0000-7000-8000-0000000000ee'),
        404,
        'PROCESS_NOT_FOUND',
      );
      expect(missing.detail).toBe(leaked.detail);
    });

    it('filtro com unidade de outro tenant não traz nada', async () => {
      const body = await list(P12, `?toDepartmentId=${UNITS_B.manutencao}`);
      expect(body.data).toEqual([]);
    });

    it('X-Tenant-Id de B sem vínculo → 403, sem chegar ao histórico', async () => {
      const response = await get(P_B, '', 'sub-ana', B);
      expect(response.status).toBe(403);
      expect(JSON.stringify(response.body)).not.toContain('LEAK-B');
    });
  });

  describe('[Duplicidade]', () => {
    it('a mesma página duas vezes: mesmos itens, nenhuma tramitação criada pela consulta', async () => {
      const before = processRepositoryOf(api).movementsOf(P12).length;
      const first = await list(P12, '?limit=3');
      const again = await list(P12, '?limit=3');
      expect(again).toEqual(first);
      expect(processRepositoryOf(api).movementsOf(P12)).toHaveLength(before);
      const next = await list(
        P12,
        `?limit=3&cursor=${encodeURIComponent(first.meta.nextCursor ?? '')}`,
      );
      expect(sequences(next).filter((sequence) => sequences(first).includes(sequence))).toEqual([]);
    });
  });

  describe('[Concorrência]', () => {
    it('nova tramitação durante a paginação: continuar do cursor não repete nem omite itens', async () => {
      const first = await list(P40, '?limit=2');
      expect(sequences(first)).toEqual([5, 4]);
      processRepositoryOf(api).seedMovements(
        movement(P40, 6, 'FORWARD', {
          toWorkflowStageId: stage('ABERTURA').id,
          actorId: FAKE_USERS.lucia.id,
        }),
      );
      const seen = [...sequences(first)];
      let cursor = first.meta.nextCursor;
      while (cursor !== null) {
        const page = await list(P40, `?limit=2&cursor=${encodeURIComponent(cursor)}`);
        seen.push(...sequences(page));
        cursor = page.meta.nextCursor;
      }
      expect(seen).toEqual([5, 4, 3, 2, 1]);
      expect(sequences(await list(P40, '?limit=2'))).toEqual([6, 5]);
    });
  });

  describe('[Falha de banco]', () => {
    it('banco indisponível → 503 DEPENDENCY_UNAVAILABLE e error process.movements_list_failed', async () => {
      error.mockClear();
      transactions.failure = new DatabaseUnavailableError(new Error('ECONNREFUSED'));
      const response = await get(P12);
      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      expect(response.headers['retry-after']).toBeDefined();
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'process.movements_list_failed',
          errorCode: 'DEPENDENCY_UNAVAILABLE',
        }),
        'process.movements_list_failed',
      );
    });

    it('conexão derrubada no meio da consulta → 503 (erro transitório)', async () => {
      transactions.failure = new Error('Connection terminated unexpectedly');
      expectProblem(await get(P12), 503, 'DEPENDENCY_UNAVAILABLE');
    });

    it('erro inesperado → 500 INTERNAL_ERROR', async () => {
      transactions.failure = new Error('bug');
      expectProblem(await get(P12), 500, 'INTERNAL_ERROR');
    });
  });

  describe('[Falha de integração]', () => {
    it('Redis (cache de permissões) fora: lista normal e ip tratado como não autorizado', async () => {
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
        const asAna = await get(P12, '', 'sub-ana', A, noRedis);
        expect(asAna.status, JSON.stringify(asAna.body)).toBe(200);
        const anaBody = processMovementsResponseSchema.parse(asAna.body);
        expect(sequences(anaBody)).toEqual([5, 4, 3, 2, 1]);
        expect(anaBody.data.every((item: MovementItemDto) => item.ip === null)).toBe(true);
        // Mesmo quem tem AUDIT_VIEW: postura segura até o cache se recuperar.
        const asAuditor = await get(P12, '', 'sub-otavio', A, noRedis);
        expect(asAuditor.status, JSON.stringify(asAuditor.body)).toBe(200);
        const auditorBody = processMovementsResponseSchema.parse(asAuditor.body);
        expect(auditorBody.meta.canViewIp).toBe(false);
        expect(auditorBody.data.every((item) => item.ip === null)).toBe(true);
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
