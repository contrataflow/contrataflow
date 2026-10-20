import { z } from 'zod';

import { defineDomainEvent } from '../events/define.js';

/*
 * Evento próprio do TR (events.md §4 · US-037): gravado no commit da importação do ETP (TRM-06),
 * junto com o `DocumentVersionCreated` (`reason = IMPORT`). Consumidor: o `TimelineProjector`
 * (`TERM_IMPORTED_FROM_ETP`) no mesmo `tx`; sem notificação (RN-TR-24). Só ids e chaves — nunca o
 * conteúdo das seções nem o valor estimado.
 */

const uuid = z.uuid();

export const TermImportedFromEtp = defineDomainEvent({
  eventType: 'TermImportedFromEtp',
  eventVersion: 1,
  aggregateType: 'TermOfReference',
  payload: z.strictObject({
    termId: uuid,
    etpId: uuid,
    /** Versão vigente do ETP na importação (`null` = ETP ainda sem versão — FA-02). */
    etpVersionId: uuid.nullable(),
    sectionsImported: z.array(z.string()),
    itemsImported: z.int().min(0),
  }),
  routingKey: 'term.imported_from_etp',
});
