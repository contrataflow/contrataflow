import { myProfileSchema, problemDetailsSchema } from '@contrataflow/validation';
import type { MyProfileDto } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import { IDENTITY_TENANT_TRANSACTIONS } from '../application/ports.js';
import type { IdentityTenantTransactions } from '../application/ports.js';

/*
 * US-098 — ME-01/ME-02 (`GET`/`PATCH /me`) pelo pipeline HTTP completo com a identidade fake e a
 * auditoria real do `AuditService`. O mesmo fluxo contra o PostgreSQL (UPDATE versionado, RLS da
 * auditoria) está em `test/tenant-leak/my-profile.spec.ts`.
 *
 * Elenco do Gherkin: Elisa = Ana (vínculo ativo na Prefeitura A); o vínculo "não ACTIVE" é o do
 * Bruno (suspenso).
 */

const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const ELISA = FAKE_USERS.ana;
const SUSPENSO = FAKE_USERS.bruno;
const OUTRA = FAKE_USERS.marta;

/** Transações simuladas com falha injetável (banco fora do ar). */
class ToggleTransactions implements IdentityTenantTransactions {
  failRun = false;

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    if (this.failRun) return Promise.reject(new DatabaseUnavailableError(new Error('down')));
    return runSimulatedTransaction(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    return runSimulatedTransaction(work);
  }
}

function expectProblem(response: request.Response, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  const body = problemDetailsSchema.parse(response.body);
  expect(body.code).toBe(code);
  return body;
}

