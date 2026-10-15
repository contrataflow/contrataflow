import {
  dataEnvelope,
  pageEnvelope,
  templateCreateSchema,
  templateIdParamsSchema,
  templateListQuerySchema,
  templateSchema,
  templateUpdateSchema,
  templateVersionIdParamsSchema,
  templateVersionSchema,
  templateVersionUpdateSchema,
} from '@contrataflow/validation';
import type {
  TemplateCreate,
  TemplateDto,
  TemplateListQuery,
  TemplateUpdate,
  TemplateVersionDto,
  TemplateVersionUpdate,
} from '@contrataflow/validation';
import { Controller, Get, Headers, HttpCode, Patch, Post, Res } from '@nestjs/common';

import type { HttpResponse } from '#shared/http/http-types.js';
import { pageResult } from '#shared/http/pagination.js';
import type { PageResult } from '#shared/http/pagination.js';
import { IfMatch, RequireIfMatch } from '#shared/http/precondition.js';
import type { IfMatchValue } from '#shared/http/precondition.js';
import { Idempotent } from '#shared/idempotency/idempotency.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodBody, ZodParams, ZodQuery } from '#shared/validation/zod-validation.pipe.js';

import {
  CreateTemplateCommand,
  UpdateTemplateCommand,
  UpdateTemplateVersionContentCommand,
} from '../application/template.commands.js';
import { TemplateQueries } from '../application/template.queries.js';

const TAGS = ['Templates'];

/** TPL-01..04/07/08 (api/04-templates.md · US-107): templates de documento e rascunho de versão. */
@Controller()
@TenantScope('TENANT')
export class TemplateController {
  constructor(
    private readonly queries: TemplateQueries,
    private readonly create: CreateTemplateCommand,
    private readonly update: UpdateTemplateCommand,
    private readonly updateContent: UpdateTemplateVersionContentCommand,
  ) {}

  @Get('templates')
  @ApiOperation({
    operationId: 'TPL-01',
    summary: 'Listar templates',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Templates do tenant por nome (filtros `documentTypeId`, `q` e `isActive`), com o rascunho e a versão publicada de cada um.',
        schema: pageEnvelope(templateSchema),
      },
    },
  })
  async listTemplates(
    @ZodQuery(templateListQuerySchema) query: TemplateListQuery,
  ): Promise<PageResult<TemplateDto>> {
    const page = await this.queries.list(query);
    return pageResult(page.items, query, page.totalItems);
  }

  @Post('templates')
  @Idempotent()
  @ApiOperation({
    operationId: 'TPL-02',
    summary: 'Criar template',
    tags: TAGS,
    idempotent: true,
    auditActions: ['template.create'],
    responses: {
      201: {
        description: 'Template criado com a versão 1 em `DRAFT` (`Location` e `ETag` = versão).',
        schema: dataEnvelope(templateSchema),
      },
    },
  })
  async createTemplate(
    @ZodBody(templateCreateSchema) body: TemplateCreate,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<TemplateDto> {
    const created = await this.create.execute({ body, idempotencyKey: idempotencyKey ?? null });
    response.setHeader('Location', `/api/v1/templates/${created.id}`);
    response.setHeader('ETag', `"${created.version}"`);
    return created;
  }

  @Get('templates/:id')
  @ApiOperation({
    operationId: 'TPL-03',
    summary: 'Consultar template',
    tags: TAGS,
    responses: {
      200: { description: 'Template (`ETag` = versão).', schema: dataEnvelope(templateSchema) },
    },
  })
  async getTemplate(
    @ZodParams(templateIdParamsSchema) params: { id: string },
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<TemplateDto> {
    const template = await this.queries.get(params.id);
    response.setHeader('ETag', `"${template.version}"`);
    return template;
  }

  @Patch('templates/:id')
  @HttpCode(200)
  @RequireIfMatch()
  @ApiOperation({
    operationId: 'TPL-04',
    summary: 'Atualizar dados do template',
    tags: TAGS,
    auditActions: ['template.update'],
    responses: {
      200: {
        description: 'Metadados atualizados (novo `ETag`).',
        schema: dataEnvelope(templateSchema),
      },
    },
  })
  async updateTemplate(
    @ZodParams(templateIdParamsSchema) params: { id: string },
    @ZodBody(templateUpdateSchema) body: TemplateUpdate,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<TemplateDto> {
    const template = await this.update.execute({
      id: params.id,
      patch: body,
      expectedVersion: ifMatch?.value ?? 0,
    });
    response.setHeader('ETag', `"${template.version}"`);
    return template;
  }

  @Get('template-versions/:versionId')
  @ApiOperation({
    operationId: 'TPL-07',
    summary: 'Consultar versão do template',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Versão com seções, `fieldConfig`, `importMappings` e layout (`ETag` = versão).',
        schema: dataEnvelope(templateVersionSchema),
      },
    },
  })
  async getTemplateVersion(
    @ZodParams(templateVersionIdParamsSchema) params: { versionId: string },
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<TemplateVersionDto> {
    const version = await this.queries.getVersion(params.versionId);
    response.setHeader('ETag', `"${version.version}"`);
    return version;
  }

  @Patch('template-versions/:versionId')
  @HttpCode(200)
  @RequireIfMatch()
  @ApiOperation({
    operationId: 'TPL-08',
    summary: 'Atualizar conteúdo da versão do template (rascunho)',
    tags: TAGS,
    auditActions: ['template.update'],
    responses: {
      200: {
        description:
          'Rascunho atualizado (novo `ETag`); conteúdo inválido → 422 `TEMPLATE_INVALID` com `violations[]`.',
        schema: dataEnvelope(templateVersionSchema),
      },
    },
  })
  async updateTemplateVersion(
    @ZodParams(templateVersionIdParamsSchema) params: { versionId: string },
    @ZodBody(templateVersionUpdateSchema) body: TemplateVersionUpdate,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<TemplateVersionDto> {
    const version = await this.updateContent.execute({
      versionId: params.versionId,
      patch: body,
      expectedVersion: ifMatch?.value ?? 0,
    });
    response.setHeader('ETag', `"${version.version}"`);
    return version;
  }
}
