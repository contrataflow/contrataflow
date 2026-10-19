import { z } from 'zod';

import { defineDomainEvent } from '../events/define.js';

/*
 * Evento próprio do ETP (events.md §4 · US-021): gravado no commit do ETP-09 quando a decisão
 * `RECOMMENDED` é confirmada (RN-ETP-21). Consumidor: o `TimelineProjector`
 * (`ETP_ALTERNATIVE_RECOMMENDED`, com o nome congelado da alternativa) no mesmo `tx`; nenhum
 * consumidor assíncrono nem notificação no MVP 1. Só ids — nunca nome, custo nem justificativa.
 */

const uuid = z.uuid();

export const EtpAlternativeRecommended = defineDomainEvent({
  eventType: 'EtpAlternativeRecommended',
  eventVersion: 1,
  aggregateType: 'Etp',
  payload: z.strictObject({
    etpId: uuid,
    alternativeId: uuid,
    /** A alternativa antes recomendada, quando houve substituição (`replaceRecommended`). */
    previousAlternativeId: uuid.optional(),
  }),
  routingKey: 'etp.alternative_recommended',
});
