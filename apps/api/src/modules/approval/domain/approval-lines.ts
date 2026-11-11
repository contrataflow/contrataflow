import { APPROVAL_LINES_MAX, approversBelowMinimum } from '@contrataflow/validation';
import type {
  ApprovalApproverStatus,
  ApprovalConfigProblem,
  ApprovalDecision,
  ApprovalDecisionPolicy,
  ApprovalSkippedReason,
  ApproverType,
} from '@contrataflow/validation';

import type { ApprovalRecord } from './approval-decision.js';
import type { ApproverConfig, ResolvedApprover } from './approval.js';

/*
 * Aprovação múltipla na solicitação (US-133 · DEC-193 · RN-APV-16..32), puro: a configuração
 * copiada da etapa `APPROVAL` (`WorkflowStageApprover`) ou da `approvalPolicy` do tipo de documento,
 * o estado inicial de cada `ApprovalApprover` pela política, a segregação de funções por linha
 * (`SelfApprovalGuard` — substituto ou recusa), a pessoa única (`DistinctApproversPolicy`), o
 * espelho da linha corrente nas colunas da `Approval` (fase expand), o mapeamento do backfill
 * (M2-03) e a sincronização das linhas com as ações do MVP 1 que ainda encerram a aprovação inteira
 * (decisão, retirada, cancelamento e redirecionamento — substituídas pelas US-134/US-135).
 */

/** Linha configurada: o aprovador como na US-051 mais a posição e o rótulo. */
export interface ApprovalLineConfig extends ApproverConfig {
  readonly sequence: number;
  /** Rótulo configurado (US-132); só para mensagens — nunca o nome resolvido. */
  readonly label: string | null;
}

/** A configuração copiada no instante da solicitação (RN-APV-16). */
export interface ApprovalRequestConfig {
  readonly decisionPolicy: ApprovalDecisionPolicy;
  readonly lines: readonly ApprovalLineConfig[];
  /** `true` = lista configurada (US-132); `false` = aprovador único do MVP 1 (FA-01). */
  readonly listed: boolean;
}

/** Linha como a etapa (snapshot) ou a `approvalPolicy` a guardam. */
export interface ApproverLineSource {
  readonly sequence?: number | undefined;
  readonly approverType: ApproverType;
  readonly approverUserId?: string | null | undefined;
  readonly approverRoleId?: string | null | undefined;
  readonly approverDepartmentResolution?:
    ApproverConfig['approverDepartmentResolution'] | undefined;
  readonly approverFixedDepartmentId?: string | null | undefined;
  readonly label?: string | null | undefined;
}

/** Etapa `APPROVAL` do snapshot ou `DocumentType.approvalPolicy`: aprovador único + lista. */
export interface ApprovalConfigSource {
  readonly decisionPolicy?: ApprovalDecisionPolicy | undefined;
  readonly approvers?: readonly ApproverLineSource[] | undefined;
  readonly approverType: ApproverType | null;
  readonly approverUserId?: string | null | undefined;
  readonly approverRoleId?: string | null | undefined;
  readonly approverDepartmentResolution?:
    ApproverConfig['approverDepartmentResolution'] | undefined;
  readonly approverFixedDepartmentId?: string | null | undefined;
}

/** V-06/V-07: dado inconsistente na configuração copiada (`APPROVER_UNRESOLVED`). */
export class ApprovalConfigInvalidError extends Error {
  constructor(readonly reason: ApprovalConfigProblem) {
    super(`Configuração de aprovação inválida (${reason}).`);
    this.name = 'ApprovalConfigInvalidError';
  }
}

const lineConfigOf = (line: ApproverLineSource, sequence: number): ApprovalLineConfig => ({
  sequence,
  approverType: line.approverType,
  approverUserId: line.approverUserId ?? null,
  approverRoleId: line.approverRoleId ?? null,
  approverDepartmentResolution: line.approverDepartmentResolution ?? null,
  approverFixedDepartmentId: line.approverFixedDepartmentId ?? null,
  label: line.label ?? null,
});

