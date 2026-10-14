import type { ApiError } from './api-error';

/*
 * Política transversal de erros da UI (architecture.md §8.12 · RN-FND-93). Ordem de prioridade:
 * sessão → MFA → tenant/vínculo → CSRF → 404 → conflito → validação/política → limite → 5xx.
 * Função pura: quem a aplica (boundaries, cliente de API) só executa a ação devolvida.
 */

export type ErrorAction =
  | { readonly kind: 'redirect'; readonly href: string }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'rate-limited'; readonly retryAfterSeconds: number | null }
  | { readonly kind: 'reload' }
  | { readonly kind: 'inline' }
  | { readonly kind: 'boundary' };

/** Caminho interno seguro para `returnTo` (só caminho relativo da própria aplicação). */
export function loginHref(returnTo: string): string {
  return `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
}

export function stepUpHref(returnTo: string): string {
  return `/api/auth/step-up?returnTo=${encodeURIComponent(returnTo)}`;
}

export function resolveErrorAction(
  error: Pick<ApiError, 'status' | 'code' | 'retryAfterSeconds'>,
  currentPath: string,
): ErrorAction {
  const { status, code } = error;
  if (status === 401) return { kind: 'redirect', href: loginHref(currentPath) };
  if (status === 403 && code === 'MFA_REQUIRED') {
    return { kind: 'redirect', href: stepUpHref(currentPath) };
  }
  if (status === 403 && code === 'MEMBERSHIP_INACTIVE') {
    return { kind: 'redirect', href: '/selecionar-orgao' };
  }
  if (status === 403 && code === 'TENANT_SUSPENDED') {
    return { kind: 'redirect', href: '/erro/acesso-indisponivel' };
  }
  if (status === 403 && code === 'USER_BLOCKED') {
    return { kind: 'redirect', href: '/erro/403' };
  }
  if (status === 403 && code === 'CSRF_REJECTED') return { kind: 'reload' };
  if (status === 404) return { kind: 'not-found' };
  if (status === 412 || (status === 409 && code !== 'IDEMPOTENCY_IN_PROGRESS')) {
    return { kind: 'conflict' };
  }
  if (status === 429) return { kind: 'rate-limited', retryAfterSeconds: error.retryAfterSeconds };
  // 403 de política (DEC-181), 422 de validação/regra e demais 4xx: mensagem na própria tela.
  if (status >= 400 && status < 500) return { kind: 'inline' };
  return { kind: 'boundary' };
}
