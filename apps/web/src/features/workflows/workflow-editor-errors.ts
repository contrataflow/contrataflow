import type { FieldError } from '@contrataflow/validation';

import { isApiError } from '@/lib/api/api-error';

import { deleteBlockersOf } from './workflow-editor-model';

/*
 * Tradução dos erros da API no editor (US-043 · Casos de erro): o que vira aviso geral da tela
 * (412/428 com "Recarregar e tentar novamente", 409 de versão não editável, 403, 503) e o que fica
 * no próprio formulário (422 por campo, chave repetida, exclusão bloqueada por referência).
 */

export type EditorProblem =
  | { readonly kind: 'conflict' }
  | { readonly kind: 'notDraft' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'mfa' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'generic'; readonly message: string | null };

export type FormOutcome =
  | { readonly kind: 'fields'; readonly errors: readonly FieldError[] }
  | { readonly kind: 'keyTaken' }
  | {
      readonly kind: 'blocked';
      readonly items: ReturnType<typeof deleteBlockersOf>;
    }
  | { readonly kind: 'rule'; readonly message: string }
  | { readonly kind: 'screen'; readonly problem: EditorProblem };

/** Classifica a falha de uma escrita do editor. */
export function outcomeOf(error: unknown): FormOutcome {
  if (!isApiError(error)) return { kind: 'screen', problem: { kind: 'generic', message: null } };
  if (error.status === 412 || error.status === 428) {
    return { kind: 'screen', problem: { kind: 'conflict' } };
  }
  if (error.code === 'WORKFLOW_VERSION_NOT_DRAFT') {
    return { kind: 'screen', problem: { kind: 'notDraft' } };
  }
  if (error.code === 'CONFLICT') return { kind: 'keyTaken' };
  if (error.code === 'VALIDATION_ERROR' && error.errors.length > 0) {
    return { kind: 'fields', errors: error.errors };
  }
  if (error.code === 'BUSINESS_RULE_VIOLATION') {
    const items = deleteBlockersOf(error.violations);
    if (items.length > 0) return { kind: 'blocked', items };
    return { kind: 'rule', message: error.violations[0]?.message ?? error.message };
  }
  if (error.code === 'MFA_REQUIRED') return { kind: 'screen', problem: { kind: 'mfa' } };
  if (error.status === 403) return { kind: 'screen', problem: { kind: 'forbidden' } };
  if (error.status === 503) return { kind: 'screen', problem: { kind: 'unavailable' } };
  return { kind: 'screen', problem: { kind: 'generic', message: error.message || null } };
}
