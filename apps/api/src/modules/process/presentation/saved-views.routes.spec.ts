import { randomUUID } from 'node:crypto';

import {
  PROCESS_EXPORT_MESSAGES,
  SAVED_VIEW_MESSAGES,
  problemDetailsSchema,
  processListResponseSchema,
  savedViewSchema,
} from '@contrataflow/validation';
import type { SavedViewDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { z } from 'zod';

import { CACHE_STORE, InMemoryCacheStore } from '#shared/cache/cache-store.js';
import type { CacheStore } from '#shared/cache/cache-store.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
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
  assignRole,
  assignDepartment,
  seedCustomRole,
  seedDefaultRolesOf,
} from '../../../../test/support/structure-fixtures.js';
import { PROCESS_CLOCK } from '../application/ports.js';
import type { ProcessListRow } from '../application/ports.js';
import type { AccessGrant } from '../domain/process-runtime-records.js';
import type { Process } from '../domain/process.js';
import { InMemorySavedViewRepository } from '../infrastructure/saved-view.repositories.js';

/*
 * US-003 — PRC-34..38 pelo pipeline HTTP completo (autenticação, tenant, vínculo, autorização,
 * idempotência, precondição, rate limit, filtro RFC 9457) com a identidade fake, os seeders reais e
 * os repositórios em memória. As 8 categorias do Gherkin. Personas: Patrícia = Lúcia (GESTOR,
 * TENANT); Ana (REQUISITANTE, OWN_DEPARTMENTS no Setor de Manutenção) faz também o papel de
 * Tatiane (sem PROCESS_EXPORT); Luciana = Marta (ADMIN_ORGAO + CONTROLE_INTERNO, TENANT); Rafaela
 * = Otávio (ADMIN_ORGAO + perfil personalizado com PROCESS_VIEW e PROCESS_EXPORT, sem POL-09).
 * O mesmo sobre PostgreSQL (SQL,
 * cursor, RLS e índices) em `test/tenant-leak/saved-views.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const NOW = new Date('2026-10-05T17:32:00.000Z');

const ORG_A = '0192d003-0000-7000-8000-0000000000a0';
const ORG_B = '0192d003-0000-7000-8000-0000000000b0';
const UNITS_A = {
  organizationId: ORG_A,
  obras: '0192d003-0000-7000-8000-0000000000a1',
  manutencao: '0192d003-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d003-0000-7000-8000-0000000000a3',
  saude: '0192d003-0000-7000-8000-0000000000a4',
  posto: '0192d003-0000-7000-8000-0000000000a5',
};
const UNITS_B = {
  organizationId: ORG_B,
  obras: '0192d003-0000-7000-8000-0000000000b1',
  manutencao: '0192d003-0000-7000-8000-0000000000b2',
  pavimentacao: '0192d003-0000-7000-8000-0000000000b3',
  saude: '0192d003-0000-7000-8000-0000000000b4',
  posto: '0192d003-0000-7000-8000-0000000000b5',
};

const P12 = '0192d003-0000-7000-8000-000000000012';
const P31 = '0192d003-0000-7000-8000-000000000031';
const P50 = '0192d003-0000-7000-8000-000000000050';
const P_B = '0192d003-0000-7000-8000-0000000000ff';
const VIEW_B = '0192d003-0000-7000-8000-00000000bbbb';
const FORMULA_TITLE = '=HYPERLINK("http://x.io";"Clique")';

const membershipOf = (userId: string, tenantId = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

const dept = (departmentId: string, reason: 'REQUESTING' | 'CURRENT') =>
  ({ principalType: 'DEPARTMENT', departmentId, reason }) as AccessGrant;
const user = (userId: string, reason: 'RESPONSIBLE') =>
  ({ principalType: 'USER', userId, reason }) as AccessGrant;

/** Cache da API com a trava da exportação controlável (ocupada ou Redis fora). */
class ExportLockCache extends InMemoryCacheStore implements CacheStore {
  mode: 'normal' | 'busy' | 'down' = 'normal';

  override async setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    if (key.includes(':process-export:')) {
      if (this.mode === 'down') throw new Error('ECONNREFUSED');
      if (this.mode === 'busy') return false;
    }
    return super.setIfAbsent(key, value, ttlSeconds);
  }
}

