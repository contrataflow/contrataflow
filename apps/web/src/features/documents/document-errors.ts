import type { Violation } from '@contrataflow/validation';

import { isApiError } from '@/lib/api/api-error';
import { resolveErrorAction } from '@/lib/api/error-policy';

/*
 * Como a SCR-105 reage a cada erro das transições do documento (US-065 · "Casos de erro"). Função
 * pura: quem a usa decide o texto (toast, alerta em linha) e o efeito (recarregar, fechar o fluxo).
 *
 * - `conflict` (412/428): `If-Match` velho — recarrega o documento;
 * - `invalidState` (409): a transição não vale mais para o status atual — recarrega e mostra o `detail`;
 * - `forbidden` (403): `NOT_PROCESS_CUSTODIAN`/`PERMISSION_DENIED` — mostra o `detail`;
 * - `incomplete` (422 `DOCUMENT_INCOMPLETE`/`WARNINGS_NOT_ACKNOWLEDGED`): reabre o painel com `violations`;
 * - `field` (422 `VALIDATION_ERROR`): mensagem do campo (justificativa);
 * - `notFound` (404), `unavailable` (503 — "Tentar novamente"), `rateLimited` (429),
 *   `redirect` (MFA, vínculo inativo…), `silent` (sessão expirada: o modal do shell cuida);
 * - `unexpected`: demais, com o `correlationId`.
 */

export type DocumentOutcome =
  | { readonly kind: 'conflict' }
  | { readonly kind: 'invalidState'; readonly detail: string | null }
  | { readonly kind: 'forbidden'; readonly detail: string | null }
  | {
      readonly kind: 'incomplete';
      readonly code: string;
      readonly violations: readonly Violation[];
    }
  | { readonly kind: 'field'; readonly message: string }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'rateLimited' }
  | { readonly kind: 'redirect'; readonly href: string }
  | { readonly kind: 'silent' }
  | { readonly kind: 'unexpected'; readonly correlationId: string | null };

/** Códigos do 422 que devolvem `violations[]` para o painel de pendências. */
const INCOMPLETE_CODES: ReadonlySet<string> = new Set([
  'DOCUMENT_INCOMPLETE',
  'WARNINGS_NOT_ACKNOWLEDGED',
]);

export function describeDocumentError(error: unknown, currentPath: string): DocumentOutcome {
  if (!isApiError(error)) return { kind: 'unexpected', correlationId: null };
  const detail = error.problem?.detail ?? null;

  if (error.status === 412 || error.status === 428) return { kind: 'conflict' };
  if (error.status === 404) return { kind: 'notFound' };
  if (error.status === 409) return { kind: 'invalidState', detail };
  if (error.status === 422) {
    if (INCOMPLETE_CODES.has(error.code)) {
      return { kind: 'incomplete', code: error.code, violations: error.violations };
    }
    const message = error.errors[0]?.message ?? detail;
    return message
      ? { kind: 'field', message }
      : { kind: 'unexpected', correlationId: error.correlationId };
  }

  // Redirecionamentos (MFA, vínculo inativo…), sessão expirada, 503 e limite vêm da política global.
  const action = resolveErrorAction(error, currentPath);
  switch (action.kind) {
    case 'redirect':
      return { kind: 'redirect', href: action.href };
    case 'session-expired':
      return { kind: 'silent' };
    case 'unavailable':
      return { kind: 'unavailable' };
    case 'rate-limited':
      return { kind: 'rateLimited' };
    default:
      break;
  }
  if (error.status === 403) return { kind: 'forbidden', detail };
  return { kind: 'unexpected', correlationId: error.correlationId };
}

/**
 * Desfechos que encerram o fluxo aberto (painel ou diálogo): a causa não se corrige na própria
 * tela — o documento é recarregado e o usuário vê o estado atual.
 */
export function endsFlow(outcome: DocumentOutcome): boolean {
  return (
    outcome.kind === 'conflict' ||
    outcome.kind === 'invalidState' ||
    outcome.kind === 'forbidden' ||
    outcome.kind === 'notFound' ||
    outcome.kind === 'redirect' ||
    outcome.kind === 'silent'
  );
}

/** Bloqueantes primeiro, depois os avisos; dentro de cada grupo vale a ordem da API. */
export function sortViolations(violations: readonly Violation[]): Violation[] {
  return [
    ...violations.filter((violation) => violation.severity === 'BLOCKING'),
    ...violations.filter((violation) => violation.severity !== 'BLOCKING'),
  ];
}

/** Códigos distintos dos avisos: o que vai em `acknowledgedWarnings` (V-02). */
export function warningCodes(violations: readonly Violation[]): string[] {
  return [
    ...new Set(
      violations
        .filter((violation) => violation.severity === 'WARNING')
        .map((violation) => violation.code),
    ),
  ];
}
