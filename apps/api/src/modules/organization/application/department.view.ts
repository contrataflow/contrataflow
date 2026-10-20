import type { DepartmentDto, DepartmentLookupItem } from '@contrataflow/validation';

import { isSecretariat } from '../domain/department.js';
import type { Department } from '../domain/department.js';

/** `Department` da resposta de DEP-01 e DEP-03..08. */
export function toDepartmentDto(department: Department): DepartmentDto {
  return {
    id: department.id,
    organizationId: department.organizationId,
    parentId: department.parentId,
    type: department.type,
    name: department.name,
    acronym: department.acronym,
    code: department.code,
    email: department.email,
    phone: department.phone,
    headUserId: department.headUserId,
    deputyUserId: department.deputyUserId,
    isActive: department.isActive,
    isSecretariat: isSecretariat(department),
    sortOrder: department.sortOrder,
    path: department.path,
    depth: department.depth,
    createdAt: department.createdAt.toISOString(),
    updatedAt: department.updatedAt.toISOString(),
    version: department.version,
  };
}

/** Item do DEP-02. */
export function toDepartmentLookupItem(department: Department): DepartmentLookupItem {
  return { id: department.id, name: department.name, type: department.type, path: department.path };
}
