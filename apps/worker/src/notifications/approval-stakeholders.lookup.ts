import type { DomainEventEnvelope } from '@contrataflow/types';

import type { SqlClient } from '#shared/database/outbox-database.js';

import type { RecipientLookupSource } from './recipient-resolver.js';

type Payload = Readonly<Record<string, unknown>>;

/**
 * Interessados na decisão (`APPROVAL_STAKEHOLDERS` — US-052 · events.md §6), destinatários de
 * `APPROVAL_DECIDED`: quem solicitou a aprovação e os responsáveis (`responsibleId`) dos documentos
 * cobertos (`approval_documents` e o documento da avulsa). O decisor sai no resolvedor
 * (`includeActor` falso). Na `tenantTransaction` do job: a RLS limita ao tenant do evento;
 * documento excluído não conta.
 */
export class ApprovalStakeholdersLookup implements RecipientLookupSource {
  readonly lookup = 'APPROVAL_STAKEHOLDERS' as const;

  async resolve(
    client: SqlClient,
    event: DomainEventEnvelope<Payload>,
  ): Promise<readonly string[]> {
    const approvalId = event.payload.approvalId;
    if (typeof approvalId !== 'string') return [];
    const { rows } = await client.query<{ user_id: string }>(
      `SELECT DISTINCT stakeholder.user_id
         FROM approvals a
         CROSS JOIN LATERAL (
           SELECT a.requested_by_id AS user_id
           UNION ALL
           SELECT d.responsible_id
             FROM documents d
            WHERE d.tenant_id = a.tenant_id
              AND d.deleted_at IS NULL
              AND (d.id = a.document_id
                   OR d.id IN (SELECT ad.document_id
                                 FROM approval_documents ad
                                WHERE ad.tenant_id = a.tenant_id AND ad.approval_id = a.id))
         ) stakeholder
        WHERE a.id = $1 AND stakeholder.user_id IS NOT NULL
        ORDER BY stakeholder.user_id`,
      [approvalId],
    );
    return rows.map((row) => row.user_id);
  }
}
