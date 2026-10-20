import { problemDetailsSchema, processListResponseSchema } from '@contrataflow/validation';
import type { ProcessListResponse } from '@contrataflow/validation';
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
import {
  assignDepartment,
  assignRole,
  seedDefaultRolesOf,
  seedDepartment,
} from '../../../../test/support/structure-fixtures.js';
import { PROCESS_CLOCK, PROCESS_TRANSACTIONS } from '../application/ports.js';
import type { ProcessTransactions } from '../application/ports.js';
import type { AccessGrant } from '../domain/process-runtime-records.js';
import type { Process } from '../domain/process.js';

/*
 * US-002 — PRC-01 pelo pipeline HTTP completo (autenticação, tenant, vínculo, autorização, filtro
 * RFC 9457) com a identidade fake, os seeders reais (catálogos, perfis, workflow padrão) e os
 * processos do Background do Gherkin no repositório em memória. As 8 categorias do Gherkin; a
 * mesma consulta sobre PostgreSQL (SQL, RLS, FTS, snapshot único) em
 * `test/tenant-leak/process-list.spec.ts`. Personas: Patrícia = Lúcia (GESTOR, TENANT); Ana
 * (REQUISITANTE, OWN_DEPARTMENTS no Setor de Manutenção); Tatiane = Otávio (SOMENTE_LEITURA,
 * ORGANIZATION); Carlos = Marta só com CONSULTOR_EXTERNO (sem PROCESS_VIEW nem concessões);
 * Bruno = Fábio no tenant B (EXTERNAL, CONSULTOR_EXTERNO, participante de um único processo).
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-05T15:00:00.000Z');

const ORG_A = '0192d002-0000-7000-8000-0000000000a0';
const ORG_B = '0192d002-0000-7000-8000-0000000000b0';
const UNITS_A = {
  organizationId: ORG_A,
  obras: '0192d002-0000-7000-8000-0000000000a1',
  manutencao: '0192d002-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d002-0000-7000-8000-0000000000a3',
  saude: '0192d002-0000-7000-8000-0000000000a4',
  posto: '0192d002-0000-7000-8000-0000000000a5',
};
const COTACOES = '0192d002-0000-7000-8000-0000000000a6';
const FARMACIA = '0192d002-0000-7000-8000-0000000000a7';
const PLANEJAMENTO = '0192d002-0000-7000-8000-0000000000a8';
const UNITS_B = {
  organizationId: ORG_B,
  obras: '0192d002-0000-7000-8000-0000000000b1',
  manutencao: '0192d002-0000-7000-8000-0000000000b2',
  pavimentacao: '0192d002-0000-7000-8000-0000000000b3',
  saude: '0192d002-0000-7000-8000-0000000000b4',
  posto: '0192d002-0000-7000-8000-0000000000b5',
};

const P12 = '0192d002-0000-7000-8000-000000000012';
const P31 = '0192d002-0000-7000-8000-000000000031';
const P45 = '0192d002-0000-7000-8000-000000000045';
const P_B = '0192d002-0000-7000-8000-0000000000ff';
const P_B2 = '0192d002-0000-7000-8000-0000000000fe';
const TAGS = [
  '0192d002-0000-7000-8000-00000000e001',
  '0192d002-0000-7000-8000-00000000e002',
  '0192d002-0000-7000-8000-00000000e003',
];

const membershipOf = (userId: string, tenantId = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

/** Transações do módulo que podem simular o banco fora do ar ou a consulta lenta. */
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
    return this.read(work);
  }
}

const dept = (departmentId: string, reason: 'REQUESTING' | 'CURRENT' | 'HISTORICAL') =>
  ({ principalType: 'DEPARTMENT', departmentId, reason }) as AccessGrant;
const user = (userId: string, reason: 'CREATOR' | 'RESPONSIBLE' | 'PARTICIPANT') =>
  ({ principalType: 'USER', userId, reason }) as AccessGrant;

