import {
  dataEnvelope,
  documentIdParamsSchema,
  documentItemSchema,
  documentItemsReplaceSchema,
} from '@contrataflow/validation';
import type { DocumentItemDto, DocumentItemsReplace } from '@contrataflow/validation';
import { Controller, Get, HttpCode, Put, Res } from '@nestjs/common';
import { z } from 'zod';

import { ImplicitAccess, Policy, RequirePermission } from '#shared/auth/authorization.js';
import type { HttpResponse } from '#shared/http/http-types.js';
import { IfMatch, RequireIfMatch } from '#shared/http/precondition.js';
import type { IfMatchValue } from '#shared/http/precondition.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodBody, ZodParams } from '#shared/validation/zod-validation.pipe.js';

import {
  DocumentItemsQuery,
  ReplaceDocumentItemsCommand,
} from '../application/document-items.commands.js';

const TAGS = ['Documentos'];

const EDIT_PERMISSION =
  'Permissão de edição do tipo do documento (DFD_UPDATE, ETP_UPDATE, TERM_UPDATE…) conferida pelo caso de uso sobre o processo do documento, com POL-02 (custódia ou participação COLLABORATOR/CONSULTANT).';

/**
 * DOC-06/07 (api/03-documents.md · US-014): os itens do documento tipado sobre os itens canônicos
 * do processo (DEC-019). `ETag` = `Document.version` — o `If-Match` da substituição.
 */
@Controller('documents')
@TenantScope('TENANT')
export class DocumentItemsController {
  constructor(
    private readonly query: DocumentItemsQuery,
    private readonly replace: ReplaceDocumentItemsCommand,
  ) {}

  @Get(':id/items')
  @RequirePermission('PROCESS_VIEW')
  @ApiOperation({
    operationId: 'DOC-06',
    summary: 'Listar itens do documento',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Linhas do documento com o nº, a descrição e a unidade do item do processo (`unit.allowsDecimal` — FA-11). `ETag` = versão do documento. Documento inexistente, excluído, de outro tenant ou de processo não visível = 404 `NOT_FOUND`.',
        schema: dataEnvelope(z.array(documentItemSchema)),
      },
    },
  })
  async listItems(
    @ZodParams(documentIdParamsSchema) params: { id: string },
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DocumentItemDto[]> {
    const result = await this.query.execute(params.id);
    response.setHeader('ETag', `"${String(result.documentVersion)}"`);
    response.setHeader('Cache-Control', 'no-store');
    return result.items;
  }

  @Put(':id/items')
  @HttpCode(200)
  @RequireIfMatch()
  @ImplicitAccess(EDIT_PERMISSION)
  @Policy('POL-02')
  @ApiOperation({
    operationId: 'DOC-07',
    summary: 'Substituir itens do documento',
    tags: TAGS,
    auditActions: ['document.items_update'],
    responses: {
      200: {
        description:
          'Substituição completa da coleção (RN-DFD-14): cada `processItemId` é item não excluído do mesmo processo, sem repetição (422 `REFERENCE_NOT_FOUND`/`DUPLICATE_IN_LIST` em `items[n].processItemId` — inclusive de outro tenant, sem revelar), quantidade > 0 com até 4 casas e inteira quando a unidade não admite decimais (422 `OUT_OF_RANGE`/`INVALID_DECIMAL` em `items[n].quantity`). Exige a permissão de edição do tipo + POL-02 (403/409 `INVALID_PROCESS_STATUS`/422 de etapa), `If-Match` com a versão do documento (428/412 `VERSION_CONFLICT` com `currentVersion`) e documento em `DRAFT`/`RETURNED` (409 `DOCUMENT_NOT_EDITABLE`). Grava `document.items_update` (sem evento); novo `ETag`.',
        schema: dataEnvelope(z.array(documentItemSchema)),
      },
    },
  })
  async replaceItems(
    @ZodParams(documentIdParamsSchema) params: { id: string },
    @ZodBody(documentItemsReplaceSchema) body: DocumentItemsReplace,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DocumentItemDto[]> {
    const result = await this.replace.execute({
      documentId: params.id,
      items: body.items,
      expectedVersion: ifMatch?.value ?? 0,
    });
    response.setHeader('ETag', `"${String(result.documentVersion)}"`);
    return result.items;
  }
}
