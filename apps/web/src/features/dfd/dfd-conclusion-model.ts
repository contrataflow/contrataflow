import { PROCESS_FORWARD_LIMITS } from '@contrataflow/validation';
import type {
  ActionEntry,
  ChecklistViolation,
  DocumentAction,
  DocumentDto,
  DocumentValidationDto,
  ForwardProcessInput,
} from '@contrataflow/validation';

import { isApiError } from '@/lib/api/api-error';

/*
 * Regras do passo 5 — Conclusão do DFD (US-016 · SCR-007), puras: qual ação o passo oferece a
 * partir do PRC-08 e das ações do documento, os alertas que exigem "Estou ciente" (DOC-08 + PRC-09),
 * o corpo do PRC-19 e a tradução dos erros da API para a causa e a ação na tela.
 */

/** Motivos do PRC-08 que tiram a pessoa do envio (o passo cai para "Finalizar DFD" ou só leitura). */
const NOT_SENDER_REASONS = new Set([
  'NOT_PROCESS_CUSTODIAN',
  'PERMISSION_DENIED',
  'INVALID_PROCESS_STATUS',
]);

/** RN-DFD-38: a transição `FORWARD` para a etapa `APPROVAL` que cobre o DFD (a primária primeiro). */
export function sendEntryOf(actions: readonly ActionEntry[]): ActionEntry | null {
  const candidates = actions.filter(
    (entry) => entry.action === 'FORWARD' && entry.toStageType === 'APPROVAL',
  );
  return candidates.find((entry) => entry.primary === true) ?? candidates[0] ?? null;
}

export type ConclusionMode =
  /** "Concluir e enviar para aprovação" (PRC-19). */
  | { readonly kind: 'SEND'; readonly entry: ActionEntry }
  /** FA-01: "Finalizar DFD" (DOC-10) — sem encaminhar. */
  | { readonly kind: 'FINALIZE' }
  /** Nem envia nem finaliza: a explicação de quem pode. */
  | { readonly kind: 'NONE' };

/**
 * O passo mostra o envio quando o PRC-08 o oferece a esta pessoa (custódia + `PROCESS_FORWARD` +
 * status editável) — mesmo bloqueado por pendência ou aprovador, para explicar o motivo; senão,
 * "Finalizar DFD" com `FINALIZE` em `allowedActions` (DFD_SUBMIT + POL-02).
 */
export function conclusionModeOf(
  actions: readonly ActionEntry[],
  allowedActions: readonly DocumentAction[],
): ConclusionMode {
  const entry = sendEntryOf(actions);
  if (entry !== null && !entry.reasons.some((reason) => NOT_SENDER_REASONS.has(reason.code))) {
    return { kind: 'SEND', entry };
  }
  return allowedActions.includes('FINALIZE') ? { kind: 'FINALIZE' } : { kind: 'NONE' };
}

/** Alerta que exige "Estou ciente": código do DFD (DOC-08) ou id da regra do workflow (PRC-09). */
export interface ConclusionWarning {
  readonly key: string;
  readonly message: string;
  readonly source: 'DOCUMENT' | 'WORKFLOW';
}

/**
 * RN-DFD-41 · DEC-016: os `WARNING` do DFD e, no envio, os do workflow que valem para a transição
 * escolhida (regra da etapa ou da própria transição) — sem repetir a mesma chave.
 */
export function conclusionWarnings(
  validation: DocumentValidationDto | undefined,
  checklist: readonly ChecklistViolation[],
  transitionId: string | null,
): ConclusionWarning[] {
  const warnings: ConclusionWarning[] = [];
  const seen = new Set<string>();
  for (const violation of validation?.violations ?? []) {
    if (violation.severity !== 'WARNING' || seen.has(violation.code)) continue;
    seen.add(violation.code);
    warnings.push({ key: violation.code, message: violation.message, source: 'DOCUMENT' });
  }
  if (transitionId === null) return warnings;
  for (const rule of checklist) {
    if (rule.severity !== 'WARNING' || rule.satisfied || seen.has(rule.ruleId)) continue;
    if (rule.transitionId !== undefined && rule.transitionId !== transitionId) continue;
    seen.add(rule.ruleId);
    warnings.push({ key: rule.ruleId, message: rule.message, source: 'WORKFLOW' });
  }
  return warnings;
}

