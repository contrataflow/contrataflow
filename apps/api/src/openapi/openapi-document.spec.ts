import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Controller, Get, Module, Post } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { API_MODULES } from '#modules/index.js';
import { InternalExampleController } from '#modules/platform/presentation/internal-example.controller.js';
import { WithoutTenant } from '#shared/auth/route-access.js';
import { API_OPERATION_METADATA, ApiOperation } from '#shared/openapi/api-operation.js';
import type { ApiOperationSpec } from '#shared/openapi/api-operation.js';
import { FAKE_TENANTS } from '#shared/testing/fake-directory.js';
import { ZodParams } from '#shared/validation/zod-validation.pipe.js';

import {
  buildOpenApiDocument,
  collectControllers,
  collectOperations,
  serializeOpenApi,
} from './openapi-document.js';
import { createTestApi } from '../../test/support/api-test-app.js';
import type { TestApi } from '../../test/support/api-test-app.js';

const CONTRACT = new URL('../../openapi/api.v1.json', import.meta.url);

interface OpenApiJson {
  paths: Record<
    string,
    Record<
      string,
      { responses: Record<string, unknown>; parameters?: { name: string; in: string }[] }
    >
  >;
  components: { schemas: Record<string, unknown> };
}

describe('openapi:generate (RN-FND-38)', () => {
  it('é determinístico: duas gerações produzem os mesmos bytes', () => {
    expect(serializeOpenApi(buildOpenApiDocument(API_MODULES))).toBe(
      serializeOpenApi(buildOpenApiDocument(API_MODULES)),
    );
  });

  it('o contrato versionado em openapi/api.v1.json está em dia com o código', () => {
    expect(readFileSync(fileURLToPath(CONTRACT), 'utf8')).toBe(
      serializeOpenApi(buildOpenApiDocument(API_MODULES)),
    );
  });

  it('rotas internas ficam fora do contrato público', () => {
    const document = buildOpenApiDocument(API_MODULES) as unknown as OpenApiJson;
    expect(Object.keys(document.paths).filter((path) => path.includes('internal'))).toEqual([]);
  });

  it('US-087: ME-01 exige X-Tenant-Id; ME-04 é chamada sem tenant (api/01-session-me.md)', () => {
    const document = buildOpenApiDocument(API_MODULES) as unknown as OpenApiJson;
    const me = document.paths['/me']?.get;
    const memberships = document.paths['/me/memberships']?.get;
    expect(me?.parameters).toContainEqual(expect.objectContaining({ name: 'X-Tenant-Id' }));
    expect(memberships?.parameters ?? []).not.toContainEqual(
      expect.objectContaining({ name: 'X-Tenant-Id' }),
    );
    expect(Object.keys(document.components.schemas)).toEqual(
      expect.arrayContaining(['MyProfile', 'MembershipSummary']),
    );
  });

  it('encontra controllers em módulos estáticos e dinâmicos', () => {
    @Controller('x')
    class XController {}
    @Module({ controllers: [XController] })
    class XModule {}
    expect(collectControllers([{ module: XModule, imports: [...API_MODULES] }])).toEqual(
      expect.arrayContaining([XController, InternalExampleController]),
    );
  });

  it('converte parâmetros de rota, ordena por caminho/método e marca rotas sem tenant', () => {
    @Controller('things')
    class ThingsController {
      @Post(':thingId/close')
      @ApiOperation({ operationId: 'T-2', summary: 'b', responses: { 204: { description: 'ok' } } })
      close(@ZodParams(z.strictObject({ thingId: z.uuid() })) _params: unknown) {
        // só os metadados importam
      }

      @Get()
      @WithoutTenant()
      @ApiOperation({ operationId: 'T-1', summary: 'a', responses: { 200: { description: 'ok' } } })
      list() {
        // só os metadados importam
      }

      @Get('undocumented')
      undocumented() {
        // sem @ApiOperation: fora do contrato
      }
    }
    const operations = collectOperations([ThingsController]);
    expect(
      operations.map(({ method, path, withoutTenant }) => ({ method, path, withoutTenant })),
    ).toEqual([
      { method: 'get', path: '/things', withoutTenant: true },
      { method: 'post', path: '/things/{thingId}/close', withoutTenant: false },
    ]);

    @Module({ controllers: [ThingsController] })
    class ThingsModule {}
    const document = buildOpenApiDocument([ThingsModule]) as unknown as OpenApiJson;
    const close = document.paths['/things/{thingId}/close']?.post;
    expect(close?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'thingId', in: 'path' }),
        expect.objectContaining({ name: 'X-Tenant-Id', in: 'header' }),
      ]),
    );
    expect(document.paths['/things']?.get?.parameters ?? []).not.toContainEqual(
      expect.objectContaining({ name: 'X-Tenant-Id' }),
    );
  });
});

describe('rota de exemplo documentada e validada contra o próprio OpenAPI', () => {
  let api: TestApi;
  const document = buildOpenApiDocument(API_MODULES, {
    includeInternal: true,
  }) as unknown as OpenApiJson;

  beforeAll(async () => {
    api = await createTestApi();
  });
  afterAll(async () => {
    await api.close();
  });

  it('documenta as cinco operações internas com erros RFC 9457', () => {
    expect(
      Object.keys(document.paths)
        .filter((path) => path.startsWith('/_internal/'))
        .sort(),
    ).toEqual([
      '/_internal/echo',
      '/_internal/feed',
      '/_internal/items',
      '/_internal/jobs/trace-demo',
      '/_internal/ping',
    ]);
    expect(Object.keys(document.paths['/_internal/echo']?.post?.responses ?? {})).toEqual(
      expect.arrayContaining(['201', '401', '409', '422', '429', '500']),
    );
    expect(Object.keys(document.components.schemas)).toEqual(
      expect.arrayContaining([
        'ProblemDetails',
        'InternalPing',
        'InternalItem',
        'PageMeta',
        'CursorMeta',
      ]),
    );
  });

  it.each([
    ['get', '/_internal/ping', 'ping', undefined],
    ['get', '/_internal/items?page=1&pageSize=5', 'items', undefined],
    ['get', '/_internal/feed?limit=5', 'feed', undefined],
    ['post', '/_internal/echo', 'echo', { name: 'Caneta' }],
    ['post', '/_internal/jobs/trace-demo', 'traceDemoJob', undefined],
  ] as const)(
    '%s %s responde conforme o schema documentado',
    async (method, path, handler, body) => {
      const spec = Reflect.getMetadata(
        API_OPERATION_METADATA,
        Reflect.get(InternalExampleController.prototype, handler),
      ) as ApiOperationSpec;
      const [status, response] = Object.entries(spec.responses)[0] as [
        string,
        { schema: z.ZodType },
      ];
      expect(document.paths[path.split('?')[0] ?? '']?.[method]?.responses[status]).toBeDefined();

      const agent = request(api.server);
      let call = agent[method](`/api/v1${path}`)
        .set('Authorization', api.bearer('sub-ana'))
        .set('X-Tenant-Id', FAKE_TENANTS.prefeituraA.id);
      if (body) call = call.send(body);
      const result = await call;

      expect(result.status).toBe(Number(status));
      expect(response.schema.safeParse(result.body).success).toBe(true);
    },
  );
});
