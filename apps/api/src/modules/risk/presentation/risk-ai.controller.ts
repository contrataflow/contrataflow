import {
  applyAiRisksResultSchema,
  applyAiRisksSchema,
  dataEnvelope,
  reviewAiRisksResultSchema,
  reviewAiRisksSchema,
} from '@contrataflow/validation';
import type {
  ApplyAiRisks,
  ApplyAiRisksResultDto,
  ReviewAiRisks,
  ReviewAiRisksResultDto,
} from '@contrataflow/validation';
import { Controller, Headers, HttpCode, Post } from '@nestjs/common';

import { ImplicitAccess } from '#shared/auth/authorization.js';
import { Idempotent } from '#shared/idempotency/idempotency.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodBody } from '#shared/validation/zod-validation.pipe.js';

import { PathId } from './risk.controller.js';
import { ApplyAiRisksCommand, ReviewAiRisksCommand } from '../application/risk-ai.commands.js';

const TAGS = ['Riscos'];

const WRITE_ACCESS =
  'RISK_MANAGE cobrindo o processo — por perfil ou por participação COLLABORATOR/CONSULTANT — conferida no caso de uso com a POL-02 estendida (RN-RISK-09, `RISK_MAP` travado); sem permissão = 403 PERMISSION_DENIED com access.denied.';

/**
 * Riscos propostos pela IA (api/08-risks.md · US-119): RSK-11 (aplicar a seleção da proposta) e
 * RSK-12 (marcar como revisados). A geração é do `ai` (AI-01..04); a criação e a revisão são do
 * `risk`, por uma pessoa (princípio 16 · DEC-079).
 */
@Controller()
@TenantScope('TENANT')
export class RiskAiController {
  constructor(
    private readonly apply: ApplyAiRisksCommand,
    private readonly review: ReviewAiRisksCommand,
  ) {}

  @Post('processes/:id/risks/ai-apply')
  @Idempotent()
  @ImplicitAccess(WRITE_ACCESS)
  @ApiOperation({
    operationId: 'RSK-11',
    summary: 'Aplicar riscos propostos pela IA',
    tags: TAGS,
    idempotent: true,
    auditActions: ['risk.create', 'risk.treatment_create', 'ai.content_apply'],
    responses: {
      201: {
        description:
          'Numa transação: cada risco escolhido vira `Risk` (próximo código `R{nn}`, escore/nível pelas faixas vigentes, `scaleSnapshot`, `aiGenerationId`, sem responsável — "gerado por IA" até o RSK-12) e cada tratamento escolhido vira `RiskTreatment` (`PLANNED`, sem responsável nem prazo; o risco com tratamento nasce `IN_TREATMENT`); a geração vai a `APPLIED` (`appliedTargets.riskIds` — as seções do `RISK_MAP` seguem pelo DOC-26). Grava `risk.create`, `risk.treatment_create` e `ai.content_apply`; eventos `RiskCreated`, `RiskTreatmentChanged` (`CREATED`) e `AiContentApplied` (timeline `AI_CONTENT_APPLIED`). Erros: 403 `PERMISSION_DENIED`/`NOT_PROCESS_CUSTODIAN`/`AI_GENERATION_NOT_OWNED`, 404 `NOT_FOUND`/`AI_GENERATION_NOT_FOUND`, 409 `DOCUMENT_NOT_EDITABLE`/`AI_GENERATION_NOT_APPLICABLE` (não `SUCCEEDED`, vencida, de outro processo ou riscos já aplicados), 422 `VALIDATION_ERROR` (seleção vazia, chave fora da proposta — `NOT_ALLOWED`, categoria inativa — `REFERENCE_INACTIVE`). Reenvio com a mesma chave = mesma resposta com `Idempotent-Replayed: true`.',
        schema: dataEnvelope(applyAiRisksResultSchema),
      },
    },
  })
  async applyAiRisks(
    @PathId('process') id: string,
    @ZodBody(applyAiRisksSchema) body: ApplyAiRisks,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ): Promise<ApplyAiRisksResultDto> {
    const result = await this.apply.execute({
      processId: id,
      body,
      idempotencyKey: idempotencyKey ?? null,
    });
    return { risks: result.risks };
  }

  @Post('processes/:id/risks/ai-review')
  @HttpCode(200)
  @ImplicitAccess(WRITE_ACCESS)
  @ApiOperation({
    operationId: 'RSK-12',
    summary: 'Marcar riscos gerados por IA como revisados',
    tags: TAGS,
    auditActions: ['ai.content_review'],
    responses: {
      200: {
        description:
          'Grava `aiReviewedAt`/`aiReviewedById` (`version + 1`) em cada risco gerado por IA ainda pendente; riscos sem `aiGenerationId` ou já revisados são ignorados (idempotente). Os tratamentos são revisados com o risco. Concorrência por risco (`expectedVersions`): divergência → 412 `VERSION_CONFLICT` com `meta.current`, sem revisar nenhum. Grava `ai.content_review` e `AiContentReviewed` (timeline `AI_CONTENT_REVIEWED`). Erros: 403, 404 `NOT_FOUND`, 409 `DOCUMENT_NOT_EDITABLE`, 422 `VALIDATION_ERROR` (lista vazia; risco de outro processo — `REFERENCE_NOT_FOUND`).',
        schema: dataEnvelope(reviewAiRisksResultSchema),
      },
    },
  })
  async reviewAiRisks(
    @PathId('process') id: string,
    @ZodBody(reviewAiRisksSchema) body: ReviewAiRisks,
  ): Promise<ReviewAiRisksResultDto> {
    const result = await this.review.execute({
      processId: id,
      riskIds: body.riskIds,
      expectedVersions: body.expectedVersions,
    });
    return { risks: result.risks, reviewedRiskIds: result.reviewedRiskIds };
  }
}
