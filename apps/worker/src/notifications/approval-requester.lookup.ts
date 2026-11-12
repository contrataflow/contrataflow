import type { DomainEventEnvelope } from '@contrataflow/types';

import type { SqlClient } from '#shared/database/outbox-database.js';

import type { RecipientLookupSource } from './recipient-resolver.js';

type Payload = Readonly<Record<string, unknown>>;

/**
 * Quem solicitou a aprovação (`APPROVAL_REQUESTER` — US-134 · events.md MVP 2 §6), destinatário de
 * `APPROVAL_VOTE_RECORDED`. O próprio votante sai no resolvedor (`includeActor` falso). Na
 * `tenantTransaction` do job: a RLS limita ao tenant do evento.
 */
export class ApprovalRequesterLookup implements RecipientLookupSource {
  readonly lookup = 'APPROVAL_REQUESTER' as const;

  async resolve(
    client: SqlClient,
    event: DomainEventEnvelope<Payload>,
  ): Promise<readonly string[]> {
    const approvalId = event.payload.approvalId;
    if (typeof approvalId !== 'string') return [];
    const { rows } = await client.query<{ user_id: string }>(
      `SELECT a.requested_by_id AS user_id FROM approvals a WHERE a.id = $1`,
      [approvalId],
    );
    return rows.map((row) => row.user_id);
  }
}
