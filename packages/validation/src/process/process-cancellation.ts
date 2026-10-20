import { z } from 'zod';

import { processSchema } from './process.js';
import { isoDateTimeSchema } from '../common/dates.js';

/*
 * Cancelar o processo e descartar o rascunho sem número (US-009 · PRC-25/PRC-06 ·
 * api/02-processes.md): o corpo de `POST /processes/{id}/cancel`, o corpo opcional de
 * `DELETE /processes/{id}` e a resposta do cancelamento. As MESMAS regras validam os diálogos
 * SCR-116 e a API; status, numeração e efeitos ficam com o comando (RN-PROC-103..110).
 */

/** Limites de RN-PROC-104 (o teto da justificativa é o do comentário da tramitação `CANCEL`). */
export const PROCESS_CANCELLATION_LIMITS = Object.freeze({
  reasonMin: 20,
  reasonMax: 5000,
  discardReasonMax: 500,
});

/** Mensagens das tabelas "Validações" e "Casos de erro" da US-009. */
export const PROCESS_CANCELLATION_MESSAGES = Object.freeze({
  /** V-01. */
  reasonTooShort: 'A justificativa deve ter pelo menos 20 caracteres.',
  reasonTooLong: 'A justificativa pode ter até 5.000 caracteres.',
  discardReasonTooLong: 'O motivo pode ter até 500 caracteres.',
  /** V-02. */
  finalStatus: 'Este processo já foi encerrado e não pode ser alterado.',
  /** Descartar fora de `DRAFT`. */
  notDraft: 'Só é possível descartar um rascunho.',
  /** V-03. */
  numbered: 'Este processo já tem número; cancele-o em vez de descartar.',
  /** V-04. */
  permissionDenied: 'Você não tem permissão para esta ação.',
  /** V-05. */
  versionConflict:
    'Este processo foi alterado por outra pessoa. Recarregue a página e tente novamente.',
  /** RN-PROC-106: motivo da retirada automática do documento em análise. */
  documentWithdrawn: 'Processo cancelado',
  /** 503. */
  unavailable: 'Não foi possível concluir a ação agora.',
});

/** Corpo de PRC-25. ESTRITO: campo fora da lista → 422 (`NOT_ALLOWED`). */
export const cancelProcessSchema = z
  .strictObject({
    cancellationReason: z
      .string({ error: PROCESS_CANCELLATION_MESSAGES.reasonTooShort })
      .trim()
      .min(PROCESS_CANCELLATION_LIMITS.reasonMin, {
        error: PROCESS_CANCELLATION_MESSAGES.reasonTooShort,
      })
      .max(PROCESS_CANCELLATION_LIMITS.reasonMax, {
        error: PROCESS_CANCELLATION_MESSAGES.reasonTooLong,
      }),
  })
  .meta({ id: 'CancelProcessRequest' });
export type CancelProcess = z.output<typeof cancelProcessSchema>;
export type CancelProcessInput = z.input<typeof cancelProcessSchema>;

/**
 * Corpo opcional de PRC-06: o motivo do descarte (até 500, só na auditoria — DEC-034). Sem corpo
 * = sem motivo. ESTRITO.
 */
export const discardProcessDraftSchema = z
  .strictObject({
    reason: z
      .string({ error: PROCESS_CANCELLATION_MESSAGES.discardReasonTooLong })
      .trim()
      .max(PROCESS_CANCELLATION_LIMITS.discardReasonMax, {
        error: PROCESS_CANCELLATION_MESSAGES.discardReasonTooLong,
      })
      .optional(),
  })
  .meta({ id: 'DiscardProcessDraftRequest' });
export type DiscardProcessDraft = z.output<typeof discardProcessDraftSchema>;
export type DiscardProcessDraftInput = z.input<typeof discardProcessDraftSchema>;

/** `Process` de PRC-25 com os campos do cancelamento (RN-PROC-104). */
export const canceledProcessSchema = processSchema
  .extend({
    canceledAt: isoDateTimeSchema.nullable(),
    cancellationReason: z.string().nullable(),
  })
  .meta({ id: 'CanceledProcess' });
export type CanceledProcessDto = z.infer<typeof canceledProcessSchema>;
