import { z } from 'zod';

import { PROCESS_STATUSES } from './process-actions.js';
import { processSchema } from './process.js';
import { DOCUMENT_STATUSES } from '../document/document-type.js';

/*
 * Encaminhamento do processo (US-047 · PRC-19 · api/02-processes.md): o corpo de
 * `POST /processes/{id}/forward`, a resposta e o registro gravado na tramitação
 * (`ProcessMovement.documents`/`metadata` — entities.md §5.6, versão 1). As MESMAS regras validam
 * o painel lateral SCR-103 e a API; as que dependem da transição escolhida (comentário obrigatório,
 * sobrescrita de prazo) ficam em funções puras chamadas pelos dois lados.
 */

/** Limites de RN-TRAM-10/11/12. */
export const PROCESS_FORWARD_LIMITS = Object.freeze({
  commentMax: 5000,
  /** Comentário obrigatório (`requiresComment`): ao menos 10 caracteres (RN-TRAM-11). */
  commentMinWhenRequired: 10,
  documentsMax: 50,
  overrideReasonMin: 10,
  overrideReasonMax: 1000,
  /** A data sobrescrita fica entre hoje e hoje + 365 dias (RN-TRAM-10). */
  overrideMaxDays: 365,
  acknowledgedWarningsMax: 100,
});

/** Mensagens das tabelas "Validações" e "Casos de erro" da US-047. */
export const PROCESS_FORWARD_MESSAGES = Object.freeze({
  transitionRequired: 'Selecione para onde o processo vai.',
  commentRequired: 'Informe um comentário (mín. 10 caracteres).',
  commentTooLong: 'O comentário pode ter até 5.000 caracteres.',
  documents: 'Selecione até 50 documentos, sem repetição.',
  documentUnavailable: 'Um dos documentos selecionados não está disponível.',
  stageChanged: 'O processo acabou de ser movimentado por outra pessoa.',
  versionConflict: 'O processo foi alterado. Recarregue para continuar.',
  transitionNotAvailable: 'Este caminho não está disponível para a etapa atual.',
  destinationInactive:
    'A unidade de destino desta etapa está inativa. Fale com o administrador do órgão.',
  blocked: (count: number) =>
    count === 1
      ? 'Há 1 pendência obrigatória na etapa.'
      : `Há ${String(count)} pendências obrigatórias na etapa.`,
  warningsNotAcknowledged: 'Confirme que está ciente dos avisos antes de encaminhar.',
  departmentRequired: 'Escolha a unidade de destino.',
  departmentInvalid: 'Selecione uma unidade de destino válida.',
  departmentMismatch: 'A unidade de destino desta etapa é definida pelo workflow.',
  assigneeNotEligible: 'Esta pessoa não pode receber o processo nesta unidade.',
  assigneeNotAllowed: 'Na etapa de aprovação o aprovador é definido pelo workflow.',
  dueDateNotAllowed: 'Esta etapa não permite alterar o prazo.',
  dueDateFormat: 'Informe a data do prazo no formato AAAA-MM-DD.',
  dueDateRange: (limit: string) =>
    `Informe uma data entre hoje e ${limit} e o motivo da alteração.`,
  dueDateReason: 'Informe o motivo da alteração do prazo (10 a 1.000 caracteres).',
  notCustodian: 'Você não está com este processo.',
  invalidStatus: 'O processo não pode ser encaminhado no status atual.',
  forwarded: 'Processo encaminhado',
});

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** `dueAt` do corpo: `YYYY-MM-DD` (normalizado ao fim do dia no fuso do tenant) ou ISO 8601. */
export function isDueDateInput(value: string): boolean {
  if (DATE_ONLY.test(value)) return !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
  return z.iso.datetime({ offset: true }).safeParse(value).success;
}

/** Código de aviso de documento reconhecível no PRC-19 (`DFD_ATTACHMENTS_PENDING`, …). */
const WARNING_CODE = /^[A-Z][A-Z0-9_]{2,79}$/;

