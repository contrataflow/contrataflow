import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LOGIN_TRANSACTION_COOKIE } from '@/bff/auth/login-transaction';
import {
  SWITCH_NOT_COMPLETED_URL,
  SWITCH_STEP_UP_URL,
  handleAuthRequest,
} from '@/bff/auth-handler';
import { captureLogsForTests } from '@/bff/logger';
import { FAKE_PERSONAS, FakeSessionDirectory } from '@/bff/session/fake-identity';
import { PENDING_SWITCH_TTL_MS } from '@/bff/session/session-service';
import { SessionStoreUnavailableError } from '@/bff/session/types';
import type { DirectoryResult, SessionDirectory, TenantActivation } from '@/bff/session/types';
import type { TestRuntime } from '@test/support/bff';
import { browserRequest, createTestRuntime, signIn } from '@test/support/bff';

/*
 * US-093 — Selecionar órgão ativo: `POST /api/auth/switch-tenant` no BFF (8 categorias do Gherkin).
 * "Helena" = a pessoa fake Ana: autenticada na Prefeitura A, com vínculo ACTIVE também na B.
 */

const MUTATION = { 'X-CF-Request': '1', 'Sec-Fetch-Site': 'same-origin' };
const [MEMBERSHIP_A, MEMBERSHIP_B] = FAKE_PERSONAS.ana.memberships;
const TENANT_A = MEMBERSHIP_A.tenant.id;
const TENANT_B = MEMBERSHIP_B.tenant.id;
const OTHER_PERSON_MEMBERSHIP = FAKE_PERSONAS.bruno.memberships[0].membershipId;

type Refusal = Exclude<DirectoryResult['kind'], 'ok'>;

let logs: ReturnType<typeof captureLogsForTests>;

beforeEach(() => {
  logs = captureLogsForTests();
});

afterEach(() => {
  logs.restore();
});

/** Diretório fake com recusas programáveis e um gancho no meio da chamada (concorrência). */
function scriptedDirectory() {
  const fake = new FakeSessionDirectory();
  const state: {
    refusals: Refusal[];
    during: ((input: TenantActivation) => Promise<void>) | null;
  } = { refusals: [], during: null };
  const activateTenant = vi.fn<SessionDirectory['activateTenant']>(async (input) => {
    if (state.during) await state.during(input);
    const refusal = state.refusals.shift();
    return refusal ? { kind: refusal } : fake.activateTenant(input);
  });
  const directory: SessionDirectory = {
    startSession: (input) => fake.startSession(input),
    activateTenant,
  };
  return { directory, state, activateTenant };
}

async function helena() {
  const scripted = scriptedDirectory();
  const test = createTestRuntime({ directory: scripted.directory });
  const session = await signIn(test, 'ana');
  return { test, ...scripted, ...session };
}

