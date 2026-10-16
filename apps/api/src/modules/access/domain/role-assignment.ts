import type { PermissionCode } from '@contrataflow/types';
import {
  ADMINISTRATIVE_PERMISSIONS,
  ROLE_ASSIGNMENT_DEPARTMENT_REQUIRED_MESSAGE,
  ROLE_ASSIGNMENT_ORGANIZATION_REQUIRED_MESSAGE,
  ROLE_ASSIGNMENT_SCOPE_NOT_ALLOWED_MESSAGE,
  ROLE_ASSIGNMENT_VALIDITY_MESSAGE,
  SUBTREE_SCOPE_TYPES,
} from '@contrataflow/validation';

import type { ScopeType } from './role.js';

/*
 * Atribuição de perfil (`RoleAssignment` — entities.md §4.2 · US-096 · DEC-134): liga um vínculo a
 * um perfil num escopo e período de validade. Regras puras de RN-IAM-89..97 e POL-12/13/15/16 — sem
 * Nest, Prisma nem contexto de requisição.
 */

export interface AssignmentScope {
  readonly scopeType: ScopeType;
  readonly scopeOrganizationId: string | null;
  readonly scopeDepartmentId: string | null;
  readonly includeSubtree: boolean;
}

export interface RoleAssignment extends AssignmentScope {
  readonly id: string;
  readonly tenantId: string;
  readonly membershipId: string;
  readonly roleId: string;
  readonly validFrom: Date;
  readonly validUntil: Date | null;
  readonly grantedById: string;
  readonly reason: string | null;
  readonly revokedAt: Date | null;
  readonly revokedById: string | null;
  readonly revocationReason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly version: number;
}

export interface AssignmentFieldError {
  readonly field: string;
  readonly code: 'CONDITIONAL_REQUIRED' | 'NOT_ALLOWED' | 'OUT_OF_RANGE';
  readonly message: string;
}

/** V-02/V-04: corpo incoerente com o escopo ou vigência fora do intervalo (422). */
export class AssignmentValidationError extends Error {
  constructor(readonly errors: readonly AssignmentFieldError[]) {
    super('Atribuição de perfil inválida.');
    this.name = 'AssignmentValidationError';
  }
}

/** ROL-12 sobre atribuição já revogada. */
export class AssignmentAlreadyRevokedError extends Error {
  constructor() {
    super('Atribuição de perfil já revogada.');
    this.name = 'AssignmentAlreadyRevokedError';
  }
}

export interface GrantInput {
  readonly membershipId: string;
  readonly roleId: string;
  readonly scopeType: ScopeType;
  readonly scopeOrganizationId?: string | null | undefined;
  readonly scopeDepartmentId?: string | null | undefined;
  readonly includeSubtree?: boolean | undefined;
  readonly validFrom?: Date | undefined;
  readonly validUntil?: Date | null | undefined;
}

export interface GrantContext {
  readonly id: string;
  readonly tenantId: string;
  readonly now: Date;
  /** Quem concede (`grantedById`). */
  readonly userId: string;
  /** Vínculo de destino: externo tem a vigência limitada pela validade do vínculo (RN-IAM-93). */
  readonly membership: {
    readonly type: 'INTERNAL' | 'EXTERNAL' | 'SERVICE';
    readonly expiresAt: Date | null;
  };
}

/** RN-IAM-89: órgão só em `ORGANIZATION`, unidade só em `DEPARTMENT`, obrigatórios neles. */
export function scopeShapeErrors(input: GrantInput): AssignmentFieldError[] {
  const organization = input.scopeOrganizationId ?? null;
  const department = input.scopeDepartmentId ?? null;
  const errors: AssignmentFieldError[] = [];
  if (input.scopeType === 'ORGANIZATION' && organization === null) {
    errors.push({
      field: 'scopeOrganizationId',
      code: 'CONDITIONAL_REQUIRED',
      message: ROLE_ASSIGNMENT_ORGANIZATION_REQUIRED_MESSAGE,
    });
  }
  if (input.scopeType === 'DEPARTMENT' && department === null) {
    errors.push({
      field: 'scopeDepartmentId',
      code: 'CONDITIONAL_REQUIRED',
      message: ROLE_ASSIGNMENT_DEPARTMENT_REQUIRED_MESSAGE,
    });
  }
  if (input.scopeType !== 'ORGANIZATION' && organization !== null) {
    errors.push({
      field: 'scopeOrganizationId',
      code: 'NOT_ALLOWED',
      message: ROLE_ASSIGNMENT_SCOPE_NOT_ALLOWED_MESSAGE,
    });
  }
  if (input.scopeType !== 'DEPARTMENT' && department !== null) {
    errors.push({
      field: 'scopeDepartmentId',
      code: 'NOT_ALLOWED',
      message: ROLE_ASSIGNMENT_SCOPE_NOT_ALLOWED_MESSAGE,
    });
  }
  return errors;
}

