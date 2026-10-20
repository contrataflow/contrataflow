import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { TokenVerificationError } from '#shared/auth/ports.js';

import { FakeJwksProvider } from './fake-jwks.provider.js';

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const seconds = NOW / 1000;

function provider(signingKey: string | null = 'k'.repeat(32)): FakeJwksProvider {
  return new FakeJwksProvider({
    signingKey,
    issuer: 'https://issuer.test/',
    audiences: ['contrataflow-api', 'contrataflow-web'],
    clockToleranceSeconds: 30,
    now: () => NOW,
  });
}

async function rejection(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(TokenVerificationError);
  return (error as TokenVerificationError).reason;
}

describe('FakeJwksProvider (FA-02)', () => {
  it('aceita token válido e devolve sub, amr e auth_time', async () => {
    const jwks = provider();
    const token = jwks.sign({ sub: 'sub-ana', amr: ['pwd', 'otp'], auth_time: seconds - 60 });
    await expect(jwks.verify(token)).resolves.toEqual({
      subject: 'sub-ana',
      amr: ['pwd', 'otp'],
      authTime: new Date(NOW - 60_000),
      email: null,
      emailVerified: false,
    });
  });

  it('aceita qualquer das audiências configuradas e tolerância de relógio', async () => {
    const jwks = provider();
    await expect(
      jwks.verify(jwks.sign({ sub: 's', aud: ['outra', 'contrataflow-web'], exp: seconds - 10 })),
    ).resolves.toMatchObject({ subject: 's', amr: [], authTime: null });
  });

  it.each<[string, () => string, 'EXPIRED' | 'INVALID']>([
    ['assinatura de outra chave', () => provider('x'.repeat(32)).sign({ sub: 's' }), 'INVALID'],
    ['formato inválido', () => 'a.b', 'INVALID'],
    ['issuer diferente', () => provider().sign({ sub: 's', iss: 'https://outro/' }), 'INVALID'],
    ['audiência diferente', () => provider().sign({ sub: 's', aud: 'outra' }), 'INVALID'],
    ['nbf no futuro', () => provider().sign({ sub: 's', nbf: seconds + 120 }), 'INVALID'],
    ['sub vazio', () => provider().sign({ sub: '' }), 'INVALID'],
    ['expirado', () => provider().sign({ sub: 's', exp: seconds - 31 }), 'EXPIRED'],
  ])('recusa %s', async (_name, token, reason) => {
    expect(await rejection(provider().verify(token()))).toBe(reason);
  });

  it('recusa alg diferente de HS256 e payload ilegível mesmo com assinatura válida', async () => {
    const jwks = provider();
    const signed = (header: string, payload: string) =>
      `${header}.${payload}.${createHmac('sha256', 'k'.repeat(32)).update(`${header}.${payload}`).digest('base64url')}`;
    const [, payload] = jwks.sign({ sub: 's' }).split('.') as [string, string];
    const none = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    const hs256 = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
    expect(await rejection(jwks.verify(signed(none, payload)))).toBe('INVALID');
    expect(await rejection(jwks.verify(signed(hs256, 'nao-json')))).toBe('INVALID');
  });

  it('sem chave configurada usa chave aleatória: nenhum token externo é aceito', async () => {
    const forged = provider('k'.repeat(32)).sign({ sub: 's' });
    expect(await rejection(provider(null).verify(forged))).toBe('INVALID');
  });
});
