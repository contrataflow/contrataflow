import { z } from 'zod';

import { RISK_LEVELS, RISK_PHASES } from './risk.js';
import { defineDomainEvent } from '../events/define.js';

/*
 * Eventos do agregado `Risk` (events.md §4 · US-033), gravados no commit de RSK-02 (criação),
 * RSK-04 (com probabilidade e/ou impacto alterados) e RSK-05 (exclusão). Consumidor: o
 * `TimelineProjector` (`RISK_ADDED`/`RISK_LEVEL_CHANGED`/`RISK_REMOVED`) no mesmo `tx`; nenhum
 * consumidor assíncrono no MVP 1. Só ids, código e níveis — nunca título, causa nem consequência.
 */

const uuid = z.uuid();
const level = z.enum(RISK_LEVELS);

export const RiskCreated = defineDomainEvent({
  eventType: 'RiskCreated',
  eventVersion: 1,
  aggregateType: 'Risk',
  payload: z.strictObject({
    riskId: uuid,
    code: z.string().min(1).max(10),
    level,
    phase: z.enum(RISK_PHASES),
    categoryCode: z.string().min(1).max(60),
  }),
  routingKey: 'risk.created',
});

/** Emitido mesmo sem mudança de nível (`fromLevel = toLevel` — FA-01). */
export const RiskAssessed = defineDomainEvent({
  eventType: 'RiskAssessed',
  eventVersion: 1,
  aggregateType: 'Risk',
  payload: z.strictObject({
    riskId: uuid,
    fromLevel: level,
    toLevel: level,
    score: z.int().min(1),
  }),
  routingKey: 'risk.assessed',
});

export const RiskDeleted = defineDomainEvent({
  eventType: 'RiskDeleted',
  eventVersion: 1,
  aggregateType: 'Risk',
  payload: z.strictObject({
    riskId: uuid,
    code: z.string().min(1).max(10),
  }),
  routingKey: 'risk.deleted',
});
