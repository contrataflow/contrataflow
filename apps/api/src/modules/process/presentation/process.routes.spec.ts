import { randomUUID } from 'node:crypto';

import {
  duplicateCheckResultSchema,
  problemDetailsSchema,
  processSchema,
} from '@contrataflow/validation';
import type { DuplicateCandidate, ProcessDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import {
  CATALOG_CLOCK,
  catalogItemId,
  getAs,
  numberSequencesOf,
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

/*
 * US-001 — PRC-02/PRC-03/PRC-04 pelo pipeline HTTP completo (autenticação, tenant, vínculo,
 * autorização, idempotência, filtro RFC 9457) com a identidade fake, os seeders reais do
 * provisionamento (catálogos, perfis, workflow padrão DEC-015), a numeração, a auditoria, o outbox
 * e a timeline em memória. Os cenários do Gherkin (8 categorias) e a matriz de perfis × escopos.
 * Atomicidade, RLS, FKs compostas e 50 criações simultâneas sobre o PostgreSQL:
 * `test/tenant-leak/processes.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-16T13:00:00.000Z');

const ORG_A = '0192d001-0000-7000-8000-0000000000a0';
const ORG_B = '0192d001-0000-7000-8000-0000000000b0';
const UNITS_A = {
  organizationId: ORG_A,
  obras: '0192d001-0000-7000-8000-0000000000a1',
  manutencao: '0192d001-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d001-0000-7000-8000-0000000000a3',
  saude: '0192d001-0000-7000-8000-0000000000a4',
  posto: '0192d001-0000-7000-8000-0000000000a5',
};
const UNITS_B = {
  organizationId: ORG_B,
  obras: '0192d001-0000-7000-8000-0000000000b1',
  manutencao: '0192d001-0000-7000-8000-0000000000b2',
  pavimentacao: '0192d001-0000-7000-8000-0000000000b3',
  saude: '0192d001-0000-7000-8000-0000000000b4',
  posto: '0192d001-0000-7000-8000-0000000000b5',
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

describe('Feature: Criar processo de contratação (US-001)', () => {
  let api: TestApi;
  const transactions = new FlakyTransactions();
  let catalog: { contractingType: string; origin: string; modality: string };
  /** Palavras aleatórias: textos de chamadas distintas nunca são "parecidos" (RN-PROC-13). */
  const words = (count: number) =>
    Array.from({ length: count }, () => randomUUID().replaceAll('-', '').slice(0, 10)).join(' ');

  /** Corpo válido só com os obrigatórios (título e objeto distintos a cada chamada). */
  const body = (overrides: Record<string, unknown> = {}) => {
    return {
      title: `Compra ${words(2)}`,
      object: `Objeto ${words(3)}`,
      contractingTypeId: catalog.contractingType,
      requestingSecretariatId: UNITS_A.obras,
      requestingDepartmentId: UNITS_A.manutencao,
      originId: catalog.origin,
      pcaStatus: 'NOT_APPLICABLE',
      ...overrides,
    };
  };
  const post = (
    payload: unknown,
    subject = 'sub-ana',
    options: { tenant?: string; key?: string | null } = {},
  ) => {
    const call = request(api.server)
      .post('/api/v1/processes')
      .set('Authorization', api.bearer(subject, { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', options.tenant ?? A);
    if (options.key !== null) call.set('Idempotency-Key', options.key ?? randomUUID());
    return call.send(payload as object);
  };
  const processesOf = (tenantId: string) =>
    processRepositoryOf(api)
      .allProcesses()
      .filter((process) => process.tenantId === tenantId);
  const auditOf = (action: string) => api.auditRecords().filter((row) => row.action === action);

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    api = await createTestApi({
      providers: [
        { token: PROCESS_TRANSACTIONS, value: transactions },
        { token: PROCESS_CLOCK, value: () => NOW },
        { token: CATALOG_CLOCK, value: () => NOW },
      ],
    });
    await runTenantSeeders(api, A);
    // B sem workflow (FA-06) e com as próprias unidades (Tenant incorreto).
    await runTenantSeeders(api, B, [
      'catalog.items',
      'access.defaultRoles',
      'document.systemTypes',
    ]);
    seedProcessStructure(api, A, { ...UNITS_A, shortName: 'PMSJ', cnpj: '11222333000181' });
    seedProcessStructure(api, B, { ...UNITS_B, shortName: 'PMB', cnpj: '60746948000112' });
    // Ana (REQUISITANTE, OWN_DEPARTMENTS) lotada no Setor de Manutenção da Secretaria de Obras.
    assignDepartment(api, membershipOf(FAKE_USERS.ana.id), UNITS_A.manutencao);
    // "Bruno" do Gherkin: Otávio só com SOMENTE_LEITURA (atribuição real substitui a ponte).
    const roles = seedDefaultRolesOf(api, A);
    assignRole(api, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.otavio.id),
      roleId: roles.get('SOMENTE_LEITURA')?.id ?? '',
    });
    catalog = {
      contractingType: catalogItemId(api, A, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
      origin: catalogItemId(api, A, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
      modality: catalogItemId(api, A, 'MODALITY', 'PREGAO'),
    };
    // Background: o último número de processo do tenant em 2026 é 11.
    numberSequencesOf(api).seed(A, 'PROCESS:*:2026', 11);
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
    it('Criar processo com os campos obrigatórios: 0012/2026 na ABERTURA com Ana, tramitação, timeline, auditoria e evento', async () => {
      const response = await post(
        body({ title: 'Aquisição de cimento para manutenção de vias' }),
        'sub-ana',
        { key: 'f1f6f1f6-0000-4000-8000-000000000001' },
      );

      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const created = processSchema.parse(data<ProcessDto>(response));
      expect(response.headers.location).toBe(`/api/v1/processes/${created.id}`);
      expect(response.headers.etag).toBe('"1"');
      expect(created).toMatchObject({
        status: 'DRAFT',
        number: 12,
        year: 2026,
        code: '0012/2026',
        priority: 'MEDIUM',
        organization: { id: ORG_A, shortName: 'PMSJ' },
        requestingSecretariat: { id: UNITS_A.obras, name: 'Secretaria de Obras' },
        requestingDepartment: { id: UNITS_A.manutencao, name: 'Setor de Manutenção' },
        currentStage: {
          key: 'ABERTURA',
          name: 'Formalização da demanda',
          documentTypeCodes: ['DFD'],
        },
        currentDepartment: { id: UNITS_A.manutencao, name: 'Setor de Manutenção' },
        currentResponsible: { id: FAKE_USERS.ana.id, name: 'Ana Souza' },
        workflow: { name: 'Fase preparatória — Lei 14.133/2021', versionNumber: 1 },
        contractingType: { code: 'AQUISICAO_BENS' },
        origin: { code: 'DEMANDA_NAO_PREVISTA' },
        openedAt: NOW.toISOString(),
        estimatedValue: null,
        estimatedValueMasked: false,
        version: 1,
      });
      // SLA de 5 dias úteis da ABERTURA: fim do dia útil no fuso do tenant (US-106).
      expect(created.currentStage?.dueAt).toBe('2026-10-24T02:59:59.999Z');

      const repository = processRepositoryOf(api);
      const [stage] = repository.stagesOf(created.id);
      expect(stage).toMatchObject({ sequence: 1, status: 'ACTIVE', assigneeId: FAKE_USERS.ana.id });
      expect(repository.assignmentsOf(created.id)).toEqual([
        expect.objectContaining({ type: 'STAGE_ENTRY', assigneeId: FAKE_USERS.ana.id }),
      ]);
      expect(repository.movementsOf(created.id)).toEqual([
        expect.objectContaining({
          sequence: 1,
          action: 'CREATE',
          ip: expect.any(String) as unknown,
          correlationId: expect.any(String) as unknown,
        }),
      ]);
      expect(
        repository
          .accessOf(created.id)
          .map((row) => `${row.reason}:${row.departmentId ?? row.userId ?? ''}`)
          .sort(),
      ).toEqual(
        [
          `CREATOR:${FAKE_USERS.ana.id}`,
          `CURRENT:${UNITS_A.manutencao}`,
          `REQUESTING:${UNITS_A.manutencao}`,
          `REQUESTING:${UNITS_A.obras}`,
          `RESPONSIBLE:${FAKE_USERS.ana.id}`,
        ].sort(),
      );
      expect(timelineRowsOf(api).filter((row) => row.processId === created.id)).toEqual([
        expect.objectContaining({
          type: 'PROCESS_CREATED',
          params: {
            code: '0012/2026',
            title: 'Aquisição de cimento para manutenção de vias',
            requestingDepartmentName: 'Setor de Manutenção',
          },
        }),
      ]);
      const [audit] = auditOf('process.create');
      expect(audit).toMatchObject({
        category: 'DATA_CHANGE',
        entityId: created.id,
        metadata: {
          code: '0012/2026',
          initialStageKey: 'ABERTURA',
          idempotencyKey: 'f1f6f1f6-0000-4000-8000-000000000001',
          duplicateConfirmed: false,
        },
      });
      // Textos longos só como hash + tamanho (story · Auditoria).
      expect(audit?.changes).toContainEqual({
        path: 'title',
        old: null,
        new: { sha256: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown, length: 44 },
      });
      // Evento no outbox (sem relay no teste: fica para publicar — PENDING no PostgreSQL).
      expect(api.outboxRows().filter((row) => row.aggregateId === created.id)).toEqual([
        expect.objectContaining({
          eventType: 'ProcessCreated',
          routingKey: 'process.created',
          processId: created.id,
          payload: expect.objectContaining({
            code: '0012/2026',
            number: 12,
            contractingTypeCode: 'AQUISICAO_BENS',
            initialStageKey: 'ABERTURA',
            initialDepartmentId: UNITS_A.manutencao,
            initialResponsibleId: FAKE_USERS.ana.id,
            creationChannel: 'WEB',
          }) as unknown,
        }),
      ]);

      // Painel do processo (SCR-006): PRC-04 e o próximo passo (etapa com DFD).
      const detail = await getAs(api, `/processes/${created.id}`, 'sub-ana', A);
      expect(detail.status, JSON.stringify(detail.body)).toBe(200);
      expect(data<ProcessDto>(detail)).toEqual(created);
      const actions = await getAs(api, `/processes/${created.id}/available-actions`, 'sub-ana', A);
      expect(actions.status, JSON.stringify(actions.body)).toBe(200);
    });

    it('Criar processo sem número quando a numeração ocorre na autuação (FA-03)', async () => {
      const settings = tenantSettingsOf(api);
      settings.seed(A, 'numbering.process.assignOn', 'START');
      const before = numberSequencesOf(api).valueOf(A, 'PROCESS:*:2026');
      try {
        const response = await post(body());
        expect(response.status, JSON.stringify(response.body)).toBe(201);
        expect(data<ProcessDto>(response)).toMatchObject({
          status: 'DRAFT',
          number: null,
          code: null,
          openedAt: null,
          year: 2026,
        });
        expect(numberSequencesOf(api).valueOf(A, 'PROCESS:*:2026')).toBe(before);
      } finally {
        settings.seed(A, 'numbering.process.assignOn', 'CREATE', 2);
      }
    });

    it('Gestor de contratações (TENANT) abre para qualquer setor; prioridade, valor e PCA previsto', async () => {
      const response = await post(
        body({
          requestingDepartmentId: UNITS_A.pavimentacao,
          priority: 'HIGH',
          estimatedValue: '15000.5',
          pcaStatus: 'PLANNED',
          pcaYear: 2026,
          pcaItemCode: 'PCA-17',
          modalityId: catalog.modality,
          targetDate: '2026-12-01',
        }),
        'sub-lucia',
      );
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(data<ProcessDto>(response)).toMatchObject({
        priority: 'HIGH',
        estimatedValue: '15000.50',
        estimatedValueSource: 'MANUAL',
        pcaStatus: 'PLANNED',
        pcaYear: 2026,
        pcaItemCode: 'PCA-17',
        modality: { code: 'PREGAO' },
        targetDate: '2026-12-01',
        currentResponsible: { id: FAKE_USERS.lucia.id },
      });
    });

    it('WF-06: a requisitante (sem WORKFLOW_VIEW) vê o fluxo do wizard', async () => {
      const response = await request(api.server)
        .post('/api/v1/workflows/resolve')
        .set('Authorization', api.bearer('sub-ana'))
        .set('X-Tenant-Id', A)
        .send({
          contractingTypeId: catalog.contractingType,
          originId: catalog.origin,
          organizationId: ORG_A,
          isPriceRegistration: false,
        });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(data<{ initialStage: { key: string } }>(response).initialStage.key).toBe('ABERTURA');
    });
  });

  describe('[Validação]', () => {
    it('Campos obrigatórios ausentes: 422 VALIDATION_ERROR com erro no campo "title"', async () => {
      const total = processesOf(A).length;
      const response = await post({ ...body(), title: undefined });
      const problem = expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(problem.errors).toEqual([
        { field: 'title', code: 'REQUIRED', message: 'Informe o título.' },
      ]);
      expect(processesOf(A)).toHaveLength(total);
    });

    it('Setor fora da secretaria selecionada: DEPARTMENT_NOT_IN_SECRETARIAT e nada criado', async () => {
      const total = processesOf(A).length;
      const response = await post(body({ requestingDepartmentId: UNITS_A.posto }), 'sub-lucia');
      const problem = expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(problem.errors).toEqual([
        {
          field: 'requestingDepartmentId',
          code: 'DEPARTMENT_NOT_IN_SECRETARIAT',
          message: 'O setor deve pertencer à secretaria selecionada.',
        },
      ]);
      expect(processesOf(A)).toHaveLength(total);
    });

    it('Contratação fora do PCA sem justificativa; prazo no passado; catálogo de outro tipo', async () => {
      const pca = expectProblem(
        await post(body({ pcaStatus: 'NOT_PLANNED' })),
        422,
        'VALIDATION_ERROR',
      );
      expect(pca.errors).toEqual([
        {
          field: 'pcaJustification',
          code: 'CONDITIONAL_REQUIRED',
          message:
            'Justifique por que a contratação não está prevista no PCA (mín. 20 caracteres).',
        },
      ]);
      const past = expectProblem(
        await post(body({ targetDate: '2026-10-15' })),
        422,
        'VALIDATION_ERROR',
      );
      expect(past.errors).toEqual([
        {
          field: 'targetDate',
          code: 'DATE_IN_PAST',
          message: 'O prazo alvo não pode ser anterior a hoje.',
        },
      ]);
      const wrongType = expectProblem(
        await post(body({ contractingTypeId: catalog.origin, originId: catalog.contractingType })),
        422,
        'VALIDATION_ERROR',
      );
      expect(wrongType.errors.map((error) => [error.field, error.code])).toEqual([
        ['contractingTypeId', 'REFERENCE_NOT_FOUND'],
        ['originId', 'REFERENCE_NOT_FOUND'],
      ]);
    });

    it('Código interno exigido pela configuração (FA-09)', async () => {
      const settings = tenantSettingsOf(api);
      settings.seed(A, 'process.requireInternalCode', true);
      try {
        const problem = expectProblem(await post(body()), 422, 'VALIDATION_ERROR');
        expect(problem.errors).toEqual([
          {
            field: 'internalCode',
            code: 'CONDITIONAL_REQUIRED',
            message: 'Informe o código interno.',
          },
        ]);
      } finally {
        settings.seed(A, 'process.requireInternalCode', false, 2);
      }
    });
  });

  describe('[Permissão]', () => {
    it('Usuário sem PROCESS_CREATE: 403 PERMISSION_DENIED, access.denied PROCESS_CREATE e nada criado', async () => {
      const total = processesOf(A).length;
      const response = await post(body(), 'sub-otavio');
      expectProblem(response, 403, 'PERMISSION_DENIED');
      expect(auditOf('access.denied').at(-1)).toMatchObject({ reasonCode: 'PROCESS_CREATE' });
      expect(processesOf(A)).toHaveLength(total);
    });

    it('Escopo que não cobre o setor solicitante (Ana não é lotada na Pavimentação): 403', async () => {
      const total = processesOf(A).length;
      const response = await post(body({ requestingDepartmentId: UNITS_A.pavimentacao }));
      expectProblem(response, 403, 'PERMISSION_DENIED');
      expect(auditOf('access.denied').at(-1)).toMatchObject({ reasonCode: 'PROCESS_CREATE' });
      expect(processesOf(A)).toHaveLength(total);
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Referência a unidade de outro tenant: 422 REFERENCE_NOT_FOUND sem revelar a unidade', async () => {
      const response = await post(
        body({
          requestingSecretariatId: UNITS_B.obras,
          requestingDepartmentId: UNITS_B.manutencao,
        }),
        'sub-lucia',
      );
      const problem = expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(problem.errors).toEqual([
        {
          field: 'requestingSecretariatId',
          code: 'REFERENCE_NOT_FOUND',
          message: 'Selecione uma unidade válida.',
        },
        {
          field: 'requestingDepartmentId',
          code: 'REFERENCE_NOT_FOUND',
          message: 'Selecione uma unidade válida.',
        },
      ]);
      expect(JSON.stringify(response.body)).not.toContain('Setor de Manutenção');
      expect(processesOf(B)).toHaveLength(0);
    });

    it('Cabeçalho de tenant sem vínculo: 403 MEMBERSHIP_INACTIVE', async () => {
      expectProblem(await post(body(), 'sub-ana', { tenant: B }), 403, 'MEMBERSHIP_INACTIVE');
    });

    it('PRC-04 com processo de outro tenant: 404 PROCESS_NOT_FOUND (mesmo corpo do inexistente)', async () => {
      const [process] = processesOf(A);
      const other = await getAs(api, `/processes/${process?.id ?? ''}`, 'sub-heitor', B);
      const missing = await getAs(api, `/processes/${randomUUID()}`, 'sub-heitor', B);
      expectProblem(other, 404, 'PROCESS_NOT_FOUND');
      expectProblem(missing, 404, 'PROCESS_NOT_FOUND');
    });

    it('Sem workflow aplicável no tenant: 422 NO_APPLICABLE_WORKFLOW (FA-06) e a sequência não avança', async () => {
      const response = await post(
        {
          ...body(),
          contractingTypeId: catalogItemId(api, B, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
          originId: catalogItemId(api, B, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
          requestingSecretariatId: UNITS_B.obras,
          requestingDepartmentId: UNITS_B.manutencao,
        },
        'sub-heitor',
        { tenant: B },
      );
      expectProblem(response, 422, 'NO_APPLICABLE_WORKFLOW');
      expect(processesOf(B)).toHaveLength(0);
    });
  });

  describe('[Duplicidade]', () => {
    it('Processo semelhante criado recentemente: aviso com o link e "Criar mesmo assim" registra a confirmação', async () => {
      const first = await post(body({ title: 'Contratação de serviço de poda de árvores' }));
      expect(first.status, JSON.stringify(first.body)).toBe(201);
      const existing = data<ProcessDto>(first);

      const check = await request(api.server)
        .post('/api/v1/processes/check-duplicates')
        .set('Authorization', api.bearer('sub-ana'))
        .set('X-Tenant-Id', A)
        .send({
          title: 'Contratação de serviços de poda das árvores',
          object: 'Outro objeto qualquer para conferência.',
          requestingDepartmentId: UNITS_A.manutencao,
        });
      expect(check.status, JSON.stringify(check.body)).toBe(200);
      const { candidates } = duplicateCheckResultSchema.parse(data(check));
      expect(candidates[0]).toMatchObject({
        id: existing.id,
        code: existing.code,
        createdBy: { id: FAKE_USERS.ana.id, name: 'Ana Souza' },
      });

      const duplicate = body({ title: 'Contratação de serviços de poda das árvores' });
      const blocked = await post(duplicate);
      const problem = expectProblem(blocked, 409, 'POSSIBLE_DUPLICATE_PROCESS');
      expect(problem.detail).toBe('Encontramos processos parecidos criados recentemente.');
      const listed = (blocked.body as { candidates: DuplicateCandidate[] }).candidates;
      expect(listed.map((candidate) => candidate.id)).toContain(existing.id);

      const confirmed = await post({ ...duplicate, confirmDuplicate: true });
      expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(201);
      expect(data<ProcessDto>(confirmed).number).toBe((existing.number ?? 0) + 1);
      expect(auditOf('process.create').at(-1)?.metadata).toMatchObject({
        duplicateConfirmed: true,
      });
    });

    it('Código interno já utilizado: 409 DUPLICATE_INTERNAL_CODE', async () => {
      expect((await post(body({ internalCode: 'PROT-2026-0457' }))).status).toBe(201);
      const problem = expectProblem(
        await post(body({ internalCode: 'PROT-2026-0457' })),
        409,
        'DUPLICATE_INTERNAL_CODE',
      );
      expect(problem.detail).toBe('Já existe um processo com o código interno PROT-2026-0457.');
    });

    it('Reenvio com a mesma chave de idempotência: mesma resposta e "Idempotent-Replayed: true"', async () => {
      const payload = body();
      const key = randomUUID();
      const original = await post(payload, 'sub-ana', { key });
      expect(original.status).toBe(201);
      const total = processesOf(A).length;
      const replay = await post(payload, 'sub-ana', { key });
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(data<ProcessDto>(replay).id).toBe(data<ProcessDto>(original).id);
      expect(processesOf(A)).toHaveLength(total);
      // Mesma chave com outro corpo (V-13).
      expectProblem(await post(body(), 'sub-ana', { key }), 422, 'IDEMPOTENCY_KEY_REUSED');
    });
  });

  describe('[Concorrência]', () => {
    it('Criações simultâneas recebem números distintos e sem lacunas; uma etapa ativa por processo', async () => {
      const before = numberSequencesOf(api).valueOf(A, 'PROCESS:*:2026');
      const responses = await Promise.all(
        Array.from({ length: 10 }, () => post(body()).then((response) => response)),
      );
      expect(responses.map((response) => response.status)).toEqual(Array(10).fill(201));
      const numbers = responses.map((response) => data<ProcessDto>(response).number ?? 0);
      expect([...numbers].sort((a, b) => a - b)).toEqual(
        Array.from({ length: 10 }, (_, index) => before + index + 1),
      );
      for (const response of responses) {
        const stages = processRepositoryOf(api).stagesOf(data<ProcessDto>(response).id);
        expect(stages.map((stage) => stage.status)).toEqual(['ACTIVE']);
      }
    });

    it('Duas requisições simultâneas com a mesma chave: um 201 e a outra replay ou 409 IDEMPOTENCY_IN_PROGRESS', async () => {
      const payload = body();
      const key = randomUUID();
      const total = processesOf(A).length;
      const [one, two] = await Promise.all([
        post(payload, 'sub-ana', { key }).then((response) => response),
        post(payload, 'sub-ana', { key }).then((response) => response),
      ]);
      const statuses = [one.status, two.status].sort();
      expect(statuses[0]).toBe(201);
      expect([201, 409]).toContain(statuses[1]);
      expect(processesOf(A)).toHaveLength(total + 1);
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível: 503 DEPENDENCY_UNAVAILABLE com Retry-After e nada persistido', async () => {
      const total = processesOf(A).length;
      const events = api.outboxRows().length;
      const audits = api.auditRecords().length;
      transactions.down = true;
      const response = await post(body());
      expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
      expect(response.headers['retry-after']).toBeDefined();
      expect(processesOf(A)).toHaveLength(total);
      expect(api.outboxRows()).toHaveLength(events);
      expect(api.auditRecords().filter((row) => row.action === 'process.create').length).toBe(
        api
          .auditRecords()
          .slice(0, audits)
          .filter((row) => row.action === 'process.create').length,
      );
    });
  });

  describe('[Falha de integração]', () => {
    it('Redis indisponível: o processo é criado e registra warn idempotency.store_unavailable', async () => {
      const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const degraded = await createTestApi({
        stores: 'redis',
        providers: [
          { token: PROCESS_CLOCK, value: () => NOW },
          { token: CATALOG_CLOCK, value: () => NOW },
        ],
      });
      try {
        await runTenantSeeders(degraded, A);
        seedProcessStructure(degraded, A, {
          ...UNITS_A,
          shortName: 'PMSJ',
          cnpj: '11222333000181',
        });
        const response = await request(degraded.server)
          .post('/api/v1/processes')
          .set('Authorization', degraded.bearer('sub-lucia'))
          .set('X-Tenant-Id', A)
          .set('Idempotency-Key', randomUUID())
          .send({
            ...body(),
            contractingTypeId: catalogItemId(degraded, A, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
            originId: catalogItemId(degraded, A, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
          });
        expect(response.status, JSON.stringify(response.body)).toBe(201);
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^idempotency\.store_unavailable/));
      } finally {
        await degraded.close();
      }
    });
  });
});
