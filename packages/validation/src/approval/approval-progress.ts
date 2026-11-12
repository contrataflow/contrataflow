import { z } from 'zod';

import { APPROVAL_APPROVER_STATUSES, APPROVAL_LINES_MAX } from './approval-approvers.js';
import type { ApprovalApproverStatus, ApprovalSkippedReason } from './approval-approvers.js';
import type { ApprovalDecisionPolicy } from '../document/approver-lines.js';
import type { ApprovalStatus } from '../process/process-actions.js';

/*
 * Andamento da aprovação múltipla na leitura (US-136 · DEC-193 · RN-APV-67/70/71): os contadores
 * de linhas, o texto de andamento montado no servidor (o MESMO na caixa, na lista e no detalhe) e a
 * situação de cada linha por texto (nunca só por cor). Puro: vale na API e no front.
 */

/** RN-APV-67: contadores das linhas não `CANCELED` e o texto de RN-APV-70 (ausente em `ANY` de uma linha). */
export const approvalProgressSchema = z
  .object({
    totalLines: z.int().min(0).max(APPROVAL_LINES_MAX),
    approvedLines: z.int().min(0).max(APPROVAL_LINES_MAX),
    pendingLines: z.int().min(0).max(APPROVAL_LINES_MAX),
    waitingLines: z.int().min(0).max(APPROVAL_LINES_MAX),
    label: z.string().optional(),
  })
  .meta({ id: 'ApprovalProgress' });
export type ApprovalProgressDto = z.infer<typeof approvalProgressSchema>;

/** Linha mínima para contar o andamento. */
export interface ApprovalProgressLine {
  readonly sequence: number;
  readonly status: ApprovalApproverStatus;
}

export interface ApprovalLineCounts {
  readonly totalLines: number;
  readonly approvedLines: number;
  readonly pendingLines: number;
  readonly waitingLines: number;
}

/** RN-APV-67: conta só as linhas vigentes (as `CANCELED` foram substituídas ou retiradas). */
export function approvalLineCountsOf(lines: readonly ApprovalProgressLine[]): ApprovalLineCounts {
  const live = lines.filter((line) => line.status !== 'CANCELED');
  return {
    totalLines: live.length,
    approvedLines: live.filter((line) => line.status === 'APPROVED').length,
    pendingLines: live.filter((line) => line.status === 'PENDING').length,
    waitingLines: live.filter((line) => line.status === 'WAITING').length,
  };
}

/** "Encerrada — {resultado}" (RN-APV-70). */
const CLOSED_RESULT: Readonly<Record<Exclude<ApprovalStatus, 'PENDING'>, string>> = {
  APPROVED: 'aprovada',
  RETURNED: 'devolvida',
  REJECTED: 'indeferida',
  CANCELED: 'cancelada',
};

export interface ApprovalProgressInput {
  readonly policy: ApprovalDecisionPolicy;
  readonly approvalStatus: ApprovalStatus;
  readonly counts: ApprovalLineCounts;
  /** A linha corrente em `SEQUENTIAL` (a `PENDING` de menor ordem), com o rótulo; senão `null`. */
  readonly current: { readonly sequence: number; readonly label: string } | null;
}

/**
 * RN-APV-70: `ALL` "{aprovadas} de {total} aprovaram"; `SEQUENTIAL` "Etapa {n} de {total} —
 * {rótulo}"; `ANY` com mais de uma linha "Qualquer um dos {total} aprovadores"; `ANY` com uma linha,
 * ausente; encerrada, "Encerrada — {resultado}".
 */
export function approvalProgressLabelOf(input: ApprovalProgressInput): string | undefined {
  const { policy, approvalStatus, counts, current } = input;
  if (policy === 'ANY' && counts.totalLines <= 1) return undefined;
  if (approvalStatus !== 'PENDING') return `Encerrada — ${CLOSED_RESULT[approvalStatus]}`;
  switch (policy) {
    case 'ALL':
      return `${String(counts.approvedLines)} de ${String(counts.totalLines)} aprovaram`;
    case 'SEQUENTIAL':
      return current === null
        ? `${String(counts.approvedLines)} de ${String(counts.totalLines)} aprovaram`
        : `Etapa ${String(current.sequence)} de ${String(counts.totalLines)} — ${current.label}`;
    case 'ANY':
      return `Qualquer um dos ${String(counts.totalLines)} aprovadores`;
  }
}

export function approvalProgressOf(input: ApprovalProgressInput): ApprovalProgressDto {
  const label = approvalProgressLabelOf(input);
  return { ...input.counts, ...(label === undefined ? {} : { label }) };
}

/** RN-APV-71: motivo da dispensa por texto. */
export const APPROVAL_SKIPPED_REASON_LABELS: Readonly<Record<ApprovalSkippedReason, string>> = {
  NEGATIVE_DECISION: 'Encerrada por decisão negativa',
  ANY_DECIDED: 'Decidida por outro aprovador',
  REASSIGNED: 'Substituída',
  WITHDRAWN: 'Aprovação retirada',
};

/** RN-APV-71: a situação da linha em pt-BR (`SKIPPED` com o motivo; `CANCELED` + `REASSIGNED` "Substituída"). */
export function approvalLineSituationOf(
  status: ApprovalApproverStatus,
  skippedReason: ApprovalSkippedReason | null,
): string {
  switch (status) {
    case 'WAITING':
      return 'Aguardando a vez';
    case 'PENDING':
      return 'Pendente';
    case 'APPROVED':
      return 'Aprovou';
    case 'RETURNED':
      return 'Devolveu';
    case 'REJECTED':
      return 'Indeferiu';
    case 'SKIPPED':
      return skippedReason === null
        ? 'Dispensada'
        : `Dispensada — ${APPROVAL_SKIPPED_REASON_LABELS[skippedReason].replace(/^./, (c) => c.toLowerCase())}`;
    case 'CANCELED':
      return skippedReason === 'REASSIGNED' ? 'Substituída' : 'Cancelada';
  }
}

/** RN-APV-67: "Minha situação" — o estado da linha de quem consulta (exceto `CANCELED`). */
export const APPROVAL_MY_LINE_STATUSES = APPROVAL_APPROVER_STATUSES.filter(
  (status): status is Exclude<ApprovalApproverStatus, 'CANCELED'> => status !== 'CANCELED',
);
export type ApprovalMyLineStatus = (typeof APPROVAL_MY_LINE_STATUSES)[number];

/** SCR-014: "Minha situação" por texto. */
export const APPROVAL_MY_LINE_STATUS_LABELS: Readonly<Record<ApprovalMyLineStatus, string>> = {
  PENDING: 'Sua vez',
  WAITING: 'Aguardando a vez',
  APPROVED: 'Você já aprovou',
  RETURNED: 'Você devolveu',
  REJECTED: 'Você indeferiu',
  SKIPPED: 'Encerrada para você',
};

/** `myLine` de APV-01 (RN-APV-67): a linha de quem consulta ou `null`. */
export const approvalListMyLineSchema = z
  .object({
    approvalApproverId: z.uuid(),
    sequence: z.int().min(1).max(APPROVAL_LINES_MAX),
    status: z.enum(APPROVAL_APPROVER_STATUSES),
  })
  .meta({ id: 'ApprovalListMyLine' });
export type ApprovalListMyLineDto = z.infer<typeof approvalListMyLineSchema>;
