import type { DomainEventEnvelope } from '@contrataflow/types';

import type { SqlClient } from '#shared/database/outbox-database.js';

import type { RecipientLookupSource } from '../notifications/recipient-resolver.js';

/**
 * Destinatário `ATTACHMENT_UPLOADER` de `ATTACHMENT_REJECTED` (US-068 · events.md §6): quem enviou o
 * anexo rejeitado, lido de `attachments` na transação do tenant do evento (RLS).
 */
export class AttachmentUploaderLookup implements RecipientLookupSource {
  readonly lookup = 'ATTACHMENT_UPLOADER' as const;

  async resolve(
    client: SqlClient,
    event: DomainEventEnvelope<Readonly<Record<string, unknown>>>,
  ): Promise<readonly string[]> {
    const attachmentId = event.payload.attachmentId;
    if (typeof attachmentId !== 'string') return [];
    const result = await client.query<{ uploaded_by_id: string | null }>(
      'SELECT uploaded_by_id FROM attachments WHERE id = $1::uuid AND tenant_id = $2::uuid',
      [attachmentId, event.tenantId],
    );
    const uploader = result.rows[0]?.uploaded_by_id ?? null;
    return uploader === null ? [] : [uploader];
  }
}
