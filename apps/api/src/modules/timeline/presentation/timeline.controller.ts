import {
  cursorEnvelope,
  processIdParamsSchema,
  processTimelineQuerySchema,
  timelineEntrySchema,
} from '@contrataflow/validation';
import type { ProcessTimelineQuery, TimelineEntryDto } from '@contrataflow/validation';
import { Controller, Get, Param } from '@nestjs/common';

import { RequirePermission } from '#shared/auth/authorization.js';
import type { CursorResult } from '#shared/http/pagination.js';
import { ApiOperation, recordRequestSchema } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodQuery } from '#shared/validation/zod-validation.pipe.js';

import { GetProcessTimelineHandler } from '../application/get-process-timeline.query.js';

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
 * PRC-12 (api/02-processes.md · US-060): timeline do processo para a aba "Timeline" de SCR-006.
 * Dono: módulo `timeline`; o caminho fica sob `/processes/{id}` como as demais leituras do painel.
 */
@Controller('processes')
@TenantScope('TENANT')
export class TimelineController {
  constructor(private readonly timeline: GetProcessTimelineHandler) {}

  @Get(':id/timeline')
  @RequirePermission('PROCESS_VIEW', { scope: { processParam: 'id' } })
  @ApiOperation({
    operationId: 'PRC-12',
    summary: 'Listar timeline do processo',
    tags: ['Processos'],
    responses: {
      200: {
        description:
          'Entradas da timeline do processo visível (DEC-024), mais recentes primeiro (`occurredAt DESC, id DESC`), por cursor; filtros por grupo (RN-TML-12), autor e período (inclusivo, UTC) combinados por E. Entradas `BUDGET_RESTRICTED` só com POL-09, omitidas sem indicação (RN-TML-13). A mensagem é renderizada no front a partir de `type` + `params` (RN-TML-14). Processo não visível, inexistente ou de outro tenant = 404 `PROCESS_NOT_FOUND`.',
        schema: cursorEnvelope(timelineEntrySchema),
      },
    },
  })
  listTimeline(
    @ProcessId() id: string,
    @ZodQuery(processTimelineQuerySchema) query: ProcessTimelineQuery,
  ): Promise<CursorResult<TimelineEntryDto>> {
    return this.timeline.execute(id, query);
  }
}
