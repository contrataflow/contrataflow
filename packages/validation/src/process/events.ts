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

/**
 * `ProcessDuplicated` (US-011 · PRC-27): commit da duplicação, no processo de ORIGEM (envelope
 * `processId = sourceProcessId`) — o novo processo tem o próprio `ProcessCreated` com
 * `duplicatedFromId`. Consumidores: `TimelineProjector` (`PROCESS_DUPLICATED` na origem) no mesmo
 * `tx` e o `BusinessMetricsCollector` (`process.*`) no worker. Sem notificação.
 */
export const ProcessDuplicated = defineDomainEvent({
  eventType: 'ProcessDuplicated',
  eventVersion: 1,
  aggregateType: 'Process',
  payload: z.strictObject({
    sourceProcessId: uuid,
    newProcessId: uuid,
    options: z.strictObject({ copyDocuments: z.boolean(), copyAttachments: z.boolean() }),
  }),
  routingKey: 'process.duplicated',
});

/**
 * `ProcessUpdated` (US-005 · PRC-05): commit de alteração efetiva dos dados do processo. Só os
 * NOMES dos campos alterados (`changedFields`, ordem canônica de `UPDATE_PROCESS_FIELDS`) e a nova
 * versão — nunca valores (events.md §1). Consumidores: `TimelineProjector` (`PROCESS_UPDATED`) e
 * `ProcessAccessProjector` (unidade solicitante trocada — RN-PROC-62) no mesmo `tx`.
 */
export const ProcessUpdated = defineDomainEvent({
  eventType: 'ProcessUpdated',
  eventVersion: 1,
  aggregateType: 'Process',
  payload: z.strictObject({
    changedFields: z.array(z.string().min(1).max(60)).min(1).max(30),
    version: z.number().int().min(1),
  }),
  routingKey: 'process.updated',
});

/**
 * `ProcessItemsChanged` (US-006 · PRC-14..17): commit de inclusão, edição, exclusão ou
 * reordenação de itens. Só ids (`added`/`updated`/`removed` — a reordenação lista os renumerados
 * em `updated`; a troca de nome de lote, os demais itens do lote) e o total de itens ativos —
 * nunca descrições nem preços (events.md §1). Consumidores: `TimelineProjector` (`ITEMS_CHANGED`)
 * no mesmo `tx` e o `BusinessMetricsCollector` (`process.*`) no worker.
 */
export const ProcessItemsChanged = defineDomainEvent({
  eventType: 'ProcessItemsChanged',
  eventVersion: 1,
  aggregateType: 'Process',
  payload: z.strictObject({
    added: z.array(uuid),
    updated: z.array(uuid),
    removed: z.array(uuid),
    itemsCount: z.int().min(0),
  }),
  routingKey: 'process.items_changed',
});
