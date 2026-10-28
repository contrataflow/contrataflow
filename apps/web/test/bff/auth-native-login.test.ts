import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LoginChallengeStore,
  MemoryLoginChallengeBackend,
  RedisLoginChallengeBackend,
} from '@/bff/auth/login-challenge';
import type { PasswordLogin } from '@/bff/auth/password-login';
import { UnconfiguredPasswordLogin } from '@/bff/auth/password-login';
import { RECOVERY_RETURN_COOKIE } from '@/bff/auth/password-recovery';
import { handleAuthRequest } from '@/bff/auth-handler';
import { deriveKey } from '@/bff/crypto';
import { captureLogsForTests } from '@/bff/logger';
import { LOGIN_USER_ATTEMPTS } from '@/bff/runtime';
import { FAKE_MFA_CODE, FAKE_PASSWORD } from '@/bff/session/fake-identity';
import { MemorySessionStore } from '@/bff/session/memory-store';
import { hashSessionId } from '@/bff/session/session-service';
import { SessionStoreUnavailableError } from '@/bff/session/types';
import type { SessionDirectory } from '@/bff/session/types';
import { browserRequest, createTestRuntime } from '@test/support/bff';
import type { TestRuntime } from '@test/support/bff';

/*
 * Login nativo `POST /api/auth/login` (DEC-187 · SCR-001 · US-090): usuário e senha na tela do
 * ContrataFlow, conduzidos pelo BFF no *flow* do IdP. Provedor fake (pessoas do diretório fake,
 * senha `FAKE_PASSWORD`, `lucia` com MFA); o cliente do executor do Authentik tem testes próprios.
 */

const MUTATION = { 'X-CF-Request': '1', 'Sec-Fetch-Site': 'same-origin' };
/** Atrás do balanceador (TRUSTED_PROXY_CIDRS = 10.0.0.0/8): IP real do cliente. */
const BEHIND_ALB = { 'X-Forwarded-For': '203.0.113.7, 10.0.0.2', 'User-Agent': 'Vitest/1.0' };
const TENANT_A = '0192a000-0000-7000-8000-00000000000a';

let logs: ReturnType<typeof captureLogsForTests>;

beforeEach(() => {
  logs = captureLogsForTests();
});

afterEach(() => {
  logs.restore();
});

function logged(event: string): Record<string, unknown>[] {
  return logs.lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.event === event);
}