/** Corpo de PRC-19. ESTRITO: campo fora da lista → 422 (`NOT_ALLOWED`). */
export const forwardProcessSchema = z
  .strictObject({
    transitionId: z.uuid({ error: PROCESS_FORWARD_MESSAGES.transitionRequired }),
    expectedStageId: z.uuid({ error: PROCESS_FORWARD_MESSAGES.transitionRequired }),
    toDepartmentId: z.uuid({ error: PROCESS_FORWARD_MESSAGES.departmentInvalid }).optional(),
    toUserId: z.uuid({ error: PROCESS_FORWARD_MESSAGES.assigneeNotEligible }).optional(),
    dueAt: z
      .string({ error: PROCESS_FORWARD_MESSAGES.dueDateFormat })
      .refine(isDueDateInput, {
        error: PROCESS_FORWARD_MESSAGES.dueDateFormat,
        params: { code: 'INVALID_FORMAT' },
      })
      .optional(),
    dueDateOverrideReason: z
      .string({ error: PROCESS_FORWARD_MESSAGES.dueDateReason })
      .trim()
      .max(PROCESS_FORWARD_LIMITS.overrideReasonMax, {
        error: PROCESS_FORWARD_MESSAGES.dueDateReason,
      })
      .optional(),
    comment: z
      .string({ error: PROCESS_FORWARD_MESSAGES.commentTooLong })
      .trim()
      .max(PROCESS_FORWARD_LIMITS.commentMax, { error: PROCESS_FORWARD_MESSAGES.commentTooLong })
      .optional(),
    documentIds: z
      .array(z.uuid({ error: PROCESS_FORWARD_MESSAGES.documentUnavailable }), {
        error: PROCESS_FORWARD_MESSAGES.documents,
      })
      .max(PROCESS_FORWARD_LIMITS.documentsMax, { error: PROCESS_FORWARD_MESSAGES.documents })
      .optional(),
    // DEC-016 · RN-DFD-41: ids das regras `WARNING` do workflow (PRC-08) e códigos dos avisos dos
    // documentos cobertos pela etapa de aprovação (DOC-08 — ex.: `DFD_ATTACHMENTS_PENDING`).
    acknowledgedWarnings: z
      .array(
        z.union([z.uuid(), z.string().regex(WARNING_CODE)], {
          error: PROCESS_FORWARD_MESSAGES.warningsNotAcknowledged,
        }),
      )
      .max(PROCESS_FORWARD_LIMITS.acknowledgedWarningsMax)
      .optional(),
  })
  .superRefine((value, ctx) => {
    const ids = value.documentIds ?? [];
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['documentIds'],
        message: PROCESS_FORWARD_MESSAGES.documents,
        params: { code: 'DUPLICATE_IN_LIST' },
      });
    }
    // V-14: o motivo acompanha a data sobrescrita (a janela de datas depende do fuso do tenant).
    const reason = value.dueDateOverrideReason ?? '';
    if (value.dueAt !== undefined && reason.length < PROCESS_FORWARD_LIMITS.overrideReasonMin) {
      ctx.addIssue({
        code: 'custom',
        path: ['dueDateOverrideReason'],
        message: PROCESS_FORWARD_MESSAGES.dueDateReason,
        params: { code: 'CONDITIONAL_REQUIRED' },
      });
    }
  })
  .meta({ id: 'ForwardProcessRequest' });
export type ForwardProcess = z.output<typeof forwardProcessSchema>;
export type ForwardProcessInput = z.input<typeof forwardProcessSchema>;

export interface ForwardIssue {
  readonly field: 'comment' | 'dueAt' | 'dueDateOverrideReason';
  readonly code: 'CONDITIONAL_REQUIRED' | 'TOO_SHORT' | 'DATE_IN_PAST' | 'OUT_OF_RANGE';
  readonly message: string;
}

/** RN-TRAM-11 (V-02): comentário obrigatório (mín. 10) quando a transição exige. */
export function forwardCommentIssues(
  comment: string | null | undefined,
  requiresComment: boolean,
): ForwardIssue[] {
  const text = comment?.trim() ?? '';
  if (!requiresComment) return [];
  if (text.length === 0) {
    return [
      {
        field: 'comment',
        code: 'CONDITIONAL_REQUIRED',
        message: PROCESS_FORWARD_MESSAGES.commentRequired,
      },
    ];
  }
  if (text.length < PROCESS_FORWARD_LIMITS.commentMinWhenRequired) {
    return [
      { field: 'comment', code: 'TOO_SHORT', message: PROCESS_FORWARD_MESSAGES.commentRequired },
    ];
  }
  return [];
}

/** Soma dias a uma data `YYYY-MM-DD` (sem fuso). */
function plusDays(date: string, days: number): string {
  const instant = new Date(`${date}T00:00:00Z`);
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}

