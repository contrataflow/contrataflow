import { FINAL_PROCESS_STATUSES } from '@contrataflow/validation';
import type {
  ActionEntry,
  ApproverType,
  ChecklistViolation,
  PendingItem,
  ProcessStageEntryDto,
  ProcessStageStatus,
  ProcessStatus,
  SummaryAction,
  SummaryDocument,
} from '@contrataflow/validation';

/*
 * Painel situacional do processo (US-004 · SCR-006): regras PURAS de composição do resumo (PRC-07)
 * e do stepper (PRC-10) — a ação primária (RN-PROC-49), as pendências com atalho (RN-PROC-51), o
 * prazo alvo (RN-PROC-53 · DEC-031), o aprovador designado (RN-PROC-48(2)/(7)) e as etapas com as
 * passagens (RN-PROC-52). A autorização continua nos comandos: aqui só se compõe o que o motor e
 * as fachadas já decidiram.
 */

/** Ações de avanço que podem ser a ação primária pela custódia (RN-PROC-49 (c)). */
const ADVANCES: ReadonlySet<string> = new Set(['FORWARD', 'COMPLETE']);

export function isFinalStatus(status: ProcessStatus): boolean {
  return FINAL_PROCESS_STATUSES.includes(status);
}

/** "Há N pendência(s) obrigatória(s) nesta etapa." (V-02). */
export function blockingPendingMessage(count: number): string {
  return count === 1
    ? 'Há 1 pendência obrigatória nesta etapa.'
    : `Há ${String(count)} pendências obrigatórias nesta etapa.`;
}

/** Aprovação pendente já resolvida para o usuário (rótulo e POL-03). */
export interface ApprovalForPanel {
  readonly id: string;
  readonly processStageId: string | null;
  readonly isMine: boolean;
}

export interface PrimaryActionInput {
  readonly status: ProcessStatus;
  /** PRC-08 para o usuário (motor de workflow), na ordem da API. */
  readonly actions: readonly ActionEntry[];
  readonly approvals: readonly ApprovalForPanel[];
}

function toSummaryAction(entry: ActionEntry): SummaryAction {
  const blocking = entry.reasons.filter((reason) => reason.code === 'TRANSITION_BLOCKED');
  const others = entry.reasons.filter((reason) => reason.code !== 'TRANSITION_BLOCKED');
  return {
    action: entry.action,
    ...(entry.transitionKey === undefined ? {} : { transitionKey: entry.transitionKey }),
    ...(entry.approvalId === undefined ? {} : { approvalId: entry.approvalId }),
    label: entry.label,
    enabled: entry.enabled,
    // V-02: as regras bloqueantes viram UM motivo com a contagem ("Há 1 pendência…").
    reasons: [
      ...others.map(({ code, message }) => ({ code, message })),
      ...(blocking.length === 0
        ? []
        : [{ code: 'TRANSITION_BLOCKED', message: blockingPendingMessage(blocking.length) }]),
    ],
  };
}

/**
 * RN-PROC-49 — ação primária, na ordem: (a) "Decidir aprovação" do aprovador designado; (b)
 * "Assumir" da fila da unidade; (c) a transição principal da etapa para quem tem a custódia —
 * inclusive bloqueada por regra `BLOCKING` (desabilitada com o motivo); (d) "Retomar" do processo
 * suspenso; (e) nenhuma (`null` — a área mostra com quem o processo está).
 */
export function selectPrimaryAction(input: PrimaryActionInput): SummaryAction | null {
  const mine = input.approvals.find((approval) => approval.isMine);
  if (mine !== undefined && !isFinalStatus(input.status)) {
    return {
      action: 'DECIDE_APPROVAL',
      approvalId: mine.id,
      label: 'Decidir aprovação',
      enabled: true,
      reasons: [],
    };
  }
  const claim = input.actions.find((entry) => entry.action === 'CLAIM' && entry.enabled);
  if (claim !== undefined) return toSummaryAction(claim);
  const advance = input.actions.find(
    (entry) =>
      ADVANCES.has(entry.action) &&
      entry.primary === true &&
      entry.reasons.every((reason) => reason.code === 'TRANSITION_BLOCKED'),
  );
  if (advance !== undefined) return toSummaryAction(advance);
  if (input.status === 'SUSPENDED') {
    const resume = input.actions.find((entry) => entry.action === 'RESUME' && entry.enabled);
    if (resume !== undefined) return toSummaryAction(resume);
  }
  return null;
}

