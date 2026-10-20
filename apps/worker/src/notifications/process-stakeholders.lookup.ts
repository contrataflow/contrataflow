import type { DomainEventEnvelope } from '@contrataflow/types';

import type { SqlClient } from '#shared/database/outbox-database.js';

import type { RecipientLookupSource } from './recipient-resolver.js';

type Payload = Readonly<Record<string, unknown>>;

/**
 * Interessados no processo (`PROCESS_STAKEHOLDERS` — US-008 · events.md §6), destinatários de
 * `PROCESS_STATUS_CHANGED` (suspenso, retomado, cancelado, concluído): o criador, o responsável
 * atual e os participantes PESSOAIS com `notify`, não revogados e dentro da validade. O autor sai
 * no resolvedor (`includeActor` falso). Na `tenantTransaction` do job: a RLS limita ao tenant do
 * evento; processo descartado não tem interessados.
 */
export class ProcessStakeholdersLookup implements RecipientLookupSource {
  readonly lookup = 'PROCESS_STAKEHOLDERS' as const;

  constructor(private readonly now: () => Date = () => new Date()) {}

  async resolve(
    client: SqlClient,
    event: DomainEventEnvelope<Payload>,
  ): Promise<readonly string[]> {
    if (event.processId === null) return [];
    const { rows } = await client.query<{ user_id: string }>(
      `SELECT DISTINCT stakeholder.user_id
         FROM processes p
         CROSS JOIN LATERAL (
           SELECT p.created_by_id AS user_id
           UNION ALL
           SELECT p.current_responsible_id
           UNION ALL
           SELECT pp.user_id
             FROM process_participants pp
            WHERE pp.tenant_id = p.tenant_id
              AND pp.process_id = p.id
              AND pp.user_id IS NOT NULL
              AND pp.notify
              AND pp.revoked_at IS NULL
              AND (pp.expires_at IS NULL OR pp.expires_at > $2)
         ) stakeholder
        WHERE p.id = $1 AND p.deleted_at IS NULL AND stakeholder.user_id IS NOT NULL
        ORDER BY stakeholder.user_id`,
      [event.processId, this.now()],
    );
    return rows.map((row) => row.user_id);
  }
}
