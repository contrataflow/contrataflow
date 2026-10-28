import 'server-only';

/*
 * Cabeçalhos de segurança de toda resposta do BFF (security.md §8 · DEC-135 · RN-FND-94).
 * Páginas: CSP com nonce por requisição (gerado no `proxy.ts`). `/api/*`: CSP mínima, sem script.
 */

export interface PageCspOptions {
  readonly nonce: string;
  /** Origens extras de `connect-src` (buckets S3 de upload e pré-visualização). */
  readonly connectSources: readonly string[];
  readonly reportUri: string;
  /** HTTPS: liga `upgrade-insecure-requests` (em http://localhost quebraria os recursos). */
  readonly secure: boolean;
  /** `next dev` exige `'unsafe-eval'` (stack traces do React); nunca em build de produção. */
  readonly development: boolean;
}

export const CSP_REPORT_GROUP = 'csp-endpoint';

export const PERMISSIONS_POLICY =
  'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()';

/** CSP das páginas (security.md §8). */
export function buildPageCsp(options: PageCspOptions): string {
  const script = ["'self'", `'nonce-${options.nonce}'`, "'strict-dynamic'"];
  if (options.development) script.push("'unsafe-eval'");
  const directives = [
    "default-src 'self'",
    `script-src ${script.join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src ${["'self'", ...options.connectSources].join(' ')}`,
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    // Só a própria origem: o login é nativo e o logout não passa pelo IdP (DEC-187).
    "form-action 'self'",
    ...(options.secure ? ['upgrade-insecure-requests'] : []),
    `report-uri ${options.reportUri}`,
    `report-to ${CSP_REPORT_GROUP}`,
  ];
  return directives.join('; ');
}

/** CSP das respostas JSON do BFF: nada executa, nada é embutido. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

/** Cabeçalhos comuns a toda resposta (sem a CSP). */
export function baseSecurityHeaders(reportUri: string): Record<string, string> {
  return {
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': PERMISSIONS_POLICY,
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Reporting-Endpoints': `${CSP_REPORT_GROUP}="${reportUri}"`,
  };
}

/** Aplica os cabeçalhos de uma resposta de `/api/*` (inclusive de erro) e desliga cache. */
export function applyApiSecurityHeaders(headers: Headers, reportUri = '/api/csp-report'): Headers {
  for (const [name, value] of Object.entries(baseSecurityHeaders(reportUri)))
    headers.set(name, value);
  headers.set('Content-Security-Policy', API_CSP);
  headers.set('Cache-Control', 'private, no-store');
  return headers;
}

/** Nonce de 128 bits em base64 (imprevisível e único por requisição). */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}
