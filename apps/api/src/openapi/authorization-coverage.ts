import { isPolicyId } from '@contrataflow/types';
import type { PolicyId } from '@contrataflow/types';
import type { Type } from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';

import { policyIdOf, routeAuthorizationOf } from '#shared/auth/authorization.js';
import type { PermissionRequirement } from '#shared/auth/authorization.js';
import { tenantScopeOf } from '#shared/tenancy/tenant-scope.js';
import type { TenantScopeKind } from '#shared/tenancy/tenant-scope.js';

/*
 * Meta-teste de autorização das rotas (US-097 · RN-IAM-101 · V-07 · permissions.md §10): toda rota
 * mutável (POST/PUT/PATCH/DELETE) declara `@RequirePermission` (com `@Policy`, quando aplicável) ou
 * consta como capacidade implícita (`@ImplicitAccess`, com motivo); as rotas `/platform/*` são
 * guardadas pelo `PlatformOperatorGuard` (permissions.md §8). Rota nova sem declaração reprova o
 * build antes de chegar à produção (FA-04).
 */

const METHOD_METADATA = 'method';
const PATH_METADATA = 'path';
const MUTABLE: ReadonlySet<RequestMethod> = new Set([
  RequestMethod.POST,
  RequestMethod.PUT,
  RequestMethod.PATCH,
  RequestMethod.DELETE,
]);
const MIN_REASON_LENGTH = 20;

export interface RouteAuthorizationEntry {
  /** `Controller.handler (MÉTODO caminho)`. */
  readonly label: string;
  readonly method: RequestMethod;
  readonly mutable: boolean;
  readonly tenantScope: TenantScopeKind;
  readonly requirement: PermissionRequirement | undefined;
  readonly policies: readonly string[];
  readonly implicitReason: string | undefined;
}

/** Todas as rotas HTTP dos controllers com a autorização declarada. */
export function routeAuthorizations(controllers: readonly Type[]): RouteAuthorizationEntry[] {
  const entries: RouteAuthorizationEntry[] = [];
  for (const controller of controllers) {
    const prototype = controller.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(prototype)) {
      const handler = prototype[name];
      if (name === 'constructor' || typeof handler !== 'function') continue;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      if (method === undefined) continue;
      const path = String(Reflect.getMetadata(PATH_METADATA, handler) ?? '');
      const declared = routeAuthorizationOf(handler, controller);
      entries.push({
        label: `${controller.name}.${name} (${RequestMethod[method]} ${path})`,
        method,
        mutable: MUTABLE.has(method),
        tenantScope: tenantScopeOf(handler, controller) ?? 'TENANT',
        requirement: declared.requirement,
        policies: declared.policies.map((policy) => {
          try {
            return policyIdOf(policy);
          } catch {
            return String((policy as { name?: string }).name ?? policy);
          }
        }),
        implicitReason: declared.implicitReason,
      });
    }
  }
  return entries;
}

/** Uma linha por rota com declaração ausente ou incoerente (vazio = cobertura completa). */
export function authorizationCoverageViolations(controllers: readonly Type[]): string[] {
  const violations: string[] = [];
  for (const entry of routeAuthorizations(controllers)) {
    const { label, requirement, implicitReason } = entry;
    if (requirement && implicitReason !== undefined) {
      violations.push(`${label}: declara @RequirePermission e @ImplicitAccess ao mesmo tempo`);
    }
    if (requirement && entry.tenantScope !== 'TENANT') {
      violations.push(`${label}: @RequirePermission só se aplica a rota @TenantScope('TENANT')`);
    }
    if (implicitReason !== undefined && implicitReason.trim().length < MIN_REASON_LENGTH) {
      violations.push(`${label}: @ImplicitAccess sem motivo (≥ ${MIN_REASON_LENGTH} caracteres)`);
    }
    const unknown = entry.policies.filter((policy) => !isPolicyId(policy));
    if (unknown.length > 0) {
      violations.push(`${label}: política fora do catálogo POL-01..17: ${unknown.join(', ')}`);
    }
    if (!entry.mutable || entry.tenantScope === 'PLATFORM') continue;
    if (!requirement && implicitReason === undefined) {
      violations.push(`${label}: rota mutável sem @RequirePermission nem @ImplicitAccess`);
    }
  }
  return violations.sort();
}

/** Políticas declaradas nas rotas, por ID (matriz de autorização). */
export function declaredPolicies(controllers: readonly Type[]): ReadonlyMap<PolicyId, string[]> {
  const byPolicy = new Map<PolicyId, string[]>();
  for (const entry of routeAuthorizations(controllers)) {
    for (const policy of entry.policies) {
      if (!isPolicyId(policy)) continue;
      byPolicy.set(policy, [...(byPolicy.get(policy) ?? []), entry.label]);
    }
  }
  return byPolicy;
}
