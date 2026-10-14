import { randomUUID } from 'node:crypto';

import {
  cursorEnvelope,
  cursorQuerySchema,
  dataEnvelope,
  internalEchoRequestSchema,
  internalEchoSchema,
  internalItemSchema,
  internalPingSchema,
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
import { ZodBody, ZodQuery } from '#shared/validation/zod-validation.pipe.js';

/** Posição codificada no cursor do feed fictício. */
const feedPositionSchema = z.strictObject({ after: z.int().min(0) });

/** Tamanho da lista fictícia usada para demonstrar a paginação. */
export const EXAMPLE_ITEM_COUNT = 45;

const exampleItems = Array.from({ length: EXAMPLE_ITEM_COUNT }, (_, index) => ({
  id: `item-${String(index + 1).padStart(2, '0')}`,
  position: index + 1,
}));

/**
 * Rota interna de exemplo (US-080 — fluxo principal, passo 3): exercita autenticação, tenant,
 * vínculo, rate limit, validação Zod, paginação, idempotência e o envelope. Não é caso de uso de
 * produto e fica fora do contrato público (`internal: true`).
 */
@Controller('_internal')
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
    return {
      status: 'ok' as const,
      correlationId: context.correlationId,
      tenantId: context.tenantId,
      userId: context.actor.userId,
      membershipId: context.actor.membershipId,
    };
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
    idempotent: true,
    responses: {
      201: { description: 'Registro fictício criado.', schema: dataEnvelope(internalEchoSchema) },
    },
  })
  echo(@ZodBody(internalEchoRequestSchema) body: InternalEchoRequest) {
    return { id: randomUUID(), name: body.name, quantity: body.quantity ?? null };
  }
}