/** V-11: "Mensagem ao aprovador" até 5.000 caracteres (RN-DFD-45). */
export function isMessageTooLong(message: string): boolean {
  return message.trim().length > PROCESS_FORWARD_LIMITS.commentMax;
}

/** Corpo do PRC-19 do passo 5 (fluxo principal 3): a transição, o DFD e os alertas reconhecidos. */
export function buildConclusionForwardBody(input: {
  readonly entry: ActionEntry;
  readonly expectedStageId: string;
  readonly documentId: string;
  readonly message: string;
  readonly acknowledged: readonly string[];
}): ForwardProcessInput {
  const comment = input.message.trim();
  return {
    transitionId: input.entry.transitionId ?? '',
    expectedStageId: input.expectedStageId,
    ...(comment === '' ? {} : { comment }),
    acknowledgedWarnings: [...input.acknowledged],
    documentIds: [input.documentId],
  };
}

/** Causa de uma recusa do envio/finalização e o que a tela recarrega (Casos de erro da story). */
export interface ConclusionProblem {
  /** Chave em `dfd.conclusion.errors`. */
  readonly key:
    | 'blocked'
    | 'warnings'
    | 'stageChanged'
    | 'versionConflict'
    | 'approverUnresolved'
    | 'forbidden'
    | 'notEditable'
    | 'status'
    | 'inProgress'
    | 'unavailable'
    | 'unexpected';
  /** O que recarregar: o DOC-08 (pendências) ou o processo/documento (nova situação). */
  readonly reload: 'validation' | 'all' | null;
  readonly detail: string | null;
  readonly correlationId: string | null;
}

export function describeConclusionError(error: unknown): ConclusionProblem {
  const problem = (
    key: ConclusionProblem['key'],
    reload: ConclusionProblem['reload'] = null,
    detail: string | null = null,
  ): ConclusionProblem => ({
    key,
    reload,
    detail,
    correlationId: isApiError(error) ? error.correlationId : null,
  });
  if (!isApiError(error)) return problem('unexpected');
  const { status, code } = error;
  if (code === 'TRANSITION_BLOCKED' || code === 'DOCUMENT_INCOMPLETE') {
    return problem('blocked', 'validation');
  }
  if (code === 'WARNINGS_NOT_ACKNOWLEDGED') return problem('warnings', 'validation');
  if (code === 'STAGE_CHANGED') return problem('stageChanged', 'all');
  if (code === 'VERSION_CONFLICT' || status === 428) return problem('versionConflict', 'all');
  if (code === 'APPROVER_UNRESOLVED') {
    return problem('approverUnresolved', null, error.problem?.detail ?? null);
  }
  if (status === 403) return problem('forbidden', 'all');
  if (code === 'DOCUMENT_NOT_EDITABLE' || code === 'INVALID_STATE')
    return problem('notEditable', 'all');
  if (code === 'INVALID_PROCESS_STATUS') {
    return problem('status', 'all', error.problem?.detail ?? null);
  }
  if (code === 'IDEMPOTENCY_IN_PROGRESS') return problem('inProgress', 'all');
  if (status === 503 || status === 0) return problem('unavailable');
  return problem('unexpected');
}

/**
 * Faixa do modo leitura (fluxo principal 5): "Em aprovação — versão N enviada em …" a partir do
 * selo derivado (`pendingApprovalId`); o finalizado que entrou na aprovação não tem `submittedAt`.
 */
export function inApprovalOf(
  document: Pick<
    DocumentDto,
    'pendingApprovalId' | 'currentVersionNumber' | 'submittedAt' | 'finalizedAt'
  >,
): { readonly versionNumber: number | null; readonly sentAt: string | null } | null {
  if (!document.pendingApprovalId) return null;
  return {
    versionNumber: document.currentVersionNumber ?? null,
    sentAt: document.submittedAt ?? null,
  };
}
