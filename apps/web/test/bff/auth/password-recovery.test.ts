import { describe, expect, it, vi } from 'vitest';

import type { LoginTransaction } from '@/bff/auth/login-transaction';
import {
  AuthentikPasswordRecovery,
  DEFAULT_RECOVERY_FLOW_SLUG,
  FakePasswordRecovery,
  PASSWORD_RESET_DONE_PATH,
  PasswordRecoveryUnavailableError,
  RECOVERY_RETURN_COOKIE,
  RECOVERY_RETURN_MAX_AGE_SECONDS,
  buildAuthentikRecoveryUrl,
  pendingReturnTo,
  recoveryReturnCookie,
} from '@/bff/auth/password-recovery';
import { IdentityProviderUnavailableError } from '@/bff/session/types';
import { requestUrl } from '@test/support/render';

/* US-089 — `BuildAuthentikRecoveryUrl`, sondagem do IdP e `returnTo` da recuperação (FA-05). */

const ISSUER = 'http://localhost:9080/application/o/contrataflow/';
const FLOW_URL = 'http://localhost:9080/if/flow/contrataflow-recovery/';
const NOW = Date.parse('2026-10-14T12:00:00Z');

function transaction(overrides: Partial<LoginTransaction> = {}): LoginTransaction {
  return {
    state: 's',
    nonce: 'n',
    codeVerifier: 'v',
    returnTo: '/processos/1',
    stepUp: false,
    createdAt: NOW,
    ...overrides,
  };
}

function recovery(fetchImpl: typeof fetch, clock = { now: NOW }) {
  return new AuthentikPasswordRecovery({
    issuerUrl: ISSUER,
    flowSlug: DEFAULT_RECOVERY_FLOW_SLUG,
    fetch: fetchImpl,
    now: () => clock.now,
  });
}

describe('buildAuthentikRecoveryUrl', () => {
  it('interface de flow do Authentik na origem do emissor, sem parâmetro algum (RN-IAM-34)', () => {
    const url = new URL(buildAuthentikRecoveryUrl(ISSUER, 'contrataflow-recovery'));
    expect(url.href).toBe(FLOW_URL);
    expect(url.search).toBe('');
    expect(url.hash).toBe('');
    expect(
      buildAuthentikRecoveryUrl('https://auth.contrataflow.com.br/application/o/x/', 'r'),
    ).toBe('https://auth.contrataflow.com.br/if/flow/r/');
  });
});

describe('AuthentikPasswordRecovery', () => {
  it('confere a página do flow (GET sem cookies, sem seguir redirecionamento) e devolve a URL', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('<html></html>', { status: 200 })),
    );
    expect(await recovery(fetchMock).recoveryUrl()).toBe(FLOW_URL);
    const [input, init] = fetchMock.mock.calls[0] ?? [];
    expect(requestUrl(input as RequestInfo)).toBe(FLOW_URL);
    expect(init?.redirect).toBe('manual');
    expect(init?.cache).toBe('no-store');
    expect(new Headers(init?.headers).get('cookie')).toBeNull();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('sondagem bem-sucedida vale 10 s; depois disso, confere de novo', async () => {
    const clock = { now: NOW };
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 200 })),
    );
    const subject = recovery(fetchMock, clock);
    await subject.recoveryUrl();
    clock.now += 9_999;
    await subject.recoveryUrl();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    clock.now += 1;
    await subject.recoveryUrl();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['flow inexistente (configuração errada)', 404],
    ['IdP com erro', 503],
    ['redirecionamento inesperado', 302],
  ])('%s → indisponível com o status do IdP', async (_case, status) => {
    const subject = recovery(() => Promise.resolve(new Response(null, { status })));
    const error = await subject.recoveryUrl().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PasswordRecoveryUnavailableError);
    expect(error).toBeInstanceOf(IdentityProviderUnavailableError);
    expect((error as PasswordRecoveryUnavailableError).providerStatus).toBe(status);
  });

  it('IdP fora do ar (rede/timeout) → indisponível sem status; falha não fica em cache', async () => {
    let down = true;
    const fetchMock = vi.fn<typeof fetch>(() =>
      down
        ? Promise.reject(new TypeError('fetch failed'))
        : Promise.resolve(new Response(null, { status: 200 })),
    );
    const subject = recovery(fetchMock);
    const error = await subject.recoveryUrl().catch((caught: unknown) => caught);
    expect((error as PasswordRecoveryUnavailableError).providerStatus).toBeNull();
    down = false;
    expect(await subject.recoveryUrl()).toBe(FLOW_URL);
  });

  it('IdP que volta a falhar depois de uma sondagem boa é detectado ao vencer o cache', async () => {
    const clock = { now: NOW };
    let status = 200;
    const subject = recovery(() => Promise.resolve(new Response(null, { status })), clock);
    await subject.recoveryUrl();
    status = 502;
    clock.now += 10_000;
    await expect(subject.recoveryUrl()).rejects.toBeInstanceOf(PasswordRecoveryUnavailableError);
  });
});

describe('FakePasswordRecovery (FA-06 da US-086)', () => {
  it('simula o flow concluído: volta direto para /entrar?motivo=senha-redefinida', async () => {
    expect(await new FakePasswordRecovery('http://localhost:3000').recoveryUrl()).toBe(
      `http://localhost:3000${PASSWORD_RESET_DONE_PATH}`,
    );
  });
});

describe('returnTo da recuperação (FA-05)', () => {
  it('cookie __Host- HttpOnly, Secure, Lax, com 1 h de validade; sem destino próprio, apaga', () => {
    expect(recoveryReturnCookie('/processos?x=1')).toBe(
      `${RECOVERY_RETURN_COOKIE}=%2Fprocessos%3Fx%3D1; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${RECOVERY_RETURN_MAX_AGE_SECONDS}`,
    );
    expect(recoveryReturnCookie(null)).toMatch(
      new RegExp(`^${RECOVERY_RETURN_COOKIE}=;.*Max-Age=0`),
    );
    // O destino padrão não precisa ser guardado.
    expect(recoveryReturnCookie('/painel')).toContain('Max-Age=0');
  });

  it('prefere o cookie da recuperação, revalidado (RN-IAM-03)', () => {
    expect(
      pendingReturnTo({
        recoveryCookie: encodeURIComponent('/processos?x=1'),
        transactions: [transaction({ returnTo: '/tarefas' })],
      }),
    ).toBe('/processos?x=1');
    // Cookie adulterado (destino externo ou codificação inválida) é ignorado.
    expect(
      pendingReturnTo({ recoveryCookie: encodeURIComponent('//evil.com'), transactions: [] }),
    ).toBeNull();
    expect(pendingReturnTo({ recoveryCookie: '%E0%A4%A', transactions: [] })).toBeNull();
  });

  it('recuperação iniciada no formulário do Authentik: usa o login em curso mais recente', () => {
    expect(
      pendingReturnTo({
        recoveryCookie: null,
        transactions: [
          transaction({ returnTo: '/antigo', createdAt: NOW - 60_000 }),
          transaction({ returnTo: '/recente', createdAt: NOW }),
          transaction({ returnTo: '/step-up', createdAt: NOW + 1, stepUp: true }),
        ],
      }),
    ).toBe('/recente');
    expect(
      pendingReturnTo({
        recoveryCookie: null,
        transactions: [transaction({ returnTo: '/painel' })],
      }),
    ).toBeNull();
    expect(pendingReturnTo({ recoveryCookie: null, transactions: [] })).toBeNull();
  });
});
