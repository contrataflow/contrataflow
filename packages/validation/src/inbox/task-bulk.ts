import { z } from 'zod';

import { PROCESS_ASSIGN_LIMITS } from '../process/process-assign.js';

/*
 * Ações em lote da caixa de tarefas (US-058 · TSK-03/TSK-04 · SCR-013/SCR-115): o corpo de
 * `POST /tasks/bulk-claim` e `POST /tasks/bulk-assign` e o resultado por item. O mesmo schema valida
 * a API (422 `VALIDATION_ERROR` com `TOO_SHORT`/`TOO_LONG`/`DUPLICATE_IN_LIST`/`REQUIRED`) e a
 * seleção do front; as mensagens são as das tabelas "Validações" e "Casos de erro" da story.
 */

/** RN-INBOX-19: de 2 a 50 `processId` distintos por lote. */
export const TASK_BULK_LIMITS = Object.freeze({ min: 2, max: 50 });

export const TASK_BULK_MESSAGES = Object.freeze({
  /** V-01. */
  tooShort: 'Selecione ao menos 2 processos.',
  /** V-02 / FA-01. */
  tooLong: 'Selecione no máximo 50 processos por vez.',
  /** V-03. */
  duplicate: 'Há processos repetidos na seleção.',
  /** V-04. */
  assignRequired: 'Selecione o responsável e informe o motivo.',
  reasonTooShort: 'O motivo deve ter ao menos 10 caracteres.',
  reasonTooLong: 'O motivo pode ter até 2.000 caracteres.',
  /** Sem permissão base (403 do lote inteiro). */
  permissionDenied: 'Você não tem permissão para esta ação em lote.',
  /** Item de outro tenant ou inexistente (`REFERENCE_NOT_FOUND`). */
  itemNotFound: 'O processo não pôde ser processado.',
  /** Item não processado por indisponibilidade (`DEPENDENCY_UNAVAILABLE`). */
  itemUnavailable: 'Não foi possível concluir a ação agora.',
});

const processIdsSchema = z
  .array(z.uuid(), { error: TASK_BULK_MESSAGES.tooShort })
  .min(TASK_BULK_LIMITS.min, { error: TASK_BULK_MESSAGES.tooShort })
  .max(TASK_BULK_LIMITS.max, { error: TASK_BULK_MESSAGES.tooLong })
  .refine((ids) => new Set(ids).size === ids.length, {
    message: TASK_BULK_MESSAGES.duplicate,
    params: { code: 'DUPLICATE_IN_LIST' },
  });

/** TSK-03. ESTRITO: campo fora da lista → 422 (`NOT_ALLOWED`). */
export const bulkClaimSchema = z
  .strictObject({ processIds: processIdsSchema })
  .meta({ id: 'BulkClaimRequest' });
export type BulkClaim = z.output<typeof bulkClaimSchema>;

/**
 * TSK-04. Todos os itens vão ao MESMO `assigneeId` (RN-INBOX-21) e o motivo vale para o lote
 * inteiro, com os limites da reatribuição manual (RN-TRAM-39 · DEC-022).
 */
export const bulkAssignSchema = z
  .strictObject({
    processIds: processIdsSchema,
    assigneeId: z.uuid({ error: TASK_BULK_MESSAGES.assignRequired }),
    reason: z
      .string({ error: TASK_BULK_MESSAGES.assignRequired })
      .trim()
      .min(PROCESS_ASSIGN_LIMITS.reasonMin, { error: TASK_BULK_MESSAGES.reasonTooShort })
      .max(PROCESS_ASSIGN_LIMITS.reasonMax, { error: TASK_BULK_MESSAGES.reasonTooLong }),
  })
  .meta({ id: 'BulkAssignRequest' });
export type BulkAssign = z.output<typeof bulkAssignSchema>;
export type BulkAssignInput = z.input<typeof bulkAssignSchema>;

/** O processo depois do item bem-sucedido (o que a lista precisa para se atualizar). */
export const bulkProcessRefSchema = z
  .object({
    id: z.uuid(),
    code: z.string().nullable(),
    version: z.int().min(1),
    currentResponsible: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  })
  .meta({ id: 'BulkProcessRef' });

/** Resultado de um item do lote (RN-INBOX-22): sucesso com `process` ou erro com `code`/`message`. */
export const bulkItemResultSchema = z
  .object({
    processId: z.uuid(),
    ok: z.boolean(),
    code: z.string().optional(),
    message: z.string().optional(),
    process: bulkProcessRefSchema.optional(),
  })
  .meta({ id: 'BulkItemResult' });
export type BulkItemResultDto = z.infer<typeof bulkItemResultSchema>;

export const bulkResultMetaSchema = z.object({
  successCount: z.int().min(0),
  errorCount: z.int().min(0),
});
export type BulkResultMeta = z.infer<typeof bulkResultMetaSchema>;

export const bulkResultResponseSchema = z.object({
  data: z.array(bulkItemResultSchema),
  meta: bulkResultMetaSchema,
});
export type BulkResultResponse = z.infer<typeof bulkResultResponseSchema>;
