import {
  createDepartmentSchema,
  dataEnvelope,
  departmentIdParamsSchema,
  departmentListQuerySchema,
  departmentLookupItemSchema,
  departmentLookupQuerySchema,
  departmentSchema,
  moveDepartmentSchema,
  pageEnvelope,
  updateDepartmentSchema,
} from '@contrataflow/validation';
import type {
  CreateDepartment,
  DepartmentDto,
  DepartmentListQuery,
  DepartmentLookupItem,
  DepartmentLookupQuery,
  MoveDepartment,
  UpdateDepartment,
} from '@contrataflow/validation';
import { Controller, Delete, Get, HttpCode, Patch, Post, Res } from '@nestjs/common';
import { z } from 'zod';

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
  ActivateDepartmentCommand,
  CreateDepartmentCommand,
  DeactivateDepartmentCommand,
  DeleteDepartmentCommand,
  MoveDepartmentCommand,
  UpdateDepartmentCommand,
} from '../application/department.commands.js';
import {
  GetDepartmentQuery,
  ListDepartmentsQuery,
  LookupDepartmentsQuery,
} from '../application/department.queries.js';

const TAGS = ['Secretarias e setores'];

/**
 * DEP-01..09 (api/14-tenant-administration.md · US-102): árvore de secretarias e setores dos
 * órgãos do tenant. Leitura é capacidade implícita do vínculo ativo; escrever exige
 * `DEPARTMENT_MANAGE` (sempre escopo `TENANT`), conferido nos casos de uso.
 */
@Controller('departments')
@TenantScope('TENANT')
export class DepartmentController {
  constructor(
    private readonly list: ListDepartmentsQuery,
    private readonly lookupQuery: LookupDepartmentsQuery,
    private readonly detail: GetDepartmentQuery,
    private readonly create: CreateDepartmentCommand,
    private readonly update: UpdateDepartmentCommand,
    private readonly move: MoveDepartmentCommand,
    private readonly activate: ActivateDepartmentCommand,
    private readonly deactivate: DeactivateDepartmentCommand,
    private readonly remove: DeleteDepartmentCommand,
  ) {}

