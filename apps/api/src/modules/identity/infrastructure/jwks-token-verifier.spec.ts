import { Logger } from '@nestjs/common';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { JWK, JWTPayload } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { TokenVerificationError, TokenVerifierUnavailableError } from '#shared/auth/ports.js';

import { JwksTokenVerifier } from './jwks-token-verifier.js';

/* RN-IAM-05: validação do access token do Authentik pelo JWKS em cache. */

const ISSUER = 'http://localhost:9080/application/o/contrataflow/';
const JWKS_URI = 'http://localhost:9080/application/o/contrataflow/jwks/';
const AUDIENCE = 'contrataflow-web';
const NOW = Date.parse('2026-10-14T12:00:00Z');

type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

interface SigningKey {
  readonly kid: string;
  readonly alg: 'RS256' | 'ES256';
  readonly privateKey: PrivateKey;
  readonly jwk: JWK;
}

async function signingKey(kid: string, alg: 'RS256' | 'ES256'): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg, use: 'sig' };
  return { kid, alg, privateKey, jwk };
}

function sign(key: SigningKey, claims: JWTPayload = {}, now = NOW) {
  const seconds = Math.floor(now / 1000);
  return new SignJWT({
    iss: ISSUER,
    aud: AUDIENCE,
    sub: '0192f000-0000-7000-8000-000000000001',
    iat: seconds,
    exp: seconds + 300,
    amr: ['pwd'],
    auth_time: seconds - 60,
    ...claims,
  })
    .setProtectedHeader({ alg: key.alg, kid: key.kid, typ: 'JWT' })
    .sign(key.privateKey);
}

/** Authentik simulado: descoberta + JWKS; `down` derruba as respostas. */
function fakeIdp(initial: readonly SigningKey[]) {
  const state = { keys: [...initial], down: false, issuer: ISSUER };
  const fetchMock = vi.fn<typeof fetch>((input) => {
    if (state.down) return Promise.reject(new TypeError('fetch failed'));
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/.well-known/openid-configuration')) {
      return Promise.resolve(Response.json({ issuer: state.issuer, jwks_uri: JWKS_URI }));
    }
    if (url === JWKS_URI) {
      return Promise.resolve(Response.json({ keys: state.keys.map((key) => key.jwk) }));
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  });
  const jwksCalls = () => fetchMock.mock.calls.filter(([input]) => input === JWKS_URI).length;
  return { state, fetch: fetchMock, jwksCalls };
}

function verifier(idp: ReturnType<typeof fakeIdp>, clock = { now: NOW }) {
  return new JwksTokenVerifier({
    issuer: ISSUER,
    audiences: ['contrataflow-api', AUDIENCE],
    clockToleranceSeconds: 60,
    fetch: idp.fetch,
    now: () => clock.now,
  });
}

let rs: SigningKey;
let es: SigningKey;
let rotated: SigningKey;

