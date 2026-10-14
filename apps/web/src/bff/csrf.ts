import 'server-only';

/*
 * CSRF em métodos mutáveis (security.md §7 · DEC-135 · V-01/V-02): `X-CF-Request: 1` obrigatório
 * e origem da própria aplicação — `Sec-Fetch-Site: same-origin` ou, sem ele, `Origin` igual a
 * `APP_BASE_URL`. Falha → 403 `CSRF_REJECTED` antes de qualquer chamada à API.
 */

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isMutatingMethod(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}

export type CsrfVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'MISSING_HEADER' | 'CROSS_ORIGIN' };

export function checkCsrf(method: string, headers: Headers, appOrigin: string): CsrfVerdict {
  if (!isMutatingMethod(method)) return { ok: true };
  if (headers.get('X-CF-Request') !== '1') return { ok: false, reason: 'MISSING_HEADER' };
  const fetchSite = headers.get('Sec-Fetch-Site');
  if (fetchSite !== null) {
    return fetchSite === 'same-origin' ? { ok: true } : { ok: false, reason: 'CROSS_ORIGIN' };
  }
  const origin = headers.get('Origin');
  return origin === appOrigin ? { ok: true } : { ok: false, reason: 'CROSS_ORIGIN' };
}
