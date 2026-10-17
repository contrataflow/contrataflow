import {
  processDocumentSchema,
  processDocumentsMetaSchema,
  processDocumentsQuerySchema,
  processIdParamsSchema,
} from '@contrataflow/validation';
import type {
  ProcessDocumentDto,
  ProcessDocumentsMeta,
  ProcessDocumentsQuery,
} from '@contrataflow/validation';
import { Controller, Get, Param } from '@nestjs/common';
import { z } from 'zod';

import { RequirePermission } from '#shared/auth/authorization.js';
import { DataResult } from '#shared/http/envelope.interceptor.js';
import { ApiOperation, recordRequestSchema } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodQuery } from '#shared/validation/zod-validation.pipe.js';

import { GetProcessDocumentsHandler } from '../application/process-documents.query.js';

/** `@ProcessId()`: `id` do caminho (o guard já recusou o malformado com 400) e o OpenAPI. */
function ProcessId(): ParameterDecorator {
  return (target, propertyKey, index) => {
    Param('id')(target, propertyKey, index);
    if (propertyKey !== undefined) {
      recordRequestSchema(target, propertyKey, 'params', processIdParamsSchema);
    }
  };
}

const PANEL_RESPONSE = z.object({
  data: z.array(processDocumentSchema),
  meta: processDocumentsMetaSchema,
});

/**
 * DOC-01 (api/03-documents.md · US-062): documentos do processo para a aba "Documentos" de SCR-006.
 * Dono: módulo `document`; o caminho fica sob `/processes/{id}` como as demais leituras do painel.
 */
@Controller('processes')
@TenantScope('TENANT')
export class ProcessDocumentsController {
  constructor(private readonly panel: GetProcessDocumentsHandler) {}

  @Get(':id/documents')
  @RequirePermission('PROCESS_VIEW', { scope: { processParam: 'id' } })
  @ApiOperation({
    operationId: 'DOC-01',
    summary: 'Listar documentos do processo',
    tags: ['Documentos'],
    responses: {
      200: {
        description:
          'Documentos não excluídos do processo visível (DEC-024), inclusive cancelados (RN-DOC-19), por `sortOrder` do tipo e título (RN-DOC-13), sem `draftContent`; cada item com `meta.allowedActions` (RN-DOC-18) e `summary` do módulo tipado sob POL-09 (RN-DOC-17). Filtros `type`/`status` (OU, por vírgula), `responsibleId` e `q` (≥ 2 caracteres) combinados por E, sem paginação (RN-DOC-20). `meta`: etapa atual, `creatableTypeIds` (menu "Criar documento" — RN-DOC-16) e `pendingTypeIds` (singulares "Não iniciado" — FA-01). Processo inexistente, de outro tenant ou não visível = 404 `PROCESS_NOT_FOUND`; filtro fora do enum/catálogo = 422.',
        schema: PANEL_RESPONSE,
      },
    },
  })
  async listDocuments(
    @ProcessId() id: string,
    @ZodQuery(processDocumentsQuerySchema) query: ProcessDocumentsQuery,
  ): Promise<DataResult<ProcessDocumentDto[], ProcessDocumentsMeta>> {
    const result = await this.panel.execute(id, query);
    return new DataResult(result.items, result.meta);
  }
}
