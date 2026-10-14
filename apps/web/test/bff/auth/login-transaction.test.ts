import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  LOGIN_TRANSACTION_COOKIE,
  LOGIN_TRANSACTION_TTL_MS,
  MAX_LOGIN_TRANSACTIONS,
  addTransaction,
  openTransactions,
  sealTransactions,
  takeTransaction,
} from '@/bff/auth/login-transaction';
import type { LoginTransaction } from '@/bff/auth/login-transaction';
import { codeChallenge, newLoginSecrets, randomToken } from '@/bff/auth/pkce';
import { deriveKey, masterKey, seal, unseal } from '@/bff/crypto';

/* RN-IAM-01/02: segredos PKCE e cookie de transação cifrado (AES-256-GCM). */

const KEY = deriveKey(Buffer.alloc(32, 1), 'login-transaction');
const NOW = Date.parse('2026-10-14T12:00:00Z');

function transaction(state: string, createdAt = NOW, returnTo = '/exemplo'): LoginTransaction {
  return {
    state,
    nonce: `n-${state}`,
    codeVerifier: `v-${state}`,
    returnTo,
    stepUp: false,
    createdAt,
  };
}

describe('cifra do BFF (DEC-137)', () => {
  it('seal/unseal: ida e volta; AAD, chave ou bytes diferentes → null', () => {
    const sealed = seal(KEY, 'segredo', 'aad-1');
    expect(sealed).not.toContain('segredo');
    expect(unseal(KEY, sealed, 'aad-1')).toBe('segredo');
    expect(unseal(KEY, sealed, 'aad-2')).toBeNull();
    expect(unseal(deriveKey(Buffer.alloc(32, 2), 'login-transaction'), sealed, 'aad-1')).toBeNull();
    const tampered = Buffer.from(sealed, 'base64url');
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    expect(unseal(KEY, tampered.toString('base64url'), 'aad-1')).toBeNull();
    expect(unseal(KEY, 'curto', 'aad-1')).toBeNull();
    // IV aleatório: o mesmo texto cifra diferente a cada vez.
    expect(seal(KEY, 'segredo', 'aad-1')).not.toBe(sealed);
  });

  it('subchaves por finalidade e chave mestra aleatória só quando não configurada', () => {
    const master = Buffer.alloc(32, 9);
    expect(deriveKey(master, 'session-tokens').equals(deriveKey(master, 'login-transaction'))).toBe(
      false,
    );
    expect(masterKey(master)).toBe(master);
    expect(masterKey(null)).toHaveLength(32);
  });
});

describe('PKCE S256 (RFC 7636)', () => {
  it('code_challenge = BASE64URL(SHA-256(code_verifier)) — vetor do Apêndice B da RFC', () => {
    expect(codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('state e nonce com 256 bits; code_verifier com 64 bytes; todos distintos', () => {
    const secrets = newLoginSecrets();
    expect(Buffer.from(secrets.state, 'base64url')).toHaveLength(32);
    expect(Buffer.from(secrets.nonce, 'base64url')).toHaveLength(32);
    expect(Buffer.from(secrets.codeVerifier, 'base64url')).toHaveLength(64);
    expect(secrets.codeVerifier).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(new Set([secrets.state, secrets.nonce, newLoginSecrets().state]).size).toBe(3);
    expect(randomToken(8)).toMatch(/^[A-Za-z0-9_-]{11}$/);
  });
});

describe('cookie de transação (RN-IAM-02)', () => {
  it('ida e volta cifrada, sem segredos em claro', () => {
    const value = sealTransactions(KEY, [transaction('s1')]);
    expect(value).not.toContain('v-s1');
    expect(openTransactions(KEY, value, NOW)).toEqual([transaction('s1')]);
  });

  it('cookie ausente, adulterado, de outra chave ou malformado → nenhuma transação', () => {
    const value = sealTransactions(KEY, [transaction('s1')]);
    expect(openTransactions(KEY, null, NOW)).toEqual([]);
    expect(openTransactions(KEY, `${value.slice(0, -2)}AA`, NOW)).toEqual([]);
    expect(openTransactions(deriveKey(randomBytes(32), 'login-transaction'), value, NOW)).toEqual(
      [],
    );
    expect(openTransactions(KEY, seal(KEY, '{"x":1}', LOGIN_TRANSACTION_COOKIE), NOW)).toEqual([]);
    expect(openTransactions(KEY, seal(KEY, 'não-json', LOGIN_TRANSACTION_COOKIE), NOW)).toEqual([]);
    expect(
      openTransactions(
        KEY,
        seal(KEY, JSON.stringify([{ state: 1 }]), LOGIN_TRANSACTION_COOKIE),
        NOW,
      ),
    ).toEqual([]);
  });

  it('válida por 10 min: expirada (ou do futuro) é descartada', () => {
    const value = sealTransactions(KEY, [
      transaction('velha', NOW - LOGIN_TRANSACTION_TTL_MS),
      transaction('nova'),
    ]);
    expect(openTransactions(KEY, value, NOW).map((item) => item.state)).toEqual(['nova']);
    // Um instante antes: a "velha" ainda vale e a "nova" ainda não existia.
    expect(openTransactions(KEY, value, NOW - 1).map((item) => item.state)).toEqual(['velha']);
  });

  it(`até ${MAX_LOGIN_TRANSACTIONS} transações simultâneas (abas): a mais antiga sai`, () => {
    let jar: LoginTransaction[] = [];
    for (const [index, state] of ['a', 'b', 'c', 'd'].entries()) {
      jar = addTransaction(jar, transaction(state, NOW + index));
    }
    expect(jar.map((item) => item.state)).toEqual(['b', 'c', 'd']);
  });

  it('uso único: retira a transação do state e mantém as demais; state ausente ou desconhecido → nada', () => {
    const jar = [transaction('s1'), transaction('s2')];
    expect(takeTransaction(jar, 's1')).toEqual({ transaction: jar[0], rest: [jar[1]] });
    expect(takeTransaction(jar, 'S2')).toEqual({ transaction: null, rest: jar });
    expect(takeTransaction(jar, null)).toEqual({ transaction: null, rest: jar });
    expect(takeTransaction(jar, 's')).toEqual({ transaction: null, rest: jar });
  });
});