/**
 * RN-APV-16/17: a política e as linhas em ordem de `sequence` (a lista do tipo de documento não
 * guarda `sequence`: vale a ordem do array); sem lista, uma linha `sequence = 1` com o aprovador
 * único (`ANY` do MVP 1). @throws ApprovalConfigInvalidError (V-06 `POLICY_INVALID`, V-07
 * `LIMIT_EXCEEDED`)
 */
export function approvalConfigOf(source: ApprovalConfigSource): ApprovalRequestConfig {
  const decisionPolicy = source.decisionPolicy ?? 'ANY';
  const listed = (source.approvers ?? [])
    .map((line, index) => ({ line, sequence: line.sequence ?? index + 1 }))
    .sort((a, b) => a.sequence - b.sequence)
    .map(({ line }, index) => lineConfigOf(line, index + 1));
  if (listed.length > APPROVAL_LINES_MAX) throw new ApprovalConfigInvalidError('LIMIT_EXCEEDED');
  if (listed.length === 0) {
    if (decisionPolicy !== 'ANY') throw new ApprovalConfigInvalidError('POLICY_INVALID');
    return {
      decisionPolicy,
      listed: false,
      lines: [
        {
          sequence: 1,
          approverType: source.approverType,
          approverUserId: source.approverUserId ?? null,
          approverRoleId: source.approverRoleId ?? null,
          approverDepartmentResolution: source.approverDepartmentResolution ?? null,
          approverFixedDepartmentId: source.approverFixedDepartmentId ?? null,
          label: null,
        },
      ],
    };
  }
  if (approversBelowMinimum(decisionPolicy, listed.length)) {
    throw new ApprovalConfigInvalidError('POLICY_INVALID');
  }
  return { decisionPolicy, listed: true, lines: listed };
}

/** Linha com o aprovador resolvido (RN-APV-19). */
export interface ResolvedApprovalLine extends ResolvedApprover {
  readonly sequence: number;
  /** Rótulo configurado da linha (mensagens de erro). */
  readonly configuredLabel: string | null;
}

/** Linha depois da segregação (RN-APV-20). */
export interface GuardedApprovalLine extends ResolvedApprovalLine {
  /** A linha foi desviada do titular autor para o substituto (só na auditoria). */
  readonly selfApprovalAvoided: boolean;
}

/** V-03: o aprovador da linha é autor de documento coberto e não há substituto elegível. */
export class SelfApprovalAtRequestError extends Error {
  constructor(readonly sequence: number) {
    super(`O aprovador da linha ${String(sequence)} é autor de um documento coberto.`);
    this.name = 'SelfApprovalAtRequestError';
  }
}

/** V-04: a mesma pessoa resolvida em duas linhas. */
export class DuplicatedApproverError extends Error {
  constructor(
    readonly first: number,
    readonly second: number,
  ) {
    super(`A mesma pessoa nas linhas ${String(first)} e ${String(second)}.`);
    this.name = 'DuplicatedApproverError';
  }
}

/**
 * RN-APV-20: a segregação vale na solicitação quando a política é `ALL`/`SEQUENTIAL` ou há mais de
 * uma linha; `ANY` com linha única mantém a regra do MVP 1 (RN-TRAM-50: só a decisão verifica).
 */
export function segregationAppliesAtRequest(
  policy: ApprovalDecisionPolicy,
  linesCount: number,
): boolean {
  return policy !== 'ANY' || linesCount > 1;
}

export interface SegregationFacts {
  readonly preventSelfApproval: boolean;
  /** Autores dos documentos cobertos (criador do documento e da versão analisada — RN-TRAM-62). */
  readonly authorIds: ReadonlySet<string>;
  /** Substituto com vínculo ativo de cada unidade das linhas `DEPARTMENT_HEAD` (`null` = nenhum). */
  readonly deputies: ReadonlyMap<string, string | null>;
}

