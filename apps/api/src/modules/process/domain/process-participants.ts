import type { ParticipantGrantChannel } from '@contrataflow/validation';

import type { ParticipantRole, ProcessParticipation } from '#shared/auth/process-access.js';

/*
 * Participantes do processo (US-012 · DEC-036 · POL-10 · RN-PROC-126..135): regras puras — sem
 * Nest, banco nem contexto de requisição. Os casos de uso leem o alvo (vínculo do usuário ou a
 * unidade) e a participação ativa e pedem aqui a decisão; a gravação, a concessão `ProcessAccess`,
 * a auditoria e o evento ficam na aplicação.
 */

export type { ParticipantGrantChannel, ParticipantRole };

/** `process_participants` (entities.md §4.4). */
export interface ProcessParticipant {
  readonly id: string;
  readonly tenantId: string;
  readonly processId: string;
  readonly userId: string | null;
  readonly departmentId: string | null;
  readonly role: ParticipantRole;
  readonly notify: boolean;
  readonly grantedById: string;
  readonly grantedAt: Date;
  readonly expiresAt: Date | null;
  readonly reason: string | null;
  readonly revokedAt: Date | null;
  readonly revokedById: string | null;
  readonly revocationReason: string | null;
}

/** RN-PROC-135: participação vencida não vale, mesmo antes de o job `participants-expire` rodar. */
export function isParticipationExpired(
  participant: { readonly expiresAt: Date | null },
  now: Date,
): boolean {
  return participant.expiresAt !== null && participant.expiresAt.getTime() <= now.getTime();
}

/** Participação ativa (não revogada, não vencida) como a autorização a lê (permissions.md §4). */
export function toParticipation(participant: ProcessParticipant): ProcessParticipation {
  return {
    userId: participant.userId,
    departmentId: participant.departmentId,
    role: participant.role,
    expiresAt: participant.expiresAt,
  };
}

/** Vínculo do usuário-alvo no tenant (`null` = sem vínculo no tenant — inclusive de outro tenant). */
export interface TargetMembership {
  readonly type: 'INTERNAL' | 'EXTERNAL' | 'SERVICE';
  readonly status: string;
  readonly expiresAt: Date | null;
}

export type GrantTarget =
  | { readonly kind: 'USER'; readonly userId: string; readonly membership: TargetMembership | null }
  | {
      readonly kind: 'DEPARTMENT';
      readonly departmentId: string;
      /** `null` = unidade inexistente no tenant. */
      readonly isActive: boolean | null;
    };

export interface GrantRequest {
  readonly role: ParticipantRole;
  readonly expiresAt: Date | null;
  /** Quem concede (o usuário da requisição). */
  readonly actorUserId: string;
}

/** Recusa da concessão, na ordem de avaliação (a primeira vale). */
export type GrantRefusal =
  /** V-04: consultor para unidade (RN-PROC-126). */
  | { readonly kind: 'NOT_ELIGIBLE'; readonly reason: 'CONSULTANT_DEPARTMENT' }
  /** V-05: autoinclusão como Colaborador/Consultor (RN-PROC-128). */
  | { readonly kind: 'NOT_ELIGIBLE'; readonly reason: 'SELF' }
  /** V-06: alvo inexistente, de outro tenant ou inativo. */
  | {
      readonly kind: 'INVALID_REFERENCE';
      readonly field: 'userId' | 'departmentId';
      readonly code: 'REFERENCE_NOT_FOUND' | 'REFERENCE_INACTIVE';
    }
  /** Validade no passado (story · "Campos": futura). */
  | { readonly kind: 'EXPIRES_IN_PAST' }
  /** V-04: consultor sem vínculo `EXTERNAL` ativo (RN-PROC-127 · POL-10). */
  | { readonly kind: 'NOT_ELIGIBLE'; readonly reason: 'NOT_EXTERNAL' }
  /** RN-PROC-127: validade além da do vínculo externo. */
  | { readonly kind: 'NOT_ELIGIBLE'; readonly reason: 'EXPIRES_AFTER_MEMBERSHIP' };

/** Vínculo utilizável: `ACTIVE` e, se tiver prazo, ainda não vencido (RN-IAM-64). */
function isMembershipUsable(membership: TargetMembership, now: Date): boolean {
  return (
    membership.status === 'ACTIVE' &&
    (membership.expiresAt === null || membership.expiresAt.getTime() > now.getTime())
  );
}

/**
 * RN-PROC-126..128 e POL-10 sobre um alvo já lido: `null` = pode conceder. A duplicidade
 * (RN-PROC-129) é conferida à parte, contra a participação ativa (e o índice único).
 */
