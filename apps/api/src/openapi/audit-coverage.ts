import { isAuditAction } from '@contrataflow/types';
import type { Type } from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';

import { API_OPERATION_METADATA } from '#shared/openapi/api-operation.js';

/*
 * Meta-teste de cobertura da auditoria (RN-AUD-09 · V-05 da US-073): todo endpoint mutável
 * (POST/PUT/PATCH/DELETE) do catálogo de rotas (OpenAPI, inclusive as internas) declara ao menos
 * uma ação de auditoria do catálogo de events.md §7 (`x-audit-actions`) ou uma isenção justificada
 * (`x-audit-exempt`); e nenhum handler mutável fica fora do catálogo por não ter `@ApiOperation`.
 */

const MUTABLE_METHODS = ['post', 'put', 'patch', 'delete'] as const;

interface OperationLike {
  readonly operationId?: string;
  readonly 'x-audit-actions'?: unknown;
  readonly 'x-audit-exempt'?: unknown;
}

export interface OpenApiPaths {
  readonly paths?: Readonly<Record<string, Readonly<Record<string, OperationLike>>>>;
}

/** Uma linha por operação mutável sem ação de auditoria válida (vazio = cobertura completa). */
export function auditCoverageViolations(document: OpenApiPaths): string[] {
  const violations: string[] = [];
  for (const [path, operations] of Object.entries(document.paths ?? {})) {
    for (const method of MUTABLE_METHODS) {
      const operation = operations[method];
      if (!operation) continue;
      const label = `${method.toUpperCase()} ${path} (${operation.operationId ?? 'sem operationId'})`;
      const actions = operation['x-audit-actions'];
      const exempt = operation['x-audit-exempt'];
      if (typeof exempt === 'string' && exempt.trim().length >= 10) continue;
      if (!Array.isArray(actions) || actions.length === 0) {
        violations.push(`${label}: sem x-audit-actions nem x-audit-exempt justificado`);
        continue;
      }
      const unknown = actions.filter(
        (action) => typeof action !== 'string' || !isAuditAction(action),
      );
      if (unknown.length > 0) {
        violations.push(`${label}: ação fora do catálogo de events.md §7: ${unknown.join(', ')}`);
      }
    }
  }
  return violations;
}

const METHOD_METADATA = 'method';
const PATH_METADATA = 'path';
const MUTABLE_REQUEST_METHODS: ReadonlySet<RequestMethod> = new Set([
  RequestMethod.POST,
  RequestMethod.PUT,
  RequestMethod.PATCH,
  RequestMethod.DELETE,
]);

/** Handlers mutáveis sem `@ApiOperation`: escapariam do catálogo de rotas (e do meta-teste). */
export function undocumentedMutableHandlers(controllers: readonly Type[]): string[] {
  const missing: string[] = [];
  for (const controller of controllers) {
    const prototype = controller.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(prototype)) {
      const handler = prototype[name];
      if (name === 'constructor' || typeof handler !== 'function') continue;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      if (method === undefined || !MUTABLE_REQUEST_METHODS.has(method)) continue;
      if (Reflect.getMetadata(API_OPERATION_METADATA, handler) !== undefined) continue;
      const path = String(Reflect.getMetadata(PATH_METADATA, handler) ?? '');
      missing.push(`${controller.name}.${name} (${RequestMethod[method]} ${path})`);
    }
  }
  return missing;
}
