import { OpenApiGeneratorV31, OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import type { ResponseConfig, RouteConfig } from '@asteasolutions/zod-to-openapi';
import { problemDetailsSchema } from '@contrataflow/validation';
import type { DynamicModule, Type } from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';
import { z } from 'zod';

import { API_OPERATION_METADATA, API_REQUEST_METADATA } from '#shared/openapi/api-operation.js';
import type { ApiOperationSpec, RequestSchemas } from '#shared/openapi/api-operation.js';
import { tenantScopeOf } from '#shared/tenancy/tenant-scope.js';
import type { TenantScopeKind } from '#shared/tenancy/tenant-scope.js';

// Chaves de metadados do Nest (`@nestjs/common/constants`): `@Module`, `@Controller`, `@Get`…
const MODULE_IMPORTS = 'imports';
const MODULE_CONTROLLERS = 'controllers';
const PATH_METADATA = 'path';
const METHOD_METADATA = 'method';

type ModuleRef = Type | DynamicModule;

/** Controllers de uma árvore de módulos (estáticos e dinâmicos), sem instanciar nada. */
export function collectControllers(roots: readonly ModuleRef[]): Type[] {
  const visited = new Set<unknown>();
  const controllers: Type[] = [];
  const visit = (ref: unknown): void => {
    if (!ref || visited.has(ref)) return;
    visited.add(ref);
    const dynamic = typeof ref === 'object' ? (ref as DynamicModule) : undefined;
    const moduleClass = dynamic ? dynamic.module : (ref as Type);
    const metadata = (key: string) => (Reflect.getMetadata(key, moduleClass) ?? []) as unknown[];
    for (const controller of [...metadata(MODULE_CONTROLLERS), ...(dynamic?.controllers ?? [])]) {
      if (!controllers.includes(controller as Type)) controllers.push(controller as Type);
    }
    for (const child of [...metadata(MODULE_IMPORTS), ...(dynamic?.imports ?? [])]) visit(child);
  };
  roots.forEach(visit);
  return controllers;
}

export interface CollectedOperation {
  readonly method: RouteConfig['method'];
  /** Caminho OpenAPI relativo a `/api/v1` (`:id` → `{id}`). */
  readonly path: string;
  readonly spec: ApiOperationSpec;
  readonly request: RequestSchemas;
  /** `@TenantScope` do handler ou do controller (US-100); `undefined` = não declarado. */
  readonly tenantScope: TenantScopeKind | undefined;
}

const METHODS: Partial<Record<RequestMethod, RouteConfig['method']>> = {
  [RequestMethod.GET]: 'get',
  [RequestMethod.POST]: 'post',
  [RequestMethod.PUT]: 'put',
  [RequestMethod.PATCH]: 'patch',
  [RequestMethod.DELETE]: 'delete',
};

function joinPath(...parts: unknown[]): string {
  const segments = parts
    .flatMap((part) => (Array.isArray(part) ? [(part as unknown[])[0]] : [part]))
    .filter((part): part is string => typeof part === 'string')
    .flatMap((part) => part.split('/'))
    .filter(Boolean)
    .map((segment) => (segment.startsWith(':') ? `{${segment.slice(1)}}` : segment));
  return `/${segments.join('/')}`;
}

/** Operações documentadas (`@ApiOperation`), em ordem estável por caminho e método. */
export function collectOperations(controllers: readonly Type[]): CollectedOperation[] {
  const operations: CollectedOperation[] = [];
  for (const controller of controllers) {
    const prototype = controller.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(prototype)) {
      const handler = prototype[name];
      if (name === 'constructor' || typeof handler !== 'function') continue;
      const spec = Reflect.getMetadata(API_OPERATION_METADATA, handler) as
        ApiOperationSpec | undefined;
      const method = METHODS[Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod];
      if (!spec || !method) continue;
      operations.push({
        method,
        path: joinPath(
          Reflect.getMetadata(PATH_METADATA, controller),
          Reflect.getMetadata(PATH_METADATA, handler),
        ),
        spec,
        request: (Reflect.getMetadata(API_REQUEST_METADATA, handler) ?? {}) as RequestSchemas,
        tenantScope: tenantScopeOf(handler, controller),
      });
    }
  }
  return operations.sort((a, b) =>
    a.path === b.path ? a.method.localeCompare(b.method) : a.path < b.path ? -1 : 1,
  );
}

