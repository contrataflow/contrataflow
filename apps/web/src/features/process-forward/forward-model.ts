import {
  PROCESS_FORWARD_LIMITS,
  PROCESS_FORWARD_MESSAGES,
  dueDateOverrideIssues,
  forwardCommentIssues,
} from '@contrataflow/validation';
import type {
  ActionEntry,
  ChecklistViolation,
  ForwardProcessInput,
  ForwardedProcessDto,
  ProcessDocumentDto,
  ProcessStageEntryDto,
  Violation,
} from '@contrataflow/validation';

import { isApiError } from '@/lib/api/api-error';

/*
 * Regras puras do painel "Encaminhar processo" (US-047 · SCR-103): escolha da transição, filtro das
 * pendências por transição, padrões de unidade/documentos/prazo, validação local (V-01/V-02/V-10/
 * V-14), o corpo do PRC-19, o resumo (passo 9), o toast (passo 12 e FA-07) e a tradução dos erros da
 * API (tabela "Casos de erro"). A API confere tudo de novo. Os textos saem como chave + valores
 * (namespace `processes.forward`) para o componente formatar via next-intl.
 */

/** Mensagem do namespace `processes.forward`: chave relativa e valores ICU. */
export interface ForwardMessage {
  readonly key: string;
  readonly values: Readonly<Record<string, string | number>>;
}

const message = (
  key: string,
  values: Readonly<Record<string, string | number>> = {},
): ForwardMessage => ({ key, values });

export interface PickedItem {
  readonly id: string;
  readonly name: string;
}

export interface DueOverride {
  readonly enabled: boolean;
  /** `AAAA-MM-DD` (campo de data). */
  readonly date: string;
  readonly reason: string;
}

export const EMPTY_DUE_OVERRIDE: DueOverride = { enabled: false, date: '', reason: '' };

/** Campos do painel, na ordem em que o foco procura o primeiro erro. */
export const FORWARD_FIELD_ORDER = [
  'transition',
  'department',
  'assignee',
  'dueAt',
  'dueReason',
  'comment',
  'documents',
  'warnings',
] as const;
export type ForwardField = (typeof FORWARD_FIELD_ORDER)[number];
export type ForwardFieldMessages = Partial<Record<ForwardField, string>>;

/** Regra de workflow não satisfeita que aparece em "Pendências e avisos". */
export interface ForwardRule {
  readonly ruleId: string;
  readonly severity: 'BLOCKING' | 'WARNING';
  readonly message: string;
  /** `params.documentTypeCode` (`REQUIRED_DOCUMENT`): leva ao documento do tipo, quando existe. */
  readonly documentTypeCode: string | null;
}

// ---- Transições -------------------------------------------------------------------------------

/** Entradas `FORWARD` do PRC-08 que carregam o `transitionId`, a principal primeiro. */
export function forwardEntries(actions: readonly ActionEntry[] | undefined): ActionEntry[] {
  const entries = (actions ?? []).filter(
    (entry) => entry.action === 'FORWARD' && entry.transitionId !== undefined,
  );
  return [
    ...entries.filter((e) => e.primary === true),
    ...entries.filter((e) => e.primary !== true),
  ];
}

/**
 * Transição inicial (passo 3): a da ação do painel (`transitionKey`) tem precedência; senão a
 * `primary` habilitada; senão a primeira habilitada. `null` quando nenhuma está habilitada.
 */
export function initialTransitionId(
  entries: readonly ActionEntry[],
  preferredKey?: string | null,
): string | null {
  const enabled = entries.filter((entry) => entry.enabled);
  const preferred =
    preferredKey === undefined || preferredKey === null
      ? undefined
      : enabled.find((entry) => entry.transitionKey === preferredKey);
  const chosen = preferred ?? enabled.find((entry) => entry.primary === true) ?? enabled[0];
  return chosen?.transitionId ?? null;
}

/** Destino de aprovação (DEC-018): etapa `APPROVAL` ou aprovador previsto. */
export function isApprovalDestination(entry: ActionEntry | undefined): boolean {
  if (entry === undefined) return false;
  return entry.toStageType === 'APPROVAL' || (entry.approverPreview ?? null) !== null;
}

