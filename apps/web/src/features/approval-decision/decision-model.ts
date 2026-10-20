import {
  APPROVAL_DECISION_MESSAGES,
  decisionCommentIssues,
  decisionRequiresComment,
} from '@contrataflow/validation';
import type {
  ApprovalDecision,
  ApprovalDecisionOption,
  ApprovalDocumentDto,
  ApprovalMeta,
  ChecklistViolation,
  DecideApprovalInput,
  Violation,
} from '@contrataflow/validation';

import { isApiError } from '@/lib/api/api-error';

/*
 * Regras puras do painel "Decidir aprovação" (US-052 · SCR-015): as opções de decisão vêm de
 * APV-02 (`meta.decisionOptions`, uma por transição do workflow) e se agrupam nos três botões; o
 * comentário segue RN-TRAM-55 (as mesmas regras do APV-03); avisos `WARNING` da opção escolhida
 * exigem ciência antes de confirmar (FA-03 · DEC-016); `BLOCKING` desabilita a opção; os erros da
 * API viram o comportamento da tabela "Casos de erro" da story.
 */

/** Ordem dos botões na tela. */
export const DECISION_ORDER = [
  'APPROVE',
  'RETURN',
  'REJECT',
] as const satisfies readonly ApprovalDecision[];

/** Campos do painel, na ordem da tela (foco no primeiro erro). */
export const DECISION_FIELD_ORDER = ['decision', 'transitionId', 'comment', 'warnings'] as const;
export type DecisionField = (typeof DECISION_FIELD_ORDER)[number];
export type DecisionFieldMessages = Partial<Record<DecisionField, string>>;

/** `meta.allowedActions` contém `DECIDE`: só então o painel de decisão aparece. */
export function canDecide(meta: ApprovalMeta): boolean {
  return meta.allowedActions.includes('DECIDE');
}

// ---- Opções de decisão --------------------------------------------------------------------------

/** Identifica a opção: a transição (devolução: uma por etapa) ou, na avulsa, só a decisão. */
export function optionKey(option: ApprovalDecisionOption): string {
  return option.transitionId ?? `decision:${option.decision}`;
}

/** Regras `BLOCKING` não satisfeitas da transição: impedem a opção (V-04). */
export function blockingViolations(option: ApprovalDecisionOption): ChecklistViolation[] {
  return option.violations.filter(
    (violation) => violation.severity === 'BLOCKING' && !violation.satisfied,
  );
}

/** Opção utilizável: habilitada pela API e sem regra bloqueante pendente. */
export function isOptionAvailable(option: ApprovalDecisionOption): boolean {
  return option.enabled && blockingViolations(option).length === 0;
}

/** Aviso `WARNING` da opção que precisa de ciência (o `ruleId` vai em `acknowledgedWarnings`). */
export interface DecisionWarning {
  readonly ruleId: string;
  readonly message: string;
}

export function warningsOf(option: ApprovalDecisionOption | undefined): DecisionWarning[] {
  const warnings: DecisionWarning[] = [];
  for (const violation of option?.violations ?? []) {
    if (violation.severity !== 'WARNING' || violation.satisfied) continue;
    if (warnings.some((warning) => warning.ruleId === violation.ruleId)) continue;
    warnings.push({ ruleId: violation.ruleId, message: violation.message });
  }
  return warnings;
}

/** Avisos da opção que ainda não foram reconhecidos. */
export function pendingWarnings(
  option: ApprovalDecisionOption | undefined,
  acknowledged: readonly string[],
): DecisionWarning[] {
  return warningsOf(option).filter((warning) => !acknowledged.includes(warning.ruleId));
}

/** FA-03: o botão de confirmar só habilita depois de reconhecer todos os avisos da opção. */
export function isConfirmEnabled(
  option: ApprovalDecisionOption | undefined,
  acknowledged: readonly string[],
): boolean {
  return pendingWarnings(option, acknowledged).length === 0;
}

/** Os botões "Aprovar", "Devolver para ajuste" e "Indeferir" com as opções de cada um. */
export interface DecisionGroup {
  readonly decision: ApprovalDecision;
  readonly options: readonly ApprovalDecisionOption[];
  /** Há ao menos uma opção utilizável. */
  readonly available: boolean;
  /** Motivo de estar indisponível: a mensagem da regra bloqueante, se houver. */
  readonly blockedMessages: readonly string[];
}