/**
 * RN-IAM-93: `validFrom` padrão agora; `validUntil` (se houver) > `validFrom`; no vínculo
 * `EXTERNAL`, a vigência não passa da validade do vínculo (`expiresAt`).
 */
export function validityErrors(
  validFrom: Date,
  validUntil: Date | null,
  membership: GrantContext['membership'],
): AssignmentFieldError[] {
  const outOfRange = (field: string): AssignmentFieldError => ({
    field,
    code: 'OUT_OF_RANGE',
    message: ROLE_ASSIGNMENT_VALIDITY_MESSAGE,
  });
  if (validUntil !== null && validUntil.getTime() <= validFrom.getTime()) {
    return [outOfRange('validUntil')];
  }
  const limit = membership.type === 'EXTERNAL' ? membership.expiresAt : null;
  if (limit === null) return [];
  if (validFrom.getTime() >= limit.getTime()) return [outOfRange('validFrom')];
  if (validUntil !== null && validUntil.getTime() > limit.getTime()) {
    return [outOfRange('validUntil')];
  }
  return [];
}

/**
 * `RoleAssignment.grant` (RN-IAM-89/93): normaliza o escopo (`includeSubtree` padrão `true` em
 * `DEPARTMENT`/`OWN_DEPARTMENTS`; irrelevante — gravado `true` — nos demais) e a vigência.
 * Referências, POL-13/15 e duplicidade dependem de leitura e ficam no caso de uso.
 * @throws AssignmentValidationError
 */
export function grantRoleAssignment(input: GrantInput, context: GrantContext): RoleAssignment {
  const validFrom = input.validFrom ?? context.now;
  const validUntil = input.validUntil ?? null;
  const errors = [
    ...scopeShapeErrors(input),
    ...validityErrors(validFrom, validUntil, context.membership),
  ];
  if (errors.length > 0) throw new AssignmentValidationError(errors);
  const subtree = SUBTREE_SCOPE_TYPES.includes(input.scopeType);
  return {
    id: context.id,
    tenantId: context.tenantId,
    membershipId: input.membershipId,
    roleId: input.roleId,
    scopeType: input.scopeType,
    scopeOrganizationId:
      input.scopeType === 'ORGANIZATION' ? (input.scopeOrganizationId ?? null) : null,
    scopeDepartmentId: input.scopeType === 'DEPARTMENT' ? (input.scopeDepartmentId ?? null) : null,
    includeSubtree: subtree ? (input.includeSubtree ?? true) : true,
    validFrom,
    validUntil,
    grantedById: context.userId,
    reason: null,
    revokedAt: null,
    revokedById: null,
    revocationReason: null,
    createdAt: context.now,
    updatedAt: context.now,
    version: 1,
  };
}

/** Concede permissões agora: não revogada e `validFrom ≤ now < validUntil` (FA-02 · RN-IAM-95). */
export function isEffective(
  assignment: Pick<RoleAssignment, 'revokedAt' | 'validFrom' | 'validUntil'>,
  now: Date,
): boolean {
  return (
    assignment.revokedAt === null &&
    assignment.validFrom.getTime() <= now.getTime() &&
    (assignment.validUntil === null || assignment.validUntil.getTime() > now.getTime())
  );
}

/**
 * `RoleAssignment.revoke` (RN-IAM-95): grava quando, quem e o motivo (vazio → `null`); a linha
 * continua no histórico.
 * @throws AssignmentAlreadyRevokedError
 */
export function revokeRoleAssignment(
  assignment: RoleAssignment,
  data: { readonly now: Date; readonly userId: string; readonly reason: string | null | undefined },
): RoleAssignment {
  if (assignment.revokedAt !== null) throw new AssignmentAlreadyRevokedError();
  const reason = data.reason?.trim() ?? '';
  return {
    ...assignment,
    revokedAt: data.now,
    revokedById: data.userId,
    revocationReason: reason === '' ? null : reason,
    updatedAt: data.now,
    version: assignment.version + 1,
  };
}

/** RN-IAM-94: a mesma atribuição ativa — `(vínculo, perfil, escopo, órgão, unidade)`. */
export function sameAssignment(
  a: Pick<
    RoleAssignment,
    'membershipId' | 'roleId' | 'scopeType' | 'scopeOrganizationId' | 'scopeDepartmentId'
  >,
  b: Pick<
    RoleAssignment,
    'membershipId' | 'roleId' | 'scopeType' | 'scopeOrganizationId' | 'scopeDepartmentId'
  >,
): boolean {
  return (
    a.membershipId === b.membershipId &&
    a.roleId === b.roleId &&
    a.scopeType === b.scopeType &&
    a.scopeOrganizationId === b.scopeOrganizationId &&
    a.scopeDepartmentId === b.scopeDepartmentId
  );
}