describe('Feature: Listar, pesquisar, filtrar e ordenar processos (US-002)', () => {
  let api: TestApi;
  let warn: MockInstance<Logger['warn']>;
  const transactions = new FlakyTransactions();
  let stageIds: Map<string, { id: string; versionId: string }>;
  let base: Omit<Process, 'id' | 'number' | 'code' | 'title' | 'status' | 'priority'>;

  const get = (query: string, subject = 'sub-lucia', tenantId: string = A, target: TestApi = api) =>
    request(target.server)
      .get(`/api/v1/processes${query}`)
      .set('Authorization', target.bearer(subject, { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', tenantId);
  const list = async (query: string, subject = 'sub-lucia') => {
    const response = await get(query, subject);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return processListResponseSchema.parse(response.body);
  };
  const codes = (body: ProcessListResponse) => body.data.map((item) => item.code);
  const expectProblem = (response: request.Response, status: number, code: string) => {
    expect(response.status, JSON.stringify(response.body)).toBe(status);
    const body = problemDetailsSchema.parse(response.body);
    expect(body.code).toBe(code);
    return body;
  };

  const processAt = (
    id: string,
    number: number | null,
    fields: Partial<Process> & { stageKey: string },
  ): Process => {
    const stage = stageIds.get(fields.stageKey);
    if (!stage) throw new Error(`etapa ${fields.stageKey} ausente`);
    const { stageKey: _stageKey, ...rest } = fields;
    return {
      ...base,
      id,
      number,
      code: number === null ? null : `${String(number).padStart(4, '0')}/2026`,
      title: `Processo ${id.slice(-4)}`,
      status: 'IN_PROGRESS',
      priority: 'MEDIUM',
      workflowVersionId: stage.versionId,
      currentWorkflowStageId: stage.id,
      ...rest,
    };
  };

  /** Background: os 3 processos, as unidades e as personas. */
  function seedBackground(target: TestApi): void {
    const repository = processRepositoryOf(target);
    repository.seed(
      processAt(P12, 12, {
        stageKey: 'PESQUISA_PRECOS',
        title: 'Aquisição de cimento para manutenção de vias',
        object: 'Cimento CP-II para a manutenção das vias.',
        priority: 'HIGH',
        currentDepartmentId: COTACOES,
        estimatedValue: '85000.00',
        updatedAt: new Date('2026-10-02T18:40:00.000Z'),
      }),
      [dept(UNITS_A.manutencao, 'REQUESTING'), dept(COTACOES, 'CURRENT')],
    );
    repository.seed(
      processAt(P31, 31, {
        stageKey: 'ESTUDOS_PRELIMINARES',
        title: 'Contratação de limpeza hospitalar',
        object: 'Serviços contínuos de limpeza hospitalar.',
        status: 'RETURNED',
        priority: 'MEDIUM',
        currentDepartmentId: UNITS_A.manutencao,
        currentResponsibleId: FAKE_USERS.ana.id,
        isBudgetConfidential: true,
        estimatedValue: '1200000.00',
        updatedAt: new Date('2026-10-03T10:00:00.000Z'),
      }),
      [
        dept(UNITS_A.manutencao, 'REQUESTING'),
        dept(UNITS_A.manutencao, 'CURRENT'),
        user(FAKE_USERS.ana.id, 'RESPONSIBLE'),
        user(FAKE_USERS.carla.id, 'PARTICIPANT'),
      ],
    );
    repository.seed(
      processAt(P45, 45, {
        stageKey: 'APROVACAO_DFD',
        title: 'Aquisição de medicamentos da farmácia básica',
        object: 'Medicamentos da farmácia básica municipal.',
        status: 'AWAITING_APPROVAL',
        priority: 'URGENT',
        requestingSecretariatId: UNITS_A.saude,
        requestingDepartmentId: FARMACIA,
        currentDepartmentId: UNITS_A.saude,
        estimatedValue: null,
        estimatedValueSource: null,
        // Venceu em 30/09 (fim do dia em São Paulo).
        currentStageDueAt: new Date('2026-10-01T02:59:59.999Z'),
        updatedAt: new Date('2026-10-01T10:00:00.000Z'),
      }),
      [dept(FARMACIA, 'REQUESTING'), dept(UNITS_A.saude, 'CURRENT')],
    );
    // Processo do tenant B no Setor X (Tenant incorreto).
    repository.seed(
      {
        ...processAt(P_B, 7, { stageKey: 'ABERTURA', title: 'Processo LEAK-B' }),
        tenantId: B,
        organizationId: ORG_B,
        requestingSecretariatId: UNITS_B.obras,
        requestingDepartmentId: UNITS_B.manutencao,
        currentDepartmentId: UNITS_B.manutencao,
      },
      [dept(UNITS_B.manutencao, 'CURRENT')],
    );
    // Processo sigiloso de B em que Fábio (consultor externo) participa.
    repository.seed(
      {
        ...processAt(P_B2, 8, { stageKey: 'ABERTURA', title: 'Consultoria de projeto LEAK-B' }),
        tenantId: B,
        organizationId: ORG_B,
        requestingSecretariatId: UNITS_B.obras,
        requestingDepartmentId: UNITS_B.manutencao,
        currentDepartmentId: UNITS_B.manutencao,
        isBudgetConfidential: true,
        estimatedValue: '500000.00',
      },
      [dept(UNITS_B.manutencao, 'CURRENT'), user(FAKE_USERS.fabio.id, 'PARTICIPANT')],
    );
  }

  async function prepare(target: TestApi): Promise<void> {
    await runTenantSeeders(target, A);
    seedProcessStructure(target, A, { ...UNITS_A, shortName: 'PMSJ', cnpj: '11222333000181' });
    seedProcessStructure(target, B, { ...UNITS_B, shortName: 'PMB', cnpj: '60746948000112' });
    const obras = { id: UNITS_A.obras, path: `/${UNITS_A.obras}/`, depth: 0 };
    const saude = { id: UNITS_A.saude, path: `/${UNITS_A.saude}/`, depth: 0 };
    const unit = { tenantId: A, organizationId: ORG_A };
    seedDepartment(target, { ...unit, id: COTACOES, name: 'Setor de Cotações', parent: obras });
    seedDepartment(target, { ...unit, id: FARMACIA, name: 'Farmácia Básica', parent: saude });
    seedDepartment(target, {
      ...unit,
      id: PLANEJAMENTO,
      name: 'Setor de Planejamento',
      parent: obras,
    });
    assignDepartment(target, membershipOf(FAKE_USERS.ana.id), UNITS_A.manutencao);
    const roles = seedDefaultRolesOf(target, A);
    assignRole(target, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.otavio.id),
      roleId: roles.get('SOMENTE_LEITURA')?.id ?? '',
      scopeType: 'ORGANIZATION',
      scopeOrganizationId: ORG_A,
    });
    assignRole(target, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.marta.id),
      roleId: roles.get('CONSULTOR_EXTERNO')?.id ?? '',
    });
    const stages = workflowStagesOf(target, A);
    stageIds = new Map(
      stages.map((stage) => [stage.key, { id: stage.id, versionId: stage.workflowVersionId }]),
    );
    base = {
      tenantId: A,
      organizationId: ORG_A,
      year: 2026,
      internalCode: null,
      object: 'Objeto do processo de teste.',
      description: null,
      contractingTypeId: catalogItemId(target, A, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
      modalityId: null,
      isPriceRegistration: false,
      requestingSecretariatId: UNITS_A.obras,
      requestingDepartmentId: UNITS_A.manutencao,
      currentDepartmentId: UNITS_A.manutencao,
      currentResponsibleId: null,
      workflowVersionId: '',
      currentStageId: null,
      currentWorkflowStageId: null,
      currentStageDueAt: null,
      openedAt: null,
      targetDate: null,
      estimatedValue: null,
      estimatedValueSource: 'MANUAL',
      isBudgetConfidential: false,
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
    seedBackground(target);
  }

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    api = await createTestApi({
      providers: [
        { token: PROCESS_TRANSACTIONS, value: transactions },
        { token: PROCESS_CLOCK, value: () => NOW },
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
    it('Gestor combina filtros e ordenação: 0012 e 0031 nesta ordem, valor sigiloso visível', async () => {
      const body = await list('?status=IN_PROGRESS%2CRETURNED&sort=-priority');
      expect(codes(body)).toEqual(['0012/2026', '0031/2026']);
      expect(body.meta).toMatchObject({ page: 1, pageSize: 20, totalItems: 2, totalPages: 1 });
      const p31 = body.data[1];
      expect(p31).toMatchObject({
        isBudgetConfidential: true,
        estimatedValue: '1200000.00',
        estimatedValueMasked: false,
        currentStage: { key: 'ESTUDOS_PRELIMINARES' },
        currentDepartment: { id: UNITS_A.manutencao, name: 'Setor de Manutenção' },
        currentResponsible: { id: FAKE_USERS.ana.id, name: 'Ana Souza' },
        organization: { id: ORG_A, shortName: 'PMSJ' },
      });
      expect(body.data[0]).toMatchObject({
        requestingSecretariat: { name: 'Secretaria de Obras' },
        currentResponsible: null,
        contractingType: { code: 'AQUISICAO_BENS' },
        modality: null,
        tags: [],
      });
    });

    it('Atalho "Atrasados": somente 0045, atrasado há 3 dias úteis', async () => {
      const body = await list('?overdue=true');
      expect(codes(body)).toEqual(['0045/2026']);
      expect(body.data[0]?.deadline).toMatchObject({
        isOverdue: true,
        overdueDays: 3,
        daysLeft: null,
        slaType: null,
        dueAt: '2026-10-01T02:59:59.999Z',
      });
    });

    it('Atalho "Comigo" e busca por código parcial (FA-04)', async () => {
      expect(codes(await list('?currentResponsibleId=me', 'sub-ana'))).toEqual(['0031/2026']);
      const search = await list('?q=12%2F2026', 'sub-ana');
      expect(search.data[0]?.code).toBe('0012/2026');
    });

    it('"Sem responsável", "Da minha unidade", "Devolvidos" e opções de etapa', async () => {
      expect(codes(await list('?currentResponsibleId=none&sort=code'))).toEqual([
        '0012/2026',
        '0045/2026',
      ]);
      expect(codes(await list('?currentDepartmentId=mine', 'sub-ana'))).toEqual(['0031/2026']);
      expect(codes(await list('?status=RETURNED'))).toEqual(['0031/2026']);
      const withOptions = await list(
        '?stageKey=PESQUISA_PRECOS,APROVACAO_DFD&includeStageOptions=true&sort=code',
      );
      expect(codes(withOptions)).toEqual(['0012/2026', '0045/2026']);
      expect(withOptions.meta.stageOptions?.map((option) => option.key)).toEqual(
        expect.arrayContaining(['ABERTURA', 'PESQUISA_PRECOS', 'TERMO_REFERENCIA']),
      );
    });

    it('sem filtro de status a API devolve todos; página além do total = data vazio com meta correto', async () => {
      expect((await list('')).meta.totalItems).toBe(3);
      const beyond = await list('?page=5&pageSize=2');
      expect(beyond.data).toEqual([]);
      expect(beyond.meta).toEqual({ page: 5, pageSize: 2, totalItems: 3, totalPages: 2 });
    });
  });

  describe('[Validação]', () => {
    it('busca curta e ordenação não permitida → 422 no campo', async () => {
      const short = expectProblem(await get('?q=a'), 422, 'VALIDATION_ERROR');
      expect(short.errors.map((error) => error.field)).toEqual(['q']);
      const sort = expectProblem(await get('?sort=internalNotes'), 422, 'VALIDATION_ERROR');
      expect(sort.errors.map((error) => error.field)).toEqual(['sort']);
    });

    it.each([
      ['?status=OPEN', 'status'],
      ['?requestingDepartmentId=abc', 'requestingDepartmentId'],
      ['?pageSize=101', 'pageSize'],
      ['?createdFrom=2026-10-05&createdTo=2026-10-01', 'createdTo'],
      ['?estimatedValueMin=1.234', 'estimatedValueMin'],
      ['?year=1999', 'year'],
      ['?sort=updatedAt;DROP%20TABLE%20processes', 'sort'],
    ])('%s → 422 em %s', async (query, field) => {
      const problem = expectProblem(await get(query), 422, 'VALIDATION_ERROR');
      // Filtros multivalorados apontam o valor inválido (`status[0]`).
      expect(problem.errors.map((error) => error.field.replace(/\[\d+\]$/, ''))).toEqual([field]);
    });

    it('parâmetro desconhecido é ignorado', async () => {
      expect((await list('?internalNotes=x')).meta.totalItems).toBe(3);
    });
  });

  describe('[Permissão]', () => {
    it('Requisitante vê apenas os processos visíveis para suas lotações', async () => {
      expect(codes(await list('?sort=code', 'sub-ana'))).toEqual(['0012/2026', '0031/2026']);
      const other = await list(`?requestingDepartmentId=${FARMACIA}`, 'sub-ana');
      expect(other.data).toEqual([]);
      expect(other.meta.totalItems).toBe(0);
    });

    it('Valor sigiloso não vaza em filtro nem em ordenação (Tatiane)', async () => {
      const all = await list('', 'sub-otavio');
      const p31 = all.data.find((item) => item.code === '0031/2026');
      expect(p31).toMatchObject({
        estimatedValue: null,
        estimatedValueMasked: true,
        isBudgetConfidential: true,
      });
      const byValue = await list('?estimatedValueMin=1000000.00', 'sub-otavio');
      expect(byValue.data).toEqual([]);
      expect(byValue.meta.valueFilterExcludesConfidential).toBe(true);
      const sorted = await list('?sort=-estimatedValue', 'sub-otavio');
      expect(codes(sorted)[0]).toBe('0012/2026');
      expect(codes(sorted).slice(1)).toEqual(expect.arrayContaining(['0031/2026', '0045/2026']));
      expect(sorted.data.find((item) => item.code === '0031/2026')?.estimatedValue).toBeNull();
      // O gestor com POL-09 amplo não recebe a nota.
      expect(
        (await list('?estimatedValueMin=1000000.00')).meta.valueFilterExcludesConfidential,
      ).toBe(false);
    });

    it('Sem MFA, PROCESS_VIEW_CONFIDENTIAL_BUDGET não desmascara (FA-12): mascarado, sem 403', async () => {
      const response = await request(api.server)
        .get('/api/v1/processes?status=RETURNED')
        .set('Authorization', api.bearer('sub-lucia', { amr: ['pwd'] }))
        .set('X-Tenant-Id', A);
      expect(response.status).toBe(200);
      const body = processListResponseSchema.parse(response.body);
      expect(body.data[0]).toMatchObject({ estimatedValue: null, estimatedValueMasked: true });
      expect(body.meta.confidentialStepUpAvailable).toBe(true);
    });

    it('Usuário sem PROCESS_VIEW e sem concessões → 403 + access.denied(PROCESS_VIEW)', async () => {
      expectProblem(await get('', 'sub-marta'), 403, 'PERMISSION_DENIED');
      const denied = api
        .auditRecords()
        .filter((row) => row.action === 'access.denied' && row.reasonCode === 'PROCESS_VIEW');
      expect(denied.length).toBeGreaterThan(0);
    });

    it('Consultor externo vê somente o processo em que participa, com valor mascarado', async () => {
      const response = await get('', 'sub-fabio', B);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const body = processListResponseSchema.parse(response.body);
      expect(codes(body)).toEqual(['0008/2026']);
      expect(body.data[0]).toMatchObject({ estimatedValue: null, estimatedValueMasked: true });
    });
  });

  describe('[Tenant incorreto]', () => {
    it('filtro com unidade de outro tenant → 200 vazio, sem revelar nada', async () => {
      const response = await get(`?currentDepartmentId=${UNITS_B.manutencao}`);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        data: [],
        meta: { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 },
      });
      expect(JSON.stringify((await list('')).data)).not.toContain('LEAK-B');
    });

    it('X-Tenant-Id sem vínculo → 403 MEMBERSHIP_INACTIVE', async () => {
      expectProblem(await get('', 'sub-lucia', B), 403, 'MEMBERSHIP_INACTIVE');
    });
  });

  describe('[Duplicidade]', () => {
    it('várias concessões e etiquetas: o processo aparece uma única vez', async () => {
      const repository = processRepositoryOf(api);
      const p12 = repository.allProcesses().find((process) => process.id === P12);
      if (!p12) throw new Error('0012 ausente');
      repository.seed(p12, [
        dept(UNITS_A.manutencao, 'HISTORICAL'),
        user(FAKE_USERS.ana.id, 'CREATOR'),
      ]);
      repository.setListExtras(P12, { tagIds: TAGS });
      const body = await list(`?tagId=${TAGS[0] ?? ''},${TAGS[2] ?? ''}`, 'sub-ana');
      expect(codes(body)).toEqual(['0012/2026']);
      expect(body.meta.totalItems).toBe(1);
      repository.setListExtras(P12, { tagIds: [] });
    });
  });

  describe('[Concorrência]', () => {
    it('tramitação entre duas consultas: etapa e unidade novas juntas', async () => {
      const repository = processRepositoryOf(api);
      const before = await list('?q=cimento');
      expect(before.data[0]?.currentStage?.key).toBe('PESQUISA_PRECOS');
      const p12 = repository.allProcesses().find((process) => process.id === P12);
      if (!p12) throw new Error('0012 ausente');
      const stage = stageIds.get('TERMO_REFERENCIA');
      repository.seed({
        ...p12,
        currentWorkflowStageId: stage?.id ?? null,
        currentDepartmentId: PLANEJAMENTO,
      });
      const after = await list('?q=cimento');
      expect(after.data[0]).toMatchObject({
        currentStage: { key: 'TERMO_REFERENCIA', name: 'Termo de Referência' },
        currentDepartment: { id: PLANEJAMENTO, name: 'Setor de Planejamento' },
      });
      repository.seed(p12);
    });

    it('paginação determinística com 45 processos de mesmo updatedAt', async () => {
      const repository = processRepositoryOf(api);
      const ids = Array.from(
        { length: 45 },
        (_, index) => `0192d002-0000-7000-8000-0000000b${String(index).padStart(4, '0')}`,
      );
      for (const id of ids) {
        repository.seed(
          processAt(id, null, {
            stageKey: 'ABERTURA',
            year: 2025,
            updatedAt: new Date('2026-10-01T12:00:00.000Z'),
          }),
          [dept(UNITS_A.manutencao, 'REQUESTING')],
        );
      }
      const seen: string[] = [];
      for (const page of [1, 2, 3]) {
        seen.push(
          ...(await list(`?year=2025&pageSize=20&page=${page}`)).data.map((item) => item.id),
        );
      }
      expect(seen).toHaveLength(45);
      expect(new Set(seen)).toEqual(new Set(ids));
    });
  });

  describe('[Falha de banco]', () => {
    it('banco indisponível → 503 DEPENDENCY_UNAVAILABLE com Retry-After', async () => {
      transactions.failure = new DatabaseUnavailableError(new Error('ECONNREFUSED'));
      const response = await get('?status=IN_PROGRESS');
      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      expect(response.headers['retry-after']).toBeDefined();
    });

    it('consulta acima do statement_timeout → 503 e warn process.list_slow sem o texto da busca', async () => {
      warn.mockClear();
      transactions.failure = Object.assign(
        new Error('canceling statement due to statement timeout'),
        {
          code: '57014',
        },
      );
      expectProblem(
        await get('?q=cimento%20sigiloso&status=IN_PROGRESS'),
        503,
        'DEPENDENCY_UNAVAILABLE',
      );
      const call = warn.mock.calls.find((args) => args[1] === 'process.list_slow');
      expect(call?.[0]).toMatchObject({
        event: 'process.list_slow',
        filterKeys: ['q', 'status'],
        timedOut: true,
      });
      expect(JSON.stringify(call?.[0])).not.toContain('cimento');
    });
  });

  describe('[Falha de integração]', () => {
    it('Redis indisponível: permissões calculadas do banco, mesmos processos e warn', async () => {
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
          { token: PROCESS_CLOCK, value: () => NOW },
          { token: CATALOG_CLOCK, value: () => NOW },
        ],
      });
      try {
        await prepare(noRedis);
        const response = await get('?sort=code', 'sub-ana', A, noRedis);
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        expect(
          processListResponseSchema.parse(response.body).data.map((item) => item.code),
        ).toEqual(['0012/2026', '0031/2026']);
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
