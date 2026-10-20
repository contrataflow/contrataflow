import { isApiError } from '@/lib/api/api-error';
import { resolveErrorAction } from '@/lib/api/error-policy';

/*
 * Como a SCR-105/106 reage a cada erro de DOC-20..23 (US-067 · "Casos de erro"). Função pura: quem a
 * usa decide o texto (`RENDITION_MESSAGES`) e o efeito.
 *
 * - `notReady` (409 `RENDITION_NOT_READY`): ainda gerando ou prévia vencida — usa o `detail`;
 * - `forbidden` (403): sem acesso ao PDF (ex.: valores sigilosos sem POL-09);
 * - `notFound` (404): não distingue inexistente de sem acesso (DEC-024);
 * - `rateLimited` (429): respeita o `Retry-After`; `unavailable` (503): "Tentar novamente";
 * - `redirect` (MFA, vínculo inativo…), `silent` (sessão expirada: o modal do shell cuida);
 * - `unexpected`: demais, com o `correlationId`.
 */

export type RenditionOutcome =
  | { readonly kind: 'notReady'; readonly detail: string | null }
  | { readonly kind: 'forbidden'; readonly detail: string | null }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'rateLimited'; readonly retryAfterSeconds: number | null }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'redirect'; readonly href: string }
  | { readonly kind: 'silent' }
  | { readonly kind: 'unexpected'; readonly correlationId: string | null };

export function describeRenditionError(error: unknown, currentPath: string): RenditionOutcome {
  if (!isApiError(error)) return { kind: 'unexpected', correlationId: null };
  const detail = error.problem?.detail ?? null;

  if (error.status === 404) return { kind: 'notFound' };
  if (error.status === 409) return { kind: 'notReady', detail };

  const action = resolveErrorAction(error, currentPath);
  switch (action.kind) {
    case 'redirect':
      return { kind: 'redirect', href: action.href };
    case 'session-expired':
      return { kind: 'silent' };
    case 'unavailable':
      return { kind: 'unavailable' };
    case 'rate-limited':
      return { kind: 'rateLimited', retryAfterSeconds: action.retryAfterSeconds };
    default:
      break;
  }
  if (error.status === 403) return { kind: 'forbidden', detail };
  return { kind: 'unexpected', correlationId: error.correlationId };
}
