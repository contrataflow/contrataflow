import { AI_POLL_AFTER_MS } from '@contrataflow/types';
import {
  aiGenerationIdParamsSchema,
  aiGenerationListItemSchema,
  aiGenerationListQuerySchema,
  aiGenerationRequestedMetaSchema,
  aiGenerationSchema,
  aiProcessIdParamsSchema,
  cursorMetaSchema,
  dataEnvelope,
  requestAiGenerationSchema,
} from '@contrataflow/validation';
import type {
  AiGenerationDto,
  AiGenerationListItemDto,
  AiGenerationListQuery,
  RequestAiGeneration,
} from '@contrataflow/validation';
import { Controller, Get, Headers, HttpCode, Post, Res } from '@nestjs/common';
import { z } from 'zod';

import { ImplicitAccess, Policy, RequirePermission } from '#shared/auth/authorization.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { DataResult } from '#shared/http/envelope.interceptor.js';
import type { HttpResponse } from '#shared/http/http-types.js';
import type { CursorResult } from '#shared/http/pagination.js';
import { Idempotent } from '#shared/idempotency/idempotency.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { RateLimit } from '#shared/rate-limit/rate-limit.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodBody, ZodParams, ZodQuery } from '#shared/validation/zod-validation.pipe.js';

import { AiGenerationQueries } from '../application/ai-generation.queries.js';
import { toAiGenerationDto } from '../application/ai-generation.view.js';
import { DiscardAiGenerationCommand } from '../application/discard-ai-generation.command.js';
import { RequestAiGenerationCommand } from '../application/request-ai-generation.command.js';

const TAGS = ['Inteligência artificial'];

const REQUESTED_RESPONSE = z.object({
  data: aiGenerationSchema,
  meta: aiGenerationRequestedMetaSchema,
});

const LIST_RESPONSE = z.object({
  data: z.array(aiGenerationListItemSchema),
  meta: cursorMetaSchema,
});

/** AI-04 aceita só `{}`. */
const discardBodySchema = z.strictObject({});

/**
 * AI-01..04 (api/16-ai.md · US-115): pedido assíncrono (202 + `Location`, sem chamada ao provedor
 * na requisição — RN-AI-02), consulta para o polling, histórico do processo e descarte/cancelamento
 * pelo solicitante. Geração de outro tenant ou de processo não visível → 404
 * `AI_GENERATION_NOT_FOUND`; processo de outro tenant → 404 `PROCESS_NOT_FOUND`.
 */
@Controller()
@TenantScope('TENANT')
export class AiGenerationController {
  constructor(
    private readonly requestGeneration: RequestAiGenerationCommand,
    private readonly discardGeneration: DiscardAiGenerationCommand,
    private readonly queries: AiGenerationQueries,
  ) {}

