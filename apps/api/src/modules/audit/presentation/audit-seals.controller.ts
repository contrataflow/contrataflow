import {
  auditSealListQuerySchema,
  auditSealSchema,
  auditSealVerificationSchema,
  dataEnvelope,
  pageEnvelope,
  verifyAuditSealsSchema,
} from '@contrataflow/validation';
import type {
  AuditSealDto,
  AuditSealListQuery,
  AuditSealVerification,
  VerifyAuditSeals,
} from '@contrataflow/validation';
import { Controller, Get, HttpCode, Post } from '@nestjs/common';

import { RequirePermission } from '#shared/auth/authorization.js';
import type { PageResult } from '#shared/http/pagination.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodBody, ZodQuery } from '#shared/validation/zod-validation.pipe.js';

import {
  GetAuditSealsHandler,
  VerifyAuditSealsHandler,
} from '../application/audit-seals.handlers.js';

const TAGS = ['Auditoria'];

/**
 * AUD-04/AUD-05 (api/13-dashboard-notifications-audit.md · US-074): selos de integridade da trilha
 * para a aba "Selos" de SCR-037. `AUDIT_VIEW` é de risco `HIGH`: o guard aplica também o MFA
 * (POL-14) e grava `access.denied` na recusa.
 */
@Controller('audit/seals')
@TenantScope('TENANT')
export class AuditSealsController {
  constructor(
    private readonly list: GetAuditSealsHandler,
    private readonly verify: VerifyAuditSealsHandler,
  ) {}

  @Get()
  @RequirePermission('AUDIT_VIEW')
  @ApiOperation({
    operationId: 'AUD-04',
    summary: 'Listar selos de integridade',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Selos do tenant, mais recentes primeiro (`periodStart DESC`), por página; `periodFrom`/`periodTo` filtram `periodStart` (inclusivo, UTC). Cada selo cobre uma hora cheia com atividade (`recordCount ≥ 1` — RN-AUD-12). A consulta é auditada como `audit.search`.',
        schema: pageEnvelope(auditSealSchema),
      },
    },
  })
  listSeals(
    @ZodQuery(auditSealListQuerySchema) query: AuditSealListQuery,
  ): Promise<PageResult<AuditSealDto>> {
    return this.list.execute(query);
  }

  @Post('verify')
  @HttpCode(200)
  @RequirePermission('AUDIT_VIEW')
  @ApiOperation({
    operationId: 'AUD-05',
    summary: 'Verificar integridade dos selos',
    tags: TAGS,
    auditExempt:
      'Verificação somente de leitura (US-074): recalcula os selos do intervalo e não grava nada; o POST só carrega o intervalo.',
    responses: {
      200: {
        description:
          'Resultado por selo do intervalo, em ordem de período (RN-AUD-15/16): `VALID` ou `INVALID` com a quebra em `digest` (registro do período alterado, removido ou inserido) ou `chain` (selo anterior alterado ou ausente); `brokenAtPeriodStart` = primeira quebra. Intervalo acima de `audit.sealVerification.maxPeriods` horas = 422 `VALIDATION_ERROR` (`OUT_OF_RANGE`); nenhum selo do tenant no intervalo = 404 `NOT_FOUND`; banco fora do ar = 503 `DEPENDENCY_UNAVAILABLE`.',
        schema: dataEnvelope(auditSealVerificationSchema),
      },
    },
  })
  verifySeals(
    @ZodBody(verifyAuditSealsSchema) body: VerifyAuditSeals,
  ): Promise<AuditSealVerification> {
    return this.verify.execute(body);
  }
}
