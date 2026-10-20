import { problemDetailsSchema } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import { createTestApi } from '../../../../test/support/api-test-app.js';
import type { TestApi } from '../../../../test/support/api-test-app.js';
import {
  AUTHENTIK_DIRECTORY,
  IDENTITY_CLOCK,
  IDENTITY_REPOSITORY,
  IDENTITY_TENANT_TRANSACTIONS,
} from '../application/ports.js';
import type { IdentityRepository, IdentityTenantTransactions } from '../application/ports.js';
import type { InMemoryAuthentikDirectory } from '../infrastructure/in-memory-identity.repositories.js';

/*
 * US-090 — USR-13 `POST /users/{userId}/mfa-reset` pelo pipeline HTTP completo (autenticação,
 * tenant, vínculo, MFA do administrador, validação Zod, filtro RFC 9457) com a identidade fake, o
 * diretório do Authentik em memória e a auditoria real do `AuditService`.
 *
 * Elenco do Gherkin no diretório fake (tenant A = "Prefeitura de São José"): o administrador é
 * Marta (`ADMIN_ORGAO`); "Bruno" é Eva (vínculo ativo, sem perfil); "Carla" é Ana (só
 * `REQUISITANTE`); Heitor só tem vínculo no tenant B.
 */

const A = FAKE_TENANTS.prefeituraA.id;
const ADMIN = FAKE_USERS.marta;
const BRUNO = FAKE_USERS.eva;
const CARLA = FAKE_USERS.ana;
const SO_NO_B = FAKE_USERS.heitor;
const MFA = ['pwd', 'otp'];
const REASON = 'Perdeu o celular com o autenticador.';

const now = new Date('2026-10-17T12:00:00.000Z');

/** Transações simuladas com o banco fora do ar injetável. */
class ToggleTransactions implements IdentityTenantTransactions {
  down = false;

  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    if (this.down) return Promise.reject(new DatabaseUnavailableError(new Error('down')));
    return runSimulatedTransaction(work);
  }

  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T> {
    if (this.down) return Promise.reject(new DatabaseUnavailableError(new Error('down')));
    return runSimulatedTransaction(work);
  }
}

function expectProblem(response: request.Response, status: number, code: string) {
  expect(response.status, JSON.stringify(response.body)).toBe(status);
  const body = problemDetailsSchema.parse(response.body);
  expect(body.code).toBe(code);
  return body;
}