/** Sempre os três grupos, na ordem da tela; sem opção da API, o botão fica indisponível. */
export function groupDecisionOptions(
  options: readonly ApprovalDecisionOption[],
): readonly DecisionGroup[] {
  return DECISION_ORDER.map((decision) => {
    const own = options.filter((option) => option.decision === decision);
    const available = own.some(isOptionAvailable);
    const blockedMessages = available
      ? []
      : own.flatMap((option) => blockingViolations(option).map((violation) => violation.message));
    return { decision, options: own, available, blockedMessages: [...new Set(blockedMessages)] };
  });
}

/**
 * Opção escolhida para a decisão: a única, ou (devolução com várias etapas de destino) a que o
 * usuário marcou. `undefined` = ainda falta escolher o destino.
 */
export function resolveOption(
  group: DecisionGroup | undefined,
  choice: string | null,
): ApprovalDecisionOption | undefined {
  if (group === undefined) return undefined;
  if (group.options.length === 1) return group.options[0];
  return group.options.find((option) => optionKey(option) === choice);
}

/** Há mais de uma opção para a decisão: o usuário escolhe a etapa de destino. */
export function needsTargetChoice(group: DecisionGroup | undefined): boolean {
  return group !== undefined && group.options.length > 1;
}

// ---- Formulário ---------------------------------------------------------------------------------

export interface DecisionDraft {
  readonly decision: ApprovalDecision | null;
  readonly group: DecisionGroup | undefined;
  readonly option: ApprovalDecisionOption | undefined;
  readonly comment: string;
  /** `ruleId` dos avisos reconhecidos. */
  readonly acknowledged: readonly string[];
}

/** V-01/V-02/V-03 no cliente (a API revalida tudo). */
export function validateDecision(draft: DecisionDraft): DecisionFieldMessages {
  const messages: DecisionFieldMessages = {};
  if (draft.decision === null) {
    messages.decision = APPROVAL_DECISION_MESSAGES.decisionRequired;
    return messages;
  }
  if (draft.group === undefined || draft.group.options.length === 0) {
    messages.decision = APPROVAL_DECISION_MESSAGES.transitionNotAvailable;
  } else if (draft.option === undefined) {
    messages.transitionId = APPROVAL_DECISION_MESSAGES.returnTargetRequired;
  } else if (!isOptionAvailable(draft.option)) {
    messages.decision = APPROVAL_DECISION_MESSAGES.transitionBlocked;
  }
  const [issue] = decisionCommentIssues(draft.decision, draft.comment);
  if (issue !== undefined) messages.comment = issue.message;
  if (
    draft.option !== undefined &&
    messages.decision === undefined &&
    !isConfirmEnabled(draft.option, draft.acknowledged)
  ) {
    messages.warnings = APPROVAL_DECISION_MESSAGES.warningsNotAcknowledged;
  }
  return messages;
}

/** O comentário é obrigatório para devolver e indeferir (RN-TRAM-55). */
export function commentRequired(decision: ApprovalDecision | null): boolean {
  return decision !== null && decisionRequiresComment(decision);
}

/**
 * Corpo do APV-03: comentário sem espaços nas pontas e só quando informado; `transitionId` da
 * opção escolhida (sempre que ela tiver um); avisos reconhecidos só os da opção.
 */
export function buildDecisionBody(draft: {
  readonly decision: ApprovalDecision;
  readonly option: ApprovalDecisionOption;
  readonly comment: string;
  readonly acknowledged: readonly string[];
}): DecideApprovalInput {
  const comment = draft.comment.trim();
  const acknowledgedWarnings = warningsOf(draft.option)
    .map((warning) => warning.ruleId)
    .filter((ruleId) => draft.acknowledged.includes(ruleId));
  return {
    decision: draft.decision,
    ...(comment === '' ? {} : { comment }),
    ...(acknowledgedWarnings.length === 0 ? {} : { acknowledgedWarnings }),
    ...(draft.option.transitionId === null ? {} : { transitionId: draft.option.transitionId }),
  };
}

/** Mensagem de regra sem o ponto final, para entrar no meio de uma frase ("…agora: {mensagem}."). */
export function withoutTrailingPeriod(message: string): string {
  return message.replace(/[.\s]+$/, '');
}

/** Violação de regra que aponta para um documento coberto (link "Abrir documento"). */
export function violationDocumentId(
  violation: Violation,
  documents: readonly ApprovalDocumentDto[],
): string | null {
  const id = violation.params.documentId;
  if (typeof id === 'string' && documents.some((document) => document.documentId === id)) {
    return id;
  }
  const typeCode = violation.params.documentTypeCode;
  if (typeof typeCode === 'string') {
    return documents.find((document) => document.typeCode === typeCode)?.documentId ?? null;
  }
  return null;
}