const SUBJECT = {
  patricia: 'sub-lucia',
  tatiane: 'sub-ana',
  ana: 'sub-ana',
  luciana: 'sub-marta',
  rafaela: 'sub-otavio',
} as const;

describe('Feature: Visões salvas e exportação CSV da lista de processos (US-003)', () => {
  let api: TestApi;
  let warn: MockInstance<Logger['warn']>;
  let error: MockInstance<Logger['error']>;
  const cache = new ExportLockCache();
  let stageIds: Map<string, { id: string; versionId: string }>;
  let base: Omit<Process, 'id' | 'number' | 'code' | 'title' | 'status' | 'priority'>;

  const auth = (call: request.Test, subject: string, tenantId: string = A) =>
    call
      .set('Authorization', api.bearer(subject, { amr: ['pwd', 'otp'] }))
      .set('X-Tenant-Id', tenantId);
  const listViews = (subject: string = SUBJECT.patricia, tenantId: string = A) =>
    auth(request(api.server).get('/api/v1/saved-views?scope=PROCESS_LIST'), subject, tenantId);
  const createView = (
    body: Record<string, unknown>,
    subject: string = SUBJECT.patricia,
    key: string = randomUUID(),
  ) =>
    auth(request(api.server).post('/api/v1/saved-views'), subject)
      .set('Idempotency-Key', key)
      .send({ scope: 'PROCESS_LIST', filters: { v: 1 }, columns: ['code', 'title'], ...body });
  const patchView = (
    id: string,
    body: Record<string, unknown>,
    version: number | null,
    subject: string = SUBJECT.patricia,
  ) => {
    const call = auth(request(api.server).patch(`/api/v1/saved-views/${id}`), subject).send(body);
    return version === null ? call : call.set('If-Match', `"${version}"`);
  };
  const deleteView = (id: string, version: number, subject: string = SUBJECT.patricia) =>
    auth(request(api.server).delete(`/api/v1/saved-views/${id}`), subject).set(
      'If-Match',
      `"${version}"`,
    );
  const exportCsv = (query: string, subject: string = SUBJECT.patricia) =>
    auth(request(api.server).get(`/api/v1/processes/export${query}`), subject).buffer(true);
  const expectProblem = (response: request.Response, status: number, code: string) => {
    expect(response.status, JSON.stringify(response.body)).toBe(status);
    const body = problemDetailsSchema.parse(response.body);
    expect(body.code).toBe(code);
    return body;
  };
  const viewOf = (response: request.Response): SavedViewDto => {
    expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
    return z.object({ data: savedViewSchema }).parse(response.body).data;
  };
  const viewsOf = (response: request.Response): SavedViewDto[] => {
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return z.object({ data: z.array(savedViewSchema) }).parse(response.body).data;
  };
  const csvLines = (response: request.Response) => {
    expect(response.status, response.text).toBe(200);
    return response.text.split('\r\n').slice(0, -1);
  };
  const exportAudits = () => api.auditRecords().filter((row) => row.action === 'process.export');
  const savedViews = () => api.app.get(InMemorySavedViewRepository, { strict: false });

  const processAt = (
    id: string,
    number: number,
    fields: Partial<Process> & { stageKey: string },
  ): Process => {
    const stage = stageIds.get(fields.stageKey);
    if (!stage) throw new Error(`etapa ${fields.stageKey} ausente`);
    const { stageKey: _stageKey, ...rest } = fields;
    return {
      ...base,
      id,
      number,
      code: `${String(number).padStart(4, '0')}/2026`,
      title: `Processo ${String(number)}`,
      status: 'IN_PROGRESS',
      priority: 'MEDIUM',
      workflowVersionId: stage.versionId,
      currentWorkflowStageId: stage.id,
      ...rest,
    };
  };

  /** Background: 137 processos IN_PROGRESS/RETURNED, o 0031/2026 sigiloso, e um de B. */
  function seedBackground(target: TestApi): void {
    const repository = processRepositoryOf(target);
    const grants = [dept(UNITS_A.manutencao, 'REQUESTING'), dept(UNITS_A.manutencao, 'CURRENT')];
    repository.seed(
      processAt(P12, 12, {
        stageKey: 'PESQUISA_PRECOS',
        title: 'Aquisição de cimento para manutenção de vias',
        priority: 'HIGH',
        estimatedValue: '85000.00',
      }),
      grants,
    );
    repository.seed(
      processAt(P31, 31, {
        stageKey: 'ESTUDOS_PRELIMINARES',
        title: 'Contratação de limpeza hospitalar',
        status: 'RETURNED',
        currentResponsibleId: FAKE_USERS.ana.id,
        isBudgetConfidential: true,
        estimatedValue: '1200000.00',
      }),
      [...grants, user(FAKE_USERS.ana.id, 'RESPONSIBLE')],
    );
    repository.seed(
      processAt(P50, 50, { stageKey: 'ABERTURA', title: FORMULA_TITLE, estimatedValue: null }),
      grants,
    );
    for (let index = 0; index < 134; index += 1) {
      const number = 100 + index;
      repository.seed(
        processAt(`0192d003-0000-7000-8000-0000000${String(number).padStart(5, '0')}`, number, {
          stageKey: 'ABERTURA',
          requestingSecretariatId: UNITS_A.saude,
          requestingDepartmentId: UNITS_A.posto,
          currentDepartmentId: UNITS_A.posto,
        }),
        [dept(UNITS_A.posto, 'REQUESTING'), dept(UNITS_A.posto, 'CURRENT')],
      );
    }
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
    savedViews().seed({
      id: VIEW_B,
      tenantId: B,
      ownerId: FAKE_USERS.heitor.id,
      scope: 'PROCESS_LIST',
      name: 'V1',
      filters: { v: 1 },
      sort: null,
      columns: ['code', 'title'],
      isShared: true,
      isDefault: false,
      createdAt: NOW,
      updatedAt: NOW,
      createdById: FAKE_USERS.heitor.id,
      updatedById: FAKE_USERS.heitor.id,
      version: 1,
    });
  }

  async function prepare(target: TestApi): Promise<void> {
    await runTenantSeeders(target, A);
    seedProcessStructure(target, A, { ...UNITS_A, shortName: 'PMSJ', cnpj: '11222333000181' });
    seedProcessStructure(target, B, { ...UNITS_B, shortName: 'PMB', cnpj: '60746948000112' });
    assignDepartment(target, membershipOf(FAKE_USERS.ana.id), UNITS_A.manutencao);
    const roles = seedDefaultRolesOf(target, A);
    assignRole(target, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.marta.id),
      roleId: roles.get('CONTROLE_INTERNO')?.id ?? '',
    });
    const exporter = seedCustomRole(target, A, 'Exportação sem sigilo', [
      'PROCESS_VIEW',
      'PROCESS_EXPORT',
    ]);
    assignRole(target, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.otavio.id),
      roleId: exporter.id,
    });
    // Fábio vê o tenant todo, mas só exporta o que o escopo de unidade cobre.
    const reader = seedCustomRole(target, A, 'Leitura ampla', ['PROCESS_VIEW']);
    const unitExporter = seedCustomRole(target, A, 'Exportação da unidade', ['PROCESS_EXPORT']);
    assignRole(target, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.fabio.id),
      roleId: reader.id,
    });
    assignRole(target, {
      tenantId: A,
      membershipId: membershipOf(FAKE_USERS.fabio.id),
      roleId: unitExporter.id,
      scopeType: 'DEPARTMENT',
      scopeDepartmentId: UNITS_A.manutencao,
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
    error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    api = await createTestApi({
      providers: [
        { token: CACHE_STORE, value: cache },
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
  beforeEach(() => {
    cache.mode = 'normal';
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('[Sucesso]', () => {
    it('Salvar visão e usá-la como padrão: 201 com ETag "1" e a padrão anterior desmarcada', async () => {
      const previous = viewOf(await createView({ name: 'Minha fila', isDefault: true }));
      expect(previous.isDefault).toBe(true);

      const response = await createView({
        name: 'Atrasados por prioridade',
        filters: { v: 1, overdue: true },
        sort: '-priority',
        columns: ['code', 'title', 'status', 'deadline'],
        isDefault: true,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.headers.etag).toBe('"1"');
      const view = viewOf(response);
      expect(response.headers.location).toBe(`/api/v1/saved-views/${view.id}`);
      expect(view).toMatchObject({
        name: 'Atrasados por prioridade',
        scope: 'PROCESS_LIST',
        filters: { v: 1, overdue: true },
        sort: '-priority',
        columns: ['code', 'title', 'status', 'deadline'],
        isDefault: true,
        isShared: false,
        isOwner: true,
        owner: { id: FAKE_USERS.lucia.id },
        version: 1,
      });

      const views = viewsOf(await listViews());
      const defaults = views.filter((item) => item.isOwner && item.isDefault);
      expect(defaults.map((item) => item.name)).toEqual(['Atrasados por prioridade']);
      expect(views.find((item) => item.id === previous.id)?.version).toBe(2);
    });

    it('Visão compartilhada: aparece para Ana como somente leitura e ela vê só o que o predicado permite', async () => {
      const shared = viewOf(
        await createView({
          name: 'Devolvidos da Saúde',
          filters: { v: 1, status: ['RETURNED', 'IN_PROGRESS'] },
          isShared: true,
        }),
      );
      const forAna = viewsOf(await listViews(SUBJECT.ana)).find((item) => item.id === shared.id);
      expect(forAna).toMatchObject({ isOwner: false, isShared: true });
      expect(forAna?.owner.name).not.toBe('');
      // O seletor aplica os critérios em PRC-01: o resultado é o de Ana (só as lotações dela).
      const asAna = await auth(
        request(api.server).get('/api/v1/processes?status=RETURNED,IN_PROGRESS&pageSize=100'),
        SUBJECT.ana,
      );
      const codes = processListResponseSchema.parse(asAna.body).data.map((item) => item.code);
      expect(codes.sort()).toEqual(['0012/2026', '0031/2026', '0050/2026']);
      // Ana não renomeia nem exclui a visão de Patrícia.
      expectProblem(
        await patchView(shared.id, { name: 'Minha' }, 1, SUBJECT.ana),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(await deleteView(shared.id, 1, SUBJECT.ana), 403, 'PERMISSION_DENIED');
      // V-06: torná-la padrão pede uma cópia.
      const asDefault = expectProblem(
        await patchView(shared.id, { isDefault: true }, 1, SUBJECT.ana),
        422,
        'VALIDATION_ERROR',
      );
      expect(asDefault.errors[0]?.message).toBe(SAVED_VIEW_MESSAGES.sharedDefault);
      // "Salvar como minha": cópia pelo PRC-36.
      const copy = viewOf(
        await createView(
          { name: 'Devolvidos da Saúde', filters: shared.filters, isDefault: true },
          SUBJECT.ana,
        ),
      );
      expect(copy).toMatchObject({ isOwner: true, isDefault: true });
    });

    it('Exportar CSV com mascaramento e auditoria (Rafaela sem POL-09; Luciana com)', async () => {
      const query =
        '?status=IN_PROGRESS,RETURNED&sort=code&columns=code,title,status,estimatedValue';
      const response = await exportCsv(query, SUBJECT.rafaela);
      const lines = csvLines(response);
      expect(lines).toHaveLength(138);
      expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(response.headers['content-disposition']).toBe(
        'attachment; filename="processos-20261005-1432.csv"',
      );
      expect(response.text.charCodeAt(0)).toBe(0xfeff);
      expect(lines[0]).toBe('﻿Código;Título;Situação;Valor estimado;Orçamento sigiloso');
      expect(lines).toContain(
        '0012/2026;Aquisição de cimento para manutenção de vias;Em andamento;85000,00;Não',
      );
      expect(lines).toContain('0031/2026;Contratação de limpeza hospitalar;Devolvido;Sigiloso;Sim');
      expect(response.text).not.toContain('1200000');

      const audit = exportAudits().at(-1);
      expect(audit).toMatchObject({ result: 'SUCCESS', actorUserId: FAKE_USERS.otavio.id });
      expect(audit?.metadata).toMatchObject({
        rowCount: 137,
        maskedRowCount: 1,
        columns: ['code', 'title', 'status', 'estimatedValue'],
        sort: 'code',
        filters: { status: ['IN_PROGRESS', 'RETURNED'] },
      });
      expect(JSON.stringify(audit)).not.toContain('1200000');

      const asLuciana = csvLines(await exportCsv(query, SUBJECT.luciana));
      expect(asLuciana).toContain(
        '0031/2026;Contratação de limpeza hospitalar;Devolvido;1200000,00;Sim',
      );
      expect(exportAudits().at(-1)?.metadata).toMatchObject({ rowCount: 137, maskedRowCount: 0 });
    });

    it('Sem `columns`: as colunas padrão da lista, com rótulos e as duas colunas do prazo', async () => {
      const [header] = csvLines(await exportCsv('?q=cimento'));
      expect(header).toBe(
        '﻿Código;Título;Situação;Etapa;Unidade atual;Responsável;Prazo da etapa;Situação do prazo;Prioridade',
      );
    });
  });

  describe('[Validação]', () => {
    it('Conteúdo que planilhas interpretariam como fórmula é neutralizado', async () => {
      const lines = csvLines(
        await exportCsv('?columns=code,title,status,estimatedValue&sort=code'),
      );
      const line = lines.find((item) => item.startsWith('0050/2026'));
      expect(line).toBe('0050/2026;"\'=HYPERLINK(""http://x.io"";""Clique"")";Em andamento;;Não');
      for (const row of lines.slice(1)) {
        for (const cell of row.split(';')) {
          expect(cell.replace(/^"/, '')).not.toMatch(/^[=+\-@]/);
        }
      }
    });

    it('Nome com 81 caracteres → 422 no campo "name"', async () => {
      const body = expectProblem(
        await createView({ name: 'x'.repeat(81) }),
        422,
        'VALIDATION_ERROR',
      );
      expect(body.errors[0]).toMatchObject({ field: 'name', message: SAVED_VIEW_MESSAGES.name });
    });

    it('Filtros fora do contrato e colunas sem code/title → 422', async () => {
      expectProblem(
        await createView({ name: 'F', filters: { status: ['DRAFT'] } }),
        422,
        'VALIDATION_ERROR',
      );
      expectProblem(
        await createView({ name: 'F', filters: { v: 1, foo: 1 } }),
        422,
        'VALIDATION_ERROR',
      );
      expectProblem(await createView({ name: 'C', columns: ['status'] }), 422, 'VALIDATION_ERROR');
      expectProblem(await exportCsv('?status=ABERTO'), 422, 'VALIDATION_ERROR');
    });

    it('Exportação acima do limite: 422 EXPORT_TOO_LARGE com meta.totalItems e sem arquivo nem auditoria', async () => {
      const repository = processRepositoryOf(api);
      const spy = vi.spyOn(repository, 'countForExport').mockResolvedValueOnce(10_240);
      const before = exportAudits().length;
      const response = await exportCsv('');
      const body = expectProblem(response, 422, 'EXPORT_TOO_LARGE');
      expect(body.detail).toBe(PROCESS_EXPORT_MESSAGES.tooLarge(10_240));
      expect((response.body as { meta?: unknown }).meta).toEqual({ totalItems: 10_240 });
      expect(response.headers['content-disposition']).toBeUndefined();
      expect(exportAudits()).toHaveLength(before);
      expect(warn).toHaveBeenCalledWith(
        { event: 'process.export_too_large', totalItems: 10_240 },
        'process.export_too_large',
      );
      spy.mockRestore();
    });

    it('Limite de 20 visões por dono e escopo', async () => {
      for (let index = 0; index < 20; index += 1) {
        expect(
          (await createView({ name: `Limite ${String(index)}` }, SUBJECT.rafaela)).status,
        ).toBe(201);
      }
      const body = expectProblem(
        await createView({ name: 'Limite 21' }, SUBJECT.rafaela),
        422,
        'VALIDATION_ERROR',
      );
      expect(body.errors[0]?.message).toBe(SAVED_VIEW_MESSAGES.limitReached);
    });
  });

  describe('[Permissão]', () => {
    it('Usuário sem PROCESS_EXPORT → 403 e access.denied com reasonCode PROCESS_EXPORT', async () => {
      const response = await exportCsv('', SUBJECT.tatiane);
      expectProblem(response, 403, 'PERMISSION_DENIED');
      const denied = api
        .auditRecords()
        .filter((row) => row.action === 'access.denied' && row.actorUserId === FAKE_USERS.ana.id)
        .at(-1);
      expect(denied).toMatchObject({ result: 'DENIED', reasonCode: 'PROCESS_EXPORT' });
    });

    it('RN-PROC-40: linhas = visíveis E cobertas pelo escopo de PROCESS_EXPORT', async () => {
      const visible = await auth(
        request(api.server).get('/api/v1/processes?pageSize=1'),
        'sub-fabio',
      );
      expect(processListResponseSchema.parse(visible.body).meta.totalItems).toBe(137);
      const lines = csvLines(await exportCsv('?columns=code,title&sort=code', 'sub-fabio'));
      expect(lines.slice(1).map((line) => line.split(';')[0])).toEqual([
        '0012/2026',
        '0031/2026',
        '0050/2026',
      ]);
    });

    it('Alterar visão de outro usuário: compartilhada → 403 (auditado); privada → 404', async () => {
      const shared = viewOf(
        await createView({ name: 'Devolvidos (compartilhada)', isShared: true }),
      );
      const own = viewOf(await createView({ name: 'Minha fila privada' }));
      expectProblem(
        await patchView(shared.id, { name: 'X' }, 1, SUBJECT.tatiane),
        403,
        'PERMISSION_DENIED',
      );
      expect(
        api
          .auditRecords()
          .filter((row) => row.action === 'access.denied' && row.entityId === shared.id),
      ).toHaveLength(1);
      expectProblem(await patchView(own.id, { name: 'X' }, 1, SUBJECT.tatiane), 404, 'NOT_FOUND');
      expect(
        savedViews()
          .snapshot()
          .find((view) => view.id === own.id)?.name,
      ).toBe('Minha fila privada');
    });

    it('Escopo INBOX (INBOX_VIEW) é separado do PROCESS_LIST', async () => {
      viewOf(await createView({ name: 'Só da caixa', scope: 'INBOX' }));
      expect(viewsOf(await listViews()).map((view) => view.name)).not.toContain('Só da caixa');
      const inbox = await auth(
        request(api.server).get('/api/v1/saved-views?scope=INBOX'),
        SUBJECT.patricia,
      );
      expect(viewsOf(inbox).map((view) => view.name)).toEqual(['Só da caixa']);
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Visão de outro tenant → 404 em PATCH/DELETE e ausente da listagem', async () => {
      expectProblem(await patchView(VIEW_B, { name: 'X' }, 1), 404, 'NOT_FOUND');
      expectProblem(await deleteView(VIEW_B, 1), 404, 'NOT_FOUND');
      expect(viewsOf(await listViews()).map((view) => view.id)).not.toContain(VIEW_B);
      const lines = csvLines(await exportCsv('?columns=code,title'));
      expect(lines.join('\n')).not.toContain('LEAK-B');
    });
  });

  describe('[Duplicidade]', () => {
    it('Nome repetido sem diferenciar maiúsculas → 409; reenvio com a mesma chave → mesma visão', async () => {
      viewOf(await createView({ name: 'Duplicada por prioridade' }));
      const conflict = expectProblem(
        await createView({ name: 'duplicada por PRIORIDADE' }),
        409,
        'CONFLICT',
      );
      expect(conflict.detail).toBe(SAVED_VIEW_MESSAGES.nameTaken);

      const key = randomUUID();
      const first = await createView({ name: 'Idempotente' }, SUBJECT.patricia, key);
      const replay = await createView({ name: 'Idempotente' }, SUBJECT.patricia, key);
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(viewOf(replay).id).toBe(viewOf(first).id);
    });
  });

  describe('[Concorrência]', () => {
    it('Mesma visão alterada em duas abas → 412 VERSION_CONFLICT; If-Match ausente → 428', async () => {
      const view = viewOf(await createView({ name: 'Duas abas' }));
      const first = await patchView(view.id, { sort: '-priority' }, 1);
      expect(viewOf(first).version).toBe(2);
      expect(first.headers.etag).toBe('"2"');
      expectProblem(await patchView(view.id, { sort: 'code' }, 1), 412, 'VERSION_CONFLICT');
      expectProblem(await patchView(view.id, { sort: 'code' }, null), 428, 'PRECONDITION_REQUIRED');
      // PATCH idêntico: sem nova versão.
      expect(viewOf(await patchView(view.id, { sort: '-priority' }, 2)).version).toBe(2);
      expect((await deleteView(view.id, 2)).status).toBe(204);
      expectProblem(await deleteView(view.id, 2), 404, 'NOT_FOUND');
    });

    it('Duas visões marcadas como padrão em paralelo → só uma permanece padrão', async () => {
      await Promise.all([
        createView({ name: 'Paralela A', isDefault: true }, SUBJECT.luciana),
        createView({ name: 'Paralela B', isDefault: true }, SUBJECT.luciana),
      ]);
      const defaults = viewsOf(await listViews(SUBJECT.luciana)).filter((view) => view.isDefault);
      expect(defaults).toHaveLength(1);
    });

    it('Segunda exportação simultânea do mesmo usuário → 429 com Retry-After', async () => {
      cache.mode = 'busy';
      const response = await exportCsv('');
      const body = expectProblem(response, 429, 'RATE_LIMITED');
      expect(body.detail).toBe(PROCESS_EXPORT_MESSAGES.inProgress);
      expect(response.headers['retry-after']).toBe('30');
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco cai durante o envio: conexão encerrada sem concluir e auditoria FAILURE', async () => {
      const repository = processRepositoryOf(api);
      const real = repository.exportCursor.bind(repository);
      const spy = vi.spyOn(repository, 'exportCursor').mockImplementation((search, size) => {
        const cursor = real(search, size);
        let batches = 0;
        let first: readonly ProcessListRow[] = [];
        return {
          open: (tx) => cursor.open(tx),
          next: async (tx) => {
            batches += 1;
            if (batches === 1) first = await cursor.next(tx);
            if (batches > 8) throw new DatabaseUnavailableError(new Error('connection lost'));
            return first;
          },
        };
      });
      const before = exportAudits().length;
      const outcome = await exportCsv('?columns=code,title').then(
        (response) => ({ ok: true, text: response.text }),
        (failure: unknown) => ({ ok: false, failure }),
      );
      // O arquivo nunca chega completo: o cliente vê a conexão abortada.
      expect(outcome.ok).toBe(false);
      await vi.waitFor(() => {
        expect(exportAudits().length).toBe(before + 1);
      });
      expect(exportAudits().at(-1)).toMatchObject({
        result: 'FAILURE',
        reasonCode: 'DEPENDENCY_UNAVAILABLE',
      });
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'process.export_failed',
          errorCode: 'DEPENDENCY_UNAVAILABLE',
        }),
        'process.export_failed',
      );
      spy.mockRestore();
    });

    it('Banco indisponível antes do envio → 503 DEPENDENCY_UNAVAILABLE, sem auditoria', async () => {
      const repository = processRepositoryOf(api);
      const spy = vi
        .spyOn(repository, 'countForExport')
        .mockRejectedValueOnce(new DatabaseUnavailableError(new Error('down')));
      const before = exportAudits().length;
      expectProblem(await exportCsv(''), 503, 'DEPENDENCY_UNAVAILABLE');
      expect(exportAudits()).toHaveLength(before);
      spy.mockRestore();
    });
  });

  describe('[Falha de integração]', () => {
    it('Redis indisponível: exportação concluída sem a trava e warn export.lock_unavailable', async () => {
      cache.mode = 'down';
      const lines = csvLines(await exportCsv('?columns=code,title&status=RETURNED'));
      expect(lines.slice(1)).toEqual(['0031/2026;Contratação de limpeza hospitalar']);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'export.lock_unavailable' }),
        'export.lock_unavailable',
      );
      expect(exportAudits().at(-1)).toMatchObject({ result: 'SUCCESS' });
    });
  });
});