/** `DD/MM/AAAA` de uma data `YYYY-MM-DD`. */
function brazilianDate(date: string): string {
  const [year, month, day] = date.split('-');
  return `${day ?? ''}/${month ?? ''}/${year ?? ''}`;
}

/**
 * RN-TRAM-10 (V-14): a data sobrescrita (dia local `YYYY-MM-DD`) fica entre hoje e hoje + 365
 * dias no fuso do tenant. O motivo obrigatório é conferido pelo schema.
 */
export function dueDateOverrideIssues(dueDate: string, today: string): ForwardIssue[] {
  const limit = plusDays(today, PROCESS_FORWARD_LIMITS.overrideMaxDays);
  if (dueDate < today) {
    return [
      {
        field: 'dueAt',
        code: 'DATE_IN_PAST',
        message: PROCESS_FORWARD_MESSAGES.dueDateRange(brazilianDate(limit)),
      },
    ];
  }
  if (dueDate > limit) {
    return [
      {
        field: 'dueAt',
        code: 'OUT_OF_RANGE',
        message: PROCESS_FORWARD_MESSAGES.dueDateRange(brazilianDate(limit)),
      },
    ];
  }
  return [];
}

/** `ProcessMovement.documents[]` (entities.md §5.6 — `MovementDocumentRef`). */
export const movementDocumentRefSchema = z
  .object({
    documentId: z.uuid(),
    documentVersionId: z.uuid().nullable(),
    versionNumber: z.int().min(1).nullable(),
    code: z.string().nullable(),
    title: z.string(),
    documentTypeCode: z.string(),
    status: z.enum(DOCUMENT_STATUSES),
  })
  .meta({ id: 'MovementDocumentRef' });
export type MovementDocumentRef = z.infer<typeof movementDocumentRefSchema>;

/** Versão do schema de `ProcessMovement.metadata` (entities.md §5.6). */
export const MOVEMENT_METADATA_VERSION = 1;

/** Aviso reconhecido (DEC-016): id e mensagem da regra exibida. */
export const acknowledgedWarningSchema = z.object({ ruleId: z.uuid(), message: z.string() });
export type AcknowledgedWarning = z.infer<typeof acknowledgedWarningSchema>;

/** Aviso reconhecido de documento coberto pela aprovação (US-016 · RN-DFD-41). */
export const acknowledgedDocumentWarningSchema = z.object({
  documentId: z.uuid(),
  code: z.string(),
  message: z.string(),
});
export type AcknowledgedDocumentWarning = z.infer<typeof acknowledgedDocumentWarningSchema>;

/** `ProcessMovement.metadata` (`MovementMetadata` v1 — todos opcionais). */
export const movementMetadataSchema = z
  .object({
    v: z.literal(MOVEMENT_METADATA_VERSION).optional(),
    warningsAcknowledged: z.array(acknowledgedWarningSchema).optional(),
    documentWarningsAcknowledged: z.array(acknowledgedDocumentWarningSchema).optional(),
    computedDueAt: z.iso.datetime({ offset: true }).nullable().optional(),
    dueDateOverridden: z.boolean().optional(),
    dueDateOverrideReason: z.string().optional(),
    approvalRequestedId: z.uuid().optional(),
    labels: z
      .object({
        fromStage: z.string().optional(),
        toStage: z.string().optional(),
        fromDepartment: z.string().optional(),
        toDepartment: z.string().optional(),
        fromUser: z.string().optional(),
        toUser: z.string().optional(),
      })
      .optional(),
    withdrawn: z.boolean().optional(),
    clientChannel: z.enum(['WEB', 'API']).optional(),
  })
  .meta({ id: 'MovementMetadata' });
export type MovementMetadata = z.infer<typeof movementMetadataSchema>;

/** PRC-19 — `data` da resposta: o processo atualizado, a tramitação e a aprovação aberta. */
export const forwardedProcessSchema = processSchema
  .extend({
    movement: z.object({ id: z.uuid(), sequence: z.int().min(1) }),
    /** Aprovação aberta pelo destino `APPROVAL` (US-051); ausente nos demais destinos. */
    approval: z.object({ id: z.uuid(), approverLabel: z.string() }).optional(),
    /** Autuação no 1º encaminhamento (FA-07): o código atribuído agora. */
    numberAssigned: z.boolean(),
    statusFrom: z.enum(PROCESS_STATUSES),
  })
  .meta({ id: 'ForwardedProcess' });
export type ForwardedProcessDto = z.infer<typeof forwardedProcessSchema>;
