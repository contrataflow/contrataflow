import type { ApprovalDecisionPolicy, ApproverType } from '../document/approver-lines.js';

/*
 * Linhas da aprovação múltipla (US-133 · DEC-193 · entities.md MVP 2 §4.6/§6.6): uma
 * `ApprovalApprover` por aprovador, criada na solicitação com o estado inicial da política
 * (`ANY`/`ALL` todas `PENDING`; `SEQUENTIAL` só a primeira, as demais `WAITING`). As regras puras
 * daqui (rótulo composto, mensagens por linha) valem na API, na timeline e no front.
 */

/** `ApprovalApproverStatus` (entities.md MVP 2 §2). */
export const APPROVAL_APPROVER_STATUSES = [
  'WAITING',
  'PENDING',
  'APPROVED',
  'RETURNED',
  'REJECTED',
  'SKIPPED',
  'CANCELED',
] as const;
export type ApprovalApproverStatus = (typeof APPROVAL_APPROVER_STATUSES)[number];

/** `ApprovalApprover.skippedReason` (entities.md MVP 2 §4.6). */
export const APPROVAL_SKIPPED_REASONS = [
  'NEGATIVE_DECISION',
  'ANY_DECIDED',
  'REASSIGNED',
  'WITHDRAWN',
] as const;
export type ApprovalSkippedReason = (typeof APPROVAL_SKIPPED_REASONS)[number];

/** RN-APV-17: máximo de linhas por aprovação (o mesmo limite da configuração — RN-APV-03). */
export const APPROVAL_LINES_MAX = 20;

/** Estado da linha por texto (SCR-015 · `ApprovalLinesList` — nunca só por cor). */
export const APPROVAL_APPROVER_STATUS_LABELS: Readonly<Record<ApprovalApproverStatus, string>> = {
  WAITING: 'Aguardando a vez',
  PENDING: 'Aguardando decisão',
  APPROVED: 'Aprovou',
  RETURNED: 'Devolveu',
  REJECTED: 'Indeferiu',
  SKIPPED: 'Dispensada',
  CANCELED: 'Cancelada',
};

/**
 * RN-APV-28: "Aprovação solicitada a {approverLabel}" com o rótulo composto pela política — `ANY`
 * "A ou B", `ALL` "A e B", `SEQUENTIAL` "A, depois B". Uma linha = o próprio rótulo.
 */
export function composeApproverLabel(
  policy: ApprovalDecisionPolicy,
  labels: readonly string[],
): string {
  if (labels.length <= 1) return labels[0] ?? '';
  if (policy === 'SEQUENTIAL') return labels.join(', depois ');
  const last = labels.at(-1) ?? '';
  return `${labels.slice(0, -1).join(', ')} ${policy === 'ALL' ? 'e' : 'ou'} ${last}`;
}

/** Rótulo genérico da linha nas mensagens de erro (nunca o nome de quem seria o aprovador). */
const GENERIC_LINE_LABELS: Readonly<Record<ApproverType, string>> = {
  USER: 'usuário designado',
  ROLE: 'perfil aprovador',
  DEPARTMENT_HEAD: 'titular da unidade',
};

/** O rótulo configurado da linha ou o genérico do tipo (V-02 · "Impacto técnico — Segurança"). */
export function approverLineLabel(
  type: ApproverType | null,
  label: string | null | undefined,
): string {
  const configured = label?.trim() ?? '';
  if (configured !== '') return configured;
  return type === null ? 'aprovador' : GENERIC_LINE_LABELS[type];
}

/** Onde a configuração mora: a etapa do workflow ou o tipo de documento (avulsa). */
export type ApprovalConfigOrigin = 'PROCESS_STAGE' | 'DOCUMENT';

const ORIGIN_TEXT: Readonly<Record<ApprovalConfigOrigin, string>> = {
  PROCESS_STAGE: 'desta etapa',
  DOCUMENT: 'deste tipo de documento',
};

/** Mensagens das validações V-02..V-07 da US-133 (por linha; sem nomes). */
export const MULTI_APPROVAL_MESSAGES = Object.freeze({
  lineUnresolved: (origin: ApprovalConfigOrigin, sequence: number, label: string) =>
    `Não há aprovador configurado para a linha ${String(sequence)} (${label}) ${ORIGIN_TEXT[origin]}. Fale com o administrador do órgão.`,
  selfApproval: (sequence: number) =>
    `O aprovador da linha ${String(sequence)} é autor de um dos documentos e não tem substituto. Fale com o administrador do órgão.`,
  duplicated: (first: number, second: number) =>
    `A mesma pessoa não pode aprovar em duas linhas (${String(first)} e ${String(second)}). Fale com o administrador do órgão.`,
  misconfigured: (origin: ApprovalConfigOrigin) =>
    `A aprovação ${ORIGIN_TEXT[origin]} está mal configurada. Fale com o administrador do órgão.`,
});

/** `meta.reason` do 422 `APPROVER_UNRESOLVED` (V-06/V-07 — dado inconsistente na configuração). */
export const APPROVAL_CONFIG_PROBLEMS = ['POLICY_INVALID', 'LIMIT_EXCEEDED'] as const;
export type ApprovalConfigProblem = (typeof APPROVAL_CONFIG_PROBLEMS)[number];
