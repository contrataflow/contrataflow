import type { Type } from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';

import { tenantScopeOf, TENANT_SCOPES } from '#shared/tenancy/tenant-scope.js';

import type { CollectedOperation } from './openapi-document.js';
import type { TenantLeakCase } from './tenant-leak.manifest.js';

/*
 * Meta-testes de isolamento das rotas (US-100): (1) toda rota declara `@TenantScope` (FA-01 ·
 * RN-TEN-19); (2) toda operação do OpenAPI está classificada no manifesto da suíte "tenant leak"
 * (RN-TEN-36), e o manifesto não guarda operações que já não existem.
 */

const METHOD_METADATA = 'method';
const PATH_METADATA = 'path';

/** Handlers HTTP sem `@TenantScope` (no método nem no controller) ou com escopo desconhecido. */
export function undeclaredTenantScopes(controllers: readonly Type[]): string[] {
  const missing: string[] = [];
  for (const controller of controllers) {
    const prototype = controller.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(prototype)) {
      const handler = prototype[name];
      if (name === 'constructor' || typeof handler !== 'function') continue;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      if (method === undefined) continue;
      const scope = tenantScopeOf(handler, controller);
      if (scope !== undefined && TENANT_SCOPES.includes(scope)) continue;
      const path = String(Reflect.getMetadata(PATH_METADATA, handler) ?? '');
      missing.push(`${controller.name}.${name} (${RequestMethod[method]} ${path})`);
    }
  }
  return missing;
}

const MIN_REASON_LENGTH = 20;

/** Operações sem classificação, isenções sem motivo e entradas órfãs do manifesto. */
export function tenantLeakCoverageViolations(
  operations: readonly CollectedOperation[],
  manifest: Readonly<Record<string, TenantLeakCase>>,
): string[] {
  const violations: string[] = [];
  const seen = new Set<string>();
  for (const operation of operations) {
    const id = operation.spec.operationId;
    seen.add(id);
    const label = `${operation.method.toUpperCase()} ${operation.path} (${id})`;
    const entry = manifest[id];
    if (!entry) {
      violations.push(`${label}: sem classificação na suíte tenant leak`);
      continue;
    }
    if (entry.kind === 'exempt' && entry.reason.trim().length < MIN_REASON_LENGTH) {
      violations.push(`${label}: isenção sem motivo`);
    }
    if (entry.kind === 'covered') {
      const params = operation.path.match(/\{(\w+)\}/g)?.map((param) => param.slice(1, -1)) ?? [];
      const unmapped = params.filter((param) => !entry.pathParams?.[param]);
      if (unmapped.length > 0) {
        violations.push(`${label}: parâmetros sem fixture do tenant B: ${unmapped.join(', ')}`);
      }
      if (operation.request.body && !entry.body && entry.referenceFields === undefined) {
        violations.push(`${label}: corpo sem exemplo com referências do tenant B`);
      }
    }
  }
  for (const id of Object.keys(manifest)) {
    if (!seen.has(id)) violations.push(`${id}: classificada no manifesto, mas não existe na API`);
  }
  return violations.sort();
}
