import type { DomainEventEnvelope } from '@contrataflow/types';

import type { SqlClient } from '#shared/database/outbox-database.js';

import type { RecipientLookupSource } from '../notifications/recipient-resolver.js';

/**
 * Destinatário `RENDITION_REQUESTER` de `DOCUMENT_RENDER_FAILED` (US-067 · events.md §6): quem pediu
 * o PDF, lido de `document_renditions` na transação do tenant do evento (RLS).
 */
export class RenditionRequesterLookup implements RecipientLookupSource {
  readonly lookup = 'RENDITION_REQUESTER' as const;

  async resolve(
    client: SqlClient,
    event: DomainEventEnvelope<Readonly<Record<string, unknown>>>,
  ): Promise<readonly string[]> {
    const renditionId = event.payload.renditionId;
    if (typeof renditionId !== 'string') return [];
    const result = await client.query<{ requested_by_id: string | null }>(
      'SELECT requested_by_id FROM document_renditions WHERE id = $1::uuid AND tenant_id = $2::uuid',
      [renditionId, event.tenantId],
    );
    const requester = result.rows[0]?.requested_by_id ?? null;
    return requester === null ? [] : [requester];
  }
}
