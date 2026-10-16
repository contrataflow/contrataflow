import { PERMISSIONS } from '@contrataflow/types';
import type { PermissionCode } from '@contrataflow/types';
import type { MyPermissionsDto, PermissionScopeDto } from '@contrataflow/validation';

import type {
  EffectiveGrant,
  EffectivePermissionsSnapshot,
  EffectiveScope,
} from '#shared/auth/effective-permissions.js';
import type {
  ParticipantRole,
  ProcessAccessTarget,
  ProcessVisibilityScope,
} from '#shared/auth/process-access.js';

import { isEffective } from './role-assignment.js';
import type { AssignmentScope, RoleAssignment } from './role-assignment.js';

/*
 * Permissões efetivas (US-097 · permissions.md §1, §1.1, §4 · DEC-134): cálculo a partir das
 * atribuições e o `EffectivePermissionSet`, que responde se uma permissão cobre um recurso. Regras
 * puras — sem Nest, banco, cache nem contexto de requisição.
 */

/** Permissões por participação no processo (permissions.md §4), somadas às do perfil. */
const OBSERVER: readonly PermissionCode[] = [
  'PROCESS_VIEW',
  'PROCESS_FOLLOW',
  'COMMENT_CREATE',
  'APPROVAL_VIEW',
];
const COLLABORATOR: readonly PermissionCode[] = [
  ...OBSERVER,
  'ATTACHMENT_UPLOAD',
  'DOCUMENT_UPDATE',
  'DFD_UPDATE',
  'ETP_UPDATE',
  'PRICE_RESEARCH_UPDATE',
  'RISK_MANAGE',
  'TERM_UPDATE',
];

export const PARTICIPATION_PERMISSIONS: Readonly<
  Record<ParticipantRole, ReadonlySet<PermissionCode>>
> = {
  OBSERVER: new Set(OBSERVER),
  COLLABORATOR: new Set(COLLABORATOR),
  CONSULTANT: new Set(COLLABORATOR),
};

/** Permissões que aceitam restrição por escopo (catálogo `scopable`). */
const SCOPABLE: ReadonlySet<PermissionCode> = new Set(
  PERMISSIONS.filter((permission) => permission.scopable).map((permission) => permission.code),
);

/** Uma atribuição do vínculo e o perfil dela (`null` = perfil inexistente no tenant). */
export interface AssignedRole {
  readonly assignment: Pick<
    RoleAssignment,
    | 'scopeType'
    | 'scopeOrganizationId'
    | 'scopeDepartmentId'
    | 'includeSubtree'
    | 'validFrom'
    | 'validUntil'
    | 'revokedAt'
  >;
  readonly role: {
    readonly isActive: boolean;
    readonly permissions: readonly PermissionCode[];
  } | null;
}

/** `validFrom ≤ now < validUntil`, não revogada e perfil ativo (permissions.md §1.2). */
export function grantingAssignments(assigned: readonly AssignedRole[], now: Date): AssignedRole[] {
  return assigned.filter(
    (item) => item.role?.isActive === true && isEffective(item.assignment, now),
  );
}

/**
 * Unidades cujas subárvores o cálculo precisa (lidas antes, numa ida ao banco): as de escopo
 * `DEPARTMENT` com subárvore e, havendo `OWN_DEPARTMENTS` com subárvore, as lotações.
 */
export function subtreeRoots(
  granting: readonly AssignedRole[],
  ownDepartmentIds: readonly string[],
): string[] {
  const roots = new Set<string>();
  for (const { assignment } of granting) {
    if (!assignment.includeSubtree) continue;
    if (assignment.scopeType === 'DEPARTMENT' && assignment.scopeDepartmentId !== null) {
      roots.add(assignment.scopeDepartmentId);
    }
    if (assignment.scopeType === 'OWN_DEPARTMENTS') ownDepartmentIds.forEach((id) => roots.add(id));
  }
  return [...roots].sort();
}

