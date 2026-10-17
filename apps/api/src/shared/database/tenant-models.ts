/*
 * Modelos Prisma com e sem `tenantId` (US-100 · RN-TEN-24). A lista é versionada e conferida com
 * `prisma/schema.prisma` a cada execução dos testes (`tenant-models.spec.ts`): modelo novo com
 * `tenantId` que não esteja aqui — ou modelo sem `tenantId` fora da lista fechada de plataforma
 * (DEC-080) — reprova o CI. Para atualizar, acrescente o modelo à lista certa no mesmo PR da
 * migração.
 */

/** Modelos de tenant: a extensão injeta e confere `tenantId` em toda operação (RN-TEN-23). */
export const TENANT_SCOPED_MODELS = [
  'AiGeneration',
  'Approval',
  'ApprovalDocument',
  'AuditLog',
  'AuditSeal',
  'CatalogItem',
  'Department',
  'Document',
  'DocumentTemplate',
  'DocumentTemplateVersion',
  'DocumentType',
  'DocumentVersion',
  'Holiday',
  'MembershipDepartment',
  'NumberSequence',
  'Organization',
  'Notification',
  'NotificationPreference',
  'OutboxEvent',
  'Process',
  'ProcessAccess',
  'ProcessAssignment',
  'ProcessMovement',
  'ProcessStage',
  'ProcessTimelineEntry',
  'Role',
  'RoleAssignment',
  'RolePermission',
  'Supplier',
  'TenantMembership',
  'TenantSetting',
  'Workflow',
  'WorkflowRule',
  'WorkflowStage',
  'WorkflowTransition',
  'WorkflowVersion',
] as const;

/**
 * Modelos de plataforma (DEC-080, lista fechada): sem `tenantId`, acessados só pelos adaptadores
 * autorizados (`PlatformTransaction`/`SystemDbService`). `Permission` é o catálogo global (US-094),
 * lido em tempo de execução a partir de `@contrataflow/types`.
 */
export const PLATFORM_MODELS = ['Permission', 'Tenant', 'User'] as const;

export type TenantScopedModel = (typeof TENANT_SCOPED_MODELS)[number];

const tenantScoped: ReadonlySet<string> = new Set(TENANT_SCOPED_MODELS);
const platform: ReadonlySet<string> = new Set(PLATFORM_MODELS);

export function isTenantScopedModel(model: string): boolean {
  return tenantScoped.has(model);
}

export function isPlatformModel(model: string): boolean {
  return platform.has(model);
}

export interface SchemaModels {
  /** Modelos com o campo `tenantId`, em ordem alfabética. */
  readonly tenantScoped: readonly string[];
  /** Modelos sem `tenantId`, em ordem alfabética. */
  readonly withoutTenant: readonly string[];
}

/** Lê os modelos do schema Prisma e separa os que têm `tenantId` (fonte da lista acima). */
export function modelsFromSchema(schema: string): SchemaModels {
  const tenantScopedModels: string[] = [];
  const withoutTenant: string[] = [];
  for (const match of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const [, name = '', body = ''] = match;
    if (/^\s*tenantId\s/m.test(body)) tenantScopedModels.push(name);
    else withoutTenant.push(name);
  }
  return { tenantScoped: tenantScopedModels.sort(), withoutTenant: withoutTenant.sort() };
}
