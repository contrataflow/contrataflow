import { numberingPreviewResponseSchema, numberingPreviewSchema } from '@contrataflow/validation';
import type { NumberingPreview, NumberingPreviewResult } from '@contrataflow/validation';
import { Controller, HttpCode, Post } from '@nestjs/common';

import { RequirePermission } from '#shared/auth/authorization.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodBody } from '#shared/validation/zod-validation.pipe.js';

import { PreviewNumberingMaskQuery } from '../application/preview-numbering-mask.query.js';

/**
 * SET-04 (api/14-tenant-administration.md · US-105): prévia de máscara de numeração antes do
 * `PATCH /settings`. Exige `SETTINGS_MANAGE` (+ MFA, POL-14), conferido no caso de uso. Não grava
 * nada, por isso não tem auditoria própria nem `Idempotency-Key`.
 */
@Controller('numbering')
@TenantScope('TENANT')
export class NumberingController {
  constructor(private readonly previewQuery: PreviewNumberingMaskQuery) {}

  @Post('preview')
  @HttpCode(200)
  @RequirePermission('SETTINGS_MANAGE')
  @ApiOperation({
    operationId: 'SET-04',
    summary: 'Pré-visualizar máscara de numeração',
    tags: ['Configurações'],
    auditExempt:
      'Prévia somente leitura (RN-TEN-73): calcula o exemplo sem gravar nem incrementar a sequência.',
    responses: {
      200: {
        description:
          'Exemplo da máscara informada com o próximo valor hipotético (`lastValue + 1`) da sequência corrente.',
        schema: numberingPreviewResponseSchema,
      },
    },
  })
  preview(
    @ZodBody(numberingPreviewSchema) body: NumberingPreview,
  ): Promise<NumberingPreviewResult> {
    return this.previewQuery.execute(body);
  }
}
