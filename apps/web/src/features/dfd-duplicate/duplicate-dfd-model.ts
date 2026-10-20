import { PROCESS_LIST_QUERY_LIMITS } from '@contrataflow/validation';
import type {
  DfdDuplicate,
  DfdDuplicateTarget,
  ProcessListItemDto,
  ProcessStatus,
} from '@contrataflow/validation';

import type { ApiError } from '@/lib/api/api-error';

/*
 * Modelo do diálogo "Duplicar DFD" (US-018 · SCR-113): o corpo do DFD-05, as regras de quais
 * processos aparecem na busca do destino (RN-DFD-73) e a leitura dos erros da API em resultados que
 * a tela sabe mostrar. Puro: sem React nem rede.
 */

/** RN-DFD-73: status em que o processo ainda aceita um DFD novo. */
const EDITABLE_TARGET_STATUSES: readonly ProcessStatus[] = ['DRAFT', 'IN_PROGRESS', 'RETURNED'];

export interface DuplicateDfdValues {
  readonly targetType: DfdDuplicateTarget;
  /** Processo escolhido na busca (só para `EXISTING_PROCESS`). */
  readonly target: ProcessListItemDto | null;
}

/** Padrão do diálogo: novo processo se o usuário pode abri-lo; senão, a busca de um existente. */
export function initialValues(canCreateProcess: boolean): DuplicateDfdValues {
  return { targetType: canCreateProcess ? 'NEW_PROCESS' : 'EXISTING_PROCESS', target: null };
}

/** Busca do destino só dispara com o mínimo de caracteres do PRC-01 (V-08 da US-002). */
export function searchTextOf(raw: string): string | null {
  const text = raw.trim();
  return text.length >= PROCESS_LIST_QUERY_LIMITS.qMin ? text : null;
}

/**
 * Candidatos do destino: processos editáveis, exceto o da origem (o DFD de origem já o ocupa). As
 * demais pré-condições (etapa que permite DFD, sem DFD ativo, custódia) a API confere ao confirmar.
 */
export function eligibleTargets(
  items: readonly ProcessListItemDto[],
  sourceProcessId: string,
): ProcessListItemDto[] {
  return items.filter(
    (item) => item.id !== sourceProcessId && EDITABLE_TARGET_STATUSES.includes(item.status),
  );
}

/** Falta escolher o processo (único campo do diálogo que pode faltar). */
export function missingTarget(values: DuplicateDfdValues): boolean {
  return values.targetType === 'EXISTING_PROCESS' && values.target === null;
}

/** Corpo do DFD-05. */
export function duplicateDfdBody(values: DuplicateDfdValues): DfdDuplicate {
  if (values.targetType === 'NEW_PROCESS' || values.target === null) {
    return { targetType: 'NEW_PROCESS' };
  }
  return { targetType: 'EXISTING_PROCESS', targetProcessId: values.target.id };
}

/** O que a tela mostra quando a API recusa a duplicação. */
export type DuplicateProblem =
  /** V-01: o processo já tem DFD ativo — oferece abri-lo. */
  | { readonly kind: 'exists'; readonly code: string | null; readonly dfdId: string | null }
  /** V-02: a etapa atual do processo não aceita DFD. */
  | { readonly kind: 'stage' }
  /** V-03: processo inexistente, de outro tenant ou não visível — recarrega a busca. */
  | { readonly kind: 'target' }
  | { readonly kind: 'process'; readonly detail: string }
  | { readonly kind: 'permission'; readonly detail: string }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'keyReused' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'unexpected'; readonly correlationId: string };

export function problemOf(error: ApiError): DuplicateProblem {
  if (error.status === 409 && error.code === 'DOCUMENT_ALREADY_EXISTS') {
    const meta = (error.problem?.meta ?? {}) as { code?: string | null; existingDfdId?: string };
    return { kind: 'exists', code: meta.code ?? null, dfdId: meta.existingDfdId ?? null };
  }
  if (error.code === 'DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE') return { kind: 'stage' };
  if (error.status === 422 && error.code === 'VALIDATION_ERROR') {
    if (error.errors.some((item) => item.field === 'targetProcessId')) return { kind: 'target' };
    return { kind: 'unexpected', correlationId: error.correlationId ?? '—' };
  }
  if (error.code === 'INVALID_PROCESS_STATUS') {
    return { kind: 'process', detail: error.problem?.detail ?? error.message };
  }
  if (error.code === 'IDEMPOTENCY_KEY_REUSED') return { kind: 'keyReused' };
  if (error.status === 403) {
    return { kind: 'permission', detail: error.problem?.detail ?? error.message };
  }
  if (error.status === 404) return { kind: 'notFound' };
  if (error.status === 503 || error.status === 429) return { kind: 'unavailable' };
  return { kind: 'unexpected', correlationId: error.correlationId ?? '—' };
}