function post(
  test: TestRuntime,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return handleAuthRequest(
    browserRequest('/api/auth/login', {
      method: 'POST',
      headers: { ...MUTATION, ...BEHIND_ALB, 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    'login',
    test.runtime,
  );
}

interface Done {
  readonly data: { readonly step: 'done'; readonly redirectTo: string };
}
interface Mfa {
  readonly data: {
    readonly step: 'mfa';
    readonly transaction: string;
    readonly methods: readonly string[];
  };
}
interface Problem {
  readonly code: string;
  readonly errors: readonly { readonly field: string; readonly code: string }[];
}

function sessionIdFrom(response: Response): string | null {
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith('__Host-cf_session='));
  return cookie ? (/^__Host-cf_session=([^;]*)/.exec(cookie)?.[1] ?? null) : null;
}

async function startMfa(test: TestRuntime, returnTo = '/processos'): Promise<string> {
  const response = await post(test, { username: 'lucia', password: FAKE_PASSWORD, returnTo });
  const body = (await response.json()) as Mfa;
  return body.data.transaction;
}

describe('Feature: login nativo pelo executor de fluxos do IdP (DEC-187)', () => {
  it('[Sucesso] usuário e senha certos: sessão segura, instituição automática e o destino pedido', async () => {
    const test = createTestRuntime();
    const response = await post(test, {
      username: ' Ana ',
      password: FAKE_PASSWORD,
      returnTo: '/processos/0192aa',
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await response.json()).toEqual({
      data: { step: 'done', redirectTo: '/processos/0192aa' },
    });
    const sid = sessionIdFrom(response) ?? '';
    expect(sid).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const record = await test.store.get(hashSessionId(sid));
    expect(record).toMatchObject({ activeTenantId: TENANT_A, amr: ['pwd'], ip: '203.0.113.7' });
    // Auditoria: tentativa aceita e sessão criada, sem o nome de usuário em claro.
    expect(logged('auth.login_succeeded')[0]).toMatchObject({ mfa: false, ip: '203.0.113.x' });
    expect(logged('auth.session_created')).toHaveLength(1);
    expect(logs.lines.join(' ')).not.toMatch(/\bana\b/i);
  });

  it('[Sucesso] usuário com MFA: etapa de código e, com o código certo, a sessão com otp', async () => {
    const test = createTestRuntime();
    const first = await post(test, { username: 'lucia', password: FAKE_PASSWORD });
    expect(first.status).toBe(200);
    const mfa = (await first.json()) as Mfa;
    expect(mfa.data).toMatchObject({ step: 'mfa', methods: ['totp'] });
    expect(mfa.data.transaction).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sessionIdFrom(first)).toBeNull();
    expect(logged('auth.mfa_required')[0]).toMatchObject({ methods: 'totp' });

    const second = await post(test, { transaction: mfa.data.transaction, code: FAKE_MFA_CODE });
    expect(await second.json()).toEqual({ data: { step: 'done', redirectTo: '/painel' } });
    const record = await test.store.get(hashSessionId(sessionIdFrom(second) ?? ''));
    expect(record?.amr).toEqual(['pwd', 'otp']);
    expect(logged('auth.login_succeeded')[0]).toMatchObject({ mfa: true });
  });

  it('[Validação] campos vazios ou longos demais → 422 com o campo; código fora do formato → 422', async () => {
    const test = createTestRuntime();
    const empty = await post(test, { username: '  ', password: '' });
    expect(empty.status).toBe(422);
    const body = (await empty.json()) as Problem;
    expect(body.errors.map((error) => [error.field, error.code])).toEqual([
      ['username', 'REQUIRED'],
      ['password', 'REQUIRED'],
    ]);
    const long = (await (
      await post(test, { username: 'a'.repeat(255), password: 'b'.repeat(1025) })
    ).json()) as Problem;
    expect(long.errors.map((error) => error.code)).toEqual(['TOO_LONG', 'TOO_LONG']);
    const code = (await (await post(test, { transaction: 'x', code: '12ab' })).json()) as Problem;
    expect(code.errors).toMatchObject([{ field: 'code', code: 'INVALID_FORMAT' }]);
    expect((await post(test, '{nao-json')).status).toBe(400);
    expect((await post(test, '[1]')).status).toBe(400);
  });

  it('[Validação] senha errada e usuário inexistente recebem a mesma resposta genérica (RN-IAM-18)', async () => {
    const test = createTestRuntime();
    const wrong = await post(test, { username: 'ana', password: 'errada' });
    const unknown = await post(test, { username: 'ninguem', password: 'errada' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    const strip = (problem: Record<string, unknown>) => ({
      ...problem,
      correlationId: undefined,
    });
    expect(strip((await wrong.json()) as Record<string, unknown>)).toEqual(
      strip((await unknown.json()) as Record<string, unknown>),
    );
    expect(logged('auth.login_failed').map((entry) => entry.reason)).toEqual([
      'INVALID_CREDENTIALS',
      'INVALID_CREDENTIALS',
    ]);
    expect(test.store.size).toBe(0);
  });

  it('[Validação] returnTo externo é descartado: entra e vai ao início', async () => {
    const test = createTestRuntime();
    const response = await post(test, {
      username: 'ana',
      password: FAKE_PASSWORD,
      returnTo: 'https://evil.com/x',
    });
    expect(((await response.json()) as Done).data.redirectTo).toBe('/painel');
    expect(logged('auth.return_to_rejected')).toHaveLength(1);
  });

  it('[Validação] CSRF: sem X-CF-Request ou de outra origem → 403 antes de falar com o IdP', async () => {
    const authenticate = vi.fn<PasswordLogin['authenticate']>();
    const test = createTestRuntime({
      passwordLogin: { authenticate, verifyCode: vi.fn() },
    });
    const missing = await handleAuthRequest(
      browserRequest('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: 'ana', password: FAKE_PASSWORD }),
      }),
      'login',
      test.runtime,
    );
    expect(missing.status).toBe(403);
    const crossSite = await post(
      test,
      { username: 'ana', password: FAKE_PASSWORD },
      { 'Sec-Fetch-Site': 'cross-site' },
    );
    expect(((await crossSite.json()) as Problem).code).toBe('CSRF_REJECTED');
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('[Permissão] conta bloqueada pelo IdP → LOCKED; bloqueada pela plataforma → página 403, sem sessão', async () => {
    const test = createTestRuntime();
    const locked = await post(test, { username: 'bloqueada', password: FAKE_PASSWORD });
    expect(locked.status).toBe(403);
    expect(((await locked.json()) as Problem).code).toBe('LOCKED');
    const blocked = await post(test, { username: 'eva', password: FAKE_PASSWORD });
    expect(await blocked.json()).toEqual({
      data: { step: 'done', redirectTo: '/erro/acesso-bloqueado' },
    });
    expect(sessionIdFrom(blocked)).toBeNull();
    expect(test.store.size).toBe(0);
    expect(logged('auth.login_failed').map((entry) => entry.reason)).toEqual([
      'LOCKED',
      'USER_BLOCKED',
    ]);
  });

  it('[Tenant incorreto] tenant no corpo é ignorado: vale a instituição resolvida pela API', async () => {
    const test = createTestRuntime();
    const response = await post(test, {
      username: 'ana',
      password: FAKE_PASSWORD,
      tenantId: '0192a000-0000-7000-8000-00000000000b',
      membershipId: '0192a000-0000-7000-8000-0000000002a1',
    });
    const record = await test.store.get(hashSessionId(sessionIdFrom(response) ?? ''));
    expect(record?.activeTenantId).toBe(TENANT_A);
  });

  it('[Duplicidade] novo login no mesmo navegador encerra a sessão anterior (anti-fixação)', async () => {
    const test = createTestRuntime();
    const first = await post(test, { username: 'ana', password: FAKE_PASSWORD });
    const firstId = sessionIdFrom(first) ?? '';
    const second = await post(
      test,
      { username: 'ana', password: FAKE_PASSWORD },
      { Cookie: `__Host-cf_session=${firstId}` },
    );
    expect(sessionIdFrom(second)).not.toBe(firstId);
    expect(test.store.size).toBe(1);
    expect(test.store.endings().map((ending) => ending.reason)).toEqual(['LOGOUT']);
  });

  it('[Duplicidade] a transação de MFA é de uso único: reenviar o código depois de entrar → MFA_EXPIRED', async () => {
    const test = createTestRuntime();
    const transaction = await startMfa(test);
    expect((await post(test, { transaction, code: FAKE_MFA_CODE })).status).toBe(200);
    const again = await post(test, { transaction, code: FAKE_MFA_CODE });
    expect(again.status).toBe(401);
    expect(((await again.json()) as Problem).code).toBe('MFA_EXPIRED');
    expect(test.store.size).toBe(1);
  });

  it('[Concorrência] dois envios simultâneos do mesmo código: um entra, o outro expira', async () => {
    const test = createTestRuntime();
    const transaction = await startMfa(test);
    const results = await Promise.all([
      post(test, { transaction, code: FAKE_MFA_CODE }),
      post(test, { transaction, code: FAKE_MFA_CODE }),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 401]);
    expect(test.store.size).toBe(1);
  });

  it('código errado mantém a transação; 5 erros ou 5 min encerram a etapa (MFA_EXPIRED)', async () => {
    const test = createTestRuntime();
    const transaction = await startMfa(test);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const wrong = await post(test, { transaction, code: '000000' });
      expect(((await wrong.json()) as Problem).code).toBe('MFA_INVALID');
    }
    const fifth = await post(test, { transaction, code: '000000' });
    expect(((await fifth.json()) as Problem).code).toBe('MFA_EXPIRED');
    const after = await post(test, { transaction, code: FAKE_MFA_CODE });
    expect(((await after.json()) as Problem).code).toBe('MFA_EXPIRED');

    const late = await startMfa(test);
    test.clock.now += 5 * 60_000;
    const expired = await post(test, { transaction: late, code: FAKE_MFA_CODE });
    expect(((await expired.json()) as Problem).code).toBe('MFA_EXPIRED');
    expect(test.store.size).toBe(0);
  });

  it('RN-IAM-15: limite por IP (20/min) e por usuário (10 falhas a cada 15 min) → 429 com Retry-After', async () => {
    const test = createTestRuntime();
    // Logins concluídos não gastam o limite por usuário.
    for (let attempt = 0; attempt < LOGIN_USER_ATTEMPTS + 2; attempt += 1) {
      const response = await post(
        test,
        { username: 'ana', password: FAKE_PASSWORD },
        { 'X-Forwarded-For': `198.51.100.${attempt + 100}, 10.0.0.2` },
      );
      expect(response.status).toBe(200);
    }
    for (let attempt = 0; attempt < LOGIN_USER_ATTEMPTS; attempt += 1) {
      const response = await post(
        test,
        { username: 'ana', password: 'errada' },
        { 'X-Forwarded-For': `198.51.100.${attempt}, 10.0.0.2` },
      );
      expect(response.status).toBe(401);
    }
    // Outro IP, mesmo usuário (com caixa e espaços diferentes): o limite é do usuário.
    const perUser = await post(
      test,
      { username: ' ANA ', password: FAKE_PASSWORD },
      { 'X-Forwarded-For': '198.51.100.99, 10.0.0.2' },
    );
    expect(perUser.status).toBe(429);
    expect(Number(perUser.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(logged('auth.rate_limited')[0]).toMatchObject({ scope: 'user' });

    const other = createTestRuntime();
    let last: Response | undefined;
    for (let attempt = 0; attempt <= 20; attempt += 1) {
      last = await post(other, { username: `pessoa${attempt}`, password: 'x' });
    }
    expect(last?.status).toBe(429);
  });

  it('[Falha de integração] IdP fora do ar ou não configurado → 503 IDP_UNAVAILABLE, sem sessão', async () => {
    const test = createTestRuntime();
    const down = await post(test, { username: 'indisponivel', password: FAKE_PASSWORD });
    expect(down.status).toBe(503);
    expect(((await down.json()) as Problem).code).toBe('IDP_UNAVAILABLE');
    expect(logged('auth.login_unavailable')[0]).toMatchObject({ step: 'flow' });

    const unconfigured = createTestRuntime({ passwordLogin: new UnconfiguredPasswordLogin() });
    const response = await post(unconfigured, { username: 'ana', password: FAKE_PASSWORD });
    expect(((await response.json()) as Problem).code).toBe('IDP_UNAVAILABLE');
    expect(await new UnconfiguredPasswordLogin().verifyCode()).toMatchObject({
      kind: 'unavailable',
      failure: { step: 'config' },
    });
    expect(test.store.size + unconfigured.store.size).toBe(0);
  });

  it('[Falha de integração] IdP fora na etapa de código: 503, e a mesma transação vale depois', async () => {
    const test = createTestRuntime();
    const transaction = await startMfa(test);
    const verifyCode = vi.spyOn(test.runtime.passwordLogin, 'verifyCode');
    verifyCode.mockResolvedValueOnce({
      kind: 'unavailable',
      failure: { step: 'mfa', providerStatus: null, component: null },
    });
    expect((await post(test, { transaction, code: FAKE_MFA_CODE })).status).toBe(503);
    expect((await post(test, { transaction, code: FAKE_MFA_CODE })).status).toBe(200);
  });

  it('[Falha de banco] API indisponível no início da sessão → manutenção com correlationId', async () => {
    const directory: SessionDirectory = {
      startSession: () => Promise.resolve({ kind: 'unavailable' }),
      activateTenant: () => Promise.resolve({ kind: 'unavailable' }),
    };
    const test = createTestRuntime({ directory });
    const response = await post(test, { username: 'ana', password: FAKE_PASSWORD });
    const { data } = (await response.json()) as Done;
    expect(data.redirectTo).toMatch(/^\/erro\/manutencao\?codigo=.+&retorno=%2Fpainel$/);
    expect(test.store.size).toBe(0);
    expect(logged('auth.login_failed')[0]).toMatchObject({ reason: 'DIRECTORY_UNAVAILABLE' });
  });

  it('[Falha de integração] Redis de sessões fora (sessão ou transação de MFA) → 503 com Retry-After', async () => {
    const failing = new MemorySessionStore();
    vi.spyOn(failing, 'create').mockRejectedValue(new SessionStoreUnavailableError());
    const test = createTestRuntime({ sessionStore: failing });
    const response = await post(test, { username: 'ana', password: FAKE_PASSWORD });
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('5');
    expect(sessionIdFrom(response)).toBeNull();

    const backend = new MemoryLoginChallengeBackend();
    vi.spyOn(backend, 'put').mockRejectedValue(new SessionStoreUnavailableError());
    const mfa = createTestRuntime({ loginChallenges: backend });
    const opening = await post(mfa, { username: 'lucia', password: FAKE_PASSWORD });
    expect(opening.status).toBe(503);
    expect(((await opening.json()) as Problem).code).toBe('DEPENDENCY_UNAVAILABLE');
  });

  it('a senha nunca vai para log, resposta ou Redis — nem quando o IdP explode', async () => {
    const secret = 'S3nh@-Ultra-Secreta';
    const backend = new MemoryLoginChallengeBackend();
    const put = vi.spyOn(backend, 'put');
    const test = createTestRuntime({ loginChallenges: backend });
    const answers = [
      await post(test, { username: 'ana', password: secret }),
      await post(test, { username: 'lucia', password: FAKE_PASSWORD }),
    ];
    const exploding = createTestRuntime({
      passwordLogin: {
        authenticate: (credentials) =>
          Promise.reject(new Error(`falhou com ${credentials.password}`)),
        verifyCode: vi.fn(),
      },
    });
    const crashed = await post(exploding, { username: 'ana', password: secret });
    expect(crashed.status).toBe(500);
    const everything = [
      ...logs.lines,
      ...(await Promise.all([...answers, crashed].map((response) => response.text()))),
      ...put.mock.calls.map(([, value]) => value),
    ].join(' ');
    expect(everything).not.toContain(secret);
    expect(everything).not.toContain(FAKE_PASSWORD);
    // A transação no Redis é cifrada: nem os cookies do IdP aparecem.
    expect(put.mock.calls[0]?.[1]).not.toContain('lucia');
  });

  it('limpa o destino guardado pela recuperação de senha ao entrar (FA-05 da US-089)', async () => {
    const test = createTestRuntime();
    const response = await post(
      test,
      { username: 'ana', password: FAKE_PASSWORD, returnTo: '/tarefas' },
      { Cookie: `${RECOVERY_RETURN_COOKIE}=%2Ftarefas` },
    );
    expect(
      response.headers
        .getSetCookie()
        .some((cookie) => cookie.startsWith(`${RECOVERY_RETURN_COOKIE}=;`)),
    ).toBe(true);
  });

  it('rota aceita GET e POST; outro método → 405 com Allow', async () => {
    const test = createTestRuntime();
    const response = await handleAuthRequest(
      browserRequest('/api/auth/login', { method: 'PUT' }),
      'login',
      test.runtime,
    );
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET, POST');
  });
});

describe('LoginChallengeStore (transação de MFA no Redis de sessões)', () => {
  const key = deriveKey(Buffer.alloc(32, 7), 'login-challenge');

  it('cifra com AAD da chave: valor adulterado ou de outra chave não abre', async () => {
    const backend = new MemoryLoginChallengeBackend(() => 0);
    const store = new LoginChallengeStore(backend, {
      key,
      keyPrefix: 'cf:test:login-mfa:',
      now: () => 0,
    });
    const id = await store.open({ cookies: { authentik_session: 's' } }, '/painel', 'u');
    const put = vi.spyOn(backend, 'take').mockResolvedValueOnce('adulterado');
    expect(await store.take(id)).toBeNull();
    put.mockRestore();
    const other = new LoginChallengeStore(backend, {
      key: deriveKey(Buffer.alloc(32, 8), 'login-challenge'),
      keyPrefix: 'cf:test:login-mfa:',
      now: () => 0,
    });
    expect(await other.take(id)).toBeNull();
  });

  it('Redis: SET PXAT + GETDEL; erro do Redis vira SessionStoreUnavailableError', async () => {
    const values = new Map<string, string>();
    const redis = {
      set: vi.fn((name: string, value: string) => {
        values.set(name, value);
        return Promise.resolve('OK');
      }),
      getdel: vi.fn((name: string) => {
        const value = values.get(name) ?? null;
        values.delete(name);
        return Promise.resolve(value);
      }),
    };
    const store = new LoginChallengeStore(new RedisLoginChallengeBackend(redis), {
      key,
      keyPrefix: 'cf:test:login-mfa:',
      now: () => 1_000,
    });
    const id = await store.open({ cookies: {} }, '/painel', 'u');
    expect(redis.set).toHaveBeenCalledWith(
      expect.stringMatching(/^cf:test:login-mfa:[0-9a-f]{64}$/),
      expect.any(String),
      'PXAT',
      301_000,
    );
    expect(await store.take(id)).toMatchObject({ returnTo: '/painel', attempts: 0 });
    expect(await store.take(id)).toBeNull();

    redis.getdel.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(store.take(id)).rejects.toBeInstanceOf(SessionStoreUnavailableError);
    redis.set.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(store.open({ cookies: {} }, '/', 'u')).rejects.toBeInstanceOf(
      SessionStoreUnavailableError,
    );
  });
});
