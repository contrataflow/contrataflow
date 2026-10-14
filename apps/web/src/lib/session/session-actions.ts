import { clearToasts } from '@contrataflow/ui';
import type { QueryClient } from '@tanstack/react-query';

import { apiErrorFromResponse } from '@/lib/api/api-error';

import { publishSessionEvent } from './session-channel';
import type { ShellSession } from './types';

/*
 * Ações de sessão do shell: troca de instituição e logout (architecture.md §8.5 · RN-IAM-72).
 * O cache do tenant anterior é apagado ANTES de qualquer dado do novo ser buscado.
 */

type FetchLike = typeof fetch;

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

export async function logout(deps: {
  readonly queryClient: QueryClient;
  readonly navigate: (href: string) => void;
  readonly fetchImpl?: FetchLike;
}): Promise<void> {
  const response = await postSession(deps.fetchImpl ?? fetch, '/api/auth/logout');
  const body = (await json(response)) as { data?: { redirectTo?: string } } | null;
  deps.queryClient.clear();
  clearToasts();
  try {
    sessionStorage.clear();
  } catch {
    // Armazenamento indisponível (modo privado restrito): nada a limpar.
  }
  publishSessionEvent({ type: 'logout' });
  deps.navigate(body?.data?.redirectTo ?? '/entrar?motivo=saiu');
}

/** `no-session`: sessão encerrada; `null`: sem resposta útil; senão, o `activeTenantId`. */
export type ActiveTenantProbe =
  { readonly kind: 'no-session' } | { readonly kind: 'tenant'; readonly tenantId: string | null };

/** `activeTenantId` atual do BFF, sem renovar a ociosidade (sondagem de foco). */
export async function fetchActiveTenantId(
  fetchImpl: FetchLike = fetch,
): Promise<ActiveTenantProbe> {
  const response = await fetchImpl('/api/auth/session?keepalive=1', {
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  if (response.status === 401) return { kind: 'no-session' };
  if (!response.ok) return { kind: 'tenant', tenantId: null };
  const body = (await json(response)) as { data?: ShellSession } | null;
  return { kind: 'tenant', tenantId: body?.data?.activeTenant?.id ?? null };
}
