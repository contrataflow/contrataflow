import type { ApiError } from './api-error';

/*
 * Política transversal de erros da UI (architecture.md §8.12 · RN-FND-93). Ordem de prioridade:
 * sessão → MFA → tenant/vínculo → CSRF → 404 → conflito → validação/política → limite → 5xx.
 * Função pura: quem a aplica (boundaries, cliente de API) só executa a ação devolvida. Sessão
 * expirada e indisponibilidade não navegam: o `SessionWatcher` abre o modal ou o banner e preserva
 * o que está na tela (US-088 · CA-T-09 · RN-IAM-33).
 */

export type ErrorAction =
  | { readonly kind: 'redirect'; readonly href: string }
  | { readonly kind: 'session-expired' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'rate-limited'; readonly retryAfterSeconds: number | null }
  | { readonly kind: 'reload' }
  | { readonly kind: 'inline' }
  | { readonly kind: 'boundary' };

/**
 * 409 de regra de negócio que a própria tela explica e resolve (US-096): não são edição concorrente
 * do mesmo registro, então não abrem o diálogo de conflito ("alterado por outra pessoa").
 */
const INLINE_CONFLICT_CODES: ReadonlySet<string> = new Set([
  'IDEMPOTENCY_IN_PROGRESS',
  // POL-12: "mantenha ao menos um administrador" — a tela sugere atribuir outro antes.
  'LAST_ADMIN_REQUIRED',
  // RN-IAM-94: a tela destaca a atribuição existente.
  'ROLE_ASSIGNMENT_ALREADY_EXISTS',
  // US-001 (FA-02 e V-10): o wizard mostra os candidatos com "Criar mesmo assim" ou o erro no campo.
  'POSSIBLE_DUPLICATE_PROCESS',
  'DUPLICATE_INTERNAL_CODE',
]);

/** SCR-111 "sem acesso a esta instituição" (FA-08 da US-088). */
export const MEMBERSHIP_INACTIVE_HREF = '/erro/vinculo-inativo';

/** SCR-101: a API não recebeu a instituição ativa — refaz a seleção (US-100 · V-01). */
export const TENANT_SELECTION_HREF = '/selecionar-orgao';

/** Cabeçalho do tenant ativo; o 400 da API aponta para ele em `errors[].field` (RN-TEN-19). */
const TENANT_HEADER = 'X-Tenant-Id';

/** Login com `returnTo` (caminho interno); após expiração, com reautenticação (RN-IAM-32). */
export function loginHref(
  returnTo: string,
  options: { readonly reauthenticate?: boolean } = {},
): string {
  const reauth = options.reauthenticate === true ? '&reauth=1' : '';
  return `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}${reauth}`;
}

export function stepUpHref(returnTo: string): string {
  return `/api/auth/step-up?returnTo=${encodeURIComponent(returnTo)}`;
}

export function resolveErrorAction(
  error: Pick<ApiError, 'status' | 'code' | 'retryAfterSeconds'> &
    Partial<Pick<ApiError, 'errors'>>,
  currentPath: string,
): ErrorAction {
  const { status, code } = error;
  if (
    status === 400 &&
    code === 'MALFORMED_REQUEST' &&
    error.errors?.some((fieldError) => fieldError.field === TENANT_HEADER)
  ) {
    return { kind: 'redirect', href: TENANT_SELECTION_HREF };
  }
  if (status === 401 && code === 'SESSION_EXPIRED') return { kind: 'session-expired' };
  if (status === 401) return { kind: 'redirect', href: loginHref(currentPath) };
  if (status === 403 && code === 'MFA_REQUIRED') {
    return { kind: 'redirect', href: stepUpHref(currentPath) };
  }
  if (status === 403 && code === 'MEMBERSHIP_INACTIVE') {
    return { kind: 'redirect', href: MEMBERSHIP_INACTIVE_HREF };
  }
  if (status === 403 && code === 'TENANT_SUSPENDED') {
    return { kind: 'redirect', href: '/erro/acesso-indisponivel' };
  }
  if (status === 403 && code === 'USER_BLOCKED') {
    return { kind: 'redirect', href: '/erro/403' };
  }
  if (status === 403 && code === 'CSRF_REJECTED') return { kind: 'reload' };
  if (status === 404) return { kind: 'not-found' };
  if (status === 412 || (status === 409 && !INLINE_CONFLICT_CODES.has(code))) {
    return { kind: 'conflict' };
  }
  if (status === 429) return { kind: 'rate-limited', retryAfterSeconds: error.retryAfterSeconds };
  // 403 de política (DEC-181), 422 de validação/regra e demais 4xx: mensagem na própria tela.
  if (status >= 400 && status < 500) return { kind: 'inline' };
  if (status === 503 && code === 'DEPENDENCY_UNAVAILABLE') return { kind: 'unavailable' };
  return { kind: 'boundary' };
}