/** `CHOSEN_ON_FORWARD`: o usuário escolhe a unidade (passo 4). */
export function choosesDepartment(entry: ActionEntry | undefined): boolean {
  return entry?.departmentResolution?.mode === 'CHOSEN_ON_FORWARD';
}

/** Motivos de indisponibilidade da transição, em texto corrido. */
export function reasonsText(entry: ActionEntry): string {
  return entry.reasons.map((reason) => reason.message).join(' · ');
}

// ---- Pendências e avisos ----------------------------------------------------------------------

function ruleOf(violation: ChecklistViolation): ForwardRule {
  const type = violation.params.documentTypeCode;
  return {
    ruleId: violation.ruleId,
    severity: violation.severity,
    message: violation.message,
    documentTypeCode: typeof type === 'string' ? type : null,
  };
}

/** Bloqueantes antes dos avisos, sem repetir a regra (a primeira ocorrência vale). */
export function mergeRules(...lists: readonly (readonly ForwardRule[])[]): ForwardRule[] {
  const seen = new Set<string>();
  const unique: ForwardRule[] = [];
  for (const rule of lists.flat()) {
    if (seen.has(rule.ruleId)) continue;
    seen.add(rule.ruleId);
    unique.push(rule);
  }
  return [
    ...unique.filter((rule) => rule.severity === 'BLOCKING'),
    ...unique.filter((rule) => rule.severity === 'WARNING'),
  ];
}

/**
 * Regras do PRC-09 que valem para a transição escolhida (passo 8): `STAGE_EXIT` vale para todas;
 * `TRANSITION` só a da transição (`transitionId`, ou `transitionKey` se a API não trouxer o id).
 */
export function rulesFor(
  violations: readonly ChecklistViolation[] | undefined,
  entry: ActionEntry | undefined,
): ForwardRule[] {
  const applicable = (violations ?? []).filter((violation) => {
    if (violation.satisfied) return false;
    if (violation.scope === 'STAGE_EXIT') return true;
    if (entry === undefined) return false;
    if (violation.transitionId !== undefined) return violation.transitionId === entry.transitionId;
    return violation.transitionKey !== undefined && violation.transitionKey === entry.transitionKey;
  });
  return mergeRules(applicable.map(ruleOf));
}

/** Violações do problem+json (`TRANSITION_BLOCKED`/`WARNINGS_NOT_ACKNOWLEDGED`) como regras. */
export function rulesOfViolations(violations: readonly Violation[]): ForwardRule[] {
  const rules: ForwardRule[] = [];
  for (const violation of violations) {
    if (violation.ruleId === null) continue;
    const type = violation.params.documentTypeCode;
    rules.push({
      ruleId: violation.ruleId,
      severity: violation.severity,
      message: violation.message,
      documentTypeCode: typeof type === 'string' ? type : null,
    });
  }
  return mergeRules(rules);
}

/** Documento ao qual o "Resolver" leva: o mais recente, não cancelado, do tipo da regra. */
export function resolveDocumentId(
  rule: ForwardRule,
  documents: readonly ProcessDocumentDto[],
): string | null {
  if (rule.documentTypeCode === null) return null;
  const candidates = documents
    .filter(
      (document) =>
        document.documentType.code === rule.documentTypeCode && document.status !== 'CANCELED',
    )
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return candidates[0]?.id ?? null;
}

/** Avisos que ainda faltam reconhecer. */
export function pendingWarnings(
  rules: readonly ForwardRule[],
  acknowledged: readonly string[],
): ForwardRule[] {
  return rules.filter((rule) => rule.severity === 'WARNING' && !acknowledged.includes(rule.ruleId));
}

// ---- Padrões ----------------------------------------------------------------------------------

/** Quando a etapa atual começou: `enteredAt` da passagem ativa (PRC-10). */
export function currentStageEnteredAt(
  stages: readonly ProcessStageEntryDto[] | undefined,
): string | null {
  const current = (stages ?? []).find((stage) => stage.isCurrent);
  const pass = current?.passes.find((candidate) => candidate.status === 'ACTIVE');
  return pass?.enteredAt ?? null;
}

