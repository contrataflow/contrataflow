import { z } from 'zod';

import { CREATION_CHANNELS, PRIORITIES } from './process.js';
import { defineDomainEvent } from '../events/define.js';

/*
 * Eventos do agregado `Process` (events.md §4.1). `ProcessCreated` (US-001): commit do PRC-02 (e,
 * na US-011, da duplicação). Consumidores: `TimelineProjector` e `ProcessAccessProjector` no mesmo
 * `tx` (DEC-161) e `BusinessMetricsCollector` (`process.*`) no worker. Sem dado sigiloso: o valor
 * estimado nunca entra no payload (events.md §1).
 */

const uuid = z.uuid();

export const ProcessCreated = defineDomainEvent({
  eventType: 'ProcessCreated',
  eventVersion: 1,
  aggregateType: 'Process',
  payload: z.strictObject({
    /** Nulos quando a numeração ocorre na autuação (`numbering.process.assignOn = START`). */
    code: z.string().min(1).max(40).nullable(),
    number: z.number().int().min(1).nullable(),
    year: z.number().int().min(2000).max(2100),
    title: z.string().min(1).max(200),
    organizationId: uuid,
    requestingSecretariatId: uuid,
    requestingDepartmentId: uuid,
    contractingTypeCode: z.string().min(1).max(60),
    modalityCode: z.string().min(1).max(60).nullable(),
    priority: z.enum(PRIORITIES),
    workflowId: uuid,
    workflowVersionId: uuid,
    initialStageKey: z.string().min(1).max(60),
    /** Unidade com a custódia na etapa inicial (concessão `CURRENT`). */
    initialDepartmentId: uuid,
    /** Responsável inicial (concessão `RESPONSIBLE`); `null` = fila da unidade. */
    initialResponsibleId: uuid.nullable(),
    creationChannel: z.enum(CREATION_CHANNELS),
    duplicatedFromId: uuid.nullable(),
  }),
  routingKey: 'process.created',
});
