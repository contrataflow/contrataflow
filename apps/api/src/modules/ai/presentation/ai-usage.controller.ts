import {
  aiAvailabilityQuerySchema,
  aiAvailabilityResponseSchema,
  aiUsageQuerySchema,
  aiUsageResponseSchema,
} from '@contrataflow/validation';
import type {
  AiAvailabilityDto,
  AiAvailabilityQuery,
  AiUsageDto,
  AiUsageQuery,
} from '@contrataflow/validation';
import { Controller, Get } from '@nestjs/common';

import { ImplicitAccess, RequirePermission } from '#shared/auth/authorization.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodQuery } from '#shared/validation/zod-validation.pipe.js';

import { AiUsageQueries } from '../application/ai-usage.queries.js';

const TAGS = ['Inteligência artificial'];

/**
 * AI-05 e AI-06 (api/16-ai.md · US-116): disponibilidade da IA para o usuário (indicativa — AI-01
 * decide) e consumo do órgão no mês (tokens, custo e divisões), este com `SETTINGS_MANAGE` + MFA.
 */
@Controller('ai')
@TenantScope('TENANT')
export class AiUsageController {
  constructor(private readonly queries: AiUsageQueries) {}

  @Get('availability')
  @ImplicitAccess(
    'Qualquer vínculo ativo consulta se pode gerar (RN-AI-23); com processId, o processo precisa ser visível (senão 404 NOT_FOUND) e AI_GENERATE é conferido como indicação em reasons[] — sem negar a requisição.',
  )
  @ApiOperation({
    operationId: 'AI-05',
    summary: 'Disponibilidade da IA para o usuário',
    tags: TAGS,
    responses: {
      200: {
        description:
          '`canGenerate` e os motivos (`reasons[]`); percentual do mês e uso diário próprio. Tokens absolutos só para `SETTINGS_MANAGE`.',
        schema: aiAvailabilityResponseSchema,
      },
    },
  })
  availability(
    @ZodQuery(aiAvailabilityQuerySchema) query: AiAvailabilityQuery,
  ): Promise<AiAvailabilityDto> {
    return this.queries.availability(query);
  }

  @Get('usage')
  @RequirePermission('SETTINGS_MANAGE', {
    detail: 'Você não tem permissão para configurar a IA.',
  })
  @ApiOperation({
    operationId: 'AI-06',
    summary: 'Consumo de IA do órgão',
    tags: TAGS,
    responses: {
      200: {
        description:
          'Consumo do mês (`month`, padrão: mês corrente no fuso do tenant): limite, tokens usados e reservados, custo (decimal em string; `null` se faltar preço) e a divisão por tipo de documento, tipo de geração e usuário.',
        schema: aiUsageResponseSchema,
      },
    },
  })
  usage(@ZodQuery(aiUsageQuerySchema) query: AiUsageQuery): Promise<AiUsageDto> {
    return this.queries.usage(query);
  }
}