function switchTo(test: TestRuntime, cookie: string, body: unknown, headers = MUTATION) {
  return handleAuthRequest(
    browserRequest('/api/auth/switch-tenant', {
      method: 'POST',
      headers: { ...headers, Cookie: cookie, 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    'switch-tenant',
    test.runtime,
  );
}

async function problem(
  response: Response,
): Promise<{ code: string; errors: unknown[] } & Record<string, unknown>> {
  return (await response.json()) as { code: string; errors: unknown[] } & Record<string, unknown>;
}

function logged(event: string): Record<string, unknown>[] {
  return logs.lines
    .filter((line) => line.includes(`"${event}"`))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.event === event);
}

describe('Feature: Selecionar órgão ativo — BFF (US-093)', () => {
  it('[Sucesso] troca para a Prefeitura B na mesma sessão, com auditoria pedida à API e log', async () => {
    const { test, cookie, record, activateTenant } = await helena();
    const response = await switchTo(test, cookie, { membershipId: MEMBERSHIP_B.membershipId });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { activeTenant: { id: string; name: string }; readOnly: boolean };
    };
    expect(body.data.activeTenant).toMatchObject({ id: TENANT_B, name: 'Prefeitura B' });
    expect(body.data.readOnly).toBe(false);
    // RN-IAM-66: mesmo `sid`, sem cookie novo; só a instituição muda no registro.
    expect(response.headers.get('Set-Cookie')).toBeNull();
    const stored = await test.store.get(record.key);
    expect(stored).toMatchObject({
      activeTenantId: TENANT_B,
      membershipId: MEMBERSHIP_B.membershipId,
      pendingTenantSwitch: null,
    });
    expect(stored?.tokens).toEqual(record.tokens);
    expect(activateTenant).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'switch',
        selection: 'MANUAL',
        membershipId: MEMBERSHIP_B.membershipId,
        tenantId: TENANT_B,
        fromTenantId: TENANT_A,
        setAsDefault: false,
        sessionIdHash: record.key,
      }),
    );
    const [entry] = logged('auth.tenant_switch');
    expect(entry).toMatchObject({
      level: 'info',
      userId: record.userId,
      fromTenantId: TENANT_A,
      toTenantId: TENANT_B,
    });
    expect(typeof entry?.durationMs).toBe('number');
    // Nunca o cookie de sessão nem tokens nos logs.
    const all = logs.lines.join('\n');
    expect(all).not.toContain(cookie.split('=')[1]);
    expect(all).not.toContain(record.tokens.accessToken);
  });

  it('[Validação] vínculo que não pertence a Helena → 422 VALIDATION_ERROR (REFERENCE_NOT_FOUND)', async () => {
    const { test, cookie, record } = await helena();
    const response = await switchTo(test, cookie, { membershipId: OTHER_PERSON_MEMBERSHIP });
    expect(response.status).toBe(422);
    const body = await problem(response);
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.errors).toEqual([
      {
        field: 'membershipId',
        code: 'REFERENCE_NOT_FOUND',
        message: 'Selecione uma instituição válida.',
      },
    ]);
    expect((await test.store.get(record.key))?.activeTenantId).toBe(TENANT_A);
    expect(logged('auth.tenant_switch_rejected')[0]).toMatchObject({
      reason: 'REFERENCE_NOT_FOUND',
    });
  });

  it('[Validação] corpo fora do contrato: ausente → REQUIRED; malformado → 422; JSON ilegível → 400', async () => {
    const { test, cookie } = await helena();
    const missing = await problem(await switchTo(test, cookie, {}));
    expect(missing).toMatchObject({
      code: 'VALIDATION_ERROR',
      errors: [{ field: 'membershipId', code: 'REQUIRED' }],
    });
    const notUuid = await problem(await switchTo(test, cookie, { membershipId: 'prefeitura-b' }));
    expect(notUuid.errors).toEqual([expect.objectContaining({ code: 'REFERENCE_NOT_FOUND' })]);
    const legacy = await problem(
      await switchTo(test, cookie, { membershipId: MEMBERSHIP_B.membershipId, tenantId: TENANT_B }),
    );
    expect(legacy.errors).toEqual([
      expect.objectContaining({ field: 'tenantId', code: 'INVALID_FORMAT' }),
    ]);
    const flag = await problem(
      await switchTo(test, cookie, {
        membershipId: MEMBERSHIP_B.membershipId,
        setAsDefault: 'sim',
      }),
    );
    expect(flag.errors).toEqual([expect.objectContaining({ field: 'setAsDefault' })]);
    expect(await problem(await switchTo(test, cookie, null))).toMatchObject({
      errors: [{ field: 'membershipId', code: 'REQUIRED' }],
    });
    expect((await switchTo(test, cookie, 'não-json')).status).toBe(400);
  });

  it('exige CSRF e sessão: sem cabeçalho → 403 CSRF_REJECTED; sem sessão → 401; vencida → SESSION_EXPIRED', async () => {
    const { test, cookie } = await helena();
    const body = { membershipId: MEMBERSHIP_B.membershipId };
    const csrf = await switchTo(test, cookie, body, {} as typeof MUTATION);
    expect((await problem(csrf)).code).toBe('CSRF_REJECTED');
    expect((await switchTo(test, '', body)).status).toBe(401);
    test.clock.now += 31 * 60_000;
    expect((await problem(await switchTo(test, cookie, body))).code).toBe('SESSION_EXPIRED');
  });

  it('[Permissão] vínculo suspenso → 403 MEMBERSHIP_INACTIVE e a sessão fica na Prefeitura A', async () => {
    const { test, cookie, record, state } = await helena();
    state.refusals.push('no_membership');
    const response = await switchTo(test, cookie, { membershipId: MEMBERSHIP_B.membershipId });
    expect(response.status).toBe(403);
    expect((await problem(response)).code).toBe('MEMBERSHIP_INACTIVE');
    expect((await test.store.get(record.key))?.activeTenantId).toBe(TENANT_A);
    expect(logged('auth.tenant_switch_rejected')[0]).toMatchObject({
      level: 'warn',
      reason: 'MEMBERSHIP_INACTIVE',
    });
  });

  it('[Tenant incorreto] Prefeitura B suspensa → 403 TENANT_SUSPENDED e a sessão fica na A', async () => {
    const { test, cookie, record, state } = await helena();
    state.refusals.push('tenant_unavailable');
    const response = await switchTo(test, cookie, { membershipId: MEMBERSHIP_B.membershipId });
    expect(response.status).toBe(403);
    expect((await problem(response)).code).toBe('TENANT_SUSPENDED');
    expect(await test.store.get(record.key)).toMatchObject({
      activeTenantId: TENANT_A,
      membershipId: MEMBERSHIP_A.membershipId,
    });
  });

  it.each([
    ['blocked', 403, 'PERMISSION_DENIED'],
    ['unauthenticated', 401, 'SESSION_EXPIRED'],
  ] as const)('recusa %s da API → %s %s', async (refusal, status, code) => {
    const { test, cookie, state } = await helena();
    state.refusals.push(refusal);
    const response = await switchTo(test, cookie, { membershipId: MEMBERSHIP_B.membershipId });
    expect(response.status).toBe(status);
    expect((await problem(response)).code).toBe(code);
  });

  it('[Duplicidade] selecionar de novo a Prefeitura A (já ativa) é no-op: sem API nem log de troca', async () => {
    const { test, cookie, record, activateTenant } = await helena();
    const response = await switchTo(test, cookie, { membershipId: MEMBERSHIP_A.membershipId });
    expect(response.status).toBe(200);
    expect(
      ((await response.json()) as { data: { activeTenant: { id: string } } }).data.activeTenant.id,
    ).toBe(TENANT_A);
    expect(activateTenant).not.toHaveBeenCalled();
    expect(logged('auth.tenant_switch')).toHaveLength(0);
    expect((await test.store.get(record.key))?.activeTenantId).toBe(TENANT_A);
  });

  it('FA-04 "Usar como padrão" na instituição já ativa: grava a padrão sem trocar nem logar troca', async () => {
    const { test, cookie, activateTenant } = await helena();
    const response = await switchTo(test, cookie, {
      membershipId: MEMBERSHIP_A.membershipId,
      setAsDefault: true,
    });
    expect(response.status).toBe(200);
    expect(activateTenant).toHaveBeenCalledWith(
      expect.objectContaining({ setAsDefault: true, fromTenantId: TENANT_A, tenantId: TENANT_A }),
    );
    expect(logged('auth.tenant_switch')).toHaveLength(0);
  });

  it('[Concorrência] dois cliques antes da primeira resposta: sessão consistente na B, uma única troca', async () => {
    const { test, cookie, record, activateTenant } = await helena();
    const body = { membershipId: MEMBERSHIP_B.membershipId };
    const [first, second] = await Promise.all([
      switchTo(test, cookie, body),
      switchTo(test, cookie, body),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
    // O segundo clique chega depois do primeiro e vira no-op (RN-IAM-70).
    expect(activateTenant).toHaveBeenCalledOnce();
    expect(logged('auth.tenant_switch')).toHaveLength(1);
    expect(await test.store.get(record.key)).toMatchObject({
      activeTenantId: TENANT_B,
      membershipId: MEMBERSHIP_B.membershipId,
    });
  });

  it('[Concorrência] renovação de token em outra requisição durante a troca não se perde', async () => {
    const { test, cookie, record, state } = await helena();
    const rotated = { ...record.tokens, accessToken: 'access-rotacionado', refreshToken: 'novo' };
    state.during = async () => {
      // Outra aba renovou os tokens enquanto a API conferia o vínculo.
      await test.store.update(record.key, (current) => ({ ...current, tokens: rotated }));
    };
    const response = await switchTo(test, cookie, { membershipId: MEMBERSHIP_B.membershipId });
    expect(response.status).toBe(200);
    const stored = await test.store.get(record.key);
    expect(stored?.activeTenantId).toBe(TENANT_B);
    expect(stored?.tokens).toEqual(rotated);
  });

  it('[Falha de banco] API sem banco ao revalidar → 503 DEPENDENCY_UNAVAILABLE e a sessão fica na A', async () => {
    const { test, cookie, record, state } = await helena();
    state.refusals.push('unavailable');
    const response = await switchTo(test, cookie, { membershipId: MEMBERSHIP_B.membershipId });
    expect(response.status).toBe(503);
    expect((await problem(response)).code).toBe('DEPENDENCY_UNAVAILABLE');
    expect((await test.store.get(record.key))?.activeTenantId).toBe(TENANT_A);
    expect(logged('auth.tenant_switch_rejected')).toHaveLength(0);
  });

  it('[Falha de banco] Redis de sessões fora ao gravar a troca → 503 com Retry-After', async () => {
    const { test, cookie } = await helena();
    vi.spyOn(test.store, 'update').mockRejectedValue(new SessionStoreUnavailableError());
    const response = await switchTo(test, cookie, { membershipId: MEMBERSHIP_B.membershipId });
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('5');
    expect((await problem(response)).code).toBe('DEPENDENCY_UNAVAILABLE');
  });
});