  @Post('processes/:id/ai-generations')
  @HttpCode(202)
  @Idempotent()
  @RateLimit('ai')
  @RequirePermission('AI_GENERATE', {
    scope: { processParam: 'id' },
    detail: 'Você não tem permissão para gerar conteúdo com IA neste processo.',
  })
  @Policy('POL-18')
  @ApiOperation({
    operationId: 'AI-01',
    summary: 'Solicitar geração com IA',
    tags: TAGS,
    idempotent: true,
    auditActions: ['ai.generation_request', 'ai.generation_discard'],
    responses: {
      202: {
        description:
          'Geração registrada em `QUEUED` antes de qualquer chamada ao provedor e enfileirada após o commit (`Location` = AI-02; consulte a cada `meta.pollAfterMs`). Ajuste de seção (`kind = SECTION`, US-121): `action` + `sectionKey` + `documentId`, `baseRevision` = revisão da seção no pedido; 422 `AI_SECTION_EMPTY` (`REWRITE`/`SUMMARIZE` com menos de 50 caracteres) e `AI_SECTION_NOT_SUPPORTED` (fora do template, sem narrativa ou `NOT_APPLICABLE`).',
        schema: REQUESTED_RESPONSE,
      },
    },
  })
  async request(
    @ZodParams(aiProcessIdParamsSchema) params: { id: string },
    @ZodBody(requestAiGenerationSchema) body: RequestAiGeneration,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<DataResult<AiGenerationDto, { pollAfterMs: number }>> {
    const { generation } = await this.requestGeneration.execute({
      processId: params.id,
      body,
      idempotencyKey: idempotencyKey ?? null,
    });
    response.setHeader('Location', `/api/v1/ai-generations/${generation.id}`);
    const dto = toAiGenerationDto(generation, requesterName());
    return new DataResult(dto, { pollAfterMs: AI_POLL_AFTER_MS });
  }

  @Get('ai-generations/:generationId')
  @ImplicitAccess(
    'PROCESS_VIEW do processo DA GERAÇÃO, conferido pelo caso de uso (o processo não está no caminho): geração inexistente, de outro tenant ou de processo não visível = 404 AI_GENERATION_NOT_FOUND; visível sem a permissão = 403.',
  )
  @ApiOperation({
    operationId: 'AI-02',
    summary: 'Consultar geração',
    tags: TAGS,
    responses: {
      200: {
        description:
          'A geração (sem custo, resumo nem instrução); `output` só em `SUCCEEDED`/`APPLIED`. `ETag` = status + `updatedAt`.',
        schema: dataEnvelope(aiGenerationSchema),
      },
    },
  })
  async get(
    @ZodParams(aiGenerationIdParamsSchema) params: { generationId: string },
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<AiGenerationDto> {
    const view = await this.queries.get(params.generationId);
    response.setHeader('ETag', view.etag);
    return view.dto;
  }

  @Get('processes/:id/ai-generations')
  @RequirePermission('PROCESS_VIEW', { scope: { processParam: 'id' } })
  @ApiOperation({
    operationId: 'AI-03',
    summary: 'Listar gerações do processo',
    tags: TAGS,
    responses: {
      200: {
        description: 'Histórico de IA do processo (`createdAt desc`, cursor), sem `output`.',
        schema: LIST_RESPONSE,
      },
    },
  })
  list(
    @ZodParams(aiProcessIdParamsSchema) params: { id: string },
    @ZodQuery(aiGenerationListQuerySchema) query: AiGenerationListQuery,
  ): Promise<CursorResult<AiGenerationListItemDto>> {
    return this.queries.list(params.id, query);
  }

  @Post('ai-generations/:generationId/discard')
  @HttpCode(200)
  @ImplicitAccess(
    'Só o solicitante descarta a proposta ou cancela a geração (RN-AI-13 · AI_GENERATION_NOT_OWNED), conferido pelo caso de uso; não depende de AI_GENERATE nem da IA ligada.',
  )
  @ApiOperation({
    operationId: 'AI-04',
    summary: 'Descartar proposta ou cancelar geração',
    tags: TAGS,
    auditActions: ['ai.generation_discard'],
    responses: {
      200: {
        description:
          '`SUCCEEDED` → `DISCARDED`; `QUEUED`/`RUNNING` → `CANCELED`. Já descartada/cancelada: devolvida sem novo efeito.',
        schema: dataEnvelope(aiGenerationSchema),
      },
    },
  })
  async discard(
    @ZodParams(aiGenerationIdParamsSchema) params: { generationId: string },
    @ZodBody(discardBodySchema) _body: Record<string, never>,
  ): Promise<AiGenerationDto> {
    const { generation } = await this.discardGeneration.execute({
      generationId: params.generationId,
    });
    return toAiGenerationDto(generation, requesterName());
  }
}

/** Solicitante = usuário da requisição (AI-01/AI-04 só valem para ele). */
function requesterName(): string {
  return requireRequestContext().actor.name ?? '';
}
