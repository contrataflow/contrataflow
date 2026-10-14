import 'server-only';

import { CORRELATION_HEADER, resolveCorrelationId } from './correlation';
import { problemResponse } from './http';
import { log } from './logger';
import { readLimitedBody } from './proxy-handler';
import { applyApiSecurityHeaders } from './security-headers';

/** Relatórios de CSP são pequenos; o excedente é descartado. */
export const CSP_REPORT_MAX_BYTES = 16 * 1024;

interface CspReport {
  readonly directive: string;
  readonly blockedOrigin: string;
}

function origin(value: unknown): string {
  if (typeof value !== 'string' || value === '') return 'unknown';
  try {
    return new URL(value).origin;
  } catch {
    // `inline`, `eval` etc. — palavras-chave sem URL.
    return /^[a-z-]{1,20}$/.test(value) ? value : 'unknown';
  }
}

function directive(value: unknown): string {
  return typeof value === 'string' && /^[a-z-]{1,40}$/.test(value) ? value : 'unknown';
}

/** Aceita `report-uri` (`csp-report`) e Reporting API (`[{ body }]`); só diretiva e origem. */
export function parseCspReports(payload: unknown): CspReport[] {
  const entries: unknown[] = Array.isArray(payload) ? payload : [payload];
  return entries.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const body = (record['csp-report'] ?? record.body) as Record<string, unknown> | undefined;
    if (typeof body !== 'object') return [];
    return [
      {
        directive: directive(
          body['effective-directive'] ?? body.effectiveDirective ?? body['violated-directive'],
        ),
        blockedOrigin: origin(body['blocked-uri'] ?? body.blockedURL),
      },
    ];
  });
}

/**
 * Endpoint interno de violações de CSP (`CSP_REPORT_URI`). Registra só a diretiva e a origem
 * bloqueada — nunca a URL completa do documento (pode conter dados) nem o nonce.
 */
export async function handleCspReport(request: Request): Promise<Response> {
  const correlationId = resolveCorrelationId(request.headers.get(CORRELATION_HEADER));
  const instance = new URL(request.url).pathname;
  const body = await readLimitedBody(request, CSP_REPORT_MAX_BYTES);
  if (body.kind === 'too_large')
    return problemResponse('PAYLOAD_TOO_LARGE', { correlationId, instance });
  let payload: unknown = null;
  try {
    payload = body.body ? (JSON.parse(new TextDecoder().decode(body.body)) as unknown) : null;
  } catch {
    return problemResponse('MALFORMED_REQUEST', { correlationId, instance });
  }
  for (const report of parseCspReports(payload).slice(0, 20)) {
    log('warn', 'bff.csp_violation', { ...report, correlationId });
  }
  return new Response(null, { status: 204, headers: applyApiSecurityHeaders(new Headers()) });
}
