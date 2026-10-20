import { z } from 'zod';

import { processSchema } from './process.js';
import { isoDateTimeSchema } from '../common/dates.js';

/*
 * Concluir o processo (US-010 · PRC-26 · api/02-processes.md): o corpo de
 * `POST /processes/{id}/complete` e as mensagens. As MESMAS regras validam o diálogo SCR-116 e a
 * API; custódia, status, transição `COMPLETE`/etapa `END` e regras de saída ficam com o comando
 * (RN-PROC-111..117 · POL-01/POL-08). A resposta é o `Process` com o carimbo da conclusão.
 */

/** Limites da tabela "Campos" da US-010. */
export const PROCESS_COMPLETION_LIMITS = Object.freeze({
  commentMax: 5000,
  acknowledgedWarningsMax: 100,
});

/** Mensagens das tabelas "Validações" e "Casos de erro" da US-010. */
export const PROCESS_COMPLETION_MESSAGES = Object.freeze({
  commentTooLong: 'A observação pode ter até 5.000 caracteres.',
  /** V-01. */
  notCustodian: 'Apenas quem está com o processo pode concluí-lo.',
  /** V-02. */
  permissionDenied: 'Você não tem permissão para concluir este processo.',
  /** V-03. */
  invalidStatus: 'Retome o processo antes de concluí-lo.',
  /** V-04. */
  blocked: 'Há pendências que impedem a conclusão.',
  /** V-05. */
  warningsNotAcknowledged: 'Confirme que está ciente dos avisos para continuar.',
  /** V-06. */
  versionConflict: 'Este processo foi alterado por outra pessoa.',
  /** Sem transição `COMPLETE` na etapa atual nem etapa `END`. */
  transitionNotAvailable: 'A conclusão não está disponível na etapa atual.',
  /** 503. */
  unavailable: 'Não foi possível concluir a ação agora.',
  completed: 'Processo concluído',
});

/** Corpo de PRC-26. ESTRITO: campo fora da lista → 422 (`NOT_ALLOWED`). */
export const completeProcessSchema = z
  .strictObject({
    comment: z
      .string({ error: PROCESS_COMPLETION_MESSAGES.commentTooLong })
      .trim()
      .max(PROCESS_COMPLETION_LIMITS.commentMax, {
        error: PROCESS_COMPLETION_MESSAGES.commentTooLong,
      })
      .optional(),
    // RN-PROC-113 · DEC-016: ids das regras `WARNING` do workflow reconhecidas no diálogo.
    acknowledgedWarnings: z
      .array(z.uuid({ error: PROCESS_COMPLETION_MESSAGES.warningsNotAcknowledged }))
      .max(PROCESS_COMPLETION_LIMITS.acknowledgedWarningsMax)
      .optional(),
  })
  .meta({ id: 'CompleteProcessRequest' });
export type CompleteProcess = z.output<typeof completeProcessSchema>;
export type CompleteProcessInput = z.input<typeof completeProcessSchema>;

/** `Process` de PRC-26 com o carimbo da conclusão (RN-PROC-115). */
export const completedProcessSchema = processSchema
  .extend({
    completedAt: isoDateTimeSchema,
    completedBy: z.object({ id: z.uuid(), name: z.string() }),
  })
  .meta({ id: 'CompletedProcess' });
export type CompletedProcessDto = z.infer<typeof completedProcessSchema>;
