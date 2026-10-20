import {
  actionEntrySchema,
  dataEnvelope,
  processChecklistSchema,
  processIdParamsSchema,
} from '@contrataflow/validation';
import type { ActionEntry, ProcessChecklist } from '@contrataflow/validation';
import { Controller, Get, Param } from '@nestjs/common';
import type { PipeTransform } from '@nestjs/common';
import { z } from 'zod';

import { ApiError } from '#shared/errors/api-error.js';
import { ApiOperation, recordRequestSchema } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';

import {
  EvaluateStageRulesHandler,
  GetAvailableActionsHandler,
} from '../application/process-actions.queries.js';

const TAGS = ['Processos'];

/** V-03: `id` que não é UUIDv7 = 400 `MALFORMED_REQUEST` (não é campo de formulário — sem 422). */
class ProcessIdPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    const parsed = processIdParamsSchema.shape.id.safeParse(value);
    if (!parsed.success) {
      throw new ApiError('MALFORMED_REQUEST', { detail: 'Requisição inválida.' });
    }
    return parsed.data;
  }
}

/** `@ProcessIdParam()`: valida o `id` do caminho e documenta-o no OpenAPI. */
function ProcessIdParam(): ParameterDecorator {
  return (target, propertyKey, index) => {
    Param('id', new ProcessIdPipe())(target, propertyKey, index);
    if (propertyKey !== undefined) {
      recordRequestSchema(target, propertyKey, 'params', processIdParamsSchema);
    }
  };
}

/**
 * Painel situacional do processo — leituras do motor de workflow (api/02-processes.md PRC-08 e
 * PRC-09 · US-041): ações disponíveis com os motivos de indisponibilidade e o checklist de
 * pendências da etapa atual. `PROCESS_VIEW` cobrindo o processo (DEC-024); não visível = 404.
 * Somente leitura: sem `Idempotency-Key`, `If-Match`, eventos ou auditoria.
 */
@Controller()
@TenantScope('TENANT')
export class ProcessActionsController {
  constructor(
    private readonly availableActions: GetAvailableActionsHandler,
    private readonly stageRules: EvaluateStageRulesHandler,
  ) {}

  @Get('processes/:id/available-actions')
  @ApiOperation({
    operationId: 'PRC-08',
    summary: 'Listar ações disponíveis do processo',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Ações da etapa atual (avanço, devolução e ciclo de vida) com `enabled` e `reasons[]`.',
        schema: dataEnvelope(z.array(actionEntrySchema)),
      },
    },
  })
  getAvailableActions(@ProcessIdParam() id: string): Promise<ActionEntry[]> {
    return this.availableActions.execute({ processId: id });
  }

  @Get('processes/:id/checklist')
  @ApiOperation({
    operationId: 'PRC-09',
    summary: 'Obter checklist de pendências do processo',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Regras não satisfeitas da etapa atual (`violations[]`, bloqueantes antes dos avisos).',
        schema: dataEnvelope(processChecklistSchema),
      },
    },
  })
  getChecklist(@ProcessIdParam() id: string): Promise<ProcessChecklist> {
    return this.stageRules.execute({ processId: id });
  }
}