export function grantRefusal(
  target: GrantTarget,
  request: GrantRequest,
  now: Date,
): GrantRefusal | null {
  if (request.role === 'CONSULTANT' && target.kind === 'DEPARTMENT') {
    return { kind: 'NOT_ELIGIBLE', reason: 'CONSULTANT_DEPARTMENT' };
  }
  if (
    target.kind === 'USER' &&
    target.userId === request.actorUserId &&
    request.role !== 'OBSERVER'
  ) {
    return { kind: 'NOT_ELIGIBLE', reason: 'SELF' };
  }
  if (target.kind === 'DEPARTMENT') {
    if (target.isActive === null) {
      return { kind: 'INVALID_REFERENCE', field: 'departmentId', code: 'REFERENCE_NOT_FOUND' };
    }
    if (!target.isActive) {
      return { kind: 'INVALID_REFERENCE', field: 'departmentId', code: 'REFERENCE_INACTIVE' };
    }
  } else {
    // Serviço não é pessoa: fora da busca e recusado como inexistente (sem revelar o vínculo).
    if (target.membership === null || target.membership.type === 'SERVICE') {
      return { kind: 'INVALID_REFERENCE', field: 'userId', code: 'REFERENCE_NOT_FOUND' };
    }
    if (!isMembershipUsable(target.membership, now)) {
      return { kind: 'INVALID_REFERENCE', field: 'userId', code: 'REFERENCE_INACTIVE' };
    }
  }
  if (request.expiresAt !== null && request.expiresAt.getTime() <= now.getTime()) {
    return { kind: 'EXPIRES_IN_PAST' };
  }
  if (request.role === 'CONSULTANT' && target.kind === 'USER') {
    const membership = target.membership;
    if (membership?.type !== 'EXTERNAL') return { kind: 'NOT_ELIGIBLE', reason: 'NOT_EXTERNAL' };
    if (
      membership.expiresAt !== null &&
      request.expiresAt !== null &&
      request.expiresAt.getTime() > membership.expiresAt.getTime()
    ) {
      return { kind: 'NOT_ELIGIBLE', reason: 'EXPIRES_AFTER_MEMBERSHIP' };
    }
  }
  return null;
}

/** Nova participação (PRC-29 ou PRC-31), ainda não gravada. */
export function newParticipant(input: {
  readonly id: string;
  readonly tenantId: string;
  readonly processId: string;
  readonly target: { readonly userId: string } | { readonly departmentId: string };
  readonly role: ParticipantRole;
  readonly notify: boolean;
  readonly expiresAt: Date | null;
  readonly reason: string | null;
  readonly grantedById: string;
  readonly now: Date;
}): ProcessParticipant {
  return {
    id: input.id,
    tenantId: input.tenantId,
    processId: input.processId,
    userId: 'userId' in input.target ? input.target.userId : null,
    departmentId: 'departmentId' in input.target ? input.target.departmentId : null,
    role: input.role,
    notify: input.notify,
    grantedById: input.grantedById,
    grantedAt: input.now,
    // Só o consultor tem validade (RN-PROC-127); os demais papéis valem até a revogação.
    expiresAt: input.role === 'CONSULTANT' ? input.expiresAt : null,
    reason: input.reason,
    revokedAt: null,
    revokedById: null,
    revocationReason: null,
  };
}

/** A participação revogada (PRC-30/PRC-32: pelo usuário; job: `revokedById` nulo = sistema). */
export function revokedParticipant(
  participant: ProcessParticipant,
  input: { readonly at: Date; readonly byUserId: string | null; readonly reason: string | null },
): ProcessParticipant {
  return {
    ...participant,
    revokedAt: input.at,
    revokedById: input.byUserId,
    revocationReason: input.reason,
  };
}

/**
 * RN-PROC-133 — "Deixar de seguir" (PRC-32): sem participação ativa é no-op (204 idempotente);
 * só o papel `OBSERVER` é revogado pelo próprio usuário; os demais exigem quem gerencia (PRC-30).
 */
export type UnfollowDecision = 'NOOP' | 'REVOKE' | 'NOT_OBSERVER';

export function unfollowDecision(own: Pick<ProcessParticipant, 'role'> | null): UnfollowDecision {
  if (own === null) return 'NOOP';
  return own.role === 'OBSERVER' ? 'REVOKE' : 'NOT_OBSERVER';
}

/** Ordem da lista do PRC-28: concessão mais antiga primeiro (desempate pelo id). */
export function compareParticipants(a: ProcessParticipant, b: ProcessParticipant): number {
  return a.grantedAt.getTime() - b.grantedAt.getTime() || a.id.localeCompare(b.id);
}