beforeAll(async () => {
  [rs, es, rotated] = await Promise.all([
    signingKey('kid-rs', 'RS256'),
    signingKey('kid-es', 'ES256'),
    signingKey('kid-rotated', 'RS256'),
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('JwksTokenVerifier — validação (RN-IAM-05)', () => {
  it('[Sucesso] aceita RS256 e ES256 pelo JWKS da descoberta e devolve as claims', async () => {
    const idp = fakeIdp([rs, es]);
    const subject = verifier(idp);
    const token = await sign(rs, {
      amr: ['pwd', 'otp'],
      email: 'ana@prefeitura-a.test',
      email_verified: true,
    });
    await expect(subject.verify(token)).resolves.toEqual({
      subject: '0192f000-0000-7000-8000-000000000001',
      amr: ['pwd', 'otp'],
      authTime: new Date(NOW - 60_000),
      email: 'ana@prefeitura-a.test',
      emailVerified: true,
    });
    await expect(subject.verify(await sign(es))).resolves.toMatchObject({ emailVerified: false });
    // Uma descoberta e um JWKS para os dois tokens (cache de 10 min).
    expect(idp.fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['iss diferente', { iss: 'https://outro-idp.test/' }],
    ['aud de outro cliente', { aud: 'outro-cliente' }],
    ['nbf no futuro além da tolerância', { nbf: Math.floor(NOW / 1000) + 120 }],
    ['sem sub', { sub: '' }],
  ])('[Validação] recusa %s com INVALID', async (_case, claims) => {
    const subject = verifier(fakeIdp([rs]));
    const token = await sign(rs, claims);
    await expect(subject.verify(token)).rejects.toMatchObject({ reason: 'INVALID' });
  });

  it('[Validação] token expirado além da tolerância de 60 s → EXPIRED; dentro dela, aceito', async () => {
    const clock = { now: NOW };
    const subject = verifier(fakeIdp([rs]), clock);
    const token = await sign(rs);
    clock.now = NOW + 300_000 + 59_000;
    await expect(subject.verify(token)).resolves.toBeDefined();
    clock.now = NOW + 300_000 + 61_000;
    await expect(subject.verify(token)).rejects.toMatchObject({ reason: 'EXPIRED' });
  });

  it('[Validação] alg none, HS256 e lixo são recusados sem consultar o IdP', async () => {
    const idp = fakeIdp([rs]);
    const subject = verifier(idp);
    const payload = Buffer.from(JSON.stringify({ sub: 'x', iss: ISSUER, aud: AUDIENCE })).toString(
      'base64url',
    );
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${payload}.`;
    const hs = `${Buffer.from('{"alg":"HS256","kid":"kid-rs"}').toString('base64url')}.${payload}.c2ln`;
    for (const token of [none, hs, 'nao-e-jwt']) {
      await expect(subject.verify(token)).rejects.toBeInstanceOf(TokenVerificationError);
    }
    expect(idp.fetch).not.toHaveBeenCalled();
  });

  it('[Validação] assinatura de outra chave com o mesmo kid é recusada', async () => {
    const impostor = await signingKey('kid-rs', 'RS256');
    const subject = verifier(fakeIdp([rs]));
    await expect(subject.verify(await sign(impostor))).rejects.toMatchObject({ reason: 'INVALID' });
  });

  it('descoberta com issuer divergente: chaves indisponíveis (503), nunca aceitas', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const idp = fakeIdp([rs]);
    idp.state.issuer = 'https://outro.test/';
    await expect(verifier(idp).verify(await sign(rs))).rejects.toBeInstanceOf(
      TokenVerifierUnavailableError,
    );
  });
});

describe('JwksTokenVerifier — rotação e indisponibilidade do JWKS', () => {
  it('kid desconhecido força a renovação: chave rotacionada é aceita', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const idp = fakeIdp([rs]);
    const subject = verifier(idp);
    await subject.verify(await sign(rs));
    idp.state.keys = [rs, rotated];
    await expect(subject.verify(await sign(rotated))).resolves.toBeDefined();
    expect(idp.jwksCalls()).toBe(2);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'auth.jwks_refresh',
        reason: 'unknown_kid',
        result: 'success',
      }),
      'auth.jwks_refresh',
    );
  });

  it('kid aleatório: no máximo uma renovação a cada 30 s (proteção contra abuso)', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const clock = { now: NOW };
    const idp = fakeIdp([rs]);
    const subject = verifier(idp, clock);
    await subject.verify(await sign(rs));
    const forged = await signingKey('kid-forjado', 'RS256');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(subject.verify(await sign(forged))).rejects.toMatchObject({ reason: 'INVALID' });
    }
    expect(idp.jwksCalls()).toBe(2);
    clock.now += 31_000;
    await expect(subject.verify(await sign(forged))).rejects.toMatchObject({ reason: 'INVALID' });
    expect(idp.jwksCalls()).toBe(3);
  });

  it('[Falha de integração] JWKS fora do ar: chave conhecida aceita; kid desconhecido → 503 + alerta', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const clock = { now: NOW };
    const idp = fakeIdp([rs]);
    const subject = verifier(idp, clock);
    await subject.verify(await sign(rs));
    idp.state.down = true;
    // Cache vencido (> 10 min) e IdP fora: segue com as chaves conhecidas.
    clock.now += 11 * 60_000;
    await expect(subject.verify(await sign(rs, {}, clock.now))).resolves.toBeDefined();
    clock.now += 31_000;
    await expect(subject.verify(await sign(rotated, {}, clock.now))).rejects.toBeInstanceOf(
      TokenVerifierUnavailableError,
    );
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'auth.jwks_refresh', result: 'failure', alert: true }),
      'auth.jwks_refresh',
    );
  });

  it('sem chave alguma em cache e IdP fora do ar: indisponível (503), nunca 401', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const idp = fakeIdp([rs]);
    idp.state.down = true;
    const subject = verifier(idp);
    await expect(subject.verify(await sign(rs))).rejects.toBeInstanceOf(
      TokenVerifierUnavailableError,
    );
    // Dentro do intervalo de 30 s não tenta de novo, e continua indisponível.
    await expect(subject.verify(await sign(rs))).rejects.toBeInstanceOf(
      TokenVerifierUnavailableError,
    );
    expect(idp.fetch).toHaveBeenCalledTimes(1);
  });

  it('requisições simultâneas compartilham a mesma renovação', async () => {
    const idp = fakeIdp([rs]);
    const subject = verifier(idp);
    const token = await sign(rs);
    await Promise.all([subject.verify(token), subject.verify(token), subject.verify(token)]);
    expect(idp.jwksCalls()).toBe(1);
  });

  it('jwksUri explícito dispensa a descoberta; JWKS malformado conta como falha', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ chaves: [] })));
    const subject = new JwksTokenVerifier({
      issuer: ISSUER,
      audiences: [AUDIENCE],
      clockToleranceSeconds: 0,
      jwksUri: JWKS_URI,
      fetch: fetchMock,
      now: () => NOW,
    });
    await expect(subject.verify(await sign(rs))).rejects.toBeInstanceOf(
      TokenVerifierUnavailableError,
    );
    expect(fetchMock).toHaveBeenCalledWith(JWKS_URI, expect.anything());
  });
});
