import { clearToasts } from '@contrataflow/ui';
import type { QueryClient } from '@tanstack/react-query';

import { apiErrorFromResponse } from '@/lib/api/api-error';
import { localDrafts } from '@/lib/drafts/local-drafts';
import type { LocalDrafts } from '@/lib/drafts/local-drafts';

import { publishSessionEvent } from './session-channel';
import type { ShellSession } from './types';

/*
 * Ações de sessão do shell: troca de instituição, logout, consulta e "Continuar conectado"
 * (architecture.md §8.5 · RN-IAM-72 · US-088). O cache do tenant anterior é apagado ANTES de
 * qualquer dado do novo ser buscado; o logout limpa cache, rascunhos do usuário e
 * `sessionStorage` e avisa as outras abas (RN-IAM-29/31).
 */

type FetchLike = typeof fetch;

/** SCR-001 depois do logout, quando o BFF não devolve o destino. */
export const LOGGED_OUT_PATH = '/entrar?motivo=saiu';

async function postSession(fetchImpl: FetchLike, path: string, body?: unknown): Promise<Response> {
  return fetchImpl(path, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      'X-CF-Request': '1',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? null : JSON.stringify(body),
  });
}

async function json(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

export async function switchTenant(
  tenantId: string,
  deps: {
    readonly queryClient: QueryClient;
    readonly refresh: () => void;
    readonly fetchImpl?: FetchLike;
  },
): Promise<ShellSession> {
  const response = await postSession(deps.fetchImpl ?? fetch, '/api/auth/switch-tenant', {
    tenantId,
  });
  const body = await json(response);
  if (!response.ok) throw apiErrorFromResponse(response.status, response.headers, body);
  deps.queryClient.clear();
  clearToasts();
  publishSessionEvent({ type: 'tenant-switched', tenantId });
  deps.refresh();
  return (body as { data: ShellSession }).data;
}

/**
 * Logout (RN-IAM-20/31): `POST /api/auth/logout` com CSRF; limpa o cache de consultas, os toasts,
 * os rascunhos locais do usuário e o `sessionStorage`; avisa as outras abas e segue para o
 * `logoutUrl` (fim de sessão no Authentik ou SCR-001). Falha de rede propaga: a sessão continua.
 */
export async function logout(deps: {
  readonly queryClient: QueryClient;
  readonly navigate: (href: string) => void;
  /** Usuário da sessão: os rascunhos dele são apagados (RN-IAM-31). */
  readonly userId?: string | null;
  readonly drafts?: LocalDrafts;
  readonly fetchImpl?: FetchLike;
}): Promise<void> {
  const response = await postSession(deps.fetchImpl ?? fetch, '/api/auth/logout');
  const body = (await json(response)) as { data?: { logoutUrl?: unknown } } | null;
  deps.queryClient.clear();
  clearToasts();
  if (deps.userId) {
    try {
      await (deps.drafts ?? localDrafts()).clearUser(deps.userId);
    } catch {
      // IndexedDB indisponível: nada a apagar.
    }
  }
  try {
    sessionStorage.clear();
  } catch {
    // Armazenamento indisponível (modo privado restrito): nada a limpar.
  }
  publishSessionEvent({ type: 'logout' });
  const logoutUrl = body?.data?.logoutUrl;
  deps.navigate(typeof logoutUrl === 'string' && logoutUrl !== '' ? logoutUrl : LOGGED_OUT_PATH);
}

/** Estado da sessão no BFF, visto pelo shell (US-088). */
export type SessionState =
  | { readonly kind: 'active'; readonly session: ShellSession }
  /** 401 `SESSION_EXPIRED`: modal "Sua sessão expirou". */
  | { readonly kind: 'expired' }
  /** 401 `UNAUTHENTICATED`: sem sessão (logout em outra aba) → SCR-001. */
  | { readonly kind: 'no-session' }
  /** 403 `MEMBERSHIP_INACTIVE`: vínculo suspenso/revogado → SCR-111 (FA-08). */
  | { readonly kind: 'membership-inactive' }
  /** 503 ou rede: indisponível — nunca "sessão expirada" (RN-IAM-33). */
  | { readonly kind: 'unavailable' };

async function sessionState(fetchImpl: FetchLike, path: string): Promise<SessionState> {
  let response: Response;
  try {
    response = await fetchImpl(path, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
  } catch {
    return { kind: 'unavailable' };
  }
  const body = (await json(response)) as { data?: ShellSession; code?: unknown } | null;
  if (response.ok && body?.data) return { kind: 'active', session: body.data };
  if (response.status === 401) {
    return body?.code === 'SESSION_EXPIRED' ? { kind: 'expired' } : { kind: 'no-session' };
  }
  if (response.status === 403 && body?.code === 'MEMBERSHIP_INACTIVE') {
    return { kind: 'membership-inactive' };
  }
  return { kind: 'unavailable' };
}

/** Consulta de sondagem (contador do shell, foco da janela): não renova a ociosidade. */
export function fetchSessionState(fetchImpl: FetchLike = fetch): Promise<SessionState> {
  return sessionState(fetchImpl, '/api/auth/session');
}

/** "Continuar conectado" (FA-01): renova a ociosidade, nunca a duração absoluta. */
export function extendSession(fetchImpl: FetchLike = fetch): Promise<SessionState> {
  return sessionState(fetchImpl, '/api/auth/session?keepalive=true');
}
