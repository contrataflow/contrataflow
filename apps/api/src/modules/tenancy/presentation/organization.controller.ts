import {
  createOrganizationSchema,
  dataEnvelope,
  organizationIdParamsSchema,
  organizationListQuerySchema,
  organizationSchema,
  pageEnvelope,
  updateOrganizationSchema,
} from '@contrataflow/validation';
import type {
  CreateOrganization,
  OrganizationDto,
  OrganizationListQuery,
  UpdateOrganization,
} from '@contrataflow/validation';
import { Controller, Get, HttpCode, Patch, Post, Res } from '@nestjs/common';

import type { HttpResponse } from '#shared/http/http-types.js';
import { pageResult } from '#shared/http/pagination.js';
import type { PageResult } from '#shared/http/pagination.js';
import { IfMatch, RequireIfMatch } from '#shared/http/precondition.js';
import type { IfMatchValue } from '#shared/http/precondition.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodBody, ZodParams, ZodQuery } from '#shared/validation/zod-validation.pipe.js';

import { CreateOrganizationCommand } from '../application/create-organization.command.js';
import {
  GetOrganizationQuery,
  ListOrganizationsQuery,
} from '../application/organization.queries.js';
import { UpdateOrganizationCommand } from '../application/update-organization.command.js';

const TAGS = ['Órgãos'];

/**
 * ORG-01..04 (api/14-tenant-administration.md · US-101): órgãos/entidades do tenant. Leitura é
 * capacidade implícita do vínculo ativo; criar e editar exigem `ORGANIZATION_MANAGE` (+ MFA,
 * POL-14), conferido nos casos de uso.
 */
@Controller('organizations')
@TenantScope('TENANT')
export class OrganizationController {
  constructor(
    private readonly list: ListOrganizationsQuery,
    private readonly detail: GetOrganizationQuery,
    private readonly create: CreateOrganizationCommand,
    private readonly update: UpdateOrganizationCommand,
  ) {}

  @Get()
  @ApiOperation({
    operationId: 'ORG-01',
    summary: 'Listar órgãos',
    tags: TAGS,
    responses: {
      200: {
        description: 'Órgãos do tenant por nome; filtros `isActive` e `q` (mín. 2 caracteres).',
        schema: pageEnvelope(organizationSchema),
      },
    },
  })
  async listOrganizations(
    @ZodQuery(organizationListQuerySchema) query: OrganizationListQuery,
  ): Promise<PageResult<OrganizationDto>> {
    const page = await this.list.execute(query);
    return pageResult(page.items, query, page.totalItems);
  }

  @Post()
  @ApiOperation({
    operationId: 'ORG-02',
    summary: 'Criar órgão',
    tags: TAGS,
    auditActions: ['organization.create'],
    responses: {
      201: {
        description: 'Órgão criado e ativo (`Location` e `ETag` = versão).',
        schema: dataEnvelope(organizationSchema),
      },
    },
  })
  async createOrganization(
    @ZodBody(createOrganizationSchema) body: CreateOrganization,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<OrganizationDto> {
    const created = await this.create.execute({ body });
    response.setHeader('Location', `/api/v1/organizations/${created.id}`);
    response.setHeader('ETag', `"${created.version}"`);
    return created;
  }

  @Get(':id')
  @ApiOperation({
    operationId: 'ORG-03',
    summary: 'Consultar órgão',
    tags: TAGS,
    responses: {
      200: { description: 'Órgão (`ETag` = versão).', schema: dataEnvelope(organizationSchema) },
    },
  })
  async getOrganization(
    @ZodParams(organizationIdParamsSchema) params: { id: string },
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<OrganizationDto> {
    const organization = await this.detail.execute(params.id);
    response.setHeader('ETag', `"${organization.version}"`);
    return organization;
  }

  @Patch(':id')
  @HttpCode(200)
  @RequireIfMatch()
  @ApiOperation({
    operationId: 'ORG-04',
    summary: 'Atualizar órgão (inclui inativar e reativar)',
    tags: TAGS,
    auditActions: ['organization.update'],
    responses: {
      200: {
        description: 'Órgão atualizado (novo `ETag`).',
        schema: dataEnvelope(organizationSchema),
      },
    },
  })
  async updateOrganization(
    @ZodParams(organizationIdParamsSchema) params: { id: string },
    @ZodBody(updateOrganizationSchema) body: UpdateOrganization,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<OrganizationDto> {
    const organization = await this.update.execute({
      id: params.id,
      patch: body,
      expectedVersion: ifMatch?.value ?? 0,
    });
    response.setHeader('ETag', `"${organization.version}"`);
    return organization;
  }
}
