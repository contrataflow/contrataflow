import {
  attachmentListQuerySchema,
  attachmentSchema,
  pageEnvelope,
  processIdParamsSchema,
} from '@contrataflow/validation';
import type { AttachmentDto, AttachmentListQuery } from '@contrataflow/validation';
import { Controller, Get } from '@nestjs/common';

import { RequirePermission } from '#shared/auth/authorization.js';
import type { PageResult } from '#shared/http/pagination.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodParams, ZodQuery } from '#shared/validation/zod-validation.pipe.js';

import { ListAttachmentsQuery } from '../application/list-attachments.query.js';

/**
 * ATT-01 (api/12-comments-attachments.md · US-069): anexos do processo, sob `/processes/{id}` como
 * as demais leituras do painel (a aba de anexos de SCR-006). Dono: módulo `files`.
 */
@Controller('processes')
@TenantScope('TENANT')
export class ProcessAttachmentsController {
  constructor(private readonly list: ListAttachmentsQuery) {}

  @Get(':id/attachments')
  @RequirePermission('PROCESS_VIEW')
  @ApiOperation({
    operationId: 'ATT-01',
    summary: 'Listar anexos do processo',
    tags: ['Anexos'],
    responses: {
      200: {
        description:
          'Anexos não excluídos do processo visível (DEC-024) por `-createdAt`, só metadados (sem URL — ATT-05); filtros `targetType`, `targetId` (exige `targetType`) e `categoryId`, com paginação padrão. Processo inexistente, de outro tenant ou não visível → 404 `NOT_FOUND`; filtro ou página inválida → 422 `VALIDATION_ERROR`.',
        schema: pageEnvelope(attachmentSchema),
      },
    },
  })
  listAttachments(
    @ZodParams(processIdParamsSchema) params: { id: string },
    @ZodQuery(attachmentListQuerySchema) query: AttachmentListQuery,
  ): Promise<PageResult<AttachmentDto>> {
    return this.list.execute(params.id, query);
  }
}