describe('Feature: Redefinição administrativa do MFA (US-090 · USR-13)', () => {
  let api: TestApi;
  let authentik: InMemoryAuthentikDirectory;
  /** Conta de "Bruno" no Authentik (PK do provisionamento — preferido ao `sub`). */
  let brunoAccount: string;
  const transactions = new ToggleTransactions();

  beforeAll(async () => {
    api = await createTestApi({
      providers: [
        { token: IDENTITY_CLOCK, value: () => now },
        { token: IDENTITY_TENANT_TRANSACTIONS, value: transactions },
      ],
    });
    authentik = api.app.get<InMemoryAuthentikDirectory>(AUTHENTIK_DIRECTORY, { strict: false });
    const users = api.app.get<IdentityRepository>(IDENTITY_REPOSITORY, { strict: false });
    const bruno = await users.findUserById(BRUNO.id);
    brunoAccount = bruno?.authentikUserId ?? BRUNO.subject;
  });
  afterAll(async () => {
    await api.close();
  });
  afterEach(() => {
    api.rateLimitStore.reset();
    transactions.down = false;
    authentik.unavailable = false;
    vi.restoreAllMocks();
  });

  const silence = () => ({
    log: vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined),
    warn: vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
    error: vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined),
  });

  const auditOf = (action: string) => api.auditRecords().filter((r) => r.action === action);

  const reset = (
    userId: string,
    body: Record<string, unknown> = { reason: REASON },
    actor: { subject: string | null } = ADMIN,
    amr: readonly string[] = MFA,
  ) =>
    request(api.server)
      .post(`/api/v1/users/${userId}/mfa-reset`)
      .set('Authorization', api.bearer(actor.subject ?? '', { amr }))
      .set('X-Tenant-Id', A)
      .send(body);

  it('[Sucesso] remove os fatores no Authentik, audita membership.mfa_reset e responde 200', async () => {
    const logs = silence();
    authentik.mfaDevices.set(brunoAccount, 2);
    const before = authentik.mfaResets.length;
    const response = await reset(BRUNO.id);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toEqual({ data: { userId: BRUNO.id, resetAt: now.toISOString() } });
    expect(authentik.mfaResets.slice(before)).toEqual([
      expect.objectContaining({ externalSubject: BRUNO.subject }),
    ]);
    expect(authentik.mfaDevices.get(brunoAccount)).toBe(0);
    expect(auditOf('membership.mfa_reset').at(-1)).toMatchObject({
      category: 'SECURITY',
      entityType: 'TenantMembership',
      metadata: { targetUserId: BRUNO.id, reason: REASON },
    });
    // Logs: quem, por quem e a correlação — nunca o motivo, segredos ou tokens.
    const entry = logs.log.mock.calls
      .map(([fields]) => fields as Record<string, unknown>)
      .find((fields) => fields.event === 'identity.mfa_reset');
    expect(entry).toMatchObject({ targetUserId: BRUNO.id, removedDevices: 2 });
    expect(JSON.stringify(entry)).not.toContain(REASON);
  });

  it('[Validação] motivo ausente ou curto → 422 VALIDATION_ERROR no campo "reason"', async () => {
    silence();
    for (const body of [{}, { reason: 'curto' }, { reason: '          ' }]) {
      const problem = expectProblem(await reset(BRUNO.id, body), 422, 'VALIDATION_ERROR');
      expect(problem.errors.map((error) => error.field)).toEqual(['reason']);
      expect(problem.errors[0]?.message).toBe(
        'Informe o motivo da redefinição (mín. 10 caracteres).',
      );
    }
    expectProblem(await reset(BRUNO.id, { reason: 'x'.repeat(501) }), 422, 'VALIDATION_ERROR');
  });

  it('[Validação] V-02 · RN-IAM-43: sobre o próprio vínculo → 422 NOT_ALLOWED, nada no Authentik', async () => {
    silence();
    const before = authentik.mfaResets.length;
    const problem = expectProblem(await reset(ADMIN.id), 422, 'VALIDATION_ERROR');
    expect(problem.errors[0]).toMatchObject({ field: 'userId', code: 'NOT_ALLOWED' });
    expect(problem.detail).toBe(
      'Para redefinir sua própria autenticação em duas etapas, use a recuperação no login.',
    );
    expect(authentik.mfaResets.length).toBe(before);
  });

  it('[Permissão] sem USER_MANAGE → 403 PERMISSION_DENIED; administrador sem MFA → 403 MFA_REQUIRED', async () => {
    silence();
    const before = authentik.mfaResets.length;
    expectProblem(await reset(BRUNO.id, { reason: REASON }, CARLA), 403, 'PERMISSION_DENIED');
    // USR-13 é risco alto: com a política ADMINS, o próprio administrador passa pelo step-up.
    expectProblem(await reset(BRUNO.id, { reason: REASON }, ADMIN, ['pwd']), 403, 'MFA_REQUIRED');
    expect(authentik.mfaResets.length).toBe(before);
    expect(auditOf('auth.mfa_required').at(-1)).toMatchObject({
      result: 'DENIED',
      metadata: { permissionCode: 'USER_MANAGE', route: '/api/v1/users/:userId/mfa-reset' },
    });
  });

  it('[Tenant incorreto] usuário sem vínculo no tenant do administrador → 404 USER_NOT_FOUND', async () => {
    silence();
    const before = authentik.mfaResets.length;
    expectProblem(await reset(SO_NO_B.id), 404, 'USER_NOT_FOUND');
    expectProblem(await reset('0192a000-0000-7000-8000-0000000000ff'), 404, 'USER_NOT_FOUND');
    expect(authentik.mfaResets.length).toBe(before);
  });

  it('[Duplicidade] redefinir de novo antes do recadastro conclui normalmente, sem fator', async () => {
    silence();
    expect((await reset(BRUNO.id)).status).toBe(200);
    const again = await reset(BRUNO.id);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(authentik.mfaDevices.get(brunoAccount)).toBe(0);
  });

  it('[Falha de integração] Authentik fora → 503 DEPENDENCY_UNAVAILABLE, sem auditoria', async () => {
    silence();
    authentik.unavailable = true;
    const audits = auditOf('membership.mfa_reset').length;
    const response = await reset(BRUNO.id);
    const problem = expectProblem(response, 503, 'DEPENDENCY_UNAVAILABLE');
    expect(problem.detail).toBe(
      'O serviço de autenticação está indisponível. Tente novamente em instantes.',
    );
    expect(response.headers['retry-after']).toBe('30');
    expect(auditOf('membership.mfa_reset')).toHaveLength(audits);
  });

  it('[Falha de banco] PostgreSQL fora → 503 e nada é feito no Authentik', async () => {
    silence();
    transactions.down = true;
    const before = authentik.mfaResets.length;
    expectProblem(await reset(BRUNO.id), 503, 'DEPENDENCY_UNAVAILABLE');
    expect(authentik.mfaResets.length).toBe(before);
  });
});
