import { problemDetailsSchema, SETTING_DEFINITIONS } from '@contrataflow/validation';
import type { SettingsMapDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import { SETTINGS_CLOCK, SETTINGS_TRANSACTIONS } from '../application/settings-ports.js';
import type { SettingsTransactions } from '../application/settings-ports.js';
import { InMemoryTenantSettingsRepository } from '../infrastructure/in-memory-tenant-settings.repository.js';

/*
 * US-103 — SET-01..03 pelo pipeline HTTP completo (autenticação, tenant, vínculo, validação Zod,
 * filtro RFC 9457) com a identidade fake, a auditoria real do `AuditService` e o outbox em memória.
 * Os mesmos casos contra o PostgreSQL (RLS, concorrência real, seeder) estão em
 * `test/tenant-leak/tenant-settings.spec.ts`.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const MARTA = FAKE_USERS.marta;
const OTAVIO = FAKE_USERS.otavio;
const LUCIA = FAKE_USERS.lucia;
const HEITOR = FAKE_USERS.heitor;
const MFA = ['pwd', 'otp'];
const NOW = new Date('2026-10-15T12:00:00.000Z');

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- o chamador informa o tipo do corpo
function dataOf<T = unknown>(response: request.Response): T {
  return (response.body as { data: T }).data;
}

function expectProblem(response: request.Response, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  const body = problemDetailsSchema.parse(response.body);
  expect(body.code).toBe(code);
  return body;
}

describe('Feature: Configurações gerais do tenant (US-103)', () => {
  let api: TestApi;
  let repository: InMemoryTenantSettingsRepository;

  const rowOf = (tenantId: string, key: string) =>
    repository.snapshot().find((row) => row.tenantId === tenantId && row.key === key);

  beforeAll(async () => {
    api = await createTestApi({ providers: [{ token: SETTINGS_CLOCK, value: () => NOW }] });
    repository = api.app.get(InMemoryTenantSettingsRepository, { strict: false });
    // Background: o tenant A provisionado com as chaves no padrão (versão 1); o B com marca própria.
    for (const definition of SETTING_DEFINITIONS) {
      repository.seed(A, definition.key, definition.defaultValue);
      repository.seed(B, definition.key, definition.defaultValue);
    }
    repository.seed(B, 'branding.primaryColor', '#000000', 3);
    repository.seed(B, 'labels.secretariat', 'Pasta LEAK-B', 2);
  });
  afterAll(async () => {
    await api.close();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    vi.restoreAllMocks();
  });

  const silence = () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  };

  const withAuth = (
    test: request.Test,
    user: { subject: string },
    options: { amr?: readonly string[]; tenant?: string } = {},
  ) =>
    test
      .set('Authorization', api.bearer(user.subject, { amr: options.amr ?? MFA }))
      .set('X-Tenant-Id', options.tenant ?? A);

  const getAll = (user: { subject: string } = MARTA, amr: readonly string[] = MFA) =>
    withAuth(request(api.server).get('/api/v1/settings'), user, { amr });

  const getPublic = (user: { subject: string } = MARTA, tenant: string = A) =>
    withAuth(request(api.server).get('/api/v1/settings/public'), user, { tenant });

  const patch = (
    values: Record<string, unknown>,
    expectedVersions: Record<string, number> | undefined,
    options: { user?: { subject: string }; amr?: readonly string[] } = {},
  ) =>
    withAuth(request(api.server).patch('/api/v1/settings'), options.user ?? MARTA, {
      amr: options.amr ?? MFA,
    }).send(expectedVersions === undefined ? { values } : { values, expectedVersions });

  const auditOf = (action: string) => api.auditRecords().filter((r) => r.action === action);
  const eventsOf = () =>
    api.outboxRows().filter((row) => row.eventType === 'TenantSettingsChanged');

  describe('[Sucesso]', () => {
    it('SET-01: todas as chaves do registro com valor e versão', async () => {
      const response = await getAll();

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers['cache-control']).toContain('must-revalidate');
      expect(response.headers.etag).toMatch(/^W\//);
      const data = dataOf<SettingsMapDto>(response);
      expect(Object.keys(data).sort()).toEqual(SETTING_DEFINITIONS.map((d) => d.key).sort());
      expect(data['labels.secretariat']).toEqual({ value: 'Secretaria', version: 1 });
      expect(data['security.mfaPolicy']).toEqual({ value: 'ADMINS', version: 1 });
    });

    it('alterar o rótulo de secretaria: versão 2, auditoria settings.update e TenantSettingsChanged', async () => {
      silence();
      const audits = auditOf('settings.update').length;
      const events = eventsOf().length;

      const response = await patch(
        { 'labels.secretariat': 'Diretoria' },
        { 'labels.secretariat': 1 },
      );

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(dataOf(response)).toEqual({
        'labels.secretariat': { value: 'Diretoria', version: 2 },
      });
      expect(rowOf(A, 'labels.secretariat')).toMatchObject({ value: 'Diretoria', version: 2 });
      expect(rowOf(B, 'labels.secretariat')).toMatchObject({ value: 'Pasta LEAK-B', version: 2 });

      const records = auditOf('settings.update');
      expect(records).toHaveLength(audits + 1);
      expect(records.at(-1)).toMatchObject({
        tenantId: A,
        category: 'CONFIGURATION',
        result: 'SUCCESS',
        actorUserId: MARTA.id,
        metadata: { key: 'labels.secretariat', group: 'labels' },
      });
      expect(records.at(-1)?.changes).toEqual([
        { path: 'labels.secretariat', old: 'Secretaria', new: 'Diretoria' },
      ]);
      expect(eventsOf()).toHaveLength(events + 1);
      expect(eventsOf().at(-1)).toMatchObject({
        tenantId: A,
        routingKey: 'tenant.settings_changed',
        aggregateType: 'Tenant',
        aggregateId: A,
        payload: { keys: ['labels.secretariat'] },
      });
    });

    it('lote com várias chaves: uma auditoria por chave e UM evento com todas as chaves', async () => {
      silence();
      const audits = auditOf('settings.update').length;
      const events = eventsOf().length;

      const response = await patch(
        {
          'labels.department': 'Divisão',
          'security.sessionIdleMinutes': 45,
          'uploads.allowedExtensions': ['pdf', 'png'],
          'features.novaTela': true,
        },
        {
          'labels.department': 1,
          'security.sessionIdleMinutes': 1,
          'uploads.allowedExtensions': 1,
          'features.novaTela': 0,
        },
      );

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(dataOf<SettingsMapDto>(response)).toMatchObject({
        'labels.department': { value: 'Divisão', version: 2 },
        'security.sessionIdleMinutes': { value: 45, version: 2 },
        'uploads.allowedExtensions': { value: ['pdf', 'png'], version: 2 },
        'features.novaTela': { value: true, version: 1 },
      });
      expect(auditOf('settings.update')).toHaveLength(audits + 4);
      expect(eventsOf()).toHaveLength(events + 1);
      expect((eventsOf().at(-1)?.payload as { keys: string[] }).keys.sort()).toEqual([
        'features.novaTela',
        'labels.department',
        'security.sessionIdleMinutes',
        'uploads.allowedExtensions',
      ]);
    });

    it('chave sem linha vale o padrão (versão 0) e a primeira gravação cria a versão 1', async () => {
      silence();
      repository.seed(A, 'features.outraFlag', true, 1);
      const before = dataOf<SettingsMapDto>(await getAll());
      expect(before['features.outraFlag']).toEqual({ value: true, version: 1 });

      const response = await patch({ 'features.beta': false }, { 'features.beta': 0 });
      // Igual ao padrão e sem linha: nada a gravar, nenhum evento.
      expect(response.status).toBe(200);
      expect(dataOf(response)).toEqual({});
      expect(rowOf(A, 'features.beta')).toBeUndefined();
    });

    it('nada alterado: 200 vazio, sem nova versão, auditoria nem evento', async () => {
      silence();
      const audits = auditOf('settings.update').length;
      const events = eventsOf().length;
      const version = rowOf(A, 'process.requireInternalCode')?.version;

      const response = await patch(
        { 'process.requireInternalCode': false },
        { 'process.requireInternalCode': version ?? 1 },
      );

      expect(response.status).toBe(200);
      expect(dataOf(response)).toEqual({});
      expect(rowOf(A, 'process.requireInternalCode')?.version).toBe(version);
      expect(auditOf('settings.update')).toHaveLength(audits);
      expect(eventsOf()).toHaveLength(events);
    });

    it('SET-03: só chaves públicas (labels.*, branding.*) do tenant da requisição', async () => {
      const response = await getPublic();

      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const data = dataOf<Record<string, unknown>>(response);
      expect(Object.keys(data).sort()).toEqual([
        'branding.logoAttachmentId',
        'branding.primaryColor',
        'labels.department',
        'labels.secretariat',
      ]);
      expect(data['branding.primaryColor']).toBe('#1D4ED8');
      expect(data['labels.secretariat']).toBe('Diretoria');
    });

    it('cor da marca em minúsculas é normalizada para maiúsculas', async () => {
      silence();
      const response = await patch(
        { 'branding.primaryColor': '#0f766e' },
        { 'branding.primaryColor': 1 },
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(rowOf(A, 'branding.primaryColor')?.value).toBe('#0F766E');
    });
  });

  describe('[Validação]', () => {
    it('máscara de numeração sem {year}: 422 NUMBERING_MASK_INVALID e nenhuma chave alterada', async () => {
      silence();
      const events = eventsOf().length;
      const response = await patch(
        { 'numbering.process.mask': 'PROC-{seq:4}', 'labels.department': 'Setorzinho' },
        { 'numbering.process.mask': 1, 'labels.department': 2 },
      );

      const problem = expectProblem(response, 422, 'NUMBERING_MASK_INVALID');
      expect(problem.errors[0]?.field).toBe('values.numbering.process.mask');
      expect(rowOf(A, 'numbering.process.mask')?.version).toBe(1);
      expect(rowOf(A, 'labels.department')?.value).toBe('Divisão');
      expect(eventsOf()).toHaveLength(events);
    });

    it('escopo ORGANIZATION exige {org} na máscara (efetiva) do processo', async () => {
      silence();
      const rejected = await patch(
        { 'numbering.process.scope': 'ORGANIZATION' },
        { 'numbering.process.scope': 1 },
      );
      expectProblem(rejected, 422, 'NUMBERING_MASK_INVALID');

      const accepted = await patch(
        {
          'numbering.process.scope': 'ORGANIZATION',
          'numbering.process.mask': '{org}-{seq:4}/{year}',
        },
        { 'numbering.process.scope': 1, 'numbering.process.mask': 1 },
      );
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    });

    it.each([
      ['security.sessionIdleMinutes', 3],
      ['security.sessionIdleMinutes', 121],
      ['security.mfaPolicy', 'SEMPRE'],
      ['priceResearch.unitPriceDecimals', 3],
      ['uploads.maxFileSizeMb', 101],
      ['uploads.allowedExtensions', ['exe']],
      ['branding.primaryColor', '#FFFF00'],
      ['branding.primaryColor', 'azul'],
      ['labels.secretariat', '   '],
      [
        'risk.levelThresholds',
        [
          { level: 'LOW', minScore: 1, maxScore: 4 },
          { level: 'HIGH', minScore: 6, maxScore: 25 },
        ],
      ],
      ['features.beta', 'sim'],
    ])('valor inválido para %s (%j): 422 VALIDATION_ERROR', async (key, value) => {
      silence();
      const version = rowOf(A, key)?.version ?? 0;
      const response = await patch({ [key]: value }, { [key]: version });
      const problem = expectProblem(response, 422, 'VALIDATION_ERROR');
      expect(problem.errors[0]?.field).toBe(`values.${key}`);
    });

    it('chave fora do registro: 422 SETTING_KEY_UNKNOWN e o lote inteiro é rejeitado (FA-02)', async () => {
      silence();
      const version = rowOf(A, 'labels.department')?.version ?? 1;
      const response = await patch(
        { 'labels.department': 'Outra coisa', 'inexistente.chave': 1 },
        { 'labels.department': version, 'inexistente.chave': 1 },
      );

      expectProblem(response, 422, 'SETTING_KEY_UNKNOWN');
      expect(rowOf(A, 'labels.department')?.version).toBe(version);
    });

    it('versão esperada ausente para a chave alterada: 428 PRECONDITION_REQUIRED', async () => {
      silence();
      expectProblem(
        await patch({ 'labels.department': 'X' }, undefined),
        428,
        'PRECONDITION_REQUIRED',
      );
      expectProblem(
        await patch(
          { 'labels.department': 'X', 'labels.secretariat': 'Y' },
          { 'labels.department': 2 },
        ),
        428,
        'PRECONDITION_REQUIRED',
      );
    });
  });

  describe('[Permissão]', () => {
    it('usuário sem SETTINGS_MANAGE: 403 PERMISSION_DENIED e access.denied; leitura pública liberada', async () => {
      silence();
      const denials = auditOf('access.denied').length;
      const events = eventsOf().length;

      const denied = await patch(
        { 'labels.department': 'Hack' },
        { 'labels.department': 2 },
        {
          user: LUCIA,
        },
      );
      expectProblem(denied, 403, 'PERMISSION_DENIED');
      expectProblem(await getAll(LUCIA), 403, 'PERMISSION_DENIED');

      const records = auditOf('access.denied');
      expect(records).toHaveLength(denials + 2);
      expect(records.at(-1)).toMatchObject({
        tenantId: A,
        actorUserId: LUCIA.id,
        reasonCode: 'SETTINGS_MANAGE',
        result: 'DENIED',
      });
      expect(eventsOf()).toHaveLength(events);
      expect(rowOf(A, 'labels.department')?.value).toBe('Divisão');

      expect((await getPublic(LUCIA)).status).toBe(200);
    });

    it('administradora sem MFA na sessão (POL-14): 403 MFA_REQUIRED e nada persistido', async () => {
      silence();
      const events = eventsOf().length;
      expectProblem(
        await patch(
          { 'labels.department': 'Sem MFA' },
          { 'labels.department': 2 },
          { amr: ['pwd'] },
        ),
        403,
        'MFA_REQUIRED',
      );
      expectProblem(await getAll(MARTA, ['pwd']), 403, 'MFA_REQUIRED');
      expect(rowOf(A, 'labels.department')?.value).toBe('Divisão');
      expect(eventsOf()).toHaveLength(events);
    });
  });

  describe('[Tenant incorreto]', () => {
    it('a leitura pública não traz nenhum valor de outro tenant', async () => {
      const response = await getPublic();
      expect(JSON.stringify(response.body)).not.toContain('LEAK-B');
      expect(dataOf<Record<string, unknown>>(response)['branding.primaryColor']).not.toBe(
        '#000000',
      );

      const other = await getPublic(HEITOR, B);
      expect(dataOf<Record<string, unknown>>(other)).toMatchObject({
        'branding.primaryColor': '#000000',
        'labels.secretariat': 'Pasta LEAK-B',
      });
    });

    it('administradora do tenant A não altera nem enxerga as chaves do tenant B', async () => {
      silence();
      const before = rowOf(B, 'branding.primaryColor');
      // A versão 3 existe só no tenant B: no A, a mesma chave está na versão 2 → conflito.
      const response = await patch(
        { 'branding.primaryColor': '#111111' },
        { 'branding.primaryColor': 3 },
      );
      expectProblem(response, 412, 'VERSION_CONFLICT');
      expect(rowOf(B, 'branding.primaryColor')).toEqual(before);

      // Mesmo tenant do cabeçalho divergente do vínculo: recusado pelo pipeline.
      const crossTenant = await withAuth(request(api.server).get('/api/v1/settings'), MARTA, {
        tenant: B,
      });
      expect(crossTenant.status).toBe(403);
      expect(JSON.stringify(crossTenant.body)).not.toContain('LEAK-B');
    });
  });

  describe('[Duplicidade]', () => {
    it('reenvio do mesmo PATCH com a mesma versão: aplica uma vez; a segunda tentativa responde VERSION_CONFLICT', async () => {
      silence();
      const events = eventsOf().length;
      const body = { 'security.sessionAbsoluteHours': 10 };
      const version = rowOf(A, 'security.sessionAbsoluteHours')?.version ?? 1;

      const first = await patch(body, { 'security.sessionAbsoluteHours': version });
      const second = await patch(body, { 'security.sessionAbsoluteHours': version });

      expect(first.status, JSON.stringify(first.body)).toBe(200);
      const conflict = expectProblem(second, 412, 'VERSION_CONFLICT');
      expect((conflict as Record<string, unknown>).currentVersion).toBe(version + 1);
      expect(rowOf(A, 'security.sessionAbsoluteHours')?.version).toBe(version + 1);
      expect(eventsOf()).toHaveLength(events + 1);
    });
  });

  describe('[Concorrência]', () => {
    it('duas alterações simultâneas da mesma chave: uma aplicada (versão +1), a outra 412 com currentVersion', async () => {
      silence();
      repository.seed(A, 'deadlines.warnBeforeBusinessDays', 2, 5);

      const [one, two] = await Promise.all([
        patch({ 'deadlines.warnBeforeBusinessDays': 3 }, { 'deadlines.warnBeforeBusinessDays': 5 }),
        patch(
          { 'deadlines.warnBeforeBusinessDays': 4 },
          { 'deadlines.warnBeforeBusinessDays': 5 },
          { user: OTAVIO },
        ),
      ]);

      expect([one.status, two.status].sort()).toEqual([200, 412]);
      const loser = one.status === 412 ? one : two;
      const problem = expectProblem(loser, 412, 'VERSION_CONFLICT');
      expect((problem as Record<string, unknown>).currentVersion).toBe(6);
      expect(rowOf(A, 'deadlines.warnBeforeBusinessDays')?.version).toBe(6);
    });

    it('chaves diferentes em requisições separadas não conflitam (FA-05)', async () => {
      silence();
      const [one, two] = await Promise.all([
        patch({ 'approval.preventSelfApproval': false }, { 'approval.preventSelfApproval': 1 }),
        patch(
          { 'notifications.emailEnabled': false },
          { 'notifications.emailEnabled': 1 },
          { user: OTAVIO },
        ),
      ]);
      expect([one.status, two.status]).toEqual([200, 200]);
    });

    it('conflito num lote identifica a chave e cancela o lote inteiro', async () => {
      silence();
      const events = eventsOf().length;
      const response = await patch(
        { 'labels.department': 'Lote A', 'access.historicalDepartmentsCanView': false },
        { 'labels.department': 2, 'access.historicalDepartmentsCanView': 9 },
      );
      const problem = expectProblem(response, 412, 'VERSION_CONFLICT');
      expect((problem as Record<string, unknown>).conflicts).toEqual([
        { key: 'access.historicalDepartmentsCanView', currentVersion: 1 },
      ]);
      expect(rowOf(A, 'labels.department')?.value).toBe('Divisão');
      expect(eventsOf()).toHaveLength(events);
    });
  });

  describe('[Falha de banco]', () => {
    it('banco indisponível ao salvar: 503 DEPENDENCY_UNAVAILABLE e nada persistido', async () => {
      silence();
      const failing: SettingsTransactions = {
        run: () => Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED'))),
        read: () => Promise.reject(new DatabaseUnavailableError(new Error('ECONNREFUSED'))),
      };
      const down = await createTestApi({
        providers: [
          { token: SETTINGS_TRANSACTIONS, value: failing },
          { token: SETTINGS_CLOCK, value: () => NOW },
        ],
      });
      try {
        const response = await request(down.server)
          .patch('/api/v1/settings')
          .set('Authorization', down.bearer(MARTA.subject, { amr: MFA }))
          .set('X-Tenant-Id', A)
          .send({
            values: { 'labels.department': 'X' },
            expectedVersions: { 'labels.department': 1 },
          });
        expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
        expect(down.auditRecords().filter((r) => r.action === 'settings.update')).toHaveLength(0);
        expect(down.outboxRows()).toHaveLength(0);
      } finally {
        await down.close();
      }
    });
  });

  describe('[Falha de integração]', () => {
    it('relay do outbox fora do ar: configuração salva (200) e evento gravado no outbox sem publicação', async () => {
      silence();
      const events = eventsOf().length;
      const response = await patch({ 'labels.department': 'Relay' }, { 'labels.department': 2 });
      // Sem relay no teste, o evento fica no outbox sem publicação; o status `PENDING` no banco é
      // conferido em `test/tenant-leak/tenant-settings.spec.ts`.
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(eventsOf()).toHaveLength(events + 1);
    });
  });
});
