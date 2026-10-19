import type {
  ApprovalDecision,
  ApprovalDecisionBlocker,
  ProcessStatus,
} from '@contrataflow/validation';

import type { Approval, ApprovalStatus } from './approval.js';

/*
 * Decisão da aprovação (US-052 · DEC-022 · RN-TRAM-54/55/62/63 · POL-03), puro: a aprovação com o
 * estado da decisão, a designação de quem decide (titular, substituto ou detentor competente do
 * perfil), a segregação de funções e o status do processo em que a decisão vale.
 */

/** A aprovação com a decisão e a versão (concorrência otimista — DEC-104). */
export interface ApprovalRecord extends Approval {
  readonly decision: ApprovalDecision | null;
  readonly decidedById: string | null;
  readonly decidedAt: Date | null;
  readonly decisionComment: string | null;
  readonly decidedAsDeputy: boolean;
  readonly updatedAt: Date;
  readonly version: number;
}

/** A aprovação recém-aberta (US-051) como registro: sem decisão, versão 1. */
export function recordOf(approval: Approval): ApprovalRecord {
  return {
    ...approval,
    decision: null,
    decidedById: null,
    decidedAt: null,
    decisionComment: null,
    decidedAsDeputy: false,
    updatedAt: approval.createdAt,
    version: 1,
  };
}

/** RN-TRAM-54: decisão → status da aprovação. */
export const STATUS_OF_DECISION: Readonly<Record<ApprovalDecision, ApprovalStatus>> = {
  APPROVE: 'APPROVED',
  RETURN: 'RETURNED',
  REJECT: 'REJECTED',
};

/** A aprovação já não está `PENDING` (decidida, retirada ou cancelada — RN-TRAM-54/63). */
export class ApprovalNotPendingError extends Error {
  constructor(readonly status: ApprovalStatus) {
    super(`Aprovação ${status} não pode ser decidida.`);
    this.name = 'ApprovalNotPendingError';
  }
}

export interface DecisionInput {
  readonly decision: ApprovalDecision;
  /** RN-TRAM-55: obrigatório (≥ 10) em `RETURN`/`REJECT` — validado no contrato. */
  readonly comment: string | null;
  readonly decidedById: string;
  readonly asDeputy: boolean;
  readonly now: Date;
}

/** RN-TRAM-54: grava decisão, decisor, data, comentário e substituto; `version + 1`. */
export function decideApproval(approval: ApprovalRecord, input: DecisionInput): ApprovalRecord {
  if (approval.status !== 'PENDING') throw new ApprovalNotPendingError(approval.status);
  return {
    ...approval,
    status: STATUS_OF_DECISION[input.decision],
    decision: input.decision,
    decidedById: input.decidedById,
    decidedAt: input.now,
    decisionComment: input.comment,
    decidedAsDeputy: input.asDeputy,
    updatedAt: input.now,
    version: approval.version + 1,
  };
}

/** Unidade do aprovador `DEPARTMENT_HEAD` com o titular e o substituto ATUAIS. */
export interface ApproverUnit {
  readonly headUserId: string | null;
  readonly deputyUserId: string | null;
}

/** O que POL-03 leu no `tx` sobre quem decide. */
export interface DesignationFacts {
  readonly userId: string;
  /** `ROLE`: detentores competentes no escopo da unidade solicitante (RN-TRAM-47). */
  readonly roleHolderIds: readonly string[];
  /** `DEPARTMENT_HEAD`: a unidade aprovadora (`null` = inexistente/fora do tenant). */
  readonly unit: ApproverUnit | null;
}

export interface Designation {
  readonly designated: boolean;
  /** FA-02: decide como substituto (`decidedAsDeputy`). */
  readonly asDeputy: boolean;
}

const NOT_DESIGNATED: Designation = { designated: false, asDeputy: false };

/**
 * POL-03 (DEC-022): `USER` — o próprio aprovador; `ROLE` — detentor do perfil com atribuição que
 * cubra a unidade solicitante (o primeiro a confirmar vence — FA-05); `DEPARTMENT_HEAD` — o titular
 * ATUAL de `approverDepartmentId` ou, com `allowDeputy`, o substituto (FA-02).
 */
export function designationOf(
  approval: Pick<Approval, 'approverType' | 'approverUserId' | 'allowDeputy'>,
  facts: DesignationFacts,
): Designation {
  switch (approval.approverType) {
    case 'USER':
      return approval.approverUserId === facts.userId
        ? { designated: true, asDeputy: false }
        : NOT_DESIGNATED;
    case 'ROLE':
      return facts.roleHolderIds.includes(facts.userId)
        ? { designated: true, asDeputy: false }
        : NOT_DESIGNATED;
    case 'DEPARTMENT_HEAD': {
      const { unit } = facts;
      if (unit === null) return NOT_DESIGNATED;
      if (unit.headUserId === facts.userId) return { designated: true, asDeputy: false };
      return approval.allowDeputy && unit.deputyUserId === facts.userId
        ? { designated: true, asDeputy: true }
        : NOT_DESIGNATED;
    }
  }
}

/**
 * RN-TRAM-62 (segregação de funções — Lei 14.133, art. 7º, § 1º): com `preventSelfApproval`, quem
 * criou um documento coberto ou a versão analisada não decide.
 */
export function isSelfApproval(
  authorIds: readonly string[],
  userId: string,
  preventSelfApproval: boolean,
): boolean {
  return preventSelfApproval && authorIds.includes(userId);
}

/** POL-03: processo suspenso ou em status final não tem decisão (DEC-013). */
const UNDECIDABLE_STATUSES: ReadonlySet<ProcessStatus> = new Set([
  'SUSPENDED',
  'CANCELED',
  'COMPLETED',
  'PUBLISHED',
]);

export function isDecidableProcessStatus(status: ProcessStatus): boolean {
  return !UNDECIDABLE_STATUSES.has(status);
}

/**
 * Por que quem consulta não pode decidir (APV-02 — SCR-015 oculta as ações e explica o motivo),
 * na ordem das checagens do APV-03; `null` = pode decidir.
 */
export function decisionBlockerOf(input: {
  readonly status: ApprovalStatus;
  readonly canDecide: boolean;
  readonly designation: Designation;
  readonly selfApproval: boolean;
  readonly processStatus: ProcessStatus;
}): ApprovalDecisionBlocker | null {
  if (input.status !== 'PENDING') return 'NOT_PENDING';
  if (!input.canDecide) return 'PERMISSION_DENIED';
  if (!input.designation.designated) return 'NOT_DESIGNATED_APPROVER';
  if (input.selfApproval) return 'SELF_APPROVAL_FORBIDDEN';
  if (!isDecidableProcessStatus(input.processStatus)) return 'INVALID_PROCESS_STATUS';
  return null;
}
