import { z } from 'zod';

import { PROCESS_STATUSES } from './process-actions.js';
import { processSchema } from './process.js';
import { isoDateTimeSchema } from '../common/dates.js';
import { DAY_COUNT_TYPES } from '../document/document-type.js';

/*
 * Suspender e retomar o processo (US-008 · PRC-23/PRC-24 · api/02-processes.md): os corpos de
 * `POST /processes/{id}/suspend` e `/resume` e as respostas. As MESMAS regras validam os diálogos
 * SCR-116 e a API; status de origem, extensão do prazo e congelamento ficam com o comando
 * (RN-PROC-93..102).
 */

/** Limites de RN-PROC-94/97. */
export const PROCESS_SUSPENSION_LIMITS = Object.freeze({
  reasonMin: 20,
  reasonMax: 5000,
  commentMax: 5000,
});

/** Status a partir dos quais se suspende (RN-PROC-93 · DEC-013 · POL-07). */
export const SUSPENDABLE_PROCESS_STATUSES = [
  'IN_PROGRESS',
  'AWAITING_APPROVAL',
  'RETURNED',
] as const;

/** Mensagens das tabelas "Validações" e "Casos de erro" da US-008. */
export const PROCESS_SUSPENSION_MESSAGES = Object.freeze({
  /** V-01. */
  reasonRequired: 'Informe o motivo da suspensão (mínimo de 20 caracteres).',
  reasonTooLong: 'O motivo pode ter até 5.000 caracteres.',
  commentTooLong: 'O comentário pode ter até 5.000 caracteres.',
  /** V-02. */
  notSuspendable:
    'Só é possível suspender processos em andamento, aguardando aprovação ou devolvidos.',
  /** V-03. */
  notSuspended: 'Este processo não está suspenso.',
  /** V-04 (ações de custódia e decisões durante a suspensão). */
  frozen: 'O processo está suspenso. Retome-o para continuar.',
  /** V-05. */
  versionConflict: 'O processo foi alterado por outra pessoa. Recarregue e tente novamente.',
  /** 403. */
  permissionDenied: 'Você não tem permissão para suspender ou retomar este processo.',
  /** FA-01 (aprovador no painel). */
  approvalFrozen: 'Processo suspenso — decisão indisponível até a retomada',
  /** 503. */
  unavailable: 'Não foi possível concluir agora. Tente novamente em instantes.',
});

/** Corpo de PRC-23. ESTRITO: campo fora da lista → 422 (`NOT_ALLOWED`). */
export const suspendProcessSchema = z
  .strictObject({
    reason: z
      .string({ error: PROCESS_SUSPENSION_MESSAGES.reasonRequired })
      .trim()
      .min(1, { error: PROCESS_SUSPENSION_MESSAGES.reasonRequired, abort: true })
      .min(PROCESS_SUSPENSION_LIMITS.reasonMin, {
        error: PROCESS_SUSPENSION_MESSAGES.reasonRequired,
      })
      .max(PROCESS_SUSPENSION_LIMITS.reasonMax, {
        error: PROCESS_SUSPENSION_MESSAGES.reasonTooLong,
      }),
  })
  .meta({ id: 'SuspendProcessRequest' });
export type SuspendProcess = z.output<typeof suspendProcessSchema>;
export type SuspendProcessInput = z.input<typeof suspendProcessSchema>;

/** Corpo de PRC-24 (comentário opcional; vazio = sem comentário). ESTRITO. */
export const resumeProcessSchema = z
  .strictObject({
    comment: z
      .string({ error: PROCESS_SUSPENSION_MESSAGES.commentTooLong })
      .trim()
      .max(PROCESS_SUSPENSION_LIMITS.commentMax, {
        error: PROCESS_SUSPENSION_MESSAGES.commentTooLong,
      })
      .optional(),
  })
  .meta({ id: 'ResumeProcessRequest' });
export type ResumeProcess = z.output<typeof resumeProcessSchema>;
export type ResumeProcessInput = z.input<typeof resumeProcessSchema>;

const currentStageSchema = processSchema.shape.currentStage.unwrap();

/**
 * `Process` de PRC-23/PRC-24 com os campos da suspensão (RN-PROC-94/97) e a pausa da etapa ativa
 * (`currentStage.pausedAt` — RN-PROC-95/98).
 */
export const suspensionProcessSchema = processSchema
  .extend({
    currentStage: currentStageSchema.extend({ pausedAt: isoDateTimeSchema.nullable() }).nullable(),
    statusBeforeSuspension: z.enum(PROCESS_STATUSES).nullable(),
    suspendedAt: isoDateTimeSchema.nullable(),
    suspensionReason: z.string().nullable(),
  })
  .meta({ id: 'SuspensionProcess' });
export type SuspensionProcessDto = z.infer<typeof suspensionProcessSchema>;

/** PRC-24 — `meta`: dias acrescidos ao prazo da etapa e o novo prazo (RN-PROC-98). */
export const resumeMetaSchema = z
  .object({
    extendedBy: z.object({ days: z.int().min(0), slaType: z.enum(DAY_COUNT_TYPES) }),
    /** `null` = etapa sem prazo (FA-02). */
    newDueAt: isoDateTimeSchema.nullable(),
  })
  .meta({ id: 'ResumeProcessMeta' });
export type ResumeMeta = z.infer<typeof resumeMetaSchema>;
