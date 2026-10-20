import { PLATFORM_TENANT_MANAGE } from '@contrataflow/types';
import {
  dataEnvelope,
  pageEnvelope,
  platformTenantDetailSchema,
  platformTenantSchema,
  platformTenantSummarySchema,
  provisionTenantResultSchema,
  provisionTenantSchema,
  tenantActivateSchema,
  tenantIdParamsSchema,
  tenantListQuerySchema,
  tenantReasonSchema,
} from '@contrataflow/validation';
import type {
  PlatformTenantDetailDto,
  PlatformTenantDto,
  PlatformTenantSummaryDto,
  ProvisionTenant,
  ProvisionTenantResultDto,
  TenantListQuery,
  TenantReason,
} from '@contrataflow/validation';
import { Controller, Get, Headers, HttpCode, Post, Res } from '@nestjs/common';

import { PlatformPermission } from '#shared/auth/platform-operator.guard.js';
import { requireRequestContext } from '#shared/context/request-context.js';
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
  toProvisionResultDto,
  toTenantDetailDto,
  toTenantDto,
  toTenantSummaryDto,
} from './platform-tenant.dto.js';
import { ChangeTenantStatusCommand } from '../application/change-tenant-status.command.js';
import { ProvisionTenantCommand } from '../application/provision-tenant.command.js';
import type { PlatformOperatorRef } from '../application/tenancy-support.js';
import { provisioningIncomplete } from '../application/tenancy-support.js';
import { GetTenantQuery, ListTenantsQuery } from '../application/tenant.queries.js';

const TAGS = ['Plataforma — tenants'];

/** Operador autenticado (o `PlatformOperatorGuard` já conferiu `isPlatformOperator` e MFA). */
function operator(): PlatformOperatorRef {
  const { actor } = requireRequestContext();
  return { id: actor.userId ?? '', name: actor.name ?? 'Operador da plataforma' };
}

/**
 * PLT-01..05 (api/15-platform-health.md · US-099): API de plataforma para automações internas e o
 * backoffice futuro (DT-07); a CLI usa os mesmos casos de uso. Sem tenant ativo
 * (`@TenantScope('PLATFORM')`), só operador da plataforma com MFA (`PLATFORM_TENANT_MANAGE`).
 * Encerramento e desativação ficam só na CLI no MVP 1 (FA-06).
 */
@Controller('platform/tenants')
@TenantScope('PLATFORM')
@PlatformPermission(PLATFORM_TENANT_MANAGE)
export class PlatformTenantsController {
  constructor(
    private readonly provision: ProvisionTenantCommand,
    private readonly changeStatus: ChangeTenantStatusCommand,
    private readonly list: ListTenantsQuery,
    private readonly detail: GetTenantQuery,
  ) {}

  @Post()
  @Idempotent()
  @ApiOperation({
    operationId: 'PLT-01',
    summary: 'Provisionar tenant',
    tags: TAGS,
    idempotent: true,
    auditActions: ['tenant.provision', 'tenant.activate'],
    responses: {
      201: {
        description:
          'Tenant provisionado (e ativado, salvo `activate: false`) com o checklist calculado (`Location`, `ETag`).',
        schema: dataEnvelope(provisionTenantResultSchema),
      },
    },
  })
  async provisionTenant(
    @ZodBody(provisionTenantSchema) body: ProvisionTenant,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<ProvisionTenantResultDto> {
    const outcome = await this.provision.execute({
      input: body,
      operator: operator(),
      channel: 'API',
      idempotencyKey: idempotencyKey ?? null,
    });
    // 5xx não é memorizado pela idempotência: a mesma chave retoma (FA-01).
    if (outcome.kind === 'incomplete') throw provisioningIncomplete(outcome.checklist);
    response.setHeader('Location', `/api/v1/platform/tenants/${outcome.tenant.id}`);
    response.setHeader('ETag', `"${outcome.tenant.version}"`);
    return toProvisionResultDto(
      outcome.tenant,
      outcome.checklist,
      outcome.firstAdmin,
      body.firstAdmin.email,
    );
  }

  @Get()
  @ApiOperation({
    operationId: 'PLT-02',
    summary: 'Listar tenants (plataforma)',
    tags: TAGS,
    responses: {
      200: {
        description: 'Tenants por nome — só metadados, nunca dados de negócio.',
        schema: pageEnvelope(platformTenantSummarySchema),
      },
    },
  })
  async listTenants(
    @ZodQuery(tenantListQuerySchema) query: TenantListQuery,
  ): Promise<PageResult<PlatformTenantSummaryDto>> {
    const page = await this.list.execute({
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.stateCode === undefined ? {} : { stateCode: query.stateCode }),
      ...(query.q === undefined || query.q === '' ? {} : { q: query.q }),
      page: query.page,
      pageSize: query.pageSize,
    });
    return pageResult(page.items.map(toTenantSummaryDto), query, page.totalItems);
  }

