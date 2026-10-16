import {
  dataEnvelope,
  pageEnvelope,
  templateCreateSchema,
  templateIdParamsSchema,
  templateListQuerySchema,
  templateSchema,
  templateUpdateSchema,
  templateVersionHistoryItemSchema,
  templateVersionIdParamsSchema,
  templateVersionListQuerySchema,
  templateVersionSchema,
  templateVersionUpdateSchema,
} from '@contrataflow/validation';
import type {
  TemplateCreate,
  TemplateDto,
  TemplateListQuery,
  TemplateUpdate,
  TemplateVersionDto,
  TemplateVersionHistoryItem,
  TemplateVersionListQuery,
  TemplateVersionUpdate,
} from '@contrataflow/validation';
import { Controller, Get, Headers, HttpCode, Patch, Post, Res } from '@nestjs/common';

import { RequirePermission } from '#shared/auth/authorization.js';
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
  CreateTemplateVersionCommand,
  PublishTemplateVersionCommand,
  RetireTemplateVersionCommand,
} from '../application/template-lifecycle.commands.js';
import {
  CreateTemplateCommand,
  UpdateTemplateCommand,
  UpdateTemplateVersionContentCommand,
} from '../application/template.commands.js';
import { TemplateQueries } from '../application/template.queries.js';

const TAGS = ['Templates'];

/**
 * TPL-01..08/10/11 (api/04-templates.md · US-107/US-108): templates de documento, rascunho de versão
 * e ciclo de vida das versões (nova versão, publicar, aposentar).
 */
@Controller()
@TenantScope('TENANT')
export class TemplateController {
  constructor(
    private readonly queries: TemplateQueries,
    private readonly create: CreateTemplateCommand,
    private readonly update: UpdateTemplateCommand,
    private readonly updateContent: UpdateTemplateVersionContentCommand,
    private readonly createVersion: CreateTemplateVersionCommand,
    private readonly publish: PublishTemplateVersionCommand,
    private readonly retire: RetireTemplateVersionCommand,
  ) {}

  @Get('templates')
  @RequirePermission('TEMPLATE_VIEW')
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
  @RequirePermission('TEMPLATE_MANAGE')
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
  @RequirePermission('TEMPLATE_VIEW')
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
  @RequirePermission('TEMPLATE_MANAGE')
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
  @RequirePermission('TEMPLATE_VIEW')
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
  @RequirePermission('TEMPLATE_MANAGE')
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

  @Get('templates/:id/versions')
  @RequirePermission('TEMPLATE_VIEW')
  @ApiOperation({
    operationId: 'TPL-05',
    summary: 'Listar versões do template',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Histórico de versões (filtro `status`), da mais recente para a mais antiga, sem o conteúdo (lido por TPL-07).',
        schema: pageEnvelope(templateVersionHistoryItemSchema),
      },
    },
  })
  async listTemplateVersions(
    @ZodParams(templateIdParamsSchema) params: { id: string },
    @ZodQuery(templateVersionListQuerySchema) query: TemplateVersionListQuery,
  ): Promise<PageResult<TemplateVersionHistoryItem>> {
    const page = await this.queries.listVersions(params.id, query);
    return pageResult(page.items, query, page.totalItems);
  }

  @Post('templates/:id/versions')
  @Idempotent()
  @RequirePermission('TEMPLATE_MANAGE')
  @ApiOperation({
    operationId: 'TPL-06',
    summary: 'Criar nova versão do template (rascunho)',
    tags: TAGS,
    idempotent: true,
    auditActions: ['template.version_create'],
    responses: {
      201: {
        description:
          'Rascunho que clona a versão mais recente (`Location` e `ETag` = versão); rascunho existente → 409 `TEMPLATE_DRAFT_EXISTS`.',
        schema: dataEnvelope(templateVersionSchema),
      },
    },
  })
  async createTemplateVersion(
    @ZodParams(templateIdParamsSchema) params: { id: string },
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<TemplateVersionDto> {
    const version = await this.createVersion.execute({
      templateId: params.id,
      idempotencyKey: idempotencyKey ?? null,
    });
    response.setHeader('Location', `/api/v1/template-versions/${version.id}`);
    response.setHeader('ETag', `"${version.version}"`);
    return version;
  }

  @Post('template-versions/:versionId/publish')
  @HttpCode(200)
  @Idempotent()
  @RequireIfMatch()
  @RequirePermission('TEMPLATE_PUBLISH')
  @ApiOperation({
    operationId: 'TPL-10',
    summary: 'Publicar versão do template',
    tags: TAGS,
    idempotent: true,
    auditActions: ['template.version_publish'],
    responses: {
      200: {
        description:
          'Versão publicada (imutável, com `contentHash`) e corrente do template (novo `ETag`); pendências → 422 `TEMPLATE_INVALID` com `violations[]`.',
        schema: dataEnvelope(templateVersionSchema),
      },
    },
  })
  async publishTemplateVersion(
    @ZodParams(templateVersionIdParamsSchema) params: { versionId: string },
    @IfMatch() ifMatch: IfMatchValue | null,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<TemplateVersionDto> {
    const version = await this.publish.execute({
      versionId: params.versionId,
      expectedVersion: ifMatch?.value ?? 0,
      idempotencyKey: idempotencyKey ?? null,
    });
    response.setHeader('ETag', `"${version.version}"`);
    return version;
  }

  @Post('template-versions/:versionId/retire')
  @HttpCode(200)
  @RequireIfMatch()
  @RequirePermission('TEMPLATE_PUBLISH')
  @ApiOperation({
    operationId: 'TPL-11',
    summary: 'Aposentar versão do template',
    tags: TAGS,
    auditActions: ['template.version_retire'],
    responses: {
      200: {
        description:
          'Versão aposentada (novo `ETag`); versão corrente sem substituta e padrão de tipo ativo → 409 `TEMPLATE_IN_USE`.',
        schema: dataEnvelope(templateVersionSchema),
      },
    },
  })
  async retireTemplateVersion(
    @ZodParams(templateVersionIdParamsSchema) params: { versionId: string },
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<TemplateVersionDto> {
    const version = await this.retire.execute({
      versionId: params.versionId,
      expectedVersion: ifMatch?.value ?? 0,
    });
    response.setHeader('ETag', `"${version.version}"`);
    return version;
  }
}
