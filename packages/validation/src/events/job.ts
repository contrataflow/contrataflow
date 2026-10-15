import { EVENT_ACTOR_TYPES } from '@contrataflow/types';
import type { JobMeta } from '@contrataflow/types';
import { z } from 'zod';

import { domainEventEnvelopeSchema } from './envelope.js';

/** `JobMeta` de todo job (DEC-164 · queues.md §3), validado pelo consumidor antes de qualquer efeito. */
export const jobMetaSchema = z.strictObject({
  schemaVersion: z.literal(1),
  tenantId: z.uuid().nullable(),
  actor: z.strictObject({
    type: z.enum(EVENT_ACTOR_TYPES),
    userId: z.uuid().nullable(),
    membershipId: z.uuid().nullable(),
  }),
  correlationId: z.string().min(1).max(64),
  causationId: z.uuid().nullable(),
  traceparent: z.string().max(55).optional(),
  tracestate: z.string().max(512).optional(),
  enqueuedAt: z.iso.datetime({ offset: true }),
}) satisfies z.ZodType<JobMeta>;

/** Job das filas `domain-events` e `notifications`: `JobData<{ envelope }>` (queues.md §4.1/§4.2). */
export const domainEventJobSchema = z.strictObject({
  meta: jobMetaSchema,
  payload: z.strictObject({ envelope: domainEventEnvelopeSchema }),
});

export type DomainEventJobData = z.infer<typeof domainEventJobSchema>;
