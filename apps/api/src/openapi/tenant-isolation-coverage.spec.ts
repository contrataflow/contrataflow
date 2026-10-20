import { Controller, Get, Module, Post } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { API_MODULES } from '#modules/index.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodBody, ZodParams } from '#shared/validation/zod-validation.pipe.js';

import { collectControllers, collectOperations } from './openapi-document.js';
import {
  tenantLeakCoverageViolations,
  undeclaredTenantScopes,
} from './tenant-isolation-coverage.js';
import { TENANT_LEAK_MANIFEST } from './tenant-leak.manifest.js';

const ok = { 200: { description: 'ok' } };

describe('meta-teste: toda rota declara @TenantScope (US-100 · FA-01)', () => {
  it('nenhum handler da API fica sem escopo de tenant', () => {
    expect(undeclaredTenantScopes(collectControllers(API_MODULES))).toEqual([]);
  });

  it('reprova handler sem declaração; aceita a do controller e a do método', () => {
    @Controller('scoped')
    @TenantScope('TENANT')
    class ScopedController {
      @Get()
      list() {
        return [];
      }

      @Get('mine')
      @TenantScope('CROSS_TENANT_LOOKUP')
      mine() {
        return [];
      }
    }

    @Controller('loose')
    class LooseController {
      @Get()
      loose() {
        return [];
      }

      @Post('ok')
      @TenantScope('PLATFORM')
      platform() {
        return [];
      }

      helper() {
        return 'sem rota';
      }
    }
    expect(undeclaredTenantScopes([ScopedController, LooseController])).toEqual([
      'LooseController.loose (GET /)',
    ]);
  });
});

describe('meta-teste: toda operação classificada na suíte tenant leak (US-100 · RN-TEN-36)', () => {
  it('as operações da API (públicas e internas) estão no manifesto, sem entradas órfãs', () => {
    const operations = collectOperations(collectControllers(API_MODULES));
    expect(tenantLeakCoverageViolations(operations, TENANT_LEAK_MANIFEST)).toEqual([]);
  });

  it('reprova operação nova sem classificação, isenção sem motivo, parâmetro sem fixture e órfã', () => {
    @Controller('things')
    @TenantScope('TENANT')
    class ThingsController {
      @Get(':thingId')
      @ApiOperation({ operationId: 'THG-01', summary: 'a', responses: ok })
      get(@ZodParams(z.strictObject({ thingId: z.uuid() })) _params: unknown) {
        return {};
      }

      @Post()
      @ApiOperation({ operationId: 'THG-02', summary: 'b', responses: ok })
      create(@ZodBody(z.strictObject({ departmentId: z.uuid() })) _body: unknown) {
        return {};
      }

      @Get()
      @ApiOperation({ operationId: 'THG-03', summary: 'c', responses: ok })
      list() {
        return [];
      }

      @Get('lazy')
      @ApiOperation({ operationId: 'THG-04', summary: 'd', responses: ok })
      lazy() {
        return [];
      }
    }
    @Module({ controllers: [ThingsController] })
    class ThingsModule {}

    const operations = collectOperations(collectControllers([ThingsModule]));
    expect(
      tenantLeakCoverageViolations(operations, {
        'THG-01': { kind: 'covered' },
        'THG-02': { kind: 'covered' },
        'THG-04': { kind: 'exempt', reason: 'curto' },
        'THG-99': { kind: 'covered' },
      }),
    ).toEqual([
      'GET /things (THG-03): sem classificação na suíte tenant leak',
      'GET /things/lazy (THG-04): isenção sem motivo',
      'GET /things/{thingId} (THG-01): parâmetros sem fixture do tenant B: thingId',
      'POST /things (THG-02): corpo sem exemplo com referências do tenant B',
      'THG-99: classificada no manifesto, mas não existe na API',
    ]);
    expect(
      tenantLeakCoverageViolations(operations, {
        'THG-01': { kind: 'covered', pathParams: { thingId: 'membership' } },
        'THG-02': {
          kind: 'covered',
          body: (ids) => ({ departmentId: ids('department') }),
          referenceFields: ['departmentId'],
        },
        'THG-03': { kind: 'covered' },
        'THG-04': { kind: 'exempt', reason: 'Rota sem dados de tenant, só de diagnóstico.' },
      }),
    ).toEqual([]);
  });
});