/**
 * `SelfApprovalGuard` por linha (RN-APV-20 · DEC-193): `USER` autor → recusa; titular autor → a
 * linha vai para o substituto da unidade (`allowDeputy = false`, `selfApprovalAvoided`), e sem
 * substituto elegível (ausente, sem vínculo ativo ou também autor) → recusa. `ROLE` não é avaliada
 * aqui (a elegibilidade é da decisão). @throws SelfApprovalAtRequestError
 */
export function guardSelfApproval(
  policy: ApprovalDecisionPolicy,
  lines: readonly ResolvedApprovalLine[],
  facts: SegregationFacts,
): GuardedApprovalLine[] {
  const applies = facts.preventSelfApproval && segregationAppliesAtRequest(policy, lines.length);
  return lines.map((line) => {
    const unchanged = { ...line, selfApprovalAvoided: false };
    if (!applies || line.approverType === 'ROLE') return unchanged;
    const person = line.approverUserId;
    if (person === null || !facts.authorIds.has(person)) return unchanged;
    if (line.approverType === 'USER') throw new SelfApprovalAtRequestError(line.sequence);
    const deputy =
      line.approverDepartmentId === null
        ? null
        : (facts.deputies.get(line.approverDepartmentId) ?? null);
    if (deputy === null || facts.authorIds.has(deputy)) {
      throw new SelfApprovalAtRequestError(line.sequence);
    }
    return { ...line, approverUserId: deputy, allowDeputy: false, selfApprovalAvoided: true };
  });
}

/**
 * `DistinctApproversPolicy` (RN-APV-21): a mesma pessoa resolvida (`USER` ou titular/substituto de
 * `DEPARTMENT_HEAD`, depois da segregação) não ocupa duas linhas; `ROLE` não entra na comparação.
 * @throws DuplicatedApproverError com as duas primeiras linhas envolvidas
 */
export function assertDistinctApprovers(lines: readonly ResolvedApprovalLine[]): void {
  const seen = new Map<string, number>();
  for (const line of [...lines].sort((a, b) => a.sequence - b.sequence)) {
    if (line.approverType === 'ROLE' || line.approverUserId === null) continue;
    const first = seen.get(line.approverUserId);
    if (first !== undefined) throw new DuplicatedApproverError(first, line.sequence);
    seen.set(line.approverUserId, line.sequence);
  }
}

/** `ApprovalApprover` (entities.md MVP 2 §4.6). */
export interface ApprovalApprover {
  readonly id: string;
  readonly approvalId: string;
  readonly sequence: number;
  readonly approverType: ApproverType;
  readonly approverUserId: string | null;
  readonly approverRoleId: string | null;
  readonly approverDepartmentId: string | null;
  readonly allowDeputy: boolean;
  readonly status: ApprovalApproverStatus;
  readonly activatedAt: Date | null;
  readonly dueAt: Date | null;
  readonly decision: ApprovalDecision | null;
  readonly decidedById: string | null;
  readonly decidedAt: Date | null;
  readonly decisionComment: string | null;
  readonly decidedAsDeputy: boolean;
  readonly reassignedFromId: string | null;
  readonly skippedReason: ApprovalSkippedReason | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** Solicitante (aplicação) ou `null` (backfill M2-03). */
  readonly createdById: string | null;
  readonly version: number;
}

/**
 * RN-APV-18: `ANY` e `ALL` — todas `PENDING` com `activatedAt = requestedAt`; `SEQUENTIAL` — a
 * linha de menor `sequence` `PENDING`, as demais `WAITING` (`activatedAt` nulo). `dueAt` da linha
 * nulo (prazo por linha: EP-030).
 */