/** Passo 4: padrão da unidade = última que executou a etapa de destino (PRC-10). */
export function defaultDepartment(
  entry: ActionEntry | undefined,
  stages: readonly ProcessStageEntryDto[] | undefined,
): PickedItem | null {
  if (!choosesDepartment(entry)) return null;
  const stage = (stages ?? []).find((candidate) => candidate.key === entry?.toStageKey);
  const last = [...(stage?.passes ?? [])].sort((a, b) => b.sequence - a.sequence)[0];
  return last === undefined ? null : { id: last.department.id, name: last.department.name };
}

/** Passo 7: marcados os documentos criados ou alterados durante a etapa atual (RN-TRAM-12). */
export function defaultDocumentIds(
  documents: readonly ProcessDocumentDto[],
  enteredAt: string | null,
): string[] {
  if (enteredAt === null) return [];
  const since = Date.parse(enteredAt);
  return documents
    .filter((document) => document.status !== 'CANCELED' && Date.parse(document.updatedAt) >= since)
    .map((document) => document.id);
}

/**
 * Destino `APPROVAL`: os documentos cobertos entram automaticamente (RN-TRAM-12). Sem como saber os
 * tipos cobertos no cliente, trava os não cancelados — a API decide quais submete.
 */
export function lockedDocumentIds(
  documents: readonly ProcessDocumentDto[],
  entry: ActionEntry | undefined,
): string[] {
  if (!isApprovalDestination(entry)) return [];
  return documents.filter((document) => document.status !== 'CANCELED').map((d) => d.id);
}

/** Seleção efetiva: a do usuário (se mexeu) ou o padrão, sempre com os travados. */
export function effectiveDocumentIds(
  selection: readonly string[] | null,
  defaults: readonly string[],
  locked: readonly string[],
): string[] {
  return [...new Set([...(selection ?? defaults), ...locked])];
}

// ---- Datas ------------------------------------------------------------------------------------

