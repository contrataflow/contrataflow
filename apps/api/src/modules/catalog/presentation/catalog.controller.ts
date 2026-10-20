import type { CatalogType } from '@contrataflow/types';
import {
  catalogItemIdParamsSchema,
  catalogItemListQuerySchema,
  catalogItemSchema,
  catalogTypeParamsSchema,
  createCatalogItemSchema,
  dataEnvelope,
  pageEnvelope,
  reorderCatalogItemsSchema,
  updateCatalogItemSchema,
} from '@contrataflow/validation';
import type {
  CatalogItemDto,
  CatalogItemListQuery,
  CreateCatalogItem,
  ReorderCatalogItems,
  UpdateCatalogItem,
} from '@contrataflow/validation';
import { Controller, Get, HttpCode, Patch, Post, Put, Res } from '@nestjs/common';
import { z } from 'zod';

import { RequirePermission } from '#shared/auth/authorization.js';
import type { HttpResponse } from '#shared/http/http-types.js';
import { pageResult } from '#shared/http/pagination.js';
import type { PageResult } from '#shared/http/pagination.js';
import { IfMatch, RequireIfMatch } from '#shared/http/precondition.js';
import type { IfMatchValue } from '#shared/http/precondition.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodBody, ZodParams, ZodQuery } from '#shared/validation/zod-validation.pipe.js';

import { ListCatalogItemsQuery } from '../application/catalog.queries.js';
import { CreateCatalogItemCommand } from '../application/create-catalog-item.command.js';
import { ReorderCatalogItemsCommand } from '../application/reorder-catalog-items.command.js';
import {
  ActivateCatalogItemCommand,
  DeactivateCatalogItemCommand,
  UpdateCatalogItemCommand,
} from '../application/update-catalog-item.command.js';

const TAGS = ['Catálogos'];

/**
 * CAT-01..06 (api/14-tenant-administration.md · US-104): catálogos parametrizáveis do tenant.
 * Leitura é capacidade implícita do vínculo ativo; criar, editar, ativar/desativar e reordenar
 * exigem `CATALOG_MANAGE` (+ MFA, POL-14), conferido nos casos de uso. Nenhuma rota exclui item
 * (RN-TEN-64).
 */
@Controller()
@TenantScope('TENANT')
export class CatalogController {
  constructor(
    private readonly list: ListCatalogItemsQuery,
    private readonly create: CreateCatalogItemCommand,
    private readonly update: UpdateCatalogItemCommand,
    private readonly activate: ActivateCatalogItemCommand,
    private readonly deactivate: DeactivateCatalogItemCommand,
    private readonly reorder: ReorderCatalogItemsCommand,
  ) {}

  @Get('catalogs/:catalogType/items')
  @ApiOperation({
    operationId: 'CAT-01',
    summary: 'Listar itens de um catálogo',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Itens do catálogo por `sortOrder`; filtros `isActive` e `q` (código ou rótulo).',
        schema: pageEnvelope(catalogItemSchema),
      },
    },
  })
  async listItems(
    @ZodParams(catalogTypeParamsSchema) params: { catalogType: CatalogType },
    @ZodQuery(catalogItemListQuerySchema) query: CatalogItemListQuery,
  ): Promise<PageResult<CatalogItemDto>> {
    const page = await this.list.execute(params.catalogType, query);
    return pageResult(page.items, query, page.totalItems);
  }

  @Post('catalogs/:catalogType/items')
  @RequirePermission('CATALOG_MANAGE')
  @ApiOperation({
    operationId: 'CAT-02',
    summary: 'Criar item de catálogo',
    tags: TAGS,
    auditActions: ['catalog.create'],
    responses: {
      201: {
        description: 'Item criado, ativo e não-sistema (`Location` e `ETag` = versão).',
        schema: dataEnvelope(catalogItemSchema),
      },
    },
  })
  async createItem(
    @ZodParams(catalogTypeParamsSchema) params: { catalogType: CatalogType },
    @ZodBody(createCatalogItemSchema) body: CreateCatalogItem,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<CatalogItemDto> {
    const created = await this.create.execute({ catalogType: params.catalogType, body });
    response.setHeader('Location', `/api/v1/catalog-items/${created.id}`);
    response.setHeader('ETag', `"${created.version}"`);
    return created;
  }

  @Patch('catalog-items/:id')
  @HttpCode(200)
  @RequireIfMatch()
  @RequirePermission('CATALOG_MANAGE')
  @ApiOperation({
    operationId: 'CAT-03',
    summary: 'Atualizar item de catálogo',
    tags: TAGS,
    auditActions: ['catalog.update'],
    responses: {
      200: {
        description: 'Item atualizado (novo `ETag`).',
        schema: dataEnvelope(catalogItemSchema),
      },
    },
  })
  async updateItem(
    @ZodParams(catalogItemIdParamsSchema) params: { id: string },
    @ZodBody(updateCatalogItemSchema) body: UpdateCatalogItem,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<CatalogItemDto> {
    const item = await this.update.execute({
      id: params.id,
      patch: body,
      expectedVersion: ifMatch?.value ?? 0,
    });
    response.setHeader('ETag', `"${item.version}"`);
    return item;
  }

  @Post('catalog-items/:id/activate')
  @HttpCode(200)
  @RequireIfMatch()
  @RequirePermission('CATALOG_MANAGE')
  @ApiOperation({
    operationId: 'CAT-04',
    summary: 'Ativar item de catálogo',
    tags: TAGS,
    auditActions: ['catalog.update'],
    responses: {
      200: {
        description: 'Item ativo (novo `ETag`).',
        schema: dataEnvelope(catalogItemSchema),
      },
    },
  })
  async activateItem(
    @ZodParams(catalogItemIdParamsSchema) params: { id: string },
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<CatalogItemDto> {
    const item = await this.activate.execute({
      id: params.id,
      expectedVersion: ifMatch?.value ?? 0,
    });
    response.setHeader('ETag', `"${item.version}"`);
    return item;
  }

  @Post('catalog-items/:id/deactivate')
  @HttpCode(200)
  @RequireIfMatch()
  @RequirePermission('CATALOG_MANAGE')
  @ApiOperation({
    operationId: 'CAT-05',
    summary: 'Desativar item de catálogo',
    tags: TAGS,
    auditActions: ['catalog.deactivate'],
    responses: {
      200: {
        description: 'Item inativo (novo `ETag`).',
        schema: dataEnvelope(catalogItemSchema),
      },
    },
  })
  async deactivateItem(
    @ZodParams(catalogItemIdParamsSchema) params: { id: string },
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<CatalogItemDto> {
    const item = await this.deactivate.execute({
      id: params.id,
      expectedVersion: ifMatch?.value ?? 0,
    });
    response.setHeader('ETag', `"${item.version}"`);
    return item;
  }

  @Put('catalogs/:catalogType/order')
  @HttpCode(200)
  @RequirePermission('CATALOG_MANAGE')
  @ApiOperation({
    operationId: 'CAT-06',
    summary: 'Reordenar itens de catálogo',
    tags: TAGS,
    auditActions: ['catalog.update'],
    responses: {
      200: {
        description: 'Itens do catálogo na nova ordem (`sortOrder` sequencial).',
        schema: dataEnvelope(z.array(catalogItemSchema)),
      },
    },
  })
  async reorderItems(
    @ZodParams(catalogTypeParamsSchema) params: { catalogType: CatalogType },
    @ZodBody(reorderCatalogItemsSchema) body: ReorderCatalogItems,
  ): Promise<CatalogItemDto[]> {
    return this.reorder.execute({ catalogType: params.catalogType, body });
  }
}