export function openApprovalLines(
  approvalId: string,
  policy: ApprovalDecisionPolicy,
  lines: readonly GuardedApprovalLine[],
  stamp: {
    readonly requestedAt: Date;
    readonly requestedById: string;
    readonly newId: () => string;
  },
): ApprovalApprover[] {
  return [...lines]
    .sort((a, b) => a.sequence - b.sequence)
    .map((line, index) => {
      const pending = policy !== 'SEQUENTIAL' || index === 0;
      return {
        id: stamp.newId(),
        approvalId,
        sequence: line.sequence,
        approverType: line.approverType,
        approverUserId: line.approverUserId,
        approverRoleId: line.approverRoleId,
        approverDepartmentId: line.approverDepartmentId,
        allowDeputy: line.allowDeputy,
        status: pending ? 'PENDING' : 'WAITING',
        activatedAt: pending ? stamp.requestedAt : null,
        dueAt: null,
        decision: null,
        decidedById: null,
        decidedAt: null,
        decisionComment: null,
        decidedAsDeputy: false,
        reassignedFromId: null,
        skippedReason: null,
        createdAt: stamp.requestedAt,
        updatedAt: stamp.requestedAt,
        createdById: stamp.requestedById,
        version: 1,
      };
    });
}

const LIVE_STATUSES: ReadonlySet<ApprovalApproverStatus> = new Set(['PENDING', 'WAITING']);

const bySequence = (a: ApprovalApprover, b: ApprovalApprover) => a.sequence - b.sequence;

/**
 * RN-APV-24 (fase expand): a linha que as colunas de aprovador da `Approval` espelham — a corrente
 * em `SEQUENTIAL` (a primeira `PENDING`), a primeira nas demais (linhas canceladas por
 * redirecionamento não contam).
 */
export function mirroredLineOf(
  policy: ApprovalDecisionPolicy,
  lines: readonly ApprovalApprover[],
): ApprovalApprover | null {
  const live = lines.filter((line) => line.status !== 'CANCELED').sort(bySequence);
  if (policy === 'SEQUENTIAL') {
    return live.find((line) => line.status === 'PENDING') ?? live[0] ?? null;
  }
  return live[0] ?? [...lines].sort(bySequence)[0] ?? null;
}

/** Os campos de aprovador da `Approval` que espelham a linha. */
export function mirrorOf(line: ApprovalApprover): ResolvedApprover {
  return {
    approverType: line.approverType,
    approverUserId: line.approverUserId,
    approverRoleId: line.approverRoleId,
    approverDepartmentId: line.approverDepartmentId,
    allowDeputy: line.allowDeputy,
  };
}

const DECIDED_LINE_STATUS: Readonly<Record<ApprovalDecision, ApprovalApproverStatus>> = {
  APPROVE: 'APPROVED',
  RETURN: 'RETURNED',
  REJECT: 'REJECTED',
};

type DecidedStatus = 'APPROVED' | 'RETURNED' | 'REJECTED';

const DECISION_OF_STATUS: Readonly<Record<DecidedStatus, ApprovalDecision>> = {
  APPROVED: 'APPROVE',
  RETURNED: 'RETURN',
  REJECTED: 'REJECT',
};

/**
 * RN-APV-30 (M2-03): a linha `sequence = 1` de uma aprovação do MVP 1 — o aprovador gravado, o
 * estado equivalente e, se decidida, a decisão; `CANCELED` → `skippedReason = WITHDRAWN` (lacuna 3).
 * O mesmo mapeamento da migração `20261112091000_approval_approvers_backfill` (em SQL).
 */
export function backfillLineOf(approval: ApprovalRecord, id: string): ApprovalApprover {
  const { status } = approval;
  const decided: DecidedStatus | null =
    status === 'APPROVED' || status === 'RETURNED' || status === 'REJECTED' ? status : null;
  return {
    id,
    approvalId: approval.id,
    sequence: 1,
    approverType: approval.approverType,
    approverUserId: approval.approverUserId,
    approverRoleId: approval.approverRoleId,
    approverDepartmentId: approval.approverDepartmentId,
    allowDeputy: approval.allowDeputy,
    status,
    activatedAt: approval.requestedAt,
    dueAt: null,
    decision: decided === null ? null : (approval.decision ?? DECISION_OF_STATUS[decided]),
    decidedById: decided === null ? null : approval.decidedById,
    decidedAt: decided === null ? null : (approval.decidedAt ?? approval.updatedAt),
    decisionComment: decided === null ? null : approval.decisionComment,
    decidedAsDeputy: decided !== null && approval.decidedAsDeputy,
    reassignedFromId: null,
    skippedReason: approval.status === 'CANCELED' ? 'WITHDRAWN' : null,
    createdAt: approval.createdAt,
    updatedAt: approval.updatedAt,
    createdById: null,
    version: 1,
  };
}