export interface BuildEffectivePermissionsInput {
  readonly membershipId: string;
  readonly userId: string;
  /** Atribuições que concedem (já filtradas por `grantingAssignments`). */
  readonly granting: readonly AssignedRole[];
  readonly ownDepartmentIds: readonly string[];
  /** Raiz → ela e as descendentes (`subtreeRoots`). */
  readonly subtrees: ReadonlyMap<string, readonly string[]>;
  readonly headOfDepartmentIds: readonly string[];
  readonly now: Date;
}

const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();

function expand(
  scope: AssignmentScope,
  ownDepartmentIds: readonly string[],
  subtrees: ReadonlyMap<string, readonly string[]>,
): string[] {
  const withSubtree = (id: string) => (scope.includeSubtree ? (subtrees.get(id) ?? [id]) : [id]);
  if (scope.scopeType === 'DEPARTMENT' && scope.scopeDepartmentId !== null) {
    return sorted(withSubtree(scope.scopeDepartmentId));
  }
  if (scope.scopeType === 'OWN_DEPARTMENTS') return sorted(ownDepartmentIds.flatMap(withSubtree));
  return [];
}

/**
 * Retrato das permissões efetivas: atribuições de escopo idêntico agrupadas (união das
 * permissões), unidades de cada escopo expandidas e tudo em ordem estável.
 */
export function buildEffectivePermissions(
  input: BuildEffectivePermissionsInput,
): EffectivePermissionsSnapshot {
  const byScope = new Map<string, { scope: EffectiveScope; permissions: Set<PermissionCode> }>();
  for (const { assignment, role } of input.granting) {
    if (!role) continue;
    const scope: EffectiveScope = {
      type: assignment.scopeType,
      organizationId:
        assignment.scopeType === 'ORGANIZATION' ? assignment.scopeOrganizationId : null,
      departmentId: assignment.scopeType === 'DEPARTMENT' ? assignment.scopeDepartmentId : null,
      includeSubtree:
        assignment.scopeType === 'DEPARTMENT' || assignment.scopeType === 'OWN_DEPARTMENTS'
          ? assignment.includeSubtree
          : false,
      departmentIds: expand(assignment, input.ownDepartmentIds, input.subtrees),
    };
    const key = [scope.type, scope.organizationId, scope.departmentId, scope.includeSubtree].join(
      '|',
    );
    const entry = byScope.get(key) ?? { scope, permissions: new Set<PermissionCode>() };
    role.permissions.forEach((code) => entry.permissions.add(code));
    byScope.set(key, entry);
  }
  // Perfil sem nenhuma concessão não vira escopo vazio no retrato.
  const grants: EffectiveGrant[] = [...byScope.entries()]
    .filter(([, entry]) => entry.permissions.size > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, entry]) => ({ scope: entry.scope, permissions: [...entry.permissions].sort() }));
  return {
    membershipId: input.membershipId,
    userId: input.userId,
    grants,
    ownDepartmentIds: sorted(input.ownDepartmentIds),
    headOfDepartmentIds: sorted(input.headOfDepartmentIds),
    computedAt: input.now.toISOString(),
  };
}

/**
 * Value object das permissões efetivas (`EffectivePermissions(membershipId)`): o retrato guardado
 * no cache e no contexto, com as perguntas que a autorização faz.
 */
export class EffectivePermissionSet {
  constructor(readonly snapshot: EffectivePermissionsSnapshot) {}

  get userId(): string {
    return this.snapshot.userId;
  }

  /** A permissão em algum escopo (`usePermission` · permissões não escopáveis). */
  has(permission: PermissionCode): boolean {
    return this.snapshot.grants.some((grant) => grant.permissions.includes(permission));
  }

  /** Escopos em que a permissão vale. */
  scopesOf(permission: PermissionCode): EffectiveScope[] {
    return this.snapshot.grants
      .filter((grant) => grant.permissions.includes(permission))
      .map((grant) => grant.scope);
  }

  /** A permissão com escopo `TENANT` (vale para todos os processos e unidades). */
  coversTenantWide(permission: PermissionCode): boolean {
    return this.scopesOf(permission).some((scope) => scope.type === 'TENANT');
  }

