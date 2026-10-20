import { clearToasts } from '@contrataflow/ui';
import type { QueryClient } from '@tanstack/react-query';

import { apiErrorFromResponse } from '@/lib/api/api-error';
import { stepUpHref } from '@/lib/api/error-policy';
import { localDrafts } from '@/lib/drafts/local-drafts';
import type { LocalDrafts } from '@/lib/drafts/local-drafts';
import { HOME_PATH } from '@/lib/routes';

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

/** Prefixo aceito no `stepUpUrl` devolvido pelo BFF (nunca um destino externo). */
const STEP_UP_PREFIX = '/api/auth/step-up';

export type TenantSwitchOutcome =
  /** Instituição trocada: cache do tenant anterior apagado e abas avisadas (RN-IAM-72). */
  | { readonly kind: 'switched'; readonly session: ShellSession }
  /** Já era a instituição ativa: no-op, cache mantido (RN-IAM-70). */
  | { readonly kind: 'unchanged'; readonly session: ShellSession }
  /** O destino exige MFA: seguir ao *step-up*, que conclui a troca (RN-IAM-69 · FA-01). */
  | { readonly kind: 'step-up'; readonly href: string };

function stepUpUrlOf(body: unknown): string {
  const url = (body as { stepUpUrl?: unknown } | null)?.stepUpUrl;
  return typeof url === 'string' && url.startsWith(STEP_UP_PREFIX) ? url : stepUpHref(HOME_PATH);
}

/**
 * Troca da instituição ativa (US-093): `POST /api/auth/switch-tenant` com o vínculo escolhido.
 * Na troca efetiva, o cache de consultas do tenant anterior é apagado ANTES de qualquer dado do
 * novo ser buscado (`refresh` vem depois — RN-IAM-72). Recusa (422/403/503) propaga como
 * `ApiError`, com o cache intacto.
 */
export async function switchTenant(
  membershipId: string,
  deps: {
    /**
     * Cache de consultas da aba; ausente só na SCR-101 do grupo `(auth)`, que não tem cache e
     * segue com recarga completa.
     */
    readonly queryClient?: QueryClient;
    /** Instituição ativa nesta aba (`null` na primeira escolha). */
    readonly currentTenantId: string | null;
    readonly refresh: () => void;
    /** "Usar como padrão" (FA-04). */
    readonly setAsDefault?: boolean;
    readonly drafts?: LocalDrafts;
    readonly fetchImpl?: FetchLike;
  },
): Promise<TenantSwitchOutcome> {
  const response = await postSession(deps.fetchImpl ?? fetch, '/api/auth/switch-tenant', {
    membershipId,
    ...(deps.setAsDefault ? { setAsDefault: true } : {}),
  });
  const body = await json(response);
  if (!response.ok) {
    const error = apiErrorFromResponse(response.status, response.headers, body);
    if (error.code === 'MFA_REQUIRED') return { kind: 'step-up', href: stepUpUrlOf(body) };
    throw error;
  }
  const session = (body as { data: ShellSession }).data;
  const tenantId = session.activeTenant?.id ?? null;
  if (tenantId !== null && tenantId === deps.currentTenantId) {
    return { kind: 'unchanged', session };
  }
  deps.queryClient?.clear();
  clearToasts();
  if (deps.currentTenantId !== null) {
    try {
      // RN-DFD-33: a contingência local do autosave não atravessa a troca de órgão.
      await (deps.drafts ?? localDrafts()).clearTenant(deps.currentTenantId);
    } catch {
      // IndexedDB indisponível: nada a apagar.
    }
  }
  if (tenantId) publishSessionEvent({ type: 'tenant-switched', tenantId });
  deps.refresh();
  return { kind: 'switched', session };
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
