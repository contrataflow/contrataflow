import {
  dataEnvelope,
  defaultTemplateSetSchema,
  documentTypeCreateSchema,
  documentTypeIdParamsSchema,
  documentTypeListQuerySchema,
  documentTypeSchema,
  documentTypeUpdateSchema,
} from '@contrataflow/validation';
import type {
  DefaultTemplateSet,
  DocumentTypeCreate,
  DocumentTypeDto,
  DocumentTypeListQuery,
  DocumentTypeUpdate,
} from '@contrataflow/validation';
import { Controller, Get, Headers, HttpCode, Patch, Post, Put, Res } from '@nestjs/common';
import { z } from 'zod';

import type { HttpResponse } from '#shared/http/http-types.js';
import { IfMatch, RequireIfMatch } from '#shared/http/precondition.js';
import type { IfMatchValue } from '#shared/http/precondition.js';
import { Idempotent } from '#shared/idempotency/idempotency.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodBody, ZodParams, ZodQuery } from '#shared/validation/zod-validation.pipe.js';

import { CreateDocumentTypeCommand } from '../application/create-document-type.command.js';
import { ListDocumentTypesQuery } from '../application/list-document-types.query.js';
import { SetDefaultTemplateCommand } from '../application/set-default-template.command.js';
import { UpdateDocumentTypeCommand } from '../application/update-document-type.command.js';

const TAGS = ['Tipos de documento'];

/**
 * DTY-01..04 (api/03-documents.md · US-061/US-108): catálogo de tipos de documento do tenant e o
 * template padrão de cada tipo.
 */
@Controller('document-types')
@TenantScope('TENANT')
export class DocumentTypeController {
  constructor(
    private readonly list: ListDocumentTypesQuery,
    private readonly create: CreateDocumentTypeCommand,
    private readonly update: UpdateDocumentTypeCommand,
    private readonly setDefault: SetDefaultTemplateCommand,
  ) {}

  @Get()
  @ApiOperation({
    operationId: 'DTY-01',
    summary: 'Listar tipos de documento',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Tipos do tenant por ordem de exibição (só ativos, salvo `includeInactive=true`, que exige `DOCUMENT_TYPE_MANAGE`).',
        schema: dataEnvelope(z.array(documentTypeSchema)),
      },
    },
  })
  listDocumentTypes(@ZodQuery(documentTypeListQuerySchema) query: DocumentTypeListQuery) {
    return this.list.execute(query);
  }

  @Post()
  @Idempotent()
  @ApiOperation({
    operationId: 'DTY-02',
    summary: 'Criar tipo de documento',
    tags: TAGS,
    idempotent: true,
    auditActions: ['document_type.create'],
    responses: {
      201: {
        description: 'Tipo criado (`Location` e `ETag` = versão).',
        schema: dataEnvelope(documentTypeSchema),
      },
    },
  })
  async createDocumentType(
    @ZodBody(documentTypeCreateSchema) body: DocumentTypeCreate,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DocumentTypeDto> {
    const created = await this.create.execute({ body, idempotencyKey: idempotencyKey ?? null });
    response.setHeader('Location', `/api/v1/document-types/${created.id}`);
    response.setHeader('ETag', `"${created.version}"`);
    return created;
  }

  @Patch(':id')
  @HttpCode(200)
  @RequireIfMatch()
  @ApiOperation({
    operationId: 'DTY-03',
    summary: 'Atualizar tipo de documento (inclui ativar e desativar)',
    tags: TAGS,
    auditActions: ['document_type.update'],
    responses: {
      200: {
        description: 'Tipo atualizado (novo `ETag`).',
        schema: dataEnvelope(documentTypeSchema),
      },
    },
  })
  async updateDocumentType(
    @ZodParams(documentTypeIdParamsSchema) params: { id: string },
    @ZodBody(documentTypeUpdateSchema) body: DocumentTypeUpdate,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DocumentTypeDto> {
    const { type } = await this.update.execute({
      id: params.id,
      patch: body,
      expectedVersion: ifMatch?.value ?? 0,
    });
    response.setHeader('ETag', `"${type.version}"`);
    return type;
  }

  @Put(':id/default-template')
  @HttpCode(200)
  @RequireIfMatch()
  @ApiOperation({
    operationId: 'DTY-04',
    summary: 'Definir template padrão do tipo',
    tags: TAGS,
    auditActions: ['document_type.update'],
    responses: {
      200: {
        description:
          'Tipo com o novo `defaultTemplate` (novo `ETag`); template de outro tipo → 422 `VALIDATION_ERROR`; sem versão publicada → 422 `BUSINESS_RULE_VIOLATION` (`TEMPLATE_NOT_PUBLISHED`).',
        schema: dataEnvelope(documentTypeSchema),
      },
    },
  })
  async setDefaultTemplate(
    @ZodParams(documentTypeIdParamsSchema) params: { id: string },
    @ZodBody(defaultTemplateSetSchema) body: DefaultTemplateSet,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DocumentTypeDto> {
    const type = await this.setDefault.execute({
      documentTypeId: params.id,
      templateId: body.templateId,
      expectedVersion: ifMatch?.value ?? 0,
    });
    response.setHeader('ETag', `"${type.version}"`);
    return type;
  }
}
