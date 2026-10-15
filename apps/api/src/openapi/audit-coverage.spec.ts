import { Controller, Delete, Module, Patch, Post, Put } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { API_MODULES } from '#modules/index.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import type { ApiOperationSpec } from '#shared/openapi/api-operation.js';

import { auditCoverageViolations, undocumentedMutableHandlers } from './audit-coverage.js';
import type { OpenApiPaths } from './audit-coverage.js';
import { buildOpenApiDocument, collectControllers } from './openapi-document.js';

const operation = (spec: Partial<ApiOperationSpec>): ApiOperationSpec => ({
  operationId: 'TST-01',
  summary: 'teste',
  responses: { 200: { description: 'ok' } },
  ...spec,
});

describe('meta-teste de auditoria das rotas mutáveis (RN-AUD-09 · V-05)', () => {
  it('toda rota mutável da API, inclusive as internas, tem ação de auditoria mapeada', () => {
    const document = buildOpenApiDocument(API_MODULES, { includeInternal: true });
    expect(auditCoverageViolations(document as unknown as OpenApiPaths)).toEqual([]);
  });

  it('nenhum handler mutável escapa do catálogo de rotas por falta de @ApiOperation', () => {
    expect(undocumentedMutableHandlers(collectControllers(API_MODULES))).toEqual([]);
  });

  it('o contrato expõe as ações de auditoria em x-audit-actions', () => {
    const document = buildOpenApiDocument(API_MODULES, { includeInternal: true }) as unknown as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    expect(document.paths['/internal/session-events']?.post?.['x-audit-actions']).toEqual([
      'auth.session_start',
      'auth.tenant_switch',
    ]);
  });

  it('reprova rota mutável sem ação, com ação fora do catálogo ou isenção sem justificativa', () => {
    @Controller('meta')
    class MetaController {
      @Post('ok')
      @ApiOperation(operation({ operationId: 'TST-OK', auditActions: ['process.create'] }))
      ok() {
        return 'ok';
      }

      @Put('none')
      @ApiOperation(operation({ operationId: 'TST-NONE' }))
      none() {
        return 'none';
      }

      @Patch('unknown')
      @ApiOperation(
        operation({ operationId: 'TST-UNKNOWN', auditActions: ['foo.bar' as 'process.create'] }),
      )
      unknown() {
        return 'unknown';
      }

      @Delete('lazy')
      @ApiOperation(operation({ operationId: 'TST-LAZY', auditExempt: 'teste' }))
      lazy() {
        return 'lazy';
      }

      @Post('exempt')
      @ApiOperation(
        operation({ operationId: 'TST-EXEMPT', auditExempt: 'Autenticação de baixo nível.' }),
      )
      exempt() {
        return 'exempt';
      }

      @Post('undocumented')
      undocumented() {
        return 'undocumented';
      }
    }
    @Module({ controllers: [MetaController] })
    class MetaModule {}

    const violations = auditCoverageViolations(
      buildOpenApiDocument([MetaModule]) as unknown as OpenApiPaths,
    );
    expect(violations).toEqual([
      'DELETE /meta/lazy (TST-LAZY): sem x-audit-actions nem x-audit-exempt justificado',
      'PUT /meta/none (TST-NONE): sem x-audit-actions nem x-audit-exempt justificado',
      'PATCH /meta/unknown (TST-UNKNOWN): ação fora do catálogo de events.md §7: foo.bar',
    ]);
    expect(undocumentedMutableHandlers([MetaController])).toEqual([
      'MetaController.undocumented (POST undocumented)',
    ]);
  });
});
