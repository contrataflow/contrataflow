import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';

import type { SqlClient } from '#shared/database/outbox-database.js';

import {
  DatabaseOperatorDirectory,
  JwksOperatorTokenVerifier,
  OperatorAccessError,
  OperatorAuthenticator,
  PLATFORM_QUEUE_ADMIN,
} from './operator-authenticator.js';
import type { OperatorRecord, VerifiedOperatorToken } from './operator-authenticator.js';

const OPERATOR: OperatorRecord = {
  id: '0192f0a0-0000-7000-8000-0000000000aa',
  name: 'Operadora',
  status: 'ACTIVE',
  isPlatformOperator: true,
};

function authenticator(
  token: Partial<VerifiedOperatorToken>,
  user: OperatorRecord | null = OPERATOR,
) {
  return new OperatorAuthenticator(
    {
      verify: (raw) =>
        raw === 'bad'
          ? Promise.reject(new Error('assinatura'))
          : Promise.resolve({
              subject: 'sub-1',
              amr: ['pwd', 'otp'],
              permissions: [PLATFORM_QUEUE_ADMIN],
              ...token,
            }),
    },
    { findBySubject: () => Promise.resolve(user) },
  );
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'OK';
  } catch (error) {
    if (error instanceof OperatorAccessError) return error.code;
    throw error;
  }
}

describe('acesso de operador ao painel/CLI de filas (RN-FND-69 · permissions.md §8)', () => {
  it('[Permissão] concede só com isPlatformOperator + PLATFORM_QUEUE_ADMIN + MFA', async () => {
    await expect(authenticator({}).authenticate('tok')).resolves.toEqual({
      userId: OPERATOR.id,
      name: 'Operadora',
    });
    expect(await codeOf(authenticator({ permissions: [] }).authenticate('tok'))).toBe(
      'PERMISSION_DENIED',
    );
    expect(
      await codeOf(
        authenticator({}, { ...OPERATOR, isPlatformOperator: false }).authenticate('tok'),
      ),
    ).toBe('PERMISSION_DENIED');
    expect(
      await codeOf(authenticator({}, { ...OPERATOR, status: 'BLOCKED' }).authenticate('tok')),
    ).toBe('PERMISSION_DENIED');
    expect(await codeOf(authenticator({}, null).authenticate('tok'))).toBe('PERMISSION_DENIED');
    expect(await codeOf(authenticator({ amr: ['pwd'] }).authenticate('tok'))).toBe('MFA_REQUIRED');
    expect(await codeOf(authenticator({}).authenticate(null))).toBe('UNAUTHENTICATED');
    expect(await codeOf(authenticator({}).authenticate('bad'))).toBe('UNAUTHENTICATED');
  });

  it('a negação identifica o usuário conhecido (para a auditoria)', async () => {
    const error = await authenticator({ amr: [] })
      .authenticate('tok')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OperatorAccessError);
    expect((error as OperatorAccessError).operator).toEqual({
      userId: OPERATOR.id,
      name: 'Operadora',
    });
  });
});

describe('JwksOperatorTokenVerifier', () => {
  const ISSUER = 'https://auth.test/application/o/ops/';
  async function setup() {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256' };
    const fetcher: typeof fetch = (input) => {
      const url = String(input instanceof Request ? input.url : input);
      const body = url.endsWith('openid-configuration')
        ? { issuer: ISSUER, jwks_uri: `${ISSUER}jwks/` }
        : { keys: [jwk] };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    };
    const sign = (claims: Record<string, unknown>, audience = 'cf-ops') =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(ISSUER)
        .setAudience(audience)
        .setSubject('sub-1')
        .setExpirationTime('5m')
        .sign(privateKey);
    return { fetcher, sign };
  }

  it('valida assinatura, emissor e audiência e lê amr e cf_platform_permissions', async () => {
    const { fetcher, sign } = await setup();
    const original = globalThis.fetch;
    globalThis.fetch = fetcher;
    try {
      const verifier = new JwksOperatorTokenVerifier({
        issuer: ISSUER,
        audience: 'cf-ops',
        fetch: fetcher,
      });
      const token = await sign({
        amr: ['pwd', 'otp'],
        cf_platform_permissions: [PLATFORM_QUEUE_ADMIN, 1],
      });
      await expect(verifier.verify(token)).resolves.toEqual({
        subject: 'sub-1',
        amr: ['pwd', 'otp'],
        permissions: [PLATFORM_QUEUE_ADMIN],
      });
      await expect(verifier.verify(await sign({}, 'outra'))).rejects.toThrow();
      await expect(verifier.verify(await sign({ amr: 'x' }))).resolves.toMatchObject({
        amr: [],
        permissions: [],
      });
    } finally {
      globalThis.fetch = original;
    }
  });

  it('descoberta OIDC com erro HTTP ou sem jwks_uri falha', async () => {
    const failing = new JwksOperatorTokenVerifier({
      issuer: 'https://auth.test/x',
      audience: 'a',
      fetch: () => Promise.resolve(new Response('{}', { status: 500 })),
    });
    await expect(failing.verify('t')).rejects.toThrow('HTTP 500');
    const missing = new JwksOperatorTokenVerifier({
      issuer: 'https://auth.test/x',
      audience: 'a',
      fetch: () => Promise.resolve(new Response('{}', { status: 200 })),
    });
    await expect(missing.verify('t')).rejects.toThrow('sem jwks_uri');
  });
});

describe('DatabaseOperatorDirectory', () => {
  it('relê o operador em users pelo external_subject', async () => {
    const queries: unknown[][] = [];
    const client: SqlClient = {
      query: (_sql: string, params: readonly unknown[] = []) => {
        queries.push([...params]);
        const rows =
          params[0] === 'sub-1'
            ? [{ id: 'u1', name: 'Op', status: 'ACTIVE', is_platform_operator: true }]
            : [];
        return Promise.resolve({ rows: rows as never[], rowCount: rows.length });
      },
    };
    const directory = new DatabaseOperatorDirectory({
      platformTransaction: (work) => work(client),
    });
    await expect(directory.findBySubject('sub-1')).resolves.toEqual({
      id: 'u1',
      name: 'Op',
      status: 'ACTIVE',
      isPlatformOperator: true,
    });
    await expect(directory.findBySubject('sub-2')).resolves.toBeNull();
    expect(queries).toEqual([['sub-1'], ['sub-2']]);
  });
});