/** Dia local (`AAAA-MM-DD`) no fuso do tenant. */
export function localToday(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** `DD/MM/AAAA` de um instante ISO no fuso do tenant. */
export function formatDueDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

/** `DD/MM/AAAA` de um dia `AAAA-MM-DD`. */
export function formatLocalDate(date: string): string {
  const [year, month, day] = date.split('-');
  return `${day ?? ''}/${month ?? ''}/${year ?? ''}`;
}

/** Soma dias a um dia `AAAA-MM-DD`. */
export function addDays(date: string, days: number): string {
  const instant = new Date(`${date}T00:00:00Z`);
  instant.setUTCDate(instant.getUTCDate() + days);
  return instant.toISOString().slice(0, 10);
}

/** Último dia permitido para sobrescrever o prazo (RN-TRAM-10). */
export function overrideLimit(today: string): string {
  return addDays(today, PROCESS_FORWARD_LIMITS.overrideMaxDays);
}

/** Passo 5: "Até 20/10/2026 (10 dias úteis)" / "Sem prazo definido". */
export function deadlineMessage(
  entry: ActionEntry | undefined,
  stages: readonly ProcessStageEntryDto[] | undefined,
  timeZone: string,
): ForwardMessage {
  const preview = entry?.dueAtPreview ?? null;
  if (entry === undefined || preview === null) return message('due.none');
  const date = formatDueDate(preview, timeZone);
  const stage = (stages ?? []).find((candidate) => candidate.key === entry.toStageKey);
  if (stage?.slaDays !== undefined && stage.slaDays !== null && stage.slaDays > 0) {
    return message('due.untilSla', {
      date,
      days: stage.slaDays,
      type: stage.slaType ?? 'BUSINESS',
    });
  }
  return message('due.until', { date });
}

// ---- Corpo e validação ------------------------------------------------------------------------

export interface ForwardDraft {
  readonly entry: ActionEntry | undefined;
  readonly department: PickedItem | null;
  readonly assignee: PickedItem | null;
  readonly dueOverride: DueOverride;
  readonly comment: string;
  /** `null` = o usuário não mexeu na lista (a API aplica o padrão RN-TRAM-12). */
  readonly documentSelection: readonly string[] | null;
  readonly documentCount: number;
  /** Regras `WARNING` da transição e as marcadas. */
  readonly warnings: readonly ForwardRule[];
  readonly acknowledged: readonly string[];
}

/** Corpo do PRC-19 (RN-TRAM-07/08/10/11/12): só envia o que se aplica à transição escolhida. */
export function buildForwardBody(
  draft: ForwardDraft,
  expectedStageId: string,
): ForwardProcessInput {
  const { entry } = draft;
  if (entry?.transitionId === undefined) {
    throw new Error('Transição sem transitionId: o painel não deveria enviar.');
  }
  const comment = draft.comment.trim();
  const override = entry.allowDueDateOverride === true && draft.dueOverride.enabled;
  const acknowledged = draft.warnings
    .filter((rule) => draft.acknowledged.includes(rule.ruleId))
    .map((rule) => rule.ruleId);
  return {
    transitionId: entry.transitionId,
    expectedStageId,
    ...(choosesDepartment(entry) && draft.department !== null
      ? { toDepartmentId: draft.department.id }
      : {}),
    ...(draft.assignee !== null && !isApprovalDestination(entry)
      ? { toUserId: draft.assignee.id }
      : {}),
    ...(override
      ? {
          dueAt: draft.dueOverride.date,
          dueDateOverrideReason: draft.dueOverride.reason.trim(),
        }
      : {}),
    ...(comment === '' ? {} : { comment }),
    ...(draft.documentSelection === null ? {} : { documentIds: [...draft.documentSelection] }),
    ...(acknowledged.length === 0 ? {} : { acknowledgedWarnings: acknowledged }),
  };
}

/** Validação local (V-01/V-02/V-03/V-09/V-10/V-14); devolve as mensagens por campo. */
export function validateForward(draft: ForwardDraft, today: string): ForwardFieldMessages {
  const found: ForwardFieldMessages = {};
  const { entry } = draft;
  if (entry?.transitionId === undefined) {
    found.transition = PROCESS_FORWARD_MESSAGES.transitionRequired;
  } else if (!entry.enabled) {
    found.transition = PROCESS_FORWARD_MESSAGES.transitionNotAvailable;
  }

  if (choosesDepartment(entry) && draft.department === null) {
    found.department = PROCESS_FORWARD_MESSAGES.departmentRequired;
  }

  if (entry?.allowDueDateOverride === true && draft.dueOverride.enabled) {
    const { date, reason } = draft.dueOverride;
    if (date === '') {
      found.dueAt = PROCESS_FORWARD_MESSAGES.dueDateRange(formatLocalDate(overrideLimit(today)));
    } else {
      const [issue] = dueDateOverrideIssues(date, today);
      if (issue !== undefined) found.dueAt = issue.message;
    }
    const length = reason.trim().length;
    if (
      length < PROCESS_FORWARD_LIMITS.overrideReasonMin ||
      length > PROCESS_FORWARD_LIMITS.overrideReasonMax
    ) {
      found.dueReason = PROCESS_FORWARD_MESSAGES.dueDateReason;
    }
  }

  const [commentIssue] = forwardCommentIssues(draft.comment, entry?.requiresComment === true);
  if (commentIssue !== undefined) found.comment = commentIssue.message;
  else if (draft.comment.trim().length > PROCESS_FORWARD_LIMITS.commentMax) {
    found.comment = PROCESS_FORWARD_MESSAGES.commentTooLong;
  }

  if (draft.documentCount > PROCESS_FORWARD_LIMITS.documentsMax) {
    found.documents = PROCESS_FORWARD_MESSAGES.documents;
  }

  if (pendingWarnings(draft.warnings, draft.acknowledged).length > 0) {
    found.warnings = PROCESS_FORWARD_MESSAGES.warningsNotAcknowledged;
  }
  return found;
}

// ---- Resumo e toast ---------------------------------------------------------------------------

export interface ForwardSummaryInput {
  readonly entry: ActionEntry | undefined;
  readonly department: PickedItem | null;
  readonly assignee: PickedItem | null;
  readonly dueOverride: DueOverride;
  readonly stages: readonly ProcessStageEntryDto[] | undefined;
  /** Documentos que o destino `APPROVAL` submete (travados, ainda não enviados). */
  readonly submitted: readonly ProcessDocumentDto[];
  readonly timeZone: string;
}

export interface ForwardSummary {
  readonly main: ForwardMessage;
  readonly extra: ForwardMessage | null;
}

/** Passo 9: "O processo irá para <b>…</b>, na fila da unidade, com prazo até <b>…</b>." */
export function summaryOf(input: ForwardSummaryInput): ForwardSummary | null {
  const { entry } = input;
  if (entry === undefined) return null;
  const stage = entry.toStageName ?? entry.toStageKey ?? entry.label;

  if (isApprovalDestination(entry)) {
    const approver = entry.approverPreview?.label ?? null;
    // Só rascunho/devolvido gera nova versão na submissão (DEC-018); os demais só ganham o selo.
    const toSubmit = input.submitted.filter(
      (document) => document.status === 'DRAFT' || document.status === 'RETURNED',
    );
    const [first] = toSubmit;
    let extra: ForwardMessage | null = null;
    if (toSubmit.length === 1 && first !== undefined) {
      extra = message('summary.submitOne', {
        document: first.documentType.name,
        version: (first.currentVersionNumber ?? 0) + 1,
      });
    } else if (toSubmit.length > 1) {
      extra = message('summary.submitMany', { count: toSubmit.length });
    }
    return {
      main:
        approver === null
          ? message('summary.approvalUndefined', { stage })
          : message('summary.approval', { approver }),
      extra,
    };
  }

  const departmentName = choosesDepartment(entry)
    ? (input.department?.name ?? null)
    : (entry.departmentResolution?.departmentName ?? null);
  if (departmentName === null) {
    return {
      main: message(choosesDepartment(entry) ? 'summary.pickDepartment' : 'summary.stageOnly', {
        stage,
      }),
      extra: null,
    };
  }

  const override = entry.allowDueDateOverride === true && input.dueOverride.enabled;
  const overrideDate =
    override && input.dueOverride.date !== '' ? formatLocalDate(input.dueOverride.date) : null;
  const previewDate =
    entry.dueAtPreview === undefined || entry.dueAtPreview === null
      ? null
      : formatDueDate(entry.dueAtPreview, input.timeZone);
  const date = overrideDate ?? previewDate;
  const values = {
    stage,
    department: departmentName,
    ...(input.assignee === null ? {} : { assignee: input.assignee.name }),
    ...(date === null ? {} : { date }),
  };
  const base = input.assignee === null ? 'summary.queue' : 'summary.assigned';
  return { main: message(date === null ? `${base}NoDue` : base, values), extra: null };
}

/** Toast do sucesso (passo 12; FA-07 quando o processo foi autuado agora). */
export function forwardedToast(result: ForwardedProcessDto): ForwardMessage {
  const code = result.code ?? '';
  if (result.approval !== undefined) {
    const approver = result.approval.approverLabel;
    return result.numberAssigned
      ? message('toast.numberedApproval', { code, approver })
      : message('toast.approval', { approver });
  }
  const stage = result.currentStage?.name ?? '';
  const department = result.currentDepartment.name;
  return result.numberAssigned
    ? message('toast.numbered', { code, stage, department })
    : message('toast.forwarded', { stage, department });
}

// ---- Erros da API -----------------------------------------------------------------------------

/** Documento coberto incompleto (`DOCUMENT_INCOMPLETE`): pendências agrupadas por documento. */
export interface IncompleteDocument {
  readonly documentId: string | null;
  readonly title: string | null;
  readonly messages: readonly string[];
}

export type ForwardProblem =
  | { readonly kind: 'stageChanged' }
  | { readonly kind: 'versionConflict' }
  | { readonly kind: 'custody' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'status'; readonly detail: string }
  | { readonly kind: 'transitionNotAvailable' }
  | {
      readonly kind: 'blocked';
      readonly rules: readonly ForwardRule[];
      readonly count: number;
    }
  | { readonly kind: 'warnings'; readonly rules: readonly ForwardRule[] }
  | {
      readonly kind: 'fields';
      readonly messages: ForwardFieldMessages;
      /** Erros de campo que o painel não tem (mensagem solta). */
      readonly others: readonly string[];
    }
  | { readonly kind: 'dueNotAllowed' }
  | { readonly kind: 'assigneeNotEligible' }
  | { readonly kind: 'documents'; readonly items: readonly IncompleteDocument[] }
  | { readonly kind: 'approver'; readonly detail: string | null }
  | { readonly kind: 'idempotencyReused' }
  | { readonly kind: 'inProgress' }
  | { readonly kind: 'unavailable'; readonly correlationId: string }
  | { readonly kind: 'unexpected'; readonly correlationId: string };

/** Campo da API (`toDepartmentId`, `documentIds.2`…) → campo do painel. */
export function forwardFieldOf(field: string): ForwardField | null {
  const root = field.split(/[.[]/)[0] ?? field;
  const fields: Readonly<Record<string, ForwardField>> = {
    transitionId: 'transition',
    expectedStageId: 'transition',
    toDepartmentId: 'department',
    toUserId: 'assignee',
    dueAt: 'dueAt',
    dueDateOverrideReason: 'dueReason',
    comment: 'comment',
    documentIds: 'documents',
    acknowledgedWarnings: 'warnings',
  };
  return fields[root] ?? null;
}

function incompleteDocumentsOf(violations: readonly Violation[]): IncompleteDocument[] {
  const groups = new Map<string, { id: string | null; title: string | null; messages: string[] }>();
  for (const violation of violations) {
    const id = typeof violation.params.documentId === 'string' ? violation.params.documentId : null;
    const titleParam = violation.params.documentTitle ?? violation.params.documentName;
    const title = typeof titleParam === 'string' ? titleParam : null;
    const key = id ?? title ?? '';
    const group = groups.get(key) ?? { id, title, messages: [] };
    group.messages.push(violation.message);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    documentId: group.id,
    title: group.title,
    messages: group.messages,
  }));
}

