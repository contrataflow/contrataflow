import { randomUUID } from 'node:crypto';

import { PERMISSIONS } from '@contrataflow/types';
import type { AiGenerationStatus } from '@contrataflow/types';
import {
  aiAvailabilitySchema,
  aiUsageSchema,
  problemDetailsSchema,
  settingsWithMetaResponseSchema,
} from '@contrataflow/validation';
import type { AiAvailabilityDto, AiUsageDto, SettingsMapDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import {
  SETTINGS_TRANSACTIONS,
  TestAiGenerator,
  replaceAiGenerator,
  aiRepositoryOf,
  jobQueueOf,
  rolesGrantingAiGenerate,
  runAiJob,
  validOutput,
} from '../../../../test/support/ai-fixtures.js';
import type { SettingsTransactions } from '../../../../test/support/ai-fixtures.js';
import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import {
  createDocumentAs,
  documentTypeRepositoryOf,
} from '../../../../test/support/document-fixtures.js';
import type { FixtureActor } from '../../../../test/support/document-fixtures.js';
import {
  catalogItemId,
  runTenantSeeders,
  seedProcessStructure,
} from '../../../../test/support/process-fixtures.js';
import { seedDefaultRolesOf } from '../../../../test/support/structure-fixtures.js';
import type { AiGeneratorCheck, AiGeneratorRequest } from '../application/ai-generator.js';
import { AI_PROVIDER } from '../application/ai-provider.port.js';
import { AI_CLOCK, AI_SETTINGS, AI_TRANSACTIONS } from '../application/ports.js';
import type { AiSettings, AiTransactions } from '../application/ports.js';
import { requestGeneration } from '../domain/ai-generation.js';
import type { AiGeneration } from '../domain/ai-generation.js';
import { FakeAiProvider } from '../infrastructure/fake-ai.provider.js';
import { runWithTenantLocks } from '../infrastructure/in-memory-ai-generation.repository.js';

/*
 * US-116 — IA no órgão: ativação com aceite dos termos (SET-02), portão do órgão no AI-01 e no job
 * (reserva de tokens, limite mensal e diário, trava por tenant), avisos de 80%/100% e AI-05/AI-06,
 * pelo pipeline HTTP completo com a identidade fake, os seeders reais e o `FakeAiProvider` (nenhuma
 * chamada real). O portão é o REAL (`AiTenantGateService`, registrado pelo módulo); o gerador é o
 * de teste (os reais chegam com US-117..121). PostgreSQL real (RLS, `pg_advisory_xact_lock`):
 * `test/tenant-leak/ai-usage.spec.ts`.
 *
 * Personas: "Marina" (ADMIN_ORGAO, SETTINGS_MANAGE) = Marta; "Carla" (AI_GENERATE, custódia do
 * DFD) = Lúcia (GESTOR_CONTRATACOES); "Bruno" sem SETTINGS_MANAGE = Lúcia; CONSULTOR_EXTERNO =
 * Carla Dias. O relógio da IA é controlado: cada teste usa um mês próprio (consumo isolado).
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const TERMS = '2026-10';
const SUMMARY = 'Aquisição de 30 computadores para os laboratórios das escolas municipais.';
const MFA = ['pwd', 'otp'];
const ORG_A = '0192d116-0000-7000-8000-0000000000a0';
const UNITS_A = {
  organizationId: ORG_A,
  obras: '0192d116-0000-7000-8000-0000000000a1',
  manutencao: '0192d116-0000-7000-8000-0000000000a2',
  pavimentacao: '0192d116-0000-7000-8000-0000000000a3',
  saude: '0192d116-0000-7000-8000-0000000000a4',
  posto: '0192d116-0000-7000-8000-0000000000a5',
};

const membershipOf = (userId: string, tenantId = A) =>
  FAKE_MEMBERSHIPS.find((m) => m.userId === userId && m.tenantId === tenantId)?.id ?? '';

const LUCIA: FixtureActor = {
  tenantId: A,
  userId: FAKE_USERS.lucia.id,
  membershipId: membershipOf(FAKE_USERS.lucia.id),
};

/** Transações da IA com a trava por tenant em memória e falha simulada do banco. */
class LockingTransactions implements AiTransactions {
  down = false;

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    if (this.down) return Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED')));
    return runWithTenantLocks(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return this.run(work);
  }
}

/** Configurações do tenant com o banco fora do ar sob demanda (Falha de banco do SET-02). */
class FlakySettingsTransactions implements SettingsTransactions {
  down = false;

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    if (this.down) return Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED')));
    return runSimulatedTransaction(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runSimulatedTransaction(work);
  }
}

/**
 * Gerador de teste com a estimativa de reserva ajustável (DFD 15 mil, ETP 40 mil, ajuste 6 mil) e
 * uma pausa opcional ENTRE o portão e a inserção (força a intercalação de pedidos simultâneos).
 */
class SizedAiGenerator extends TestAiGenerator {
  override reservedTokens = 15_000;
  pauseMs = 0;
  entered = 0;

  override async validateRequest(
    tx: TenantTx,
    request: AiGeneratorRequest,
  ): Promise<AiGeneratorCheck> {
    this.entered += 1;
    if (this.pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, this.pauseMs));
    return super.validateRequest(tx, request);
  }
}

