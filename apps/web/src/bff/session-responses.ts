import 'server-only';

import { clearCookie, readCookie, serializeCookie } from './cookies';
import { problemResponse } from './http';
import type { SessionLookup } from './session/session-service';

/*
 * Respostas do BFF para sessão inexistente, vencida ou encerrada (US-088 · V-02/V-03/V-04),
 * comuns ao proxy `/api/v1/*` e às rotas `/api/auth/*`:
 * - sem sessão (ou encerrada por logout/limite) → 401 `UNAUTHENTICATED` → SCR-001 com `returnTo`;
 * - vencida (ociosidade, absoluta, renovação recusada) → 401 `SESSION_EXPIRED` → modal "Sua sessão
 *   expirou", e o cookie de reautenticação: a próxima entrada neste navegador pede a senha de novo
 *   ao Authentik (`max_age=0`), para que a ociosidade não seja contornada pelo SSO (RN-IAM-32);
 * - encerrada pelo vínculo (worker) → 403 `MEMBERSHIP_INACTIVE` → SCR-111 (FA-08).
 */

/** Marca "a última sessão deste navegador expirou" (sem dado pessoal; só `1`). */
export const REAUTH_COOKIE = '__Host-cf_reauth';
/** Vale pelo teto absoluto da plataforma (24 h). */
const REAUTH_MAX_AGE_SECONDS = 24 * 3_600;

export function reauthCookie(): string {
  return serializeCookie(REAUTH_COOKIE, '1', REAUTH_MAX_AGE_SECONDS);
}

export function clearReauthCookie(): string {
  return clearCookie(REAUTH_COOKIE);
}

export function reauthenticationRequested(headers: Headers): boolean {
  return readCookie(headers, REAUTH_COOKIE) === '1';
}

interface ProblemContext {
  readonly correlationId: string;
  readonly instance: string;
}

/** Resposta para uma consulta de sessão que não está ativa. */
export function inactiveSessionResponse(
  lookup: { readonly status: Exclude<SessionLookup['status'], 'active'> | 'ended' },
  context: ProblemContext,
  sessionCookieName: string,
): Response {
  const headers = new Headers();
  headers.append('Set-Cookie', clearCookie(sessionCookieName));
  switch (lookup.status) {
    case 'expired':
      headers.append('Set-Cookie', reauthCookie());
      return problemResponse('SESSION_EXPIRED', { ...context, headers });
    case 'membership_ended':
      return problemResponse('MEMBERSHIP_INACTIVE', { ...context, headers });
    case 'none':
    case 'ended':
      return problemResponse('UNAUTHENTICATED', { ...context, headers });
  }
}