describe('Feature: Meu perfil e preferências (US-098)', () => {
  let api: TestApi;
  const transactions = new ToggleTransactions();

  beforeAll(async () => {
    api = await createTestApi({
      providers: [{ token: IDENTITY_TENANT_TRANSACTIONS, value: transactions }],
    });
  });
  afterAll(async () => {
    await api.close();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    transactions.failRun = false;
    vi.restoreAllMocks();
  });

  const silence = () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  };

  const as = (test: request.Test, user: { subject: string | null } = ELISA, tenant: string = A) =>
    test.set('Authorization', api.bearer(user.subject ?? '')).set('X-Tenant-Id', tenant);
  const getMe = (user: { subject: string | null } = ELISA) =>
    as(request(api.server).get('/api/v1/me'), user);
  const patchMe = (
    body: Record<string, unknown>,
    version: number | null,
    user: { subject: string | null } = ELISA,
    tenant: string = A,
  ) => {
    const call = as(request(api.server).patch('/api/v1/me'), user, tenant);
    return (version === null ? call : call.set('If-Match', `"${String(version)}"`)).send(body);
  };
  const auditOf = (action: string) => api.auditRecords().filter((r) => r.action === action);
  const profileOf = (response: request.Response): MyProfileDto =>
    myProfileSchema.parse((response.body as { data: unknown }).data);

  async function versionOf(user: { subject: string | null } = ELISA): Promise<number> {
    const response = await getMe(user);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return profileOf(response).version;
  }

  describe('[Sucesso] Atualizar nome social e tema', () => {
    it('responde 200 com o perfil novo, ETag da nova versão e auditoria profile.update', async () => {
      silence();
      const version = await versionOf();
      const response = await patchMe(
        { socialName: 'Eli', phone: '(11) 91234-5678', preferences: { theme: 'dark' } },
        version,
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.headers.etag).toBe(`"${String(version + 1)}"`);
      expect(profileOf(response)).toMatchObject({
        name: 'Ana Souza',
        socialName: 'Eli',
        phone: '(11) 91234-5678',
        email: ELISA.email,
        preferences: { density: 'comfortable', theme: 'dark' },
        version: version + 1,
      });
      // A leitura seguinte devolve o mesmo estado (e o mesmo ETag).
      const reread = await getMe();
      expect(profileOf(reread)).toEqual(profileOf(response));
      expect(reread.headers.etag).toBe(response.headers.etag);

      const audit = auditOf('profile.update').at(-1);
      expect(audit).toMatchObject({
        action: 'profile.update',
        category: 'SECURITY',
        entityType: 'User',
        entityId: ELISA.id,
      });
      expect(audit?.changes).toEqual([
        { path: 'socialName', old: null, new: 'Eli' },
        { path: 'phone', old: null, new: '***5678' },
        { path: 'preferences.theme', old: 'system', new: 'dark' },
      ]);
      // Telefone completo nunca na trilha (RN-IAM-113 · Logs).
      expect(JSON.stringify(audit)).not.toContain('91234');
    });

    it('FA-01: nome social vazio volta ao nome civil; preferência já igual não gera mudança', async () => {
      silence();
      const before = auditOf('profile.update').length;
      const version = await versionOf();
      const cleared = await patchMe({ socialName: '', preferences: { theme: 'dark' } }, version);
      expect(profileOf(cleared)).toMatchObject({ socialName: null, version: version + 1 });
      expect(auditOf('profile.update')).toHaveLength(before + 1);
      expect(auditOf('profile.update').at(-1)?.changes).toEqual([
        { path: 'socialName', old: 'Eli', new: null },
      ]);
    });

    it('nada alterado: 200 sem nova versão nem auditoria', async () => {
      silence();
      const version = await versionOf();
      const before = auditOf('profile.update').length;
      const response = await patchMe(
        { name: 'Ana Souza', preferences: { theme: 'dark' } },
        version,
      );
      expect(response.status).toBe(200);
      expect(profileOf(response).version).toBe(version);
      expect(response.headers.etag).toBe(`"${String(version)}"`);
      expect(auditOf('profile.update')).toHaveLength(before);
    });
  });

  describe('[Validação]', () => {
    it.each([
      ['nome curto', { name: 'A' }, 'name'],
      ['nome vazio', { name: '' }, 'name'],
      ['telefone inválido', { phone: '12345' }, 'phone'],
      ['nome social curto', { socialName: 'E' }, 'socialName'],
      ['e-mail não é editável (RN-IAM-109)', { email: 'outro@x.test' }, null],
      ['status não é editável', { status: 'BLOCKED' }, null],
    ])('%s → 422 VALIDATION_ERROR sem gravar', async (_label, body, field) => {
      silence();
      const version = await versionOf();
      const response = await patchMe(body, version);
      const problem = expectProblem(response, 422, 'VALIDATION_ERROR');
      if (field !== null) expect(problem.errors.map((e) => e.field)).toContain(field);
      expect(await versionOf()).toBe(version);
    });

    it('valor de preferência fora do registro → 422 VALIDATION_ERROR', async () => {
      silence();
      const version = await versionOf();
      const problem = expectProblem(
        await patchMe({ preferences: { theme: 'neon' } }, version),
        422,
        'VALIDATION_ERROR',
      );
      expect(problem.errors.map((e) => e.field)).toContain('preferences.theme');
    });

    it('V-02: chave de preferência desconhecida → 422 SETTING_KEY_UNKNOWN e nada é aplicado', async () => {
      silence();
      const version = await versionOf();
      const response = await patchMe(
        { name: 'Ana Maria Souza', preferences: { theme: 'light', fontSize: 'xl' } },
        version,
      );
      expectProblem(response, 422, 'SETTING_KEY_UNKNOWN');
      const reread = profileOf(await getMe());
      expect(reread.version).toBe(version);
      expect(reread.name).toBe('Ana Souza');
    });
  });

  describe('[Permissão] / [Tenant incorreto]', () => {
    it('vínculo não ACTIVE → 403 MEMBERSHIP_INACTIVE (o front redireciona para SCR-111)', async () => {
      silence();
      expectProblem(await getMe(SUSPENSO), 403, 'MEMBERSHIP_INACTIVE');
      expectProblem(await patchMe({ name: 'Bruno' }, 1, SUSPENSO), 403, 'MEMBERSHIP_INACTIVE');
    });

    it('X-Tenant-Id de tenant sem vínculo → 403 MEMBERSHIP_INACTIVE e nada é gravado', async () => {
      silence();
      const version = await versionOf();
      expectProblem(
        await patchMe({ name: 'Ana Silva' }, version, ELISA, B),
        403,
        'MEMBERSHIP_INACTIVE',
      );
      expect(profileOf(await getMe()).name).toBe('Ana Souza');
    });

    it('sem token → 401', async () => {
      const response = await request(api.server).patch('/api/v1/me').set('X-Tenant-Id', A);
      expect(response.status).toBe(401);
    });

    it('cada pessoa edita só o próprio registro (não há id na rota)', async () => {
      silence();
      const otherVersion = await versionOf(OUTRA);
      const own = await versionOf();
      expect((await patchMe({ name: 'Ana Souza Lima' }, own)).status).toBe(200);
      const other = profileOf(await getMe(OUTRA));
      expect(other.name).toBe(OUTRA.name);
      expect(other.version).toBe(otherVersion);
      await patchMe({ name: 'Ana Souza' }, own + 1);
    });
  });

  describe('If-Match (RN-IAM-112)', () => {
    it('sem If-Match → 428 PRECONDITION_REQUIRED', async () => {
      silence();
      expectProblem(await patchMe({ name: 'Ana Silva' }, null), 428, 'PRECONDITION_REQUIRED');
    });

    it('[Duplicidade] clique duplo: a segunda requisição, com o If-Match superado, recebe 412', async () => {
      silence();
      const version = await versionOf();
      expect((await patchMe({ preferences: { density: 'compact' } }, version)).status).toBe(200);
      const second = expectProblem(
        await patchMe({ preferences: { density: 'compact' } }, version),
        412,
        'VERSION_CONFLICT',
      );
      expect((second as unknown as { currentVersion: number }).currentVersion).toBe(version + 1);
    });

    it('[Concorrência] duas abas com o mesmo ETag: só a primeira grava', async () => {
      silence();
      const version = await versionOf();
      const first = await patchMe({ name: 'Ana S. Primeira' }, version);
      const second = await patchMe({ name: 'Ana S. Segunda' }, version);
      expect(first.status).toBe(200);
      expectProblem(second, 412, 'VERSION_CONFLICT');
      expect(profileOf(await getMe()).name).toBe('Ana S. Primeira');
      // O front recarrega GET /me e repete a edição com o ETag novo.
      const retry = await patchMe({ name: 'Ana Souza' }, await versionOf());
      expect(retry.status).toBe(200);
    });
  });

  describe('[Falha de banco]', () => {
    it('banco indisponível ao salvar → 503 DEPENDENCY_UNAVAILABLE', async () => {
      silence();
      const version = await versionOf();
      transactions.failRun = true;
      expectProblem(await patchMe({ name: 'Ana Silva' }, version), 503, 'DEPENDENCY_UNAVAILABLE');
      transactions.failRun = false;
      expect(profileOf(await getMe()).version).toBe(version);
    });
  });
});
