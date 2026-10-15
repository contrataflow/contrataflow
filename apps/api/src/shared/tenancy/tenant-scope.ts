import { SetMetadata } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

/**
 * Classificação obrigatória de toda rota quanto ao tenant (US-100 · FA-01 · RN-TEN-19):
 * - `TENANT` — exige `X-Tenant-Id` e vínculo ativo; abre o contexto do tenant (padrão de negócio).
 * - `PLATFORM` — `/platform/*` (US-099): operador da plataforma, sem tenant ativo.
 * - `NONE` — sem tenant e sem dados de tenant (`/health/*`, `/metrics`).
 * - `CROSS_TENANT_LOOKUP` — leitura controlada entre tenants do próprio usuário (ME-04, aceite de
 *   convite USR-06, início de sessão do BFF), só por funções `SECURITY DEFINER` (FA-05).
 * Rota sem declaração reprova o build (meta-teste `src/openapi/tenant-scope.spec.ts`); em tempo
 * de execução, a ausência é tratada como `TENANT` (falha fechada).
 */
export type TenantScopeKind = 'TENANT' | 'PLATFORM' | 'NONE' | 'CROSS_TENANT_LOOKUP';

export const TENANT_SCOPES: readonly TenantScopeKind[] = [
  'TENANT',
  'PLATFORM',
  'NONE',
  'CROSS_TENANT_LOOKUP',
];

export const TENANT_SCOPE_METADATA = 'cf:tenancy:scope';
export const OFFBOARDING_EXPORT_METADATA = 'cf:tenancy:offboarding-export';

/** Declara o escopo de tenant da rota (no método ou no controller; o do método prevalece). */
export const TenantScope = (scope: TenantScopeKind): MethodDecorator & ClassDecorator =>
  SetMetadata(TENANT_SCOPE_METADATA, scope);

/**
 * Comando de exportação permitido numa instituição em `OFFBOARDING` (RN-TEN-37 · DEC-132): no MVP 1,
 * DOC-20, DOC-21, DOC-23, ATT-05, AUD-03, PRS-22 e PRC-34. Os demais métodos mutáveis respondem 403
 * `TENANT_SUSPENDED` com `accessMode = READ_EXPORT`.
 */
export const OffboardingExport = (): MethodDecorator =>
  SetMetadata(OFFBOARDING_EXPORT_METADATA, true);

/** Escopo declarado da rota em execução (`undefined` se não declarado). */
export function declaredTenantScope(
  reflector: Reflector,
  context: ExecutionContext,
): TenantScopeKind | undefined {
  return reflector.getAllAndOverride<TenantScopeKind | undefined>(TENANT_SCOPE_METADATA, [
    context.getHandler(),
    context.getClass(),
  ]);
}

/** Escopo efetivo: o declarado ou `TENANT` (falha fechada para rota sem declaração). */
export function effectiveTenantScope(
  reflector: Reflector,
  context: ExecutionContext,
): TenantScopeKind {
  return declaredTenantScope(reflector, context) ?? 'TENANT';
}

/** A rota é um comando de exportação liberado em `OFFBOARDING`? */
export function isOffboardingExport(reflector: Reflector, context: ExecutionContext): boolean {
  return (
    reflector.getAllAndOverride<boolean | undefined>(OFFBOARDING_EXPORT_METADATA, [
      context.getHandler(),
      context.getClass(),
    ]) === true
  );
}

/** Escopo declarado num handler/controller sem `ExecutionContext` (meta-testes e OpenAPI). */
export function tenantScopeOf(handler: object, controller: object): TenantScopeKind | undefined {
  return (Reflect.getMetadata(TENANT_SCOPE_METADATA, handler) ??
    Reflect.getMetadata(TENANT_SCOPE_METADATA, controller)) as TenantScopeKind | undefined;
}
