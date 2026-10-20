import { z } from 'zod';

import { SUPPLIER_DOCUMENT_TYPES } from './supplier.js';
import { defineDomainEvent } from '../events/define.js';

/*
 * Eventos do agregado `Supplier` (events.md §4.5 · US-025), gravados no commit de SUP-02 (criação)
 * e SUP-04 (qualquer edição, inclusive a inativação). A exclusão (SUP-05) só gera auditoria.
 * Nenhum consumidor assíncrono no MVP 1; o payload leva só IDs e o tipo do documento — nunca o
 * número (CPF é dado pessoal — DEC-086).
 */

export const SupplierCreated = defineDomainEvent({
  eventType: 'SupplierCreated',
  eventVersion: 1,
  aggregateType: 'Supplier',
  payload: z.strictObject({
    supplierId: z.uuid(),
    documentType: z.enum(SUPPLIER_DOCUMENT_TYPES),
  }),
  routingKey: 'supplier.created',
});

export const SupplierUpdated = defineDomainEvent({
  eventType: 'SupplierUpdated',
  eventVersion: 1,
  aggregateType: 'Supplier',
  payload: z.strictObject({
    supplierId: z.uuid(),
    documentType: z.enum(SUPPLIER_DOCUMENT_TYPES),
    changedFields: z.array(z.string().min(1).max(60)).max(30),
  }),
  routingKey: 'supplier.updated',
});