/** `meta.allowedActions` de PRC-04 (api.md §1.5): as ações habilitadas, sem repetição. */
export function allowedActionsOf(
  actions: readonly ActionEntry[],
  approvals: readonly ApprovalForPanel[],
): string[] {
  const allowed = new Set(actions.filter((entry) => entry.enabled).map((entry) => entry.action));
  if (approvals.some((approval) => approval.isMine)) allowed.add('DECIDE_APPROVAL');
  return [...allowed];
}

/**
 * RN-PROC-51 — "O que falta": os itens não satisfeitos do checklist (PRC-09), com o atalho do
 * `REQUIRED_DOCUMENT` para o documento existente do tipo ou para criá-lo. Regra que não pôde ser
 * avaliada já chega não satisfeita e com a mensagem padrão (fail-closed — FA-10).
 */
export function pendingOf(
  violations: readonly ChecklistViolation[],
  documents: readonly Pick<SummaryDocument, 'id' | 'typeCode' | 'restricted'>[],
): { blockingCount: number; warningCount: number; items: PendingItem[] } {
  const items = violations.map((violation): PendingItem => {
    const typeCode = violation.params.documentTypeCode;
    let link: PendingItem['link'] = null;
    if (violation.type === 'REQUIRED_DOCUMENT' && typeof typeCode === 'string') {
      const document = documents.find((candidate) => candidate.typeCode === typeCode);
      link =
        document === undefined
          ? { createDocumentTypeCode: typeCode }
          : { documentId: document.id, restricted: document.restricted };
    }
    return {
      ruleId: violation.ruleId,
      name: violation.name,
      type: violation.type,
      severity: violation.severity,
      message: violation.message,
      evaluationFailed: violation.evaluationFailed === true,
      link,
    };
  });
  return {
    blockingCount: items.filter((item) => item.severity === 'BLOCKING').length,
    warningCount: items.filter((item) => item.severity === 'WARNING').length,
    items,
  };
}