/** Corpo de sucesso: JSON por padrão; arquivo nos tipos informados (ex.: CSV/NDJSON de AUD-03). */
function contentOf(
  schema: z.ZodType,
  contentTypes: readonly string[] = ['application/json'],
): NonNullable<ResponseConfig['content']> {
  return Object.fromEntries(contentTypes.map((type) => [type, { schema }]));
}

const problem = (description: string): ResponseConfig => ({
  description,
  content: { 'application/problem+json': { schema: problemDetailsSchema } },
});

/** Erros RFC 9457 comuns a toda rota do pipeline (api.md §2.1). */
const COMMON_ERRORS: Readonly<Record<string, ResponseConfig>> = {
  '400': problem('MALFORMED_REQUEST'),
  '401': problem('UNAUTHENTICATED · SESSION_EXPIRED'),
  '403': problem('TENANT_SUSPENDED · MEMBERSHIP_INACTIVE · MFA_REQUIRED · PERMISSION_DENIED'),
  '422': problem('VALIDATION_ERROR · BUSINESS_RULE_VIOLATION'),
  '429': problem('RATE_LIMITED'),
  '500': problem('INTERNAL_ERROR'),
};

export interface BuildOpenApiOptions {
  /** Inclui as rotas internas (`internal: true`) — só para testes; o contrato versionado não. */
  readonly includeInternal?: boolean;
}

/**
 * Documento OpenAPI 3.1 a partir dos metadados dos controllers e dos schemas Zod (DEC-054 ·
 * RN-FND-38). Determinístico: mesma entrada, mesmos bytes.
 */
export function buildOpenApiDocument(
  roots: readonly ModuleRef[],
  options: BuildOpenApiOptions = {},
) {
  // Componentes nomeados vêm do `.meta({ id })` dos schemas de packages/validation (sem `.openapi()`).
  const registry = new OpenAPIRegistry();
  registry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
  });

  for (const operation of collectOperations(collectControllers(roots))) {
    if (operation.spec.internal && !options.includeInternal) continue;
    const headers: Record<string, z.ZodType> = {};
    const tenantScope = operation.tenantScope ?? 'TENANT';
    if (tenantScope === 'TENANT') {
      headers['X-Tenant-Id'] = z.uuid().describe('Órgão ativo (DEC-132 · RN-TEN-19).');
    }
    if (operation.spec.idempotent) {
      headers['Idempotency-Key'] = z.uuid().optional().describe('Chave de idempotência (DEC-105).');
    }
    const { body, query, params } = operation.request;
    const success = Object.fromEntries(
      Object.entries(operation.spec.responses).map(([status, response]) => [
        status,
        {
          description: response.description,
          ...(response.schema
            ? { content: contentOf(response.schema, response.contentTypes) }
            : {}),
        } satisfies ResponseConfig,
      ]),
    );

    registry.registerPath({
      method: operation.method,
      path: operation.path,
      operationId: operation.spec.operationId,
      summary: operation.spec.summary,
      ...(operation.spec.tags ? { tags: [...operation.spec.tags] } : {}),
      security: [{ bearerAuth: [] }],
      'x-tenant-scope': tenantScope,
      ...(operation.spec.auditActions
        ? { 'x-audit-actions': [...operation.spec.auditActions] }
        : {}),
      ...(operation.spec.auditExempt ? { 'x-audit-exempt': operation.spec.auditExempt } : {}),
      request: {
        headers: z.object(headers),
        ...(operation.spec.requestBody
          ? {
              body: {
                required: true,
                content: {
                  [operation.spec.requestBody.contentType]: {
                    schema: operation.spec.requestBody.schema,
                  },
                },
              },
            }
          : body
            ? { body: { required: true, content: { 'application/json': { schema: body } } } }
            : {}),
        ...(query ? { query: query as z.ZodObject } : {}),
        ...(params ? { params: params as z.ZodObject } : {}),
      },
      responses: {
        ...success,
        ...COMMON_ERRORS,
        ...(operation.spec.idempotent ? { '409': problem('IDEMPOTENCY_IN_PROGRESS') } : {}),
      },
    });
  }

  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'ContrataFlow API',
      version: '1.0.0',
      description: 'API REST v1 do ContrataFlow (docs/mvp-01/api.md). Gerado — não edite à mão.',
    },
    servers: [{ url: '/api/v1' }],
  });
}

/** Serialização estável do contrato versionado (`openapi/api.v1.json`). */
export function serializeOpenApi(document: unknown): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
