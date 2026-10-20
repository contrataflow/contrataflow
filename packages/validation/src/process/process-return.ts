import { z } from 'zod';

import { PROCESS_STATUSES } from './process-actions.js';
import { isDueDateInput } from './process-forward.js';
import { processSchema } from './process.js';

/*
 * Devolução do processo (US-048 · PRC-20 · api/02-processes.md): o corpo de
 * `POST /processes/{id}/return` e a resposta. As MESMAS regras validam o diálogo SCR-104 e a API;
 * o destino (etapa já percorrida e configurada na transição `RETURN`) e a sobrescrita de prazo
 * dependem do estado do processo e ficam com o comando (RN-TRAM-24/26).
 */

/** Limites de RN-TRAM-25. */
export const PROCESS_RETURN_LIMITS = Object.freeze({
  commentMin: 10,
  commentMax: 5000,
});

/** Mensagens das tabelas "Validações" e "Casos de erro" da US-048. */
export const PROCESS_RETURN_MESSAGES = Object.freeze({
  targetRequired: 'Informe a etapa de destino.',
  commentRequired: 'Informe o motivo da devolução.',
  commentTooShort: 'O motivo deve ter ao menos 10 caracteres.',
  commentTooLong: 'O motivo pode ter até 5.000 caracteres.',
  targetNotAvailable: 'Esta etapa não está disponível como destino da devolução.',
  dueDateNotAllowed: 'O prazo desta devolução não pode ser alterado.',
  dueDateFormat: 'Informe a data do prazo no formato AAAA-MM-DD.',
  dueDateRange: 'Informe uma data de prazo entre hoje e os próximos 365 dias.',
  invalidStatus: 'Este processo não pode ser devolvido no status atual.',
  notCustodian: 'Você não está com este processo.',
  stageChanged: 'Este processo foi tramitado por outra pessoa. Atualize a página.',
  versionConflict: 'Os dados do processo mudaram. Atualize a página.',
  /** Motivo gravado na passagem quando o prazo é informado na devolução (CHECK de `process_stages`). */
  dueDateOverrideReason: 'Prazo definido na devolução.',
});

/** Corpo de PRC-20. ESTRITO: campo fora da lista → 422 (`NOT_ALLOWED`). */
export const returnProcessSchema = z
  .strictObject({
    targetStageId: z.uuid({ error: PROCESS_RETURN_MESSAGES.targetRequired }),
    comment: z
      .string({ error: PROCESS_RETURN_MESSAGES.commentRequired })
      .trim()
      .min(1, { error: PROCESS_RETURN_MESSAGES.commentRequired, abort: true })
      .min(PROCESS_RETURN_LIMITS.commentMin, { error: PROCESS_RETURN_MESSAGES.commentTooShort })
      .max(PROCESS_RETURN_LIMITS.commentMax, { error: PROCESS_RETURN_MESSAGES.commentTooLong }),
    dueAt: z
      .string({ error: PROCESS_RETURN_MESSAGES.dueDateFormat })
      .refine(isDueDateInput, {
        error: PROCESS_RETURN_MESSAGES.dueDateFormat,
        params: { code: 'INVALID_FORMAT' },
      })
      .optional(),
    /** `ProcessStage` ativa quando a tela foi carregada (RN-TRAM-30). */
    expectedStageId: z.uuid({ error: PROCESS_RETURN_MESSAGES.stageChanged }).optional(),
  })
  .meta({ id: 'ReturnProcessRequest' });
export type ReturnProcess = z.output<typeof returnProcessSchema>;
export type ReturnProcessInput = z.input<typeof returnProcessSchema>;

/** PRC-20 — `data` da resposta: o processo atualizado e a tramitação `RETURN`. */
export const returnedProcessSchema = processSchema
  .extend({
    movement: z.object({ id: z.uuid(), sequence: z.int().min(1) }),
    statusFrom: z.enum(PROCESS_STATUSES),
  })
  .meta({ id: 'ReturnedProcess' });
export type ReturnedProcessDto = z.infer<typeof returnedProcessSchema>;