function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00.000Z`);
  const end = Date.parse(`${to}T00:00:00.000Z`);
  return Math.round((end - start) / 86_400_000);
}

/**
 * RN-PROC-53 · DEC-031 — prazo alvo: vencido quando anterior a hoje (fuso do tenant), em dias
 * corridos, só para status não final. Sem prazo alvo = `null`.
 */
export function targetOf(
  targetDate: string | null,
  status: ProcessStatus,
  today: string,
): { targetDate: string; isOverdue: boolean; overdueDays: number | null } | null {
  if (targetDate === null) return null;
  if (isFinalStatus(status) || targetDate >= today) {
    return { targetDate, isOverdue: false, overdueDays: null };
  }
  return { targetDate, isOverdue: true, overdueDays: daysBetween(targetDate, today) };
}

/** Aprovação pendente como as fachadas a leem (aprovador designado). */
export interface ApproverFacts {
  readonly approverType: ApproverType;
  readonly approverUserId: string | null;
  readonly approverRoleId: string | null;
  readonly approverDepartmentId: string | null;
  readonly allowDeputy: boolean;
}

/** Quem consulta, para POL-03 (aprovador designado). */
export interface ApproverViewer {
  readonly userId: string;
  /** Unidades de que é titular ou substituto (capacidade implícita). */
  readonly headOfDepartmentIds: readonly string[];
  /** `Role.key` dos perfis do vínculo. */
  readonly roleKeys: readonly string[];
}

export interface ApproverNames {
  readonly users: ReadonlyMap<string, string>;
  readonly roles: ReadonlyMap<string, { readonly key: string; readonly name: string }>;
  readonly departments: ReadonlyMap<string, string>;
}

/** RN-PROC-48(2)/(7): usuário, perfil no escopo ou titular da unidade (e substituto). */
export function approverLabelOf(approval: ApproverFacts, names: ApproverNames): string {
  if (approval.approverType === 'USER') {
    const id = approval.approverUserId ?? '';
    return names.users.get(id) ?? id;
  }
  if (approval.approverType === 'ROLE') {
    const id = approval.approverRoleId ?? '';
    return `Perfil ${names.roles.get(id)?.name ?? id}`;
  }
  const id = approval.approverDepartmentId ?? '';
  const unit = names.departments.get(id) ?? id;
  return approval.allowDeputy ? `Titular de ${unit} ou substituto` : `Titular de ${unit}`;
}

/** POL-03: o usuário é o aprovador designado (usuário, perfil ou titular/substituto da unidade). */
export function isDesignatedApprover(
  approval: ApproverFacts,
  viewer: ApproverViewer,
  names: Pick<ApproverNames, 'roles'>,
): boolean {
  if (approval.approverType === 'USER') return approval.approverUserId === viewer.userId;
  if (approval.approverType === 'ROLE') {
    const role = names.roles.get(approval.approverRoleId ?? '');
    return role !== undefined && viewer.roleKeys.includes(role.key);
  }
  return (
    approval.approverDepartmentId !== null &&
    viewer.headOfDepartmentIds.includes(approval.approverDepartmentId)
  );
}

/** Etapa da versão fixada como o stepper a lê (snapshot publicado). */
export interface StepperStage {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly type: ProcessStageEntryDto['type'];
  readonly groupLabel: string | null;
  readonly displayOrder: number;
  readonly slaDays: number | null;
  readonly slaType: ProcessStageEntryDto['slaType'];
}

/** Passagem com os nomes já resolvidos. */
export interface StepperPass {
  readonly processStageId: string;
  readonly workflowStageId: string;
  readonly sequence: number;
  readonly status: ProcessStageStatus;
  readonly department: { readonly id: string; readonly name: string };
  readonly assignee: { readonly id: string; readonly name: string } | null;
  readonly enteredAt: Date;
  readonly exitedAt: Date | null;
  readonly dueAt: Date | null;
  readonly dueDateOverridden: boolean;
  readonly overdueSince: Date | null;
}

const iso = (value: Date | null) => value?.toISOString() ?? null;

/**
 * RN-PROC-52 — stepper (PRC-10): as etapas da versão fixada em `displayOrder` (o web agrupa por
 * `groupLabel`), cada uma com o status da última passagem (`null` = não percorrida) e todas as
 * passagens. A etapa `END` só aparece concluída com o processo `COMPLETED`.
 */
export function stageEntriesOf(
  stages: readonly StepperStage[],
  passes: readonly StepperPass[],
  status: ProcessStatus,
): ProcessStageEntryDto[] {
  return [...stages]
    .sort((a, b) => a.displayOrder - b.displayOrder || (a.key < b.key ? -1 : 1))
    .map((stage) => {
      const own = passes
        .filter((pass) => pass.workflowStageId === stage.id)
        .sort((a, b) => a.sequence - b.sequence);
      const last = own.at(-1);
      let lastPassStatus: ProcessStageStatus | null = last?.status ?? null;
      if (stage.type === 'END') {
        if (status === 'COMPLETED') lastPassStatus = 'COMPLETED';
        else if (lastPassStatus === 'COMPLETED') lastPassStatus = 'ACTIVE';
      }
      return {
        workflowStageId: stage.id,
        key: stage.key,
        name: stage.name,
        type: stage.type,
        groupLabel: stage.groupLabel,
        displayOrder: stage.displayOrder,
        slaDays: stage.slaDays,
        slaType: stage.slaType,
        lastPassStatus,
        isCurrent: !isFinalStatus(status) && last?.status === 'ACTIVE',
        passes: own.map((pass) => ({
          processStageId: pass.processStageId,
          sequence: pass.sequence,
          status: pass.status,
          department: pass.department,
          assignee: pass.assignee,
          enteredAt: pass.enteredAt.toISOString(),
          exitedAt: iso(pass.exitedAt),
          dueAt: iso(pass.dueAt),
          dueDateOverridden: pass.dueDateOverridden,
          overdueSince: iso(pass.overdueSince),
        })),
      };
    });
}