  /**
   * A permissão cobre a unidade (ex.: unidade solicitante do `PROCESS_CREATE`): `TENANT`, o órgão
   * da unidade (`ORGANIZATION`) ou um escopo de unidade que a contenha. Não escopável = `has`.
   */
  coversDepartment(
    permission: PermissionCode,
    department: { readonly id: string; readonly organizationId: string | null },
  ): boolean {
    if (!SCOPABLE.has(permission)) return this.has(permission);
    return this.scopesOf(permission).some(
      (scope) =>
        scope.type === 'TENANT' ||
        (scope.type === 'ORGANIZATION' && scope.organizationId === department.organizationId) ||
        scope.departmentIds.includes(department.id),
    );
  }

  /**
   * O perfil cobre o processo (permissions.md §1.1): `TENANT`; `ORGANIZATION` do processo; ou
   * escopo de unidade com `ProcessAccess` do processo para alguma unidade dele. Não escopável =
   * `has`.
   */
  roleCoversProcess(
    permission: PermissionCode,
    target: Pick<ProcessAccessTarget, 'organizationId' | 'departmentIds'>,
  ): boolean {
    if (!SCOPABLE.has(permission)) return this.has(permission);
    return this.scopesOf(permission).some(
      (scope) =>
        scope.type === 'TENANT' ||
        (scope.type === 'ORGANIZATION' &&
          target.organizationId !== null &&
          scope.organizationId === target.organizationId) ||
        scope.departmentIds.some((id) => target.departmentIds.includes(id)),
    );
  }

  /** Participação ativa e não expirada concede a permissão NAQUELE processo (FA-02 · §4). */
  participationGrants(
    permission: PermissionCode,
    target: Pick<ProcessAccessTarget, 'participations'>,
    now: Date,
  ): boolean {
    return target.participations.some(
      (participation) =>
        participation.userId === this.snapshot.userId &&
        (participation.expiresAt === null || participation.expiresAt.getTime() > now.getTime()) &&
        PARTICIPATION_PERMISSIONS[participation.role].has(permission),
    );
  }

  /** Escopos de `PROCESS_VIEW` expandidos — entrada do predicado de visibilidade (DEC-024). */
  visibilityScope(): ProcessVisibilityScope {
    const scopes = this.scopesOf('PROCESS_VIEW');
    return {
      userId: this.snapshot.userId,
      tenantWide: scopes.some((scope) => scope.type === 'TENANT'),
      organizationIds: sorted(
        scopes.flatMap((scope) =>
          scope.type === 'ORGANIZATION' && scope.organizationId !== null
            ? [scope.organizationId]
            : [],
        ),
      ),
      departmentIds: sorted(scopes.flatMap((scope) => scope.departmentIds)),
    };
  }

  /** Corpo de ME-03 (RN-IAM-106): permissões em ordem alfabética, escopos sem repetição. */
  toMyPermissions(): MyPermissionsDto {
    const scopesByCode = new Map<string, Map<string, PermissionScopeDto>>();
    for (const grant of this.snapshot.grants) {
      const dto: PermissionScopeDto = {
        type: grant.scope.type,
        ...(grant.scope.organizationId === null
          ? {}
          : { organizationId: grant.scope.organizationId }),
        ...(grant.scope.departmentId === null ? {} : { departmentId: grant.scope.departmentId }),
        includeSubtree: grant.scope.includeSubtree,
      };
      const key = JSON.stringify(dto);
      for (const code of grant.permissions) {
        const scopes = scopesByCode.get(code) ?? new Map<string, PermissionScopeDto>();
        scopes.set(key, dto);
        scopesByCode.set(code, scopes);
      }
    }
    return {
      permissions: [...scopesByCode.keys()].sort().map((code) => ({
        code,
        scopes: [...(scopesByCode.get(code)?.values() ?? [])],
      })),
      implicit: {
        headOfDepartmentIds: [...this.snapshot.headOfDepartmentIds],
        ownDepartmentIds: [...this.snapshot.ownDepartmentIds],
      },
    };
  }
}
