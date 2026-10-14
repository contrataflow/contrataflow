import 'server-only';

import { API_CSP, baseSecurityHeaders, buildPageCsp, generateNonce } from './security-headers';
import type { PageCspOptions } from './security-headers';

/*
 * Lógica do `proxy.ts` (antes de qualquer rota): nonce da CSP por requisição para as páginas,
 * cabeçalhos de segurança e `Cache-Control: private, no-store` em toda resposta dinâmica
 * (RN-FND-88/94). Cabeçalhos internos vindos do browser são sobrescritos.
 */

/** Cabeçalho com o caminho original (o layout de `(app)` monta o `returnTo` com ele). */
export const PATHNAME_HEADER = 'x-cf-pathname';
/** Cabeçalho com o nonce (lido pelo layout raiz). */
export const NONCE_HEADER = 'x-nonce';

export interface EdgeHeaders {
  readonly requestHeaders: Headers;
  readonly responseHeaders: Record<string, string>;
}

export function edgeHeaders(
  pathname: string,
  search: string,
  incoming: Headers,
  csp: Omit<PageCspOptions, 'nonce'>,
  nonce: string = generateNonce(),
): EdgeHeaders {
  const requestHeaders = new Headers(incoming);
  requestHeaders.set(PATHNAME_HEADER, `${pathname}${search}`);
  requestHeaders.delete(NONCE_HEADER);
  const responseHeaders: Record<string, string> = {
    ...baseSecurityHeaders(csp.reportUri),
    'Cache-Control': 'private, no-store',
  };
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    responseHeaders['Content-Security-Policy'] = API_CSP;
  } else {
    const policy = buildPageCsp({ ...csp, nonce });
    // O Next lê a CSP da requisição para aplicar o nonce aos próprios scripts.
    requestHeaders.set('Content-Security-Policy', policy);
    requestHeaders.set(NONCE_HEADER, nonce);
    responseHeaders['Content-Security-Policy'] = policy;
  }
  return { requestHeaders, responseHeaders };
}
