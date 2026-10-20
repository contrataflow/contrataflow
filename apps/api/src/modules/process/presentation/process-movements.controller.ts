import {
  processIdParamsSchema,
  processMovementsQuerySchema,
  processMovementsResponseSchema,
} from '@contrataflow/validation';
import type {
  MovementItemDto,
  ProcessMovementsMeta,
  ProcessMovementsQuery,
} from '@contrataflow/validation';
import { Controller, Get, Param, Res } from '@nestjs/common';

import { RequirePermission } from '#shared/auth/authorization.js';
import type { DataResult } from '#shared/http/envelope.interceptor.js';
import type { HttpResponse } from '#shared/http/http-types.js';
import { ApiOperation, recordRequestSchema } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodQuery } from '#shared/validation/zod-validation.pipe.js';

import { ListProcessMovementsHandler } from '../application/list-process-movements.query.js';

/** `@ProcessId()`: `id` do caminho (o guard já recusou o malformado com 400) e o OpenAPI. */
function ProcessId(): ParameterDecorator {
  return (target, propertyKey, index) => {
    Param('id')(target, propertyKey, index);
    if (propertyKey !== undefined) {
      recordRequestSchema(target, propertyKey, 'params', processIdParamsSchema);
    }
  };
}

/**
 * PRC-11 (api/02-processes.md · US-054): histórico de tramitações para a aba "Tramitação" de
 * SCR-006. Somente leitura — `ProcessMovement` é imutável (RN-TRAM-76).
 */
@Controller('processes')
@TenantScope('TENANT')
export class ProcessMovementsController {
  constructor(private readonly movements: ListProcessMovementsHandler) {}

  @Get(':id/movements')
  @RequirePermission('PROCESS_VIEW', { scope: { processParam: 'id' } })
  @ApiOperation({
    operationId: 'PRC-11',
    summary: 'Listar histórico de tramitações',
    tags: ['Processos'],
    responses: {
      200: {
        description:
          'Tramitações do processo visível (DEC-024), mais recentes primeiro (`sequence DESC`), por cursor; filtros por ação (OU), unidade de origem/destino, ator e período (inclusivo, UTC) combinados por E. Nomes de etapa, unidade e usuário hidratados na consulta (`isActive = false` = inativo). `ip` só com `AUDIT_VIEW` (`null` para os demais; `meta.canViewIp` diz qual o caso). Processo não visível, inexistente ou de outro tenant = 404 `PROCESS_NOT_FOUND`.',
        schema: processMovementsResponseSchema,
      },
    },
  })
  async listMovements(
    @ProcessId() id: string,
    @ZodQuery(processMovementsQuerySchema) query: ProcessMovementsQuery,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DataResult<MovementItemDto[], ProcessMovementsMeta>> {
    const page = await this.movements.execute(id, query);
    // A lista cresce com a atividade do processo e o `ip` depende de quem consulta.
    response.setHeader('Cache-Control', 'no-store');
    return page;
  }
}
