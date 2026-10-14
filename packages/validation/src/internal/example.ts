import { z } from 'zod';

import { trimmedString } from '../common/text.js';

/*
 * Schemas da rota interna de exemplo da US-080 (`/api/v1/_internal/*`), que exercita o pipeline
 * completo (autenticação, tenant, paginação, idempotência e validação). Fora do contrato público.
 */

export const internalPingSchema = z
  .object({
    status: z.literal('ok'),
    correlationId: z.string(),
    tenantId: z.uuid().nullable(),
    userId: z.uuid().nullable(),
    membershipId: z.uuid().nullable(),
  })
  .meta({ id: 'InternalPing' });

export const internalEchoRequestSchema = z
  .strictObject({
    name: trimmedString({ max: 120 }),
    quantity: z.int().min(1).max(1000).optional(),
  })
  .meta({ id: 'InternalEchoRequest' });

export type InternalEchoRequest = z.infer<typeof internalEchoRequestSchema>;

export const internalEchoSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    quantity: z.int().nullable(),
  })
  .meta({ id: 'InternalEcho' });

export const internalItemSchema = z
  .object({ id: z.string(), position: z.int().min(1) })
  .meta({ id: 'InternalItem' });

/**
 * Job de teste da US-084: o `JobMeta` de rastreio que o produtor grava (DEC-164) — prova a
 * propagação de `correlationId`/`traceparent` da requisição até o worker.
 */
export const internalTraceDemoJobSchema = z
  .object({
    queue: z.string(),
    jobName: z.string(),
    jobId: z.uuid(),
    meta: z.object({
      correlationId: z.string(),
      tenantId: z.uuid().nullable(),
      causationId: z.string().nullable(),
      traceparent: z.string().optional(),
      tracestate: z.string().optional(),
    }),
  })
  .meta({ id: 'InternalTraceDemoJob' });