describe('[Falha de integração] Prefeitura B exige MFA (mfaPolicy ALL) e a sessão não tem', () => {
  /** Step-up completo pelo provedor fake (código `ana:mfa` → `amr` com `otp`). */
  async function stepUp(test: TestRuntime, cookie: string): Promise<Response> {
    const start = await handleAuthRequest(
      browserRequest(SWITCH_STEP_UP_URL, { headers: { Cookie: cookie } }),
      'step-up',
      test.runtime,
    );
    const url = new URL(start.headers.get('Location') ?? '');
    expect(url.searchParams.get('code')).toBe('ana:mfa');
    const transaction = /__Host-cf_auth_tx=([^;,]*)/.exec(start.headers.get('Set-Cookie') ?? '');
    return handleAuthRequest(
      browserRequest(`${url.pathname}${url.search}`, {
        headers: { Cookie: `${cookie}; ${LOGIN_TRANSACTION_COOKIE}=${transaction?.[1] ?? ''}` },
      }),
      'callback',
      test.runtime,
    );
  }

  it('o BFF manda ao step-up e só completa a troca depois dele', async () => {
    const { test, cookie, record, state, activateTenant } = await helena();
    state.refusals.push('mfa_required');
    const response = await switchTo(test, cookie, {
      membershipId: MEMBERSHIP_B.membershipId,
      setAsDefault: true,
    });
    expect(response.status).toBe(403);
    const body = await problem(response);
    expect(body).toMatchObject({ code: 'MFA_REQUIRED', stepUpUrl: SWITCH_STEP_UP_URL });
    expect(SWITCH_STEP_UP_URL).toBe('/api/auth/step-up?returnTo=%2Fpainel');
    expect(await test.store.get(record.key)).toMatchObject({
      activeTenantId: TENANT_A,
      pendingTenantSwitch: {
        membershipId: MEMBERSHIP_B.membershipId,
        tenantId: TENANT_B,
        setAsDefault: true,
      },
    });
    expect(logged('auth.tenant_switch_rejected')[0]).toMatchObject({ reason: 'MFA_REQUIRED' });

    const callback = await stepUp(test, cookie);
    expect(callback.status).toBe(302);
    expect(callback.headers.get('Location')).toBe('/painel');
    const stored = await test.store.get(record.key);
    expect(stored).toMatchObject({
      activeTenantId: TENANT_B,
      membershipId: MEMBERSHIP_B.membershipId,
      pendingTenantSwitch: null,
      amr: ['pwd', 'otp'],
    });
    expect(activateTenant).toHaveBeenLastCalledWith(
      expect.objectContaining({
        membershipId: MEMBERSHIP_B.membershipId,
        setAsDefault: true,
        fromTenantId: TENANT_A,
        accessToken: stored?.tokens.accessToken,
      }),
    );
    expect(logged('auth.tenant_switch')).toHaveLength(1);
  });

  it('recusada depois do step-up: sessão fica na A, pendência apagada e SCR-101 com aviso', async () => {
    const { test, cookie, record, state } = await helena();
    state.refusals.push('mfa_required', 'no_membership');
    await switchTo(test, cookie, { membershipId: MEMBERSHIP_B.membershipId });
    const callback = await stepUp(test, cookie);
    expect(callback.headers.get('Location')).toBe(SWITCH_NOT_COMPLETED_URL);
    expect(await test.store.get(record.key)).toMatchObject({
      activeTenantId: TENANT_A,
      pendingTenantSwitch: null,
    });
    expect(logged('auth.tenant_switch_rejected').at(-1)).toMatchObject({
      reason: 'no_membership',
      afterStepUp: true,
    });
  });

  it('pendência vencida (> 10 min) não é aplicada por um step-up posterior', async () => {
    const { test, cookie, record, state, activateTenant } = await helena();
    state.refusals.push('mfa_required');
    await switchTo(test, cookie, { membershipId: MEMBERSHIP_B.membershipId });
    test.clock.now += PENDING_SWITCH_TTL_MS + 1_000;
    // Mantém a sessão viva (ociosidade de 30 min não venceu): só a pendência expirou.
    const callback = await stepUp(test, cookie);
    expect(callback.headers.get('Location')).toBe('/painel');
    expect(activateTenant).toHaveBeenCalledOnce();
    expect(await test.store.get(record.key)).toMatchObject({
      activeTenantId: TENANT_A,
      pendingTenantSwitch: null,
    });
  });

  it('step-up sem pendência segue como antes (só troca os tokens)', async () => {
    const { test, cookie, record, activateTenant } = await helena();
    const callback = await stepUp(test, cookie);
    expect(callback.headers.get('Location')).toBe('/painel');
    expect(activateTenant).not.toHaveBeenCalled();
    expect((await test.store.get(record.key))?.activeTenantId).toBe(TENANT_A);
  });
});