  @Get()
  @ApiOperation({
    operationId: 'DEP-01',
    summary: 'Listar secretarias/setores',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Lista plana na ordem da árvore (pais antes dos filhos; irmãos por `sortOrder` e nome), com `parentId`/`path`/`depth`; filtros `organizationId`, `isActive` e `q` (mín. 2 caracteres).',
        schema: pageEnvelope(departmentSchema),
      },
    },
  })
  async listDepartments(
    @ZodQuery(departmentListQuerySchema) query: DepartmentListQuery,
  ): Promise<PageResult<DepartmentDto>> {
    const page = await this.list.execute(query);
    return pageResult(page.items, query, page.totalItems);
  }

  @Get('lookup')
  @ApiOperation({
    operationId: 'DEP-02',
    summary: 'Buscar unidades para seleção (lookup)',
    tags: TAGS,
    responses: {
      200: {
        description: 'Até 50 unidades ATIVAS por nome (seletores de novos vínculos e processos).',
        schema: dataEnvelope(z.array(departmentLookupItemSchema)),
      },
    },
  })
  lookupDepartments(
    @ZodQuery(departmentLookupQuerySchema) query: DepartmentLookupQuery,
  ): Promise<DepartmentLookupItem[]> {
    return this.lookupQuery.execute(query);
  }

  @Post()
  @Idempotent()
  @RequirePermission('DEPARTMENT_MANAGE')
  @ApiOperation({
    operationId: 'DEP-03',
    summary: 'Criar unidade',
    tags: TAGS,
    idempotent: true,
    auditActions: ['department.create'],
    responses: {
      201: {
        description: 'Unidade criada e ativa (`Location` e `ETag` = versão).',
        schema: dataEnvelope(departmentSchema),
      },
    },
  })
  async createDepartment(
    @ZodBody(createDepartmentSchema) body: CreateDepartment,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DepartmentDto> {
    const created = await this.create.execute({ body });
    response.setHeader('Location', `/api/v1/departments/${created.id}`);
    response.setHeader('ETag', `"${created.version}"`);
    return created;
  }

  @Get(':id')
  @ApiOperation({
    operationId: 'DEP-04',
    summary: 'Consultar unidade',
    tags: TAGS,
    responses: {
      200: { description: 'Unidade (`ETag` = versão).', schema: dataEnvelope(departmentSchema) },
    },
  })
  async getDepartment(
    @ZodParams(departmentIdParamsSchema) params: { id: string },
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DepartmentDto> {
    const department = await this.detail.execute(params.id);
    response.setHeader('ETag', `"${department.version}"`);
    return department;
  }

  @Patch(':id')
  @HttpCode(200)
  @RequireIfMatch()
  @RequirePermission('DEPARTMENT_MANAGE')
  @ApiOperation({
    operationId: 'DEP-05',
    summary: 'Atualizar unidade',
    tags: TAGS,
    auditActions: ['department.update'],
    responses: {
      200: {
        description: 'Unidade atualizada (novo `ETag`).',
        schema: dataEnvelope(departmentSchema),
      },
    },
  })
  async updateDepartment(
    @ZodParams(departmentIdParamsSchema) params: { id: string },
    @ZodBody(updateDepartmentSchema) body: UpdateDepartment,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DepartmentDto> {
    const department = await this.update.execute({
      id: params.id,
      patch: body,
      expectedVersion: ifMatch?.value ?? 0,
    });
    response.setHeader('ETag', `"${department.version}"`);
    return department;
  }

  @Post(':id/move')
  @HttpCode(200)
  @RequireIfMatch()
  @RequirePermission('DEPARTMENT_MANAGE')
  @ApiOperation({
    operationId: 'DEP-06',
    summary: 'Mover unidade na hierarquia',
    tags: TAGS,
    auditActions: ['department.move'],
    responses: {
      200: {
        description: 'Unidade movida; `path`/`depth` da subárvore recalculados (novo `ETag`).',
        schema: dataEnvelope(departmentSchema),
      },
    },
  })
  async moveDepartment(
    @ZodParams(departmentIdParamsSchema) params: { id: string },
    @ZodBody(moveDepartmentSchema) body: MoveDepartment,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DepartmentDto> {
    const department = await this.move.execute({
      id: params.id,
      parentId: body.parentId ?? null,
      expectedVersion: ifMatch?.value ?? 0,
    });
    response.setHeader('ETag', `"${department.version}"`);
    return department;
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  @RequireIfMatch()
  @RequirePermission('DEPARTMENT_MANAGE')
  @ApiOperation({
    operationId: 'DEP-07',
    summary: 'Desativar unidade',
    tags: TAGS,
    auditActions: ['department.deactivate'],
    responses: {
      200: {
        description: 'Unidade inativa (novo `ETag`).',
        schema: dataEnvelope(departmentSchema),
      },
    },
  })
  async deactivateDepartment(
    @ZodParams(departmentIdParamsSchema) params: { id: string },
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DepartmentDto> {
    const department = await this.deactivate.execute({
      id: params.id,
      expectedVersion: ifMatch?.value ?? 0,
    });
    response.setHeader('ETag', `"${department.version}"`);
    return department;
  }

  @Post(':id/activate')
  @HttpCode(200)
  @RequireIfMatch()
  @RequirePermission('DEPARTMENT_MANAGE')
  @ApiOperation({
    operationId: 'DEP-08',
    summary: 'Ativar unidade',
    tags: TAGS,
    auditActions: ['department.update'],
    responses: {
      200: { description: 'Unidade ativa (novo `ETag`).', schema: dataEnvelope(departmentSchema) },
    },
  })
  async activateDepartment(
    @ZodParams(departmentIdParamsSchema) params: { id: string },
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DepartmentDto> {
    const department = await this.activate.execute({
      id: params.id,
      expectedVersion: ifMatch?.value ?? 0,
    });
    response.setHeader('ETag', `"${department.version}"`);
    return department;
  }

  @Delete(':id')
  @HttpCode(204)
  @RequireIfMatch()
  @RequirePermission('DEPARTMENT_MANAGE')
  @ApiOperation({
    operationId: 'DEP-09',
    summary: 'Excluir unidade',
    tags: TAGS,
    auditActions: ['department.delete'],
    responses: {
      204: { description: 'Unidade excluída; referenciada → 409 (desativar em vez de excluir).' },
    },
  })
  async deleteDepartment(
    @ZodParams(departmentIdParamsSchema) params: { id: string },
    @IfMatch() ifMatch: IfMatchValue | null,
  ): Promise<void> {
    await this.remove.execute({ id: params.id, expectedVersion: ifMatch?.value ?? 0 });
  }
}