  @Get(':id')
  @ApiOperation({
    operationId: 'PLT-03',
    summary: 'Consultar tenant (plataforma)',
    tags: TAGS,
    responses: {
      200: {
        description: 'Dados do tenant e checklist calculado (só contagens); `ETag` = versão.',
        schema: dataEnvelope(platformTenantDetailSchema),
      },
    },
  })
  async getTenant(
    @ZodParams(tenantIdParamsSchema) params: { id: string },
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<PlatformTenantDetailDto> {
    const { tenant, provisioning } = await this.detail.execute({ id: params.id });
    response.setHeader('ETag', `"${tenant.version}"`);
    return toTenantDetailDto(tenant, provisioning);
  }

  @Post(':id/activate')
  @HttpCode(200)
  @RequireIfMatch()
  @ApiOperation({
    operationId: 'PLT-04',
    summary: 'Ativar ou reativar tenant',
    tags: TAGS,
    auditActions: ['tenant.activate'],
    responses: {
      200: {
        description:
          '`PROVISIONING` (checklist completo, envia o convite), `SUSPENDED` ou `OFFBOARDING` → `ACTIVE`.',
        schema: dataEnvelope(platformTenantSchema),
      },
    },
  })
  async activateTenant(
    @ZodParams(tenantIdParamsSchema) params: { id: string },
    @ZodBody(tenantActivateSchema) _body: Record<string, never>,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<PlatformTenantDto> {
    const { tenant } = await this.changeStatus.execute({
      tenant: { id: params.id },
      action: 'ACTIVATE',
      expectedVersion: ifMatch?.value ?? 0,
      operator: operator(),
      channel: 'API',
    });
    response.setHeader('ETag', `"${tenant.version}"`);
    return toTenantDto(tenant);
  }

  @Post(':id/suspend')
  @HttpCode(200)
  @RequireIfMatch()
  @ApiOperation({
    operationId: 'PLT-05',
    summary: 'Suspender tenant',
    tags: TAGS,
    auditActions: ['tenant.suspend'],
    responses: {
      200: {
        description: '`ACTIVE` → `SUSPENDED`; requisições de usuários recebem 403 em até 60 s.',
        schema: dataEnvelope(platformTenantSchema),
      },
    },
  })
  async suspendTenant(
    @ZodParams(tenantIdParamsSchema) params: { id: string },
    @ZodBody(tenantReasonSchema) body: TenantReason,
    @IfMatch() ifMatch: IfMatchValue | null,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<PlatformTenantDto> {
    const { tenant } = await this.changeStatus.execute({
      tenant: { id: params.id },
      action: 'SUSPEND',
      expectedVersion: ifMatch?.value ?? 0,
      reason: body.reason,
      operator: operator(),
      channel: 'API',
    });
    response.setHeader('ETag', `"${tenant.version}"`);
    return toTenantDto(tenant);
  }
}
