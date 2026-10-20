import {
  createSupplierSchema,
  dataEnvelope,
  pageEnvelope,
  supplierIdParamsSchema,
  supplierListQuerySchema,
  supplierLookupQuerySchema,
  supplierSchema,
  updateSupplierSchema,
} from '@contrataflow/validation';
import type {
  CreateSupplier,
  SupplierDto,
  SupplierListQuery,
  SupplierLookupQuery,
  UpdateSupplier,
} from '@contrataflow/validation';
import { Controller, Delete, Get, HttpCode, Patch, Post, Res } from '@nestjs/common';

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
  CreateSupplierCommand,
  DeleteSupplierCommand,
  UpdateSupplierCommand,
} from '../application/supplier.commands.js';
import {
  GetSupplierQuery,
  ListSuppliersQuery,
  LookupSupplierQuery,
} from '../application/supplier.queries.js';

const TAGS = ['Fornecedores'];

/**
 * SUP-01..06 (api/07-price-research-suppliers.md · US-025): cadastro de fornecedores do tenant,
 * sem processo nem escopo por unidade (DEC-010). Consultar exige `SUPPLIER_VIEW`; criar, editar,
 * inativar e excluir exigem `SUPPLIER_MANAGE` (nível de tenant, conferido de novo no caso de uso
 * por causa da política de MFA). O CPF nunca sai em claro (RN-PRICE-16).
 */
@Controller('suppliers')
@TenantScope('TENANT')
export class SupplierController {
  constructor(
    private readonly list: ListSuppliersQuery,
    private readonly lookupQuery: LookupSupplierQuery,
    private readonly detail: GetSupplierQuery,
    private readonly create: CreateSupplierCommand,
    private readonly update: UpdateSupplierCommand,
    private readonly remove: DeleteSupplierCommand,
  ) {}

  @Get()
  @RequirePermission('SUPPLIER_VIEW')
  @ApiOperation({
    operationId: 'SUP-01',
    summary: 'Listar fornecedores',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Fornecedores não excluídos por razão social; filtros `q` (razão social, nome fantasia ou documento; mín. 2 caracteres) e `isActive`.',
        schema: pageEnvelope(supplierSchema),
      },
    },
  })
  async listSuppliers(
    @ZodQuery(supplierListQuerySchema) query: SupplierListQuery,
  ): Promise<PageResult<SupplierDto>> {
    const page = await this.list.execute(query);
    return pageResult(page.items, query, page.totalItems);
  }

  // Declarada antes de `:id`: `lookup` não é um identificador.
  @Get('lookup')
  @RequirePermission('SUPPLIER_VIEW')
  @ApiOperation({
    operationId: 'SUP-06',
    summary: 'Consultar fornecedor por documento',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Fornecedor do tenant com o documento informado (CNPJ numérico/alfanumérico, CPF ou estrangeiro; com ou sem máscara) ou `null`; outro tenant é `null`.',
        schema: dataEnvelope(supplierSchema.nullable()),
      },
    },
  })
  lookupSupplier(
    @ZodQuery(supplierLookupQuerySchema) query: SupplierLookupQuery,
  ): Promise<SupplierDto | null> {
    return this.lookupQuery.execute(query);
  }

  @Post()
  @Idempotent()
  @RequirePermission('SUPPLIER_MANAGE')
  @ApiOperation({
    operationId: 'SUP-02',
    summary: 'Cadastrar fornecedor',
    tags: TAGS,
    idempotent: true,
    auditActions: ['supplier.create'],
    responses: {
      201: {
        description:
          'Fornecedor criado e ativo (`Location` e `ETag` = versão); CPF mascarado; duplicidade → 409 `SUPPLIER_ALREADY_EXISTS`.',
        schema: dataEnvelope(supplierSchema),
      },
    },
  })
  async createSupplier(
    @ZodBody(createSupplierSchema) body: CreateSupplier,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<SupplierDto> {
    const created = await this.create.execute({ body });
    response.setHeader('Location', `/api/v1/suppliers/${created.id}`);
    response.setHeader('ETag', `"${created.version}"`);
    return created;
  }

  @Get(':id')
  @RequirePermission('SUPPLIER_VIEW')
  @ApiOperation({
    operationId: 'SUP-03',
    summary: 'Consultar fornecedor',
    tags: TAGS,
    responses: {
      200: { description: 'Fornecedor (`ETag` = versão).', schema: dataEnvelope(supplierSchema) },
    },
  })
  async getSupplier(
    @ZodParams(supplierIdParamsSchema) params: { id: string },
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<SupplierDto> {
    const supplier = await this.detail.execute(params.id);
    response.setHeader('ETag', `"${supplier.version}"`);
    return supplier;
  }

  @Patch(':id')
  @HttpCode(200)
  @RequireIfMatch()
  @RequirePermission('SUPPLIER_MANAGE')
  @ApiOperation({
    operationId: 'SUP-04',
    summary: 'Atualizar fornecedor',
    tags: TAGS,
    auditActions: ['supplier.update', 'supplier.deactivate'],
    responses: {
      200: {
        description:
          'Fornecedor atualizado (novo `ETag`); inclui inativar/reativar (`isActive`); alterar tipo/número do documento → 422 `NOT_ALLOWED`.',
        schema: dataEnvelope(supplierSchema),
      },
    },
  })
  async updateSupplier(
    @ZodParams(supplierIdParamsSchema) params: { id: string },
    @ZodBody(updateSupplierSchema) body: UpdateSupplier,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<SupplierDto> {
    const supplier = await this.update.execute({
      id: params.id,
      patch: body,
      expectedVersion: ifMatch?.value ?? 0,
    });
    response.setHeader('ETag', `"${supplier.version}"`);
    return supplier;
  }

  @Delete(':id')
  @HttpCode(204)
  @RequireIfMatch()
  @RequirePermission('SUPPLIER_MANAGE')
  @ApiOperation({
    operationId: 'SUP-05',
    summary: 'Excluir fornecedor',
    tags: TAGS,
    auditActions: ['supplier.delete'],
    responses: {
      204: {
        description:
          'Fornecedor excluído (lógico); em uso por fonte de preço → 409 `SUPPLIER_IN_USE` (inativar em vez de excluir).',
      },
    },
  })
  async deleteSupplier(
    @ZodParams(supplierIdParamsSchema) params: { id: string },
    @IfMatch() ifMatch: IfMatchValue | null,
  ): Promise<void> {
    await this.remove.execute({ id: params.id, expectedVersion: ifMatch?.value ?? 0 });
  }
}