// ---- Erros da API -------------------------------------------------------------------------------

export type DeniedReason =
  'NOT_DESIGNATED_APPROVER' | 'SELF_APPROVAL_FORBIDDEN' | 'PERMISSION_DENIED';

/** O que fazer com cada recusa da API (tabela "Casos de erro" da US-052). */
export type DecisionProblem =
  | { readonly kind: 'fields'; readonly messages: DecisionFieldMessages; readonly others: string[] }
  | { readonly kind: 'warnings'; readonly violations: readonly Violation[] }
  | { readonly kind: 'blocked'; readonly violations: readonly Violation[] }
  | { readonly kind: 'transitionNotAvailable' }
  | { readonly kind: 'approverUnresolved' }
  | { readonly kind: 'idempotencyReused' }
  | { readonly kind: 'membership' }
  | { readonly kind: 'denied'; readonly reason: DeniedReason }
  | { readonly kind: 'notPending' }
  | { readonly kind: 'processStatus' }
  | { readonly kind: 'stale' }
  | { readonly kind: 'precondition' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'unexpected'; readonly correlationId: string };

export type DecisionProblemKind = DecisionProblem['kind'];

const isDecisionField = (field: string): field is DecisionField =>
  (DECISION_FIELD_ORDER as readonly string[]).includes(field);

export function describeDecisionError(error: unknown): DecisionProblem {
  if (!isApiError(error)) return { kind: 'unexpected', correlationId: '—' };
  const { status, code } = error;
  if (status === 428) return { kind: 'precondition' };
  if (status === 412) return { kind: 'stale' };
  if (status === 409 && code === 'APPROVAL_NOT_PENDING') return { kind: 'notPending' };
  if (status === 409 && code === 'INVALID_PROCESS_STATUS') return { kind: 'processStatus' };
  if (status === 403) {
    if (code === 'MEMBERSHIP_INACTIVE' || code === 'TENANT_SUSPENDED') {
      return { kind: 'membership' };
    }
    const reason: DeniedReason =
      code === 'NOT_DESIGNATED_APPROVER' || code === 'SELF_APPROVAL_FORBIDDEN'
        ? code
        : 'PERMISSION_DENIED';
    return { kind: 'denied', reason };
  }
  if (status === 404) return { kind: 'notFound' };
  if (status === 422) {
    switch (code) {
      case 'WARNINGS_NOT_ACKNOWLEDGED':
        return { kind: 'warnings', violations: error.violations };
      case 'TRANSITION_BLOCKED':
        return { kind: 'blocked', violations: error.violations };
      case 'TRANSITION_NOT_AVAILABLE':
        return { kind: 'transitionNotAvailable' };
      case 'APPROVER_UNRESOLVED':
        return { kind: 'approverUnresolved' };
      case 'IDEMPOTENCY_KEY_REUSED':
        return { kind: 'idempotencyReused' };
      case 'VALIDATION_ERROR': {
        const messages: DecisionFieldMessages = {};
        const others: string[] = [];
        for (const item of error.errors) {
          const field = item.field.startsWith('acknowledgedWarnings') ? 'warnings' : item.field;
          if (isDecisionField(field)) messages[field] ??= item.message;
          else others.push(item.message);
        }
        return { kind: 'fields', messages, others };
      }
      default:
        break;
    }
  }
  if (status === 503 || status === 429 || status === 502 || status === 504) {
    return { kind: 'unavailable' };
  }
  return { kind: 'unexpected', correlationId: error.correlationId ?? '—' };
}

/**
 * Recusas que a tela inteira explica (e recarrega): a aprovação mudou, deixou de ser decidível
 * ou não existe mais. As demais ficam no painel, com o formulário preenchido.
 */
export function isNoticeProblem(problem: DecisionProblem): boolean {
  switch (problem.kind) {
    case 'notPending':
    case 'stale':
    case 'precondition':
    case 'denied':
    case 'processStatus':
    case 'notFound':
      return true;
    default:
      return false;
  }
}

/** Recusas em que o formulário continua, mas as opções (avisos, bloqueios) precisam ser relidas. */
export function needsRefresh(problem: DecisionProblem): boolean {
  return (
    problem.kind === 'warnings' ||
    problem.kind === 'blocked' ||
    problem.kind === 'transitionNotAvailable'
  );
}
