import {
  documentCreateSchema,
  documentMetaSchema,
  documentSchema,
  processDocumentSchema,
  processDocumentsMetaSchema,
  processDocumentsQuerySchema,
  processIdParamsSchema,
} from '@contrataflow/validation';
import type {
  DocumentCreate,
  DocumentDto,
  DocumentMeta,
  ProcessDocumentDto,
  ProcessDocumentsMeta,
  ProcessDocumentsQuery,
} from '@contrataflow/validation';
import { Controller, Get, Headers, Param, Post, Res } from '@nestjs/common';
import { z } from 'zod';

import { Policy, RequirePermission } from '#shared/auth/authorization.js';
import { DataResult } from '#shared/http/envelope.interceptor.js';
import type { HttpResponse } from '#shared/http/http-types.js';
import { Idempotent } from '#shared/idempotency/idempotency.js';
import { ApiOperation, recordRequestSchema } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodBody, ZodQuery } from '#shared/validation/zod-validation.pipe.js';

import { toDocumentDto } from '../application/document.view.js';
import { GetProcessDocumentsHandler } from '../application/process-documents.query.js';
import { CreateProcessDocumentCommand } from '../application/uploaded-document.commands.js';

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
 * DOC-01 (api/03-documents.md · US-062): documentos do processo para a aba "Documentos" de SCR-006;
 * DOC-02 (US-064 — `UPLOADED`; US-063 — `FREE_TEXT`, do template padrão publicado): criar documento no processo. Dono: módulo
 * `document`; o caminho fica sob `/processes/{id}` como as demais leituras do painel.
 */
@Controller('processes')
@TenantScope('TENANT')
export class ProcessDocumentsController {
  constructor(
    private readonly panel: GetProcessDocumentsHandler,
    private readonly create: CreateProcessDocumentCommand,
  ) {}

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

  @Post(':id/documents')
  @Idempotent()
  @RequirePermission('DOCUMENT_CREATE')
  @Policy('POL-02')
  @ApiOperation({
    operationId: 'DOC-02',
    summary: 'Criar documento no processo',
    tags: ['Documentos'],
    idempotent: true,
    auditActions: ['document.create'],
    responses: {
      201: {
        description:
          'Documento em `DRAFT` (`Location`, `ETag` = versão). Tipo `UPLOADED` nasce sem versão (`currentVersionId = null` — o arquivo vem pelo DOC-19; `meta.template = null`). Tipo `FREE_TEXT` (US-063) nasce da versão publicada do template padrão do tipo, com `draftContent.sections` por seção do modelo (`revision = 1`; `FILLED` com `defaultContent` de variáveis resolvidas, senão `EMPTY`) e `meta.template` (seções na ordem); sem template padrão publicado → 422 `VALIDATION_ERROR` (`REFERENCE_INACTIVE` em `documentTypeId`). `DOCUMENT_CREATE` cobrindo o processo + custódia ou participação `COLLABORATOR`/`CONSULTANT` (POL-02); processo inexistente/de outro tenant/não visível → 404 `NOT_FOUND`; fora de `DRAFT`/`IN_PROGRESS`/`RETURNED` → 409 `INVALID_PROCESS_STATUS`; tipo inexistente/inativo/de outro `kind` → 422 `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`); fora da etapa → 422 `DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE`; singular já existente → 409 `DOCUMENT_ALREADY_EXISTS`.',
        schema: z.object({ data: documentSchema, meta: documentMetaSchema }),
      },
    },
  })
  async createDocument(
    @ProcessId() id: string,
    @ZodBody(documentCreateSchema) body: DocumentCreate,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DataResult<DocumentDto, DocumentMeta>> {
    const result = await this.create.execute({
      processId: id,
      documentTypeId: body.documentTypeId,
      title: body.title,
      responsibleId: body.responsibleId ?? null,
      idempotencyKey: idempotencyKey ?? null,
    });
    response.setHeader('Location', `/api/v1/documents/${result.document.id}`);
    response.setHeader('ETag', `"${result.document.version}"`);
    return new DataResult(toDocumentDto(result.document, result.type), {
      allowedActions: result.allowedActions,
      template: result.template,
    });
  }
}
