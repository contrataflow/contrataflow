import { Controller, Get, HttpCode, Module, Post } from '@nestjs/common';
import { z } from 'zod';

import { TenantTransaction } from '#shared/database/database.module.js';
import { newId } from '#shared/database/ids.js';
import { ApiError } from '#shared/errors/api-error.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { TenantContext } from '#shared/tenancy/tenant-context.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodBody, ZodParams } from '#shared/validation/zod-validation.pipe.js';

import type { TenantLeakCase } from '../../src/openapi/tenant-leak.manifest.js';

const membershipSelect = { id: true, userId: true, jobTitle: true } as const;

/**
 * Rotas de prova da suíte "tenant leak" (US-100), só nos testes: um recurso de tenant real
 * (`tenant_memberships`/`membership_departments`) lido e gravado como as stories de negócio farão —
 * pelo `TenantTransaction`, SEM filtro de tenant escrito à mão (a extensão e a RLS garantem). Fazem o
 * papel de PRC-xx até a US-001 criar `processes`.
 */
@Controller('_leak')
@TenantScope('TENANT')
export class LeakProbeController {
  constructor(private readonly transaction: TenantTransaction) {}

  @Get('memberships')
  @ApiOperation({
    operationId: 'LEAK-01',
    summary: 'Lista os vínculos do tenant',
    internal: true,
    responses: { 200: { description: 'Vínculos.' } },
  })
  list() {
    return this.transaction.read((tx) =>
      tx.tenantMembership.findMany({ select: membershipSelect, orderBy: { id: 'asc' } }),
    );
  }

  @Get('memberships/:membershipId')
  @ApiOperation({
    operationId: 'LEAK-02',
    summary: 'Detalha um vínculo',
    internal: true,
    responses: { 200: { description: 'Vínculo.' } },
  })
  async get(
    @ZodParams(z.strictObject({ membershipId: z.uuid() })) params: { membershipId: string },
  ) {
    const membership = await this.transaction.read((tx) =>
      tx.tenantMembership.findUnique({
        where: { id: params.membershipId },
        select: membershipSelect,
      }),
    );
    if (!membership) {
      throw new ApiError('MEMBERSHIP_NOT_FOUND', {
        status: 404,
        title: 'Vínculo não encontrado',
        detail: 'Vínculo não encontrado.',
      });
    }
    return membership;
  }

  @Post('membership-departments')
  @HttpCode(201)
  @ApiOperation({
    operationId: 'LEAK-03',
    summary: 'Lota um vínculo numa unidade',
    internal: true,
    auditExempt: 'Rota de prova da suíte tenant leak, só nos testes de integração.',
    responses: { 201: { description: 'Lotação criada.' } },
  })
  create(
    @ZodBody(z.strictObject({ membershipId: z.uuid(), departmentId: z.uuid() }))
    body: {
      membershipId: string;
      departmentId: string;
    },
  ) {
    const { tenantId } = TenantContext.getOrThrow();
    return this.transaction.run((tx) =>
      tx.membershipDepartment.create({
        data: { id: newId(), tenantId, ...body },
        select: { id: true },
      }),
    );
  }

  @Get('context')
  @ApiOperation({
    operationId: 'LEAK-04',
    summary: 'Ecoa o app.tenant_id da transação',
    internal: true,
    responses: { 200: { description: 'Contexto do banco.' } },
  })
  async context() {
    const [row] = await this.transaction.read(
      (tx) => tx.$queryRaw<{ tenant: string }[]>`SELECT current_setting('app.tenant_id') AS tenant`,
    );
    return { tenant: row?.tenant ?? null };
  }
}

@Module({ controllers: [LeakProbeController] })
export class LeakProbeModule {}

/** Classificação das rotas de prova na suíte (mesma forma do manifesto da API). */
export const PROBE_MANIFEST: Readonly<Record<string, TenantLeakCase>> = {
  'LEAK-01': { kind: 'covered' },
  'LEAK-02': { kind: 'covered', pathParams: { membershipId: 'membership' } },
  'LEAK-03': {
    kind: 'covered',
    body: (ids) => ({ membershipId: ids('membership'), departmentId: ids('department') }),
    referenceFields: ['membershipId'],
  },
  'LEAK-04': { kind: 'covered' },
};
