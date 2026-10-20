import type { ApprovalCancelReason, ApproverType } from '@contrataflow/validation';

import { ApprovalNotPendingError } from './approval-decision.js';
import type { ApprovalRecord } from './approval-decision.js';
import type { ApproverConfig, ResolvedApprover } from './approval.js';

/*
 * Retirar ou redirecionar a aprovação pendente (US-053 · DEC-018/022 · RN-TRAM-64..71), puro: a
 * aprovação cancelada pela retirada, a troca do aprovador e as checagens do novo aprovador que não
 * dependem de leitura (igual ao atual, segregação de funções). Elegibilidade (vínculo ativo,
 * detentor competente do perfil, titular da unidade) é a resolução da US-051 (`resolveApprover`).
 */

/** Motivo codificado gravado em `cancellationReason` e no `ApprovalCanceled` da retirada. */
export const WITHDRAWN: ApprovalCancelReason = 'WITHDRAWN';

export interface WithdrawalInput {
  readonly withdrawnById: string;
  readonly now: Date;
}

/**
 * RN-TRAM-66: `CANCELED` com data, autor e o motivo codificado `WITHDRAWN` (o texto informado vai na
 * tramitação de devolução, nunca na aprovação); `version + 1`. Só `PENDING` (RN-TRAM-65).
 */
export function withdrawApproval(approval: ApprovalRecord, input: WithdrawalInput): ApprovalRecord {
  if (approval.status !== 'PENDING') throw new ApprovalNotPendingError(approval.status);
  return {
    ...approval,
    status: 'CANCELED',
    canceledAt: input.now,
    canceledById: input.withdrawnById,
    cancellationReason: WITHDRAWN,
    updatedAt: input.now,
    version: approval.version + 1,
  };
}

/** O novo aprovador pedido no APV-05 (`approverType` + o `targetApprover*` correspondente). */
export interface ReassignTarget {
  readonly approverType: ApproverType;
  readonly targetApproverUserId: string | null;
  readonly targetApproverRoleId: string | null;
  readonly targetApproverDepartmentId: string | null;
}

/**
 * O alvo como configuração da resolução (US-051): `USER` e `ROLE` diretos; `DEPARTMENT_HEAD` pela
 * unidade escolhida (`FIXED`) — o titular ATUAL dela, com `allowDeputy`.
 */
export function approverConfigOfTarget(target: ReassignTarget): ApproverConfig {
  return {
    approverType: target.approverType,
    approverUserId: target.approverType === 'USER' ? target.targetApproverUserId : null,
    approverRoleId: target.approverType === 'ROLE' ? target.targetApproverRoleId : null,
    approverDepartmentResolution: target.approverType === 'DEPARTMENT_HEAD' ? 'FIXED' : null,
    approverFixedDepartmentId:
      target.approverType === 'DEPARTMENT_HEAD' ? target.targetApproverDepartmentId : null,
  };
}

/**
 * RN-TRAM-69 (V-02): o novo aprovador é o mesmo registro atual — mesmo usuário (`USER`), mesmo
 * perfil (`ROLE`) ou mesma unidade (`DEPARTMENT_HEAD`).
 */
export function isSameApprover(
  approval: Pick<
    ApprovalRecord,
    'approverType' | 'approverUserId' | 'approverRoleId' | 'approverDepartmentId'
  >,
  target: ResolvedApprover,
): boolean {
  if (approval.approverType !== target.approverType) return false;
  switch (target.approverType) {
    case 'USER':
      return approval.approverUserId === target.approverUserId;
    case 'ROLE':
      return approval.approverRoleId === target.approverRoleId;
    case 'DEPARTMENT_HEAD':
      return approval.approverDepartmentId === target.approverDepartmentId;
  }
}

/**
 * RN-TRAM-69 + RN-TRAM-62 (V-05): com `approval.preventSelfApproval`, a pessoa que passaria a
 * decidir (o `USER` ou o titular da unidade) não pode ser autora de documento coberto. Perfil
 * (`ROLE`) não nomeia ninguém: a segregação vale na decisão (POL-03).
 */
export function violatesSegregation(
  target: ResolvedApprover,
  authorIds: readonly string[],
  preventSelfApproval: boolean,
): boolean {
  return (
    preventSelfApproval &&
    target.approverUserId !== null &&
    target.approverType !== 'ROLE' &&
    authorIds.includes(target.approverUserId)
  );
}

/**
 * RN-TRAM-70: troca SOMENTE o aprovador (`approverType`, ids e `allowDeputy` da resolução); título,
 * prazo, solicitante e cobertura ficam. `version + 1`. Só `PENDING` (RN-TRAM-65).
 */
export function reassignApproval(
  approval: ApprovalRecord,
  target: ResolvedApprover,
  now: Date,
): ApprovalRecord {
  if (approval.status !== 'PENDING') throw new ApprovalNotPendingError(approval.status);
  return {
    ...approval,
    approverType: target.approverType,
    approverUserId: target.approverUserId,
    approverRoleId: target.approverRoleId,
    approverDepartmentId: target.approverDepartmentId,
    allowDeputy: target.allowDeputy,
    updatedAt: now,
    version: approval.version + 1,
  };
}
