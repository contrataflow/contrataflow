/**
 * Catálogo de permissões (`RESOURCE_ACTION` — DEC-001), fonte única para api e web.
 * Preenchido pela story dona do RBAC a partir de docs/mvp-01/permissions.md.
 */
export const PERMISSION_CODES = [] as const satisfies readonly string[];

export type PermissionCode = (typeof PERMISSION_CODES)[number];