function expectProblem(response: request.Response, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  const body = problemDetailsSchema.parse(response.body);
  expect(body.code).toBe(code);
  return body;
}

describe('Feature: Configurar a IA no órgão: ativação, limites e consumo (US-116)', () => {
  let api: TestApi;
  const generator = new SizedAiGenerator();
  const provider = new FakeAiProvider();
  const transactions = new LockingTransactions();
  const settingsTx = new FlakySettingsTransactions();
  const clock = { now: new Date('2026-01-15T15:00:00Z') };
  const settings: AiSettings = {
    provider: 'fake',
    models: { draft: 'fake-draft-1', section: 'fake-section-1' },
    requestTimeoutMs: 200,
    maxAttempts: 3,
    backoffBaseMs: 10_000,
    maxContextChars: 240_000,
  };
  let dfdTypeId: string;

  const words = () => randomUUID().replaceAll('-', '').slice(0, 12);

  const call = (
    method: 'get' | 'post' | 'patch',
    path: string,
    options: { subject?: string; tenant?: string; amr?: string[]; body?: object } = {},
  ) => {
    const agent = request(api.server);
    let pending = agent[method](`/api/v1${path}`)
      .set('Authorization', api.bearer(options.subject ?? 'sub-lucia', { amr: options.amr ?? MFA }))
      .set('X-Tenant-Id', options.tenant ?? A);
    if (method !== 'get') pending = pending.set('Idempotency-Key', randomUUID());
    return options.body === undefined ? pending : pending.send(options.body);
  };

  /** Processo novo (PRC-02) de Lúcia com um DFD em `DRAFT` sob a custódia dela (Background). */
  async function newDfd(): Promise<{ processId: string; documentId: string }> {
    const response = await call('post', '/processes', {
      body: {
        title: `Compra ${words()} ${words()}`,
        object: `Objeto ${words()} ${words()} ${words()}`,
        contractingTypeId: catalogItemId(api, A, 'CONTRACTING_TYPE', 'AQUISICAO_BENS'),
        requestingSecretariatId: UNITS_A.obras,
        requestingDepartmentId: UNITS_A.manutencao,
        originId: catalogItemId(api, A, 'PROCESS_ORIGIN', 'DEMANDA_NAO_PREVISTA'),
        pcaStatus: 'NOT_APPLICABLE',
      },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const processId = (response.body as { data: { id: string } }).data.id;
    const document = await createDocumentAs(api, LUCIA, {
      processId,
      documentTypeId: dfdTypeId,
      title: 'DFD dos laboratórios',
      templateVersionId: null,
    });
    return { processId, documentId: document.id };
  }

  const requestDraft = (target: { processId: string; documentId: string }, subject?: string) =>
    call('post', `/processes/${target.processId}/ai-generations`, {
      ...(subject === undefined ? {} : { subject }),
      body: {
        targetModule: 'DFD',
        kind: 'DRAFT',
        documentId: target.documentId,
        needSummary: SUMMARY,
      },
    });

  async function requested(target: { processId: string; documentId: string }): Promise<string> {
    const response = await requestDraft(target);
    expect(response.status, JSON.stringify(response.body)).toBe(202);
    return (response.body as { data: { id: string } }).data.id;
  }

  const stored = (id: string): AiGeneration | undefined =>
    aiRepositoryOf(api)
      .all()
      .find((row) => row.id === id);

  /** Geração pronta no repositório (consumo do mês), criada "agora" pelo relógio da IA. */
  function seedUsage(
    fields: {
      readonly tokens?: number;
      readonly status?: AiGenerationStatus;
      readonly tenantId?: string;
      readonly userId?: string;
      readonly startedAt?: Date | null;
      readonly errorCode?: AiGeneration['errorCode'];
      readonly reservedTokens?: number;
      readonly costUsd?: string | null;
    } = {},
  ): AiGeneration {
    const base = requestGeneration({
      id: newId(),
      tenantId: fields.tenantId ?? A,
      processId: newId(),
      documentId: newId(),
      targetModule: 'DFD',
      kind: 'DRAFT',
      action: null,
      sectionKey: null,
      baseRevision: null,
      needSummary: null,
      instruction: null,
      provider: 'fake',
      promptKey: 'test.draft',
      promptVersion: '1.0.0',
      reservedTokens: fields.reservedTokens ?? 15_000,
      createdById: fields.userId ?? FAKE_USERS.lucia.id,
      now: clock.now,
    });
    const tokens = fields.tokens ?? 0;
    const generation: AiGeneration = {
      ...base,
      status: fields.status ?? 'SUCCEEDED',
      startedAt: fields.startedAt === undefined ? clock.now : fields.startedAt,
      errorCode: fields.errorCode ?? null,
      inputTokens: tokens,
      outputTokens: 0,
      totalTokens: tokens,
      costUsd: fields.costUsd === undefined ? '0.010000' : fields.costUsd,
      model: 'fake-draft-1',
    };
    aiRepositoryOf(api).seed(generation);
    return generation;
  }

  async function settingsOf(subject = 'sub-marta'): Promise<SettingsMapDto> {
    const response = await call('get', '/settings', { subject });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return settingsWithMetaResponseSchema.parse(response.body).data;
  }

  /** SET-02 com as versões lidas agora (como a SCR-041 faz). */
  async function patchSettings(
    values: Record<string, unknown>,
    options: { subject?: string; amr?: string[]; versions?: Record<string, number> } = {},
  ) {
    const current = options.versions === undefined ? await settingsOf() : null;
    const expectedVersions =
      options.versions ??
      Object.fromEntries(Object.keys(values).map((key) => [key, current?.[key]?.version ?? 0]));
    return call('patch', '/settings', {
      subject: options.subject ?? 'sub-marta',
      ...(options.amr === undefined ? {} : { amr: options.amr }),
      body: { values, expectedVersions },
    });
  }

  async function configure(values: Record<string, unknown>): Promise<void> {
    const response = await patchSettings(values);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  }

  /** IA ligada (termos vigentes) com os limites do teste. */
  const enableAi = (monthlyTokenLimit = 50_000, userDailyRequestLimit = 40) =>
    configure({
      'ai.enabled': true,
      'ai.termsAcceptedVersion': TERMS,
      'ai.monthlyTokenLimit': monthlyTokenLimit,
      'ai.userDailyRequestLimit': userDailyRequestLimit,
    });

  async function availability(subject = 'sub-lucia', query = ''): Promise<AiAvailabilityDto> {
    const response = await call('get', `/ai/availability${query}`, { subject });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return aiAvailabilitySchema.parse((response.body as { data: unknown }).data);
  }

  async function usage(query = '', subject = 'sub-marta'): Promise<AiUsageDto> {
    const response = await call('get', `/ai/usage${query}`, { subject });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return aiUsageSchema.parse((response.body as { data: unknown }).data);
  }

  const auditOf = (action: string) => api.auditRecords().filter((row) => row.action === action);
  const thresholdEvents = (month: string) =>
    api
      .outboxRows()
      .filter(
        (row) =>
          row.eventType === 'AiUsageThresholdReached' &&
          (row.payload as { month: string }).month === month,
      );

  /** Cada teste num mês próprio: o consumo derivado não vaza entre testes. */
  let monthSeq = 0;
  const nextMonth = () => {
    monthSeq += 1;
    const year = 2026 + Math.floor((monthSeq - 1) / 12);
    const month = ((monthSeq - 1) % 12) + 1;
    clock.now = new Date(Date.UTC(year, month - 1, 15, 15, 0, 0));
    return `${String(year)}-${String(month).padStart(2, '0')}`;
  };

  beforeAll(async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    api = await createTestApi({
      providers: [
        { token: AI_PROVIDER, value: provider },
        { token: AI_SETTINGS, value: settings },
        { token: AI_TRANSACTIONS, value: transactions },
        { token: AI_CLOCK, value: () => clock.now },
        { token: SETTINGS_TRANSACTIONS, value: settingsTx },
      ],
    });
    await runTenantSeeders(api, A);
    await runTenantSeeders(api, B, ['catalog.items', 'access.defaultRoles']);
    seedProcessStructure(api, A, { ...UNITS_A, shortName: 'PMSJ', cnpj: '11222333000181' });
    seedDefaultRolesOf(api, A);
    dfdTypeId =
      documentTypeRepositoryOf(api)
        .snapshot()
        .find((type) => type.tenantId === A && type.code === 'DFD')?.id ?? '';
    expect(dfdTypeId).not.toBe('');
    replaceAiGenerator(api, generator);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await api.close();
  });

  beforeEach(() => {
    provider.reset();
    nextMonth();
  });

  afterEach(async () => {
    api.rateLimitStore.reset();
    transactions.down = false;
    settingsTx.down = false;
    generator.reservedTokens = 15_000;
    generator.pauseMs = 0;
    await configure({ 'ai.enabled': false });
  });

  describe('[Sucesso]', () => {
    it('Ligar a IA aceitando os termos: 200, auditoria com a versão, TenantSettingsChanged e AI-05 imediato', async () => {
      const response = await patchSettings({
        'ai.enabled': true,
        'ai.termsAcceptedVersion': TERMS,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const data = (response.body as { data: SettingsMapDto }).data;
      expect(data['ai.enabled']?.value).toBe(true);
      expect(data['ai.termsAcceptedVersion']?.value).toBe(TERMS);

      const audits = auditOf('settings.update').filter((row) =>
        JSON.stringify(row.changes ?? []).includes('ai.termsAcceptedVersion'),
      );
      expect(audits.at(-1)?.changes).toEqual([
        { path: 'ai.termsAcceptedVersion', old: null, new: TERMS },
      ]);
      const changed = api
        .outboxRows()
        .filter((row) => row.eventType === 'TenantSettingsChanged')
        .at(-1);
      expect(changed?.payload).toEqual({ keys: ['ai.enabled', 'ai.termsAcceptedVersion'] });

      const now = await availability();
      expect(now).toMatchObject({ enabled: true, providerAvailable: true, canGenerate: true });
      expect(now.reasons).toEqual([]);

      // SET-01 traz a versão vigente dos termos e o teto da plataforma; SET-03 nunca traz ai.*.
      const full = settingsWithMetaResponseSchema.parse(
        (await call('get', '/settings', { subject: 'sub-marta' })).body,
      );
      expect(full.meta.aiTerms).toEqual({
        currentVersion: TERMS,
        provider: 'fake',
        maxMonthlyTokens: 20_000_000,
      });
      const publicSettings = await call('get', '/settings/public', { subject: 'sub-ana' });
      expect(Object.keys((publicSettings.body as { data: object }).data)).not.toContain(
        'ai.enabled',
      );
      expect(JSON.stringify(publicSettings.body)).not.toContain('"ai.');
    });

    it('Reserva de tokens e bloqueio pelo limite mensal; o consumo real substitui a reserva', async () => {
      await enableAi(50_000);
      seedUsage({ tokens: 20_000 });

      const dfd = await requested(await newDfd());
      expect(stored(dfd)).toMatchObject({ status: 'QUEUED', reservedTokens: 15_000 });

      // "ETP com 40 mil estimados": 20 mil + 15 mil reservados + 40 mil > 50 mil.
      generator.reservedTokens = 40_000;
      const before = aiRepositoryOf(api).all().length;
      expectProblem(await requestDraft(await newDfd()), 422, 'AI_USAGE_LIMIT_REACHED');
      expect(aiRepositoryOf(api).all()).toHaveLength(before);

      provider.enqueue({
        kind: 'output',
        output: validOutput(),
        usage: { inputTokens: 10_000, outputTokens: 2_400 },
      });
      await runAiJob(api, dfd);
      expect(stored(dfd)).toMatchObject({ status: 'SUCCEEDED', totalTokens: 12_400 });
      const month = await usage();
      expect(month).toMatchObject({ usedTokens: 32_400, reservedTokens: 0, limitTokens: 50_000 });
    });

    it('Aviso em 80% e em 100% do limite, uma vez por faixa', async () => {
      const month = `${String(clock.now.getUTCFullYear())}-${String(clock.now.getUTCMonth() + 1).padStart(2, '0')}`;
      await enableAi(50_000);
      seedUsage({ tokens: 39_000 });

      generator.reservedTokens = 6_000;
      const first = await requested(await newDfd());
      provider.enqueue({
        kind: 'output',
        output: validOutput(),
        usage: { inputTokens: 1_500, outputTokens: 500 },
      });
      await runAiJob(api, first);
      const [eighty] = thresholdEvents(month);
      expect(thresholdEvents(month)).toHaveLength(1);
      expect(eighty).toMatchObject({
        aggregateType: 'Tenant',
        aggregateId: A,
        processId: null,
        payload: { month, threshold: 80, usedTokens: 41_000, limitTokens: 50_000 },
      });

      const second = await requested(await newDfd());
      provider.enqueue({
        kind: 'output',
        output: validOutput(),
        usage: { inputTokens: 9_000, outputTokens: 500 },
      });
      await runAiJob(api, second);
      expect(
        thresholdEvents(month).map((row) => (row.payload as { threshold: number }).threshold),
      ).toEqual([80, 100]);
      // Pode ultrapassar o limite em até uma geração (RN-AI-18).
      expect((await usage()).usedTokens).toBe(50_500);
    });

    it('Consultar disponibilidade (AI-05) e consumo (AI-06) do mês corrente', async () => {
      await enableAi(100_000, 10);
      seedUsage({ tokens: 30_000, costUsd: '0.120000' });
      seedUsage({ tokens: 10_000, costUsd: '0.030000', userId: FAKE_USERS.fabio.id });
      seedUsage({ status: 'QUEUED', tokens: 0, reservedTokens: 15_000 });

      const forCarla = await availability();
      expect(forCarla.monthly).toEqual({ percentUsed: 40 });
      expect(forCarla.userDaily).toEqual({ used: 2, limit: 10 });
      const forAdmin = await availability('sub-marta');
      expect(forAdmin.monthly).toEqual({
        percentUsed: 40,
        usedTokens: 40_000,
        limitTokens: 100_000,
      });

      const report = await usage();
      expect(report).toMatchObject({
        limitTokens: 100_000,
        usedTokens: 40_000,
        reservedTokens: 15_000,
        costUsd: '0.150000',
        generations: { total: 3 },
      });
      expect(report.generations.byStatus).toMatchObject({ SUCCEEDED: 2, QUEUED: 1 });
      expect(report.byDocumentType).toEqual([
        { targetModule: 'DFD', generations: 3, totalTokens: 40_000, costUsd: '0.150000' },
      ]);
      expect(report.byKind).toEqual([
        { kind: 'DRAFT', action: null, generations: 3, totalTokens: 40_000 },
      ]);
      expect(report.byUser).toEqual([
        { userId: FAKE_USERS.lucia.id, name: 'Lúcia Matos', generations: 2, totalTokens: 30_000 },
        {
          userId: FAKE_USERS.fabio.id,
          name: expect.stringContaining('Nunes') as unknown,
          generations: 1,
          totalTokens: 10_000,
        },
      ]);
      // Meses anteriores continuam consultáveis; o seguinte (futuro) não.
      const [year = 0, monthNumber = 0] = report.month.split('-').map(Number);
      const previous = `${String(monthNumber === 1 ? year - 1 : year)}-${String(monthNumber === 1 ? 12 : monthNumber - 1).padStart(2, '0')}`;
      expect((await usage(`?month=${previous}`)).month).toBe(previous);
      const future = `${String(monthNumber === 12 ? year + 1 : year)}-${String(monthNumber === 12 ? 1 : monthNumber + 1).padStart(2, '0')}`;
      expectProblem(
        await call('get', `/ai/usage?month=${future}`, { subject: 'sub-marta' }),
        422,
        'VALIDATION_ERROR',
      );
      expectProblem(
        await call('get', '/ai/usage?month=2026-13', { subject: 'sub-marta' }),
        422,
        'VALIDATION_ERROR',
      );
    });

    it('Desligar a IA preserva as propostas prontas e cancela a fila por política', async () => {
      await enableAi(1_000_000);
      const ready = await requested(await newDfd());
      provider.enqueue({ kind: 'output', output: validOutput() });
      await runAiJob(api, ready);
      expect(stored(ready)?.status).toBe('SUCCEEDED');
      const queued = await requested(await newDfd());

      await configure({ 'ai.enabled': false });
      expectProblem(await requestDraft(await newDfd()), 403, 'AI_DISABLED');
      const calls = provider.calls.length;
      await runAiJob(api, queued);
      expect(stored(queued)).toMatchObject({ status: 'CANCELED', errorCode: 'CANCELED_BY_POLICY' });
      expect(provider.calls).toHaveLength(calls);

      const discard = await call('post', `/ai-generations/${ready}/discard`, { body: {} });
      expect(discard.status, JSON.stringify(discard.body)).toBe(200);
      expect(stored(ready)?.status).toBe('DISCARDED');
      expect((await availability()).reasons).toContain('AI_DISABLED');
    });
  });

  describe('[Validação]', () => {
    it('Ligar sem aceitar os termos: 422 AI_TERMS_NOT_ACCEPTED e a IA continua desligada', async () => {
      await configure({ 'ai.termsAcceptedVersion': null });
      expectProblem(await patchSettings({ 'ai.enabled': true }), 422, 'AI_TERMS_NOT_ACCEPTED');
      expectProblem(
        await patchSettings({ 'ai.enabled': true, 'ai.termsAcceptedVersion': '2025-01' }),
        422,
        'AI_TERMS_NOT_ACCEPTED',
      );
      expect((await settingsOf())['ai.enabled']?.value).toBe(false);
    });

    it('Limites fora da faixa: 422 VALIDATION_ERROR em cada campo', async () => {
      for (const [key, value] of [
        ['ai.monthlyTokenLimit', 49_999],
        ['ai.monthlyTokenLimit', 20_000_001],
        ['ai.userDailyRequestLimit', 0],
        ['ai.userDailyRequestLimit', 501],
      ] as const) {
        const body = expectProblem(await patchSettings({ [key]: value }), 422, 'VALIDATION_ERROR');
        expect(body.errors.map((error) => error.field)).toEqual([`values.${key}`]);
      }
      const max = expectProblem(
        await patchSettings({ 'ai.monthlyTokenLimit': 20_000_001 }),
        422,
        'VALIDATION_ERROR',
      );
      expect(max.errors[0]?.message).toBe('Informe um limite entre 50.000 e 20.000.000 tokens.');
    });

    it('Limite diário por usuário no dia civil do tenant (canceladas antes de rodar não contam)', async () => {
      await enableAi(2_000_000, 40);
      for (let index = 0; index < 38; index += 1) seedUsage({ tokens: 10 });
      seedUsage({ status: 'CANCELED', startedAt: null });
      seedUsage({ status: 'CANCELED', errorCode: 'CANCELED_BY_POLICY' });
      // Ontem no fuso do tenant (00:30 de São Paulo = 03:30 UTC do dia corrente): não conta.
      const today = clock.now;
      clock.now = new Date(
        Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 2, 30),
      );
      seedUsage({ tokens: 10 });
      clock.now = today;

      expect((await availability()).userDaily).toEqual({ used: 38, limit: 40 });
      await requested(await newDfd());
      await requested(await newDfd());
      expectProblem(await requestDraft(await newDfd()), 422, 'AI_USER_DAILY_LIMIT_REACHED');
      expect((await availability()).reasons).toEqual(['AI_USER_DAILY_LIMIT_REACHED']);
    });

    it('Limite abaixo do consumo atual (FA-04): permitido; novos pedidos recebem AI_USAGE_LIMIT_REACHED', async () => {
      await enableAi(1_000_000);
      seedUsage({ tokens: 60_000 });
      await configure({ 'ai.monthlyTokenLimit': 50_000 });
      expectProblem(await requestDraft(await newDfd()), 422, 'AI_USAGE_LIMIT_REACHED');
      const now = await availability();
      expect(now.canGenerate).toBe(false);
      expect(now.reasons).toEqual(['AI_USAGE_LIMIT_REACHED']);
    });
  });

  describe('[Permissão]', () => {
    it('Sem SETTINGS_MANAGE: 403 PERMISSION_DENIED com access.denied; sem MFA: 403 MFA_REQUIRED', async () => {
      const denials = auditOf('access.denied').length;
      expectProblem(
        await patchSettings(
          { 'ai.enabled': true },
          { subject: 'sub-lucia', versions: { 'ai.enabled': 0 } },
        ),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(await call('get', '/ai/usage'), 403, 'PERMISSION_DENIED');
      expect(auditOf('access.denied').length).toBeGreaterThanOrEqual(denials + 2);

      expectProblem(
        await patchSettings(
          { 'ai.enabled': true, 'ai.termsAcceptedVersion': TERMS },
          { amr: ['pwd'] },
        ),
        403,
        'MFA_REQUIRED',
      );
      expectProblem(
        await call('get', '/ai/usage', { subject: 'sub-marta', amr: ['pwd'] }),
        403,
        'MFA_REQUIRED',
      );
      // AI-05 não exige MFA nem SETTINGS_MANAGE.
      expect((await call('get', '/ai/availability', { amr: ['pwd'] })).status).toBe(200);
    });

    it('AI_GENERATE nos perfis semeados; fora de CONSULTOR_EXTERNO; catálogo com 69 permissões', async () => {
      // Só os perfis da RN-AI-21 — nem CONSULTOR_EXTERNO nem ADMIN_ORGAO.
      expect(rolesGrantingAiGenerate().sort()).toEqual(
        [
          'COMPRAS',
          'GESTOR_CONTRATACOES',
          'GESTOR_CONTRATO',
          'PLANEJAMENTO',
          'REQUISITANTE',
        ].sort(),
      );
      expect(PERMISSIONS).toHaveLength(69);

      await enableAi(1_000_000);
      // ADMIN_ORGAO vê o processo, mas não tem AI_GENERATE: 403 em AI-01 e motivo no AI-05.
      const target = await newDfd();
      expectProblem(await requestDraft(target, 'sub-otavio'), 403, 'PERMISSION_DENIED');
      const forOtavio = await availability('sub-otavio', `?processId=${target.processId}`);
      expect(forOtavio.reasons).toEqual(['PERMISSION_DENIED']);
      // Com AI_GENERATE e o DFD editável por ela: pode gerar.
      const forLucia = await availability(
        'sub-lucia',
        `?processId=${target.processId}&documentId=${target.documentId}`,
      );
      expect(forLucia.canGenerate).toBe(true);
    });
  });

  describe('[Tenant incorreto]', () => {
    it('Consumo e disponibilidade isolados por tenant', async () => {
      await enableAi(1_000_000);
      for (let index = 0; index < 80; index += 1) {
        seedUsage({ tenantId: B, userId: FAKE_USERS.heitor.id, tokens: 1_000 });
      }
      seedUsage({ tokens: 5_000 });

      const report = await usage();
      expect(report.generations.total).toBe(1);
      expect(report.usedTokens).toBe(5_000);
      expect(report.byUser.map((entry) => entry.userId)).toEqual([FAKE_USERS.lucia.id]);

      // Processo de outro tenant (ou inexistente): 404 NOT_FOUND, indistinguíveis.
      expectProblem(await call('get', `/ai/availability?processId=${newId()}`), 404, 'NOT_FOUND');
      // O aviso de limite é por tenant: nenhum evento de A cita o consumo de B.
      expect(
        api
          .outboxRows()
          .filter((row) => row.eventType === 'AiUsageThresholdReached' && row.tenantId === B),
      ).toEqual([]);
    });
  });

  describe('[Duplicidade]', () => {
    it('Aviso de 80% não se repete no mês, mesmo com o limite alterado', async () => {
      const month = `${String(clock.now.getUTCFullYear())}-${String(clock.now.getUTCMonth() + 1).padStart(2, '0')}`;
      await enableAi(50_000);
      seedUsage({ tokens: 39_000 });
      generator.reservedTokens = 2_000;
      for (const tokens of [1_500, 500]) {
        const id = await requested(await newDfd());
        provider.enqueue({
          kind: 'output',
          output: validOutput(),
          usage: { inputTokens: tokens, outputTokens: 0 },
        });
        await runAiJob(api, id);
      }
      expect(thresholdEvents(month)).toHaveLength(1);

      // Aumenta e volta a reduzir o limite: cruzar 80% de novo no mesmo mês não gera novo evento.
      await configure({ 'ai.monthlyTokenLimit': 100_000 });
      await configure({ 'ai.monthlyTokenLimit': 52_000 });
      const again = await requested(await newDfd());
      provider.enqueue({
        kind: 'output',
        output: validOutput(),
        usage: { inputTokens: 1_000, outputTokens: 0 },
      });
      await runAiJob(api, again);
      expect(
        thresholdEvents(month).filter(
          (row) => (row.payload as { threshold: number }).threshold === 80,
        ),
      ).toHaveLength(1);
    });
  });

  describe('[Concorrência]', () => {
    it('Dois pedidos disputando os últimos tokens: exatamente um 202 e um 422', async () => {
      await enableAi(50_000);
      seedUsage({ tokens: 30_000 });
      const [first, second] = [await newDfd(), await newDfd()];
      // O primeiro fica parado depois do portão: sem a trava por tenant, o segundo também passaria.
      generator.pauseMs = 150;
      const responses = await Promise.all([requestDraft(first), requestDraft(second)]);
      generator.pauseMs = 0;
      expect(responses.map((response) => response.status).sort()).toEqual([202, 422]);
      const refused = responses.find((response) => response.status === 422);
      expect((refused?.body as { code: string }).code).toBe('AI_USAGE_LIMIT_REACHED');
    });

    it('Dois administradores alteram o limite na mesma versão: o segundo recebe 412', async () => {
      const version = (await settingsOf())['ai.monthlyTokenLimit']?.version ?? 0;
      const firstSave = await patchSettings(
        { 'ai.monthlyTokenLimit': 300_000 },
        { versions: { 'ai.monthlyTokenLimit': version } },
      );
      expect(firstSave.status).toBe(200);
      expectProblem(
        await patchSettings(
          { 'ai.monthlyTokenLimit': 400_000 },
          { subject: 'sub-otavio', versions: { 'ai.monthlyTokenLimit': version } },
        ),
        412,
        'VERSION_CONFLICT',
      );
    });
  });

  describe('[Falha de banco]', () => {
    it('Banco indisponível ao salvar SET-02: 503 e ai.enabled nem alterado nem auditado', async () => {
      const versions = await settingsOf();
      const audits = auditOf('settings.update').length;
      settingsTx.down = true;
      expectProblem(
        await patchSettings(
          { 'ai.enabled': true, 'ai.termsAcceptedVersion': TERMS },
          {
            versions: {
              'ai.enabled': versions['ai.enabled']?.version ?? 0,
              'ai.termsAcceptedVersion': versions['ai.termsAcceptedVersion']?.version ?? 0,
            },
          },
        ),
        503,
        'DEPENDENCY_UNAVAILABLE',
      );
      settingsTx.down = false;
      expect((await settingsOf())['ai.enabled']?.value).toBe(false);
      expect(auditOf('settings.update')).toHaveLength(audits);
    });
  });

  describe('[Falha de integração]', () => {
    it('Relay fora quando o consumo cruza 80%: a geração fica SUCCEEDED e o evento gravado no outbox', async () => {
      const month = `${String(clock.now.getUTCFullYear())}-${String(clock.now.getUTCMonth() + 1).padStart(2, '0')}`;
      await enableAi(50_000);
      seedUsage({ tokens: 39_500 });
      generator.reservedTokens = 6_000;
      jobQueueOf(api).down = false;
      const id = await requested(await newDfd());
      provider.enqueue({
        kind: 'output',
        output: validOutput(),
        usage: { inputTokens: 1_000, outputTokens: 0 },
      });
      await runAiJob(api, id);
      expect(stored(id)?.status).toBe('SUCCEEDED');
      // Sem relay (modo em memória): o evento fica no outbox até ser publicado.
      expect(thresholdEvents(month)).toHaveLength(1);
    });

    it('Provedor indisponível na plataforma (FA-03): AI-05 informa e a configuração continua possível', async () => {
      await enableAi(1_000_000);
      const mutable = settings as { provider: string };
      mutable.provider = 'none';
      try {
        const now = await availability();
        expect(now).toMatchObject({ providerAvailable: false, canGenerate: false });
        expect(now.reasons).toEqual(['AI_PROVIDER_UNAVAILABLE']);
        await configure({ 'ai.userDailyRequestLimit': 20 });
      } finally {
        mutable.provider = 'fake';
      }
    });
  });
});
