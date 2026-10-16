import {
  MEMBERSHIP_DEPARTMENT_INVALID_MESSAGE,
  membershipValidityMessage,
} from '@contrataflow/validation';
import type { FieldError, MembershipAction } from '@contrataflow/validation';

import type { MembershipStatus } from '#shared/auth/ports.js';

import type { MembershipType } from './tenant-membership.js';

/*
 * Regras puras da gestão de vínculos (US-092 · RN-IAM-54..64 · POL-12/16): transições de status,
 * autoproteção, anti-bloqueio, validação de lotação e da validade do `EXTERNAL`, diff dos campos
 * editáveis e as ações disponíveis no detalhe. Sem I/O: o serviço de aplicação lê, trava e grava.
 */

const DAY_MS = 24 * 3_600_000;

/** Transições de status de USR-10/11/12. */
export type MembershipTransition = 'SUSPEND' | 'REACTIVATE' | 'REVOKE';

/** RN-IAM-57/58/59: de onde cada transição parte. */
const TRANSITION_FROM: Readonly<Record<MembershipTransition, readonly MembershipStatus[]>> = {
  SUSPEND: ['ACTIVE'],
  REACTIVATE: ['SUSPENDED'],
  REVOKE: ['INVITED', 'ACTIVE', 'SUSPENDED', 'EXPIRED'],
};

const TRANSITION_TO: Readonly<Record<MembershipTransition, MembershipStatus>> = {
  SUSPEND: 'SUSPENDED',
  REACTIVATE: 'ACTIVE',
  REVOKE: 'REVOKED',
};

export function transitionSources(action: MembershipTransition): readonly MembershipStatus[] {
  return TRANSITION_FROM[action];
}

export function transitionTarget(action: MembershipTransition): MembershipStatus {
  return TRANSITION_TO[action];
}

/** A transição é válida a partir do status atual (senão 409 `INVALID_STATE`). */
export function canTransition(action: MembershipTransition, status: MembershipStatus): boolean {
  return TRANSITION_FROM[action].includes(status);
}

/** Suspender e revogar tiram o acesso: sujeitos a POL-12 e POL-16. */
export function removesAccess(action: MembershipTransition): boolean {
  return action !== 'REACTIVATE';
}

/** POL-16: ninguém suspende/revoga o próprio vínculo. */
export function violatesSelfProtection(
  action: MembershipTransition,
  targetMembershipId: string,
  actorMembershipId: string | null,
): boolean {
  return removesAccess(action) && actorMembershipId === targetMembershipId;
}

/**
 * POL-12: o alvo é um dos administradores ativos (lidos sob trava) e é o único — tirá-lo deixaria
 * o tenant sem `ADMIN_ORGAO` `ACTIVE`.
 */
export function violatesLastAdmin(
  targetMembershipId: string,
  activeAdminMembershipIds: readonly string[],
): boolean {
  return (
    activeAdminMembershipIds.includes(targetMembershipId) &&
    activeAdminMembershipIds.every((id) => id === targetMembershipId)
  );
}

/** Ações do detalhe (`meta.allowedActions` · api.md §1.5): status, POL-16 e `USER_MANAGE`. */
export function allowedMembershipActions(input: {
  readonly status: MembershipStatus;
  readonly canManage: boolean;
  readonly isSelf: boolean;
}): MembershipAction[] {
  if (!input.canManage) return [];
  const actions: MembershipAction[] = [];
  if (input.status !== 'REVOKED') actions.push('UPDATE', 'UPDATE_DEPARTMENTS');
  if (!input.isSelf && canTransition('SUSPEND', input.status)) actions.push('SUSPEND');
  if (canTransition('REACTIVATE', input.status)) actions.push('REACTIVATE');
  if (!input.isSelf && canTransition('REVOKE', input.status)) actions.push('REVOKE');
  return actions;
}

/** V-02 · RN-IAM-55: hoje < validade ≤ hoje + `security.externalMembershipMaxDays`. */
export function membershipValidityError(
  expiresAt: Date,
  now: Date,
  maxDays: number,
): FieldError | null {
  const inRange =
    expiresAt.getTime() > now.getTime() && expiresAt.getTime() <= now.getTime() + maxDays * DAY_MS;
  return inRange
    ? null
    : { field: 'expiresAt', code: 'OUT_OF_RANGE', message: membershipValidityMessage(maxDays) };
}

/** RN-IAM-55: só o `EXTERNAL` tem validade editável. */
export function validityNotAllowedError(type: MembershipType): FieldError | null {
  return type === 'EXTERNAL'
    ? null
    : {
        field: 'expiresAt',
        code: 'NOT_ALLOWED',
        message: 'Somente vínculos externos têm validade.',
      };
}

/** V-03 · RN-IAM-56: toda unidade existe no tenant e está ativa. */
export function departmentReferenceErrors(
  departmentIds: readonly string[],
  departments: ReadonlyMap<string, { readonly isActive: boolean }>,
): FieldError[] {
  for (const id of departmentIds) {
    const department = departments.get(id);
    if (!department?.isActive) {
      return [
        {
          field: 'departmentIds',
          code: department ? 'REFERENCE_INACTIVE' : 'REFERENCE_NOT_FOUND',
          message: MEMBERSHIP_DEPARTMENT_INVALID_MESSAGE,
        },
      ];
    }
  }
  return [];
}

/** A principal primeiro (a persistência marca `isPrimary` na primeira posição). */
export function primaryFirst(departmentIds: readonly string[], primaryId: string): string[] {
  return [primaryId, ...departmentIds.filter((id) => id !== primaryId)];
}

/** Mesmo conjunto e mesma principal: nada a gravar. */
export function sameDepartments(current: readonly string[], next: readonly string[]): boolean {
  return (
    current[0] === next[0] &&
    current.length === next.length &&
    next.every((id) => current.includes(id))
  );
}

export interface MembershipProfile {
  readonly jobTitle: string | null;
  readonly registrationNumber: string | null;
  readonly expiresAt: Date | null;
}

export interface ProfileChange {
  readonly path: 'jobTitle' | 'registrationNumber' | 'expiresAt';
  readonly old: string | null;
  readonly new: string | null;
}

/** Texto vazio limpa o campo (`null`). */
function normalized(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  return value === null || value.length === 0 ? null : value;
}

/**
 * Diff do USR-08: só os campos informados que mudaram (a auditoria grava `changes` e o evento os
 * nomes em `changedFields`).
 */
export function profileChanges(
  current: MembershipProfile,
  patch: {
    readonly jobTitle?: string | null | undefined;
    readonly registrationNumber?: string | null | undefined;
    readonly expiresAt?: Date | undefined;
  },
): ProfileChange[] {
  const changes: ProfileChange[] = [];
  const jobTitle = normalized(patch.jobTitle);
  if (jobTitle !== undefined && jobTitle !== current.jobTitle) {
    changes.push({ path: 'jobTitle', old: current.jobTitle, new: jobTitle });
  }
  const registrationNumber = normalized(patch.registrationNumber);
  if (registrationNumber !== undefined && registrationNumber !== current.registrationNumber) {
    changes.push({
      path: 'registrationNumber',
      old: current.registrationNumber,
      new: registrationNumber,
    });
  }
  if (
    patch.expiresAt !== undefined &&
    patch.expiresAt.getTime() !== (current.expiresAt?.getTime() ?? null)
  ) {
    changes.push({
      path: 'expiresAt',
      old: current.expiresAt?.toISOString() ?? null,
      new: patch.expiresAt.toISOString(),
    });
  }
  return changes;
}
