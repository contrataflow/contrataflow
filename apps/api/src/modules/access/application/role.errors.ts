import type { PermissionCode } from '@contrataflow/types';
import type { RoleDto, RoleWithPermissionsDto } from '@contrataflow/validation';
import type { Logger } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import type { Counter } from '@opentelemetry/api';

import { ApiError, validationError } from '#shared/errors/api-error.js';

import type { Role } from '../domain/role.js';

/** 404 de perfil inexistente ou de outro tenant (indistinguíveis). */
export function roleNotFound(): ApiError {
  return new ApiError('ROLE_NOT_FOUND');
}

/** V-02 · RN-IAM-87: nome (sem distinção de maiúsculas) ou chave gerada já usados no tenant. */
export function roleAlreadyExists(): ApiError {
  return new ApiError('ROLE_ALREADY_EXISTS');
}

/** Nome sem letras nem dígitos: não há de onde gerar a chave (RN-IAM-80). */
export function roleKeyUnderivable(): ApiError {
  return validationError([
    {
      field: 'name',
      code: 'INVALID_FORMAT',
      message: 'Informe um nome com letras ou números.',
    },
  ]);
}

/** V-04 · POL-13: as permissões que o ator tentou conceder sem possuí-las. */
export function privilegeEscalation(permissions: readonly PermissionCode[]): ApiError {
  return new ApiError('PRIVILEGE_ESCALATION_FORBIDDEN', {
    extensions: { permissions: [...permissions] },
  });
}

export const PROTECTED_PERMISSION_MESSAGE =
  'Esta permissão é protegida e não pode ser removida do Administrador do órgão.';

/** V-05 · RN-IAM-82: 422 com uma violação por permissão protegida removida. */
export function protectedPermissionRemoval(permissions: readonly PermissionCode[]): ApiError {
  return new ApiError('BUSINESS_RULE_VIOLATION', {
    detail: PROTECTED_PERMISSION_MESSAGE,
    violations: permissions.map((permission) => ({
      code: 'ROLE_PROTECTED_PERMISSION',
      severity: 'BLOCKING',
      message: PROTECTED_PERMISSION_MESSAGE,
      ruleId: null,
      sectionKey: null,
      field: 'permissions',
      itemId: null,
      params: { permission },
    })),
  });
}

/** V-06 · POL-12. */
export function lastAdminRequired(): ApiError {
  return new ApiError('LAST_ADMIN_REQUIRED');
}

/** V-07 · RN-IAM-83: o BFF dispara o *step-up* (`/api/auth/step-up`). */
export function externalAssignmentMfaRequired(): ApiError {
  return new ApiError('MFA_REQUIRED', {
    detail: 'Confirme sua identidade para continuar.',
    auditReasonCode: 'MFA_REQUIRED',
  });
}

/** FA-04: desativação com vínculos ativos sem `confirmDeactivate: true`. */
export function deactivationNotConfirmed(activeAssignments: number): ApiError {
  return validationError([
    {
      field: 'confirmDeactivate',
      code: 'REQUIRED',
      message: `Confirme a desativação: ${activeAssignments} vínculo(s) ativo(s) deixarão de receber as permissões deste perfil.`,
    },
  ]);
}

/** V-09: 412 com a versão atual do perfil (`currentVersion`) para o cliente recarregar. */
export function versionConflict(currentVersion: number): ApiError {
  return new ApiError('VERSION_CONFLICT', {
    detail: 'Este perfil foi alterado por outra pessoa. Recarregue para ver a versão atual.',
    extensions: { currentVersion },
  });
}

/**
 * `error` `role.update_failed`: só falha de gravação (erro inesperado ou dependência fora); regra
 * de negócio, autorização e validação (4xx) não entram. Nunca a lista de permissões.
 */
export function logRoleFailure(logger: Logger, error: unknown, correlationId: string): void {
  const code = error instanceof ApiError ? error.code : null;
  if (code !== null && code !== 'DEPENDENCY_UNAVAILABLE' && code !== 'INTERNAL_ERROR') return;
  logger.error(
    {
      event: 'role.update_failed',
      errorCode: code ?? 'INTERNAL_ERROR',
      cause: error instanceof Error ? error.name : 'unknown',
      correlationId,
    },
    'role.update_failed',
  );
}

export type RoleOperation = 'create' | 'update' | 'permissions' | 'duplicate' | 'deactivate';

let roleChanges: Counter | undefined;

/** `access_role_changes_total{operation}` — mutações de perfil confirmadas (US-095 · DoD). */
export function countRoleChange(operation: RoleOperation): void {
  roleChanges ??= metrics.getMeter('contrataflow-api').createCounter('access_role_changes_total', {
    description: 'Mutações de perfil confirmadas, por operação.',
  });
  roleChanges.add(1, { operation });
}

/** `Role` da resposta; `permissions` só em ROL-04/06. */
export function toRoleDto(role: Role, activeAssignmentsCount: number): RoleDto;
export function toRoleDto(
  role: Role,
  activeAssignmentsCount: number,
  permissions: readonly PermissionCode[],
): RoleWithPermissionsDto;
export function toRoleDto(
  role: Role,
  activeAssignmentsCount: number,
  permissions?: readonly PermissionCode[],
): RoleDto {
  return {
    id: role.id,
    key: role.key,
    name: role.name,
    description: role.description,
    isSystem: role.isSystem,
    isProtected: role.isProtected,
    allowExternalAssignment: role.allowExternalAssignment,
    isActive: role.isActive,
    activeAssignmentsCount,
    ...(permissions === undefined ? {} : { permissions: [...permissions] }),
    createdAt: role.createdAt.toISOString(),
    updatedAt: role.updatedAt.toISOString(),
    version: role.version,
  };
}
