import 'server-only';

import { createHash, randomBytes } from 'node:crypto';

import type { LoginSecrets } from '../session/types';

/*
 * Segredos do Authorization Code + PKCE (RFC 7636 · RN-IAM-01/02): `state` e `nonce` com 256 bits
 * e `code_verifier` com 64 bytes, todos por CSPRNG em base64url; `code_challenge` S256.
 */

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** `BASE64URL(SHA-256(code_verifier))` — único método aceito (`plain` é recusado). */
export function codeChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
}

export function newLoginSecrets(): LoginSecrets {
  return { state: randomToken(32), nonce: randomToken(32), codeVerifier: randomToken(64) };
}
