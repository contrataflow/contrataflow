import {
  dataEnvelope,
  documentIdParamsSchema,
  documentRenditionSchema,
  documentVersionIdParamsSchema,
  renditionDownloadSchema,
  renditionIdParamsSchema,
  renditionRequestSchema,
} from '@contrataflow/validation';
import type {
  DocumentRenditionDto,
  RenditionDownloadDto,
  RenditionRequest,
} from '@contrataflow/validation';
import { Controller, Get, HttpCode, Post } from '@nestjs/common';

import { RequirePermission } from '#shared/auth/authorization.js';
import { WithHttpStatus } from '#shared/http/envelope.interceptor.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { RateLimit } from '#shared/rate-limit/rate-limit.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodBody, ZodParams } from '#shared/validation/zod-validation.pipe.js';

import { toRenditionDto } from '../application/rendition-access.js';
import {
  RequestPreviewCommand,
  RequestRenditionCommand,
} from '../application/rendition.commands.js';
import { GetRenditionDownloadQuery, GetRenditionQuery } from '../application/rendition.queries.js';

/*
 * PDFs dos documentos (api/03-documents.md DOC-20..23 · US-067 · ADR-007): o pedido é assíncrono —
 * 202 com a `DocumentRendition` `PENDING` (o PDF nunca sai na resposta), *polling* em DOC-22 e
 * download por URL pré-assinada em DOC-23. `PROCESS_VIEW` na rota; o caso de uso confere o
 * processo do documento (DEC-024: invisível ou de outro tenant = 404) e POL-09. Classe de limite
 * "Exportações e renderização" (20 req/min por usuário + tenant).
 */

const TAGS = ['Documentos'];
const RENDITION_RESPONSE = dataEnvelope(documentRenditionSchema);

@Controller('documents')
@TenantScope('TENANT')
export class DocumentPreviewController {
  constructor(private readonly preview: RequestPreviewCommand) {}

  @Post(':id/preview')
  @HttpCode(202)
  @RateLimit('export')
  @RequirePermission('PROCESS_VIEW')
  @ApiOperation({
    operationId: 'DOC-20',
    summary: 'Gerar prévia em PDF do rascunho',
    tags: TAGS,
    auditActions: ['document.render_request'],
    responses: {
      202: {
        description:
          'Prévia `PENDING` do rascunho atual (`draftRevision`), com marca d’água "RASCUNHO" e validade de 24 h (`expiresAt`). Cada pedido gera uma prévia nova; acompanhe em DOC-22. Documento externo → 422 `NOT_ALLOWED`.',
        schema: RENDITION_RESPONSE,
      },
    },
  })
  async requestPreview(
    @ZodParams(documentIdParamsSchema) params: { id: string },
  ): Promise<DocumentRenditionDto> {
    const { rendition } = await this.preview.execute({ documentId: params.id });
    return toRenditionDto(rendition);
  }
}

@Controller('document-versions')
@TenantScope('TENANT')
export class DocumentVersionRenditionController {
  constructor(private readonly request: RequestRenditionCommand) {}

  @Post(':versionId/renditions')
  @HttpCode(202)
  @RateLimit('export')
  @RequirePermission('PROCESS_VIEW')
  @ApiOperation({
    operationId: 'DOC-21',
    summary: 'Gerar PDF de uma versão',
    tags: TAGS,
    auditActions: ['document.render_request'],
    responses: {
      202: {
        description:
          'PDF oficial (`CONTENT`) ou selo de aprovação (`APPROVAL_STAMPED` + `approvalId` que cobre a versão) `PENDING`, com o hash da versão no rodapé. Sem POL-09 sobre processo sigiloso, o PDF sai com os valores ocultos (`masked`).',
        schema: RENDITION_RESPONSE,
      },
      200: {
        description:
          'Já existe a rendition equivalente (mesma versão, tipo, aprovação e forma de POL-09) em andamento ou pronta: devolvida sem gerar outra (FA-01).',
        schema: RENDITION_RESPONSE,
      },
    },
  })
  async requestRendition(
    @ZodParams(documentVersionIdParamsSchema) params: { versionId: string },
    @ZodBody(renditionRequestSchema) body: RenditionRequest,
  ): Promise<WithHttpStatus<DocumentRenditionDto>> {
    const { rendition, reused } = await this.request.execute({
      versionId: params.versionId,
      body,
    });
    return new WithHttpStatus(reused ? 200 : 202, toRenditionDto(rendition));
  }
}

@Controller('document-renditions')
@TenantScope('TENANT')
export class DocumentRenditionController {
  constructor(
    private readonly detail: GetRenditionQuery,
    private readonly download: GetRenditionDownloadQuery,
  ) {}

  @Get(':renditionId')
  @RequirePermission('PROCESS_VIEW')
  @ApiOperation({
    operationId: 'DOC-22',
    summary: 'Consultar status de uma renderização',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Status para o *polling* (`PENDING`/`PROCESSING` → `READY`/`FAILED`; prévia vencida = `EXPIRED`), com `sha256`, `sizeBytes` e `pageCount` quando pronto. Sem chave de storage.',
        schema: RENDITION_RESPONSE,
      },
    },
  })
  async getRendition(
    @ZodParams(renditionIdParamsSchema) params: { renditionId: string },
  ): Promise<DocumentRenditionDto> {
    return toRenditionDto(await this.detail.execute(params.renditionId));
  }

  @Get(':renditionId/download')
  @RateLimit('export')
  @RequirePermission('PROCESS_VIEW')
  @ApiOperation({
    operationId: 'DOC-23',
    summary: 'Baixar PDF gerado',
    tags: TAGS,
    auditActions: ['document.download'],
    responses: {
      200: {
        description:
          'URL pré-assinada (≤ 300 s, `Content-Disposition: attachment`) do PDF `READY`. Antes de pronto ou prévia vencida → 409 `RENDITION_NOT_READY`; PDF completo de conteúdo sigiloso sem POL-09 → 403.',
        schema: dataEnvelope(renditionDownloadSchema),
      },
    },
  })
  getDownload(
    @ZodParams(renditionIdParamsSchema) params: { renditionId: string },
  ): Promise<RenditionDownloadDto> {
    return this.download.execute(params.renditionId);
  }
}
