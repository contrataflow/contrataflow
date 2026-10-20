/*
 * Ações em lote da caixa de tarefas (US-058 · TSK-03/TSK-04), puro: o resultado de cada item e o
 * resumo do lote. Nenhuma regra de autorização nova — cada item passa pelo PRC-21/PRC-22 inteiro
 * (POL-04/POL-05 por item — RN-INBOX-20/21); aqui só se traduz a recusa de um item no erro que o
 * resultado mostra e se agrega o lote (RN-INBOX-22).
 */

/** Erro de um item como o caso de uso o recusou (código estável, status HTTP e mensagem). */
export interface BulkItemRefusal {
  readonly code: string;
  readonly status: number;
  readonly detail: string;
  /** Mensagem do primeiro `errors[]` de um `VALIDATION_ERROR` (ex.: `assigneeId`). */
  readonly fieldMessage?: string | undefined;
}

export interface BulkItemFailure {
  readonly code: string;
  readonly message: string;
}

export type BulkItemResult<P> =
  | { readonly processId: string; readonly ok: true; readonly process: P }
  | {
      readonly processId: string;
      readonly ok: false;
      readonly code: string;
      readonly message: string;
    };

export interface BulkSummary {
  readonly successCount: number;
  readonly errorCount: number;
}

export const BULK_ITEM_MESSAGES = Object.freeze({
  notFound: 'O processo não pôde ser processado.',
  unavailable: 'Não foi possível concluir a ação agora.',
  unexpected: 'Ocorreu um erro inesperado ao processar este item.',
});

/**
 * Item de outro tenant, inexistente ou invisível sai como `REFERENCE_NOT_FOUND` sem revelar a
 * existência (cenário [Tenant incorreto]); indisponibilidade como `DEPENDENCY_UNAVAILABLE`; as
 * demais recusas de regra mantêm o código e a mensagem do PRC-21/PRC-22.
 */
export function bulkItemFailureOf(refusal: BulkItemRefusal | null): BulkItemFailure {
  if (refusal === null) return { code: 'INTERNAL_ERROR', message: BULK_ITEM_MESSAGES.unexpected };
  if (refusal.code === 'PROCESS_NOT_FOUND') {
    return { code: 'REFERENCE_NOT_FOUND', message: BULK_ITEM_MESSAGES.notFound };
  }
  if (isUnavailable(refusal)) {
    return { code: 'DEPENDENCY_UNAVAILABLE', message: BULK_ITEM_MESSAGES.unavailable };
  }
  if (refusal.status >= 500) {
    return { code: 'INTERNAL_ERROR', message: BULK_ITEM_MESSAGES.unexpected };
  }
  return { code: refusal.code, message: refusal.fieldMessage ?? refusal.detail };
}

/** Banco fora no meio do lote: os itens seguintes não são tentados (cenário [Falha de banco]). */
export function isUnavailable(refusal: BulkItemRefusal | null): boolean {
  return refusal !== null && refusal.code === 'DEPENDENCY_UNAVAILABLE';
}

/** O item que não chegou a ser tentado porque o banco caiu antes dele. */
export function notAttempted(processId: string): BulkItemResult<never> {
  return {
    processId,
    ok: false,
    code: 'DEPENDENCY_UNAVAILABLE',
    message: BULK_ITEM_MESSAGES.unavailable,
  };
}

export function summarizeBulk(results: readonly BulkItemResult<unknown>[]): BulkSummary {
  const successCount = results.filter((result) => result.ok).length;
  return { successCount, errorCount: results.length - successCount };
}