/** Tabela "Casos de erro" da US-047: o que o painel faz com cada resposta da API. */
export function describeForwardError(error: unknown): ForwardProblem {
  if (!isApiError(error)) return { kind: 'unexpected', correlationId: '—' };
  const correlationId = error.correlationId ?? '—';
  const { status, code } = error;

  if (status === 409 && code === 'STAGE_CHANGED') return { kind: 'stageChanged' };
  if ((status === 412 && code === 'VERSION_CONFLICT') || status === 428) {
    return { kind: 'versionConflict' };
  }
  if (status === 403) return { kind: 'custody' };
  if (status === 404) return { kind: 'notFound' };
  if (status === 409 && code === 'INVALID_PROCESS_STATUS') {
    return {
      kind: 'status',
      detail: error.problem?.detail ?? PROCESS_FORWARD_MESSAGES.invalidStatus,
    };
  }
  if (status === 409 && code === 'IDEMPOTENCY_IN_PROGRESS') return { kind: 'inProgress' };
  if (status === 422) {
    if (code === 'TRANSITION_NOT_AVAILABLE') return { kind: 'transitionNotAvailable' };
    if (code === 'TRANSITION_BLOCKED') {
      return {
        kind: 'blocked',
        rules: rulesOfViolations(error.violations),
        count: error.violations.filter((violation) => violation.severity === 'BLOCKING').length,
      };
    }
    if (code === 'WARNINGS_NOT_ACKNOWLEDGED') {
      return { kind: 'warnings', rules: rulesOfViolations(error.violations) };
    }
    if (code === 'DEPARTMENT_REQUIRED') {
      return {
        kind: 'fields',
        messages: { department: PROCESS_FORWARD_MESSAGES.departmentRequired },
        others: [],
      };
    }
    if (code === 'DUE_DATE_OVERRIDE_NOT_ALLOWED') return { kind: 'dueNotAllowed' };
    if (code === 'ASSIGNEE_NOT_ELIGIBLE') return { kind: 'assigneeNotEligible' };
    if (code === 'DOCUMENT_INCOMPLETE') {
      return { kind: 'documents', items: incompleteDocumentsOf(error.violations) };
    }
    if (code === 'APPROVER_UNRESOLVED') {
      const detail = error.problem?.detail ?? null;
      return { kind: 'approver', detail: detail === code ? null : detail };
    }
    if (code === 'IDEMPOTENCY_KEY_REUSED') return { kind: 'idempotencyReused' };
    if (code === 'VALIDATION_ERROR') {
      const messages: ForwardFieldMessages = {};
      const others: string[] = [];
      for (const item of error.errors) {
        const field = forwardFieldOf(item.field);
        if (field === null) others.push(item.message);
        else messages[field] ??= item.message;
      }
      return { kind: 'fields', messages, others };
    }
  }
  if (status === 503 || status === 429 || status === 502 || status === 504) {
    return { kind: 'unavailable', correlationId };
  }
  return { kind: 'unexpected', correlationId };
}