// --- POL-13 (anti-escalonamento) --------------------------------------------------------------

/** Unidade na árvore: órgão e caminho da raiz até ela (inclusive). */
export interface DepartmentNode {
  readonly organizationId: string;
  readonly pathIds: readonly string[];
}

export type DepartmentLookup = (departmentId: string) => DepartmentNode | undefined;

/**
 * O escopo concedido ao ator cobre o pedido ("igual ou mais amplo" — POL-13): `TENANT` cobre tudo;
 * o órgão cobre a si e as unidades dele; a unidade cobre a si (e, com subárvore, as descendentes —
 * pedir subárvore exige tê-la); `OWN_DEPARTMENTS` só cobre `OWN_DEPARTMENTS` (as lotações do alvo
 * podem estar em qualquer órgão).
 */
export function scopeCovers(
  granted: AssignmentScope,
  requested: AssignmentScope,
  departments: DepartmentLookup,
): boolean {
  switch (granted.scopeType) {
    case 'TENANT':
      return true;
    case 'ORGANIZATION':
      if (requested.scopeType === 'ORGANIZATION') {
        return requested.scopeOrganizationId === granted.scopeOrganizationId;
      }
      if (requested.scopeType === 'DEPARTMENT' && requested.scopeDepartmentId !== null) {
        return (
          departments(requested.scopeDepartmentId)?.organizationId === granted.scopeOrganizationId
        );
      }
      return false;
    case 'DEPARTMENT': {
      if (requested.scopeType !== 'DEPARTMENT' || requested.scopeDepartmentId === null) {
        return false;
      }
      if (requested.scopeDepartmentId === granted.scopeDepartmentId) {
        return granted.includeSubtree || !requested.includeSubtree;
      }
      const path = departments(requested.scopeDepartmentId)?.pathIds ?? [];
      return granted.includeSubtree && path.includes(granted.scopeDepartmentId ?? '');
    }
    case 'OWN_DEPARTMENTS':
      return (
        requested.scopeType === 'OWN_DEPARTMENTS' &&
        (granted.includeSubtree || !requested.includeSubtree)
      );
  }
}

/** Uma atribuição vigente do ator: as permissões ATUAIS do perfil e o escopo concedido. */
export interface ScopedGrant {
  readonly scope: AssignmentScope;
  readonly permissions: ReadonlySet<PermissionCode>;
}

export interface AssignmentActor {
  /** `ADMIN_ORGAO` vigente: isento de POL-13 (permissions.md §4). */
  readonly isTenantAdmin: boolean;
  readonly grants: readonly ScopedGrant[];
}

/**
 * POL-13 (RN-IAM-91): permissões do perfil que o ator NÃO tem num escopo que cubra o pedido. Vazio
 * = pode atribuir.
 */
export function escalatedPermissions(
  required: readonly PermissionCode[],
  requested: AssignmentScope,
  actor: AssignmentActor,
  departments: DepartmentLookup,
): PermissionCode[] {
  if (actor.isTenantAdmin) return [];
  const covering = actor.grants.filter((grant) => scopeCovers(grant.scope, requested, departments));
  return required.filter((code) => !covering.some((grant) => grant.permissions.has(code)));
}

/** Escopo amplo do tenant — usado para as chaves do contexto sem atribuição gravada (ponte). */
export const TENANT_SCOPE: AssignmentScope = {
  scopeType: 'TENANT',
  scopeOrganizationId: null,
  scopeDepartmentId: null,
  includeSubtree: true,
};

// --- POL-15/16 ---------------------------------------------------------------------------------

/** POL-15 (RN-IAM-92): vínculo `EXTERNAL` só recebe perfil com `allowExternalAssignment`. */
export function externalAssignmentForbidden(
  membershipType: GrantContext['membership']['type'],
  role: { readonly allowExternalAssignment: boolean },
): boolean {
  return membershipType === 'EXTERNAL' && !role.allowExternalAssignment;
}

const ADMINISTRATIVE: ReadonlySet<string> = new Set(ADMINISTRATIVE_PERMISSIONS);

/** Perfil administrativo para a autoproteção (POL-16): concede gestão de acessos. */
export function isAdministrativeRole(permissions: Iterable<PermissionCode>): boolean {
  for (const code of permissions) if (ADMINISTRATIVE.has(code)) return true;
  return false;
}

/**
 * POL-16 (RN-IAM-97): o ator revogando a própria atribuição administrativa quando não lhe resta
 * outra atribuição administrativa vigente.
 */
export function violatesSelfProtection(input: {
  readonly targetMembershipId: string;
  readonly actorMembershipId: string | null;
  readonly targetIsAdministrative: boolean;
  readonly otherAdministrativeEffective: number;
}): boolean {
  return (
    input.actorMembershipId === input.targetMembershipId &&
    input.targetIsAdministrative &&
    input.otherAdministrativeEffective === 0
  );
}
