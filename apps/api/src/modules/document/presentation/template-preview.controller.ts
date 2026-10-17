import {
  dataEnvelope,
  renditionDownloadSchema,
  templatePreviewParamsSchema,
  templatePreviewRequestedSchema,
  templatePreviewSchema,
  templateVersionIdParamsSchema,
} from '@contrataflow/validation';
import type {
  RenditionDownloadDto,
  TemplatePreviewDto,
  TemplatePreviewRequestedDto,
} from '@contrataflow/validation';
import { Controller, Get, HttpCode, Post } from '@nestjs/common';

import { RequirePermission } from '#shared/auth/authorization.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { RateLimit } from '#shared/rate-limit/rate-limit.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodParams } from '#shared/validation/zod-validation.pipe.js';

import {
  RenderTemplatePreviewCommand,
  toPreviewRequestedDto,
} from '../application/template-preview.commands.js';
import {
  TemplatePreviewQueries,
  toTemplatePreviewDto,
} from '../application/template-preview.queries.js';

/*
 * TPL-09/12/13 (api/04-templates.md · US-109): prévia efêmera em PDF do layout e das seções da versão
 * do template — pedido assíncrono (202 com o `renditionId`), *polling* do estado (Redis, 24 h) e
 * download por URL pré-assinada. `TEMPLATE_VIEW` (inclusive de versões publicadas — FA-01). Classe
 * de limite "Exportações e renderização" (20 req/min). Sem auditoria (visualização).
 */

const TAGS = ['Templates'];

@Controller('template-versions')
@TenantScope('TENANT')
export class TemplatePreviewController {
  constructor(
    private readonly request: RenderTemplatePreviewCommand,
    private readonly queries: TemplatePreviewQueries,
  ) {}

  @Post(':versionId/preview')
  @HttpCode(202)
  @RateLimit('export')
  @RequirePermission('TEMPLATE_VIEW')
  @ApiOperation({
    operationId: 'TPL-09',
    summary: 'Solicitar prévia da versão do template',
    tags: TAGS,
    auditExempt:
      'Visualização de configuração (US-109): a prévia efêmera não altera dados — apenas logs técnicos do worker de renderização.',
    responses: {
      202: {
        description:
          'Prévia enfileirada (`document-render`): o layout e as seções da versão com `defaultContent` (ou espaço reservado), marca d’água "RASCUNHO" e validade de 24 h. Cliques repetidos do mesmo usuário na mesma revisão devolvem a prévia em andamento. Template com pendências → 422 `TEMPLATE_INVALID`.',
        schema: dataEnvelope(templatePreviewRequestedSchema),
      },
    },
  })
  async requestPreview(
    @ZodParams(templateVersionIdParamsSchema) params: { versionId: string },
  ): Promise<TemplatePreviewRequestedDto> {
    const { preview } = await this.request.execute(params.versionId);
    return toPreviewRequestedDto(preview);
  }

  @Get(':versionId/preview/:renditionId')
  @RequirePermission('TEMPLATE_VIEW')
  @ApiOperation({
    operationId: 'TPL-12',
    summary: 'Consultar prévia efêmera do template',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Estado para o *polling* (`PENDING`/`PROCESSING` → `READY`/`FAILED`, com `errorCode` e mensagem na falha). Vencida (24 h), de outra versão ou de outro tenant → 404.',
        schema: dataEnvelope(templatePreviewSchema),
      },
    },
  })
  async getPreview(
    @ZodParams(templatePreviewParamsSchema) params: { versionId: string; renditionId: string },
  ): Promise<TemplatePreviewDto> {
    return toTemplatePreviewDto(await this.queries.get(params.versionId, params.renditionId));
  }

  @Get(':versionId/preview/:renditionId/download')
  @RateLimit('export')
  @RequirePermission('TEMPLATE_VIEW')
  @ApiOperation({
    operationId: 'TPL-13',
    summary: 'Baixar prévia efêmera do template',
    tags: TAGS,
    responses: {
      200: {
        description:
          'URL pré-assinada (≤ 300 s) do PDF da prévia `READY`. Antes de pronta → 409 `RENDITION_NOT_READY`; vencida → 404.',
        schema: dataEnvelope(renditionDownloadSchema),
      },
    },
  })
  getDownload(
    @ZodParams(templatePreviewParamsSchema) params: { versionId: string; renditionId: string },
  ): Promise<RenditionDownloadDto> {
    return this.queries.download(params.versionId, params.renditionId);
  }
}
