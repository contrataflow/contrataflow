import { randomUUID } from 'node:crypto';

import { captureJobTraceMeta, uuidv7, withSpan } from '@contrataflow/observability';
import {
  cursorEnvelope,
  cursorQuerySchema,
  dataEnvelope,
  internalEchoRequestSchema,
  internalEchoSchema,
  internalItemSchema,
  internalPingSchema,
  internalTraceDemoJobSchema,
  pageEnvelope,
  pageQuerySchema,
} from '@contrataflow/validation';
import type { InternalEchoRequest } from '@contrataflow/validation';
import { Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { z } from 'zod';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { cursorResult, decodeCursor, pageResult, pageWindow } from '#shared/http/pagination.js';
import type { CursorQueryDto, PageQueryDto } from '#shared/http/pagination.js';
import { Idempotent } from '#shared/idempotency/idempotency.js';
import { ApiOperation } from '#shared/openapi/api-operation.js';
import { TenantScope } from '#shared/tenancy/tenant-scope.js';
import { ZodBody, ZodQuery } from '#shared/validation/zod-validation.pipe.js';

/** Posição codificada no cursor do feed fictício. */
const feedPositionSchema = z.strictObject({ after: z.int().min(0) });

/** Fila e job de teste da propagação de trace (US-084); o enfileiramento real é da US-083. */
export const TRACE_DEMO_QUEUE = 'platform-demo';
export const TRACE_DEMO_JOB = 'trace-demo';

/** Tamanho da lista fictícia usada para demonstrar a paginação. */
export const EXAMPLE_ITEM_COUNT = 45;

const exampleItems = Array.from({ length: EXAMPLE_ITEM_COUNT }, (_, index) => ({
  id: `item-${String(index + 1).padStart(2, '0')}`,
  position: index + 1,
}));

/**
 * Rota interna de exemplo (US-080 — fluxo principal, passo 3): exercita autenticação, tenant,
 * vínculo, rate limit, validação Zod, paginação, idempotência e o envelope — e, desde a US-084, o
 * span manual de referência e o job de teste da propagação de trace. Não é caso de uso de
 * produto e fica fora do contrato público (`internal: true`).
 */
@Controller('_internal')
@TenantScope('TENANT')
export class InternalExampleController {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @Get('ping')
  @ApiOperation({
    operationId: 'INTERNAL-PING',
    summary: 'Ecoa o contexto da requisição',
    internal: true,
    responses: {
      200: { description: 'Contexto da requisição.', schema: dataEnvelope(internalPingSchema) },
    },
  })
  ping() {
    const context = requireRequestContext();
    // Span manual de referência (observability.md §4.3): só atributos da allowlist (UUIDs).
    return withSpan(
      'platform.example.ping',
      { 'cf.tenant.id': context.tenantId, 'enduser.id': context.actor.userId },
      () => ({
        status: 'ok' as const,
        correlationId: context.correlationId,
        tenantId: context.tenantId,
        userId: context.actor.userId,
        membershipId: context.actor.membershipId,
      }),
    );
  }

  @Post('jobs/trace-demo')
  @HttpCode(202)
  @ApiOperation({
    operationId: 'INTERNAL-TRACE-DEMO-JOB',
    summary: 'Dispara o job de teste da propagação de trace',
    internal: true,
    auditExempt: 'Rota interna de exemplo da US-084: não persiste nada nem age sobre dados.',
    responses: {
      202: {
        description: 'JobMeta de rastreio do job de teste.',
        schema: dataEnvelope(internalTraceDemoJobSchema),
      },
    },
  })
  async traceDemoJob() {
    const context = requireRequestContext();
    // O `JobProducer` da US-083 grava este `JobMeta`; aqui ele volta ao chamador para o teste
    // ponta a ponta (o worker executa o job com `runInJobContext`).
    const meta = await captureJobTraceMeta(TRACE_DEMO_QUEUE, {
      correlationId: context.correlationId,
      tenantId: context.tenantId,
    });
    return { queue: TRACE_DEMO_QUEUE, jobName: TRACE_DEMO_JOB, jobId: uuidv7(), meta };
  }

  @Get('items')
  @ApiOperation({
    operationId: 'INTERNAL-ITEMS',
    summary: 'Lista fictícia paginada por página',
    internal: true,
    responses: {
      200: { description: 'Página da lista.', schema: pageEnvelope(internalItemSchema) },
    },
  })
  items(@ZodQuery(pageQuerySchema) query: PageQueryDto) {
    const window = pageWindow(query, this.config.pagination.maxPageSize);
    return pageResult(
      exampleItems.slice(window.skip, window.skip + window.take),
      window,
      exampleItems.length,
    );
  }

  @Get('feed')
  @ApiOperation({
    operationId: 'INTERNAL-FEED',
    summary: 'Feed fictício paginado por cursor',
    internal: true,
    responses: {
      200: { description: 'Trecho do feed.', schema: cursorEnvelope(internalItemSchema) },
    },
  })
  feed(@ZodQuery(cursorQuerySchema) query: CursorQueryDto) {
    const after = query.cursor ? decodeCursor(query.cursor, feedPositionSchema).after : 0;
    const fetched = exampleItems.filter((item) => item.position > after).slice(0, query.limit + 1);
    return cursorResult(fetched, query.limit, (item) => ({ after: item.position }));
  }

  @Post('echo')
  @HttpCode(201)
  @Idempotent()
  @ApiOperation({
    operationId: 'INTERNAL-ECHO',
    summary: 'Ecoa o corpo validado',
    internal: true,
    auditExempt: 'Rota interna de exemplo da US-080: só ecoa o corpo, sem persistência.',
    idempotent: true,
    responses: {
      201: { description: 'Registro fictício criado.', schema: dataEnvelope(internalEchoSchema) },
    },
  })
  echo(@ZodBody(internalEchoRequestSchema) body: InternalEchoRequest) {
    return { id: randomUUID(), name: body.name, quantity: body.quantity ?? null };
  }
}