/**
 * Sincronização provisória com a decisão do MVP 1 (US-052), que encerra a aprovação na primeira
 * decisão: a linha viva de quem decidiu (`USER`/titular gravado) — senão a primeira `PENDING` —
 * recebe a decisão; as demais vivas ficam `SKIPPED` (`ANY_DECIDED` na aprovação, senão
 * `NEGATIVE_DECISION` — entities.md MVP 2 §6.6). A decisão por linha é da US-134.
 */
export function linesAfterDecision(
  lines: readonly ApprovalApprover[],
  decided: ApprovalRecord,
): ApprovalApprover[] {
  const { decision, decidedAt } = decided;
  if (decision === null || decidedAt === null) return [...lines];
  const live = lines.filter((line) => LIVE_STATUSES.has(line.status)).sort(bySequence);
  const target =
    live.find((line) => line.status === 'PENDING' && line.approverUserId === decided.decidedById) ??
    live.find((line) => line.status === 'PENDING') ??
    live[0];
  const skippedReason: ApprovalSkippedReason =
    decision === 'APPROVE' ? 'ANY_DECIDED' : 'NEGATIVE_DECISION';
  return lines.map((line) => {
    if (!LIVE_STATUSES.has(line.status)) return line;
    const touched = { updatedAt: decidedAt, version: line.version + 1 };
    if (line.id === target?.id) {
      return {
        ...line,
        ...touched,
        status: DECIDED_LINE_STATUS[decision],
        activatedAt: line.activatedAt ?? decidedAt,
        decision,
        decidedById: decided.decidedById,
        decidedAt,
        decisionComment: decided.decisionComment,
        decidedAsDeputy: decided.decidedAsDeputy,
      };
    }
    return { ...line, ...touched, status: 'SKIPPED', skippedReason };
  });
}

/**
 * Retirada (US-053) ou cancelamento do processo (US-009): toda linha não decidida vira `CANCELED`
 * com `skippedReason = WITHDRAWN` (entities.md MVP 2 §6.6; lacuna 3 da US-133 para o cancelamento).
 */
export function linesAfterCancellation(
  lines: readonly ApprovalApprover[],
  at: Date,
): ApprovalApprover[] {
  return lines.map((line) =>
    LIVE_STATUSES.has(line.status)
      ? {
          ...line,
          status: 'CANCELED',
          skippedReason: 'WITHDRAWN',
          updatedAt: at,
          version: line.version + 1,
        }
      : line,
  );
}

/**
 * Redirecionamento do MVP 1 (US-053 · APV-05): o novo aprovador assume a linha espelhada, no lugar
 * (mesmo id — as concessões `APPROVER` seguem pela linha). O redirecionamento por linha (cancelar e
 * recriar com `reassignedFromId`) é da US-135. `null` = nenhuma linha viva.
 */
export function lineAfterReassignment(
  policy: ApprovalDecisionPolicy,
  lines: readonly ApprovalApprover[],
  reassigned: ApprovalRecord,
): ApprovalApprover | null {
  const current = mirroredLineOf(
    policy,
    lines.filter((line) => LIVE_STATUSES.has(line.status)),
  );
  if (current === null) return null;
  return {
    ...current,
    approverType: reassigned.approverType,
    approverUserId: reassigned.approverUserId,
    approverRoleId: reassigned.approverRoleId,
    approverDepartmentId: reassigned.approverDepartmentId,
    allowDeputy: reassigned.allowDeputy,
    updatedAt: reassigned.updatedAt,
    version: current.version + 1,
  };
}
