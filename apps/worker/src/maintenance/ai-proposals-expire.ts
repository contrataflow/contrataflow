import { Logger } from '@nestjs/common';

import type { SqlClient } from '#shared/database/outbox-database.js';

import type { HousekeepingTask } from './tenant-housekeeping.job.js';

/**
 * `ai-proposals-expire` (US-115 · RN-AI-11 · queues.md §4.8 · tarefa diária do
 * `tenant-housekeeping`): propostas `SUCCEEDED` com `expires_at` vencido viram `EXPIRED`. O
 * conteúdo fica guardado para rastreabilidade, mas a aplicação (DOC-26/RSK-11) passa a recusar.
 * Idempotente — `UPDATE … WHERE status = 'SUCCEEDED'` — e dentro da `tenantTransaction` (RLS do
 * tenant do job). Sem evento nem notificação; só `ai.proposals_expired` no log.
 */
export class AiProposalsExpireTask implements HousekeepingTask {
  readonly name = 'ai-proposals-expire';
  private readonly logger = new Logger('AiMaintenance');

  constructor(private readonly now: () => Date = () => new Date()) {}

  async run(client: SqlClient, tenantId: string): Promise<Readonly<Record<string, number>>> {
    const result = await client.query(
      `UPDATE ai_generations
          SET status = 'EXPIRED', updated_at = $2
        WHERE tenant_id = $1 AND status = 'SUCCEEDED' AND expires_at <= $2`,
      [tenantId, this.now()],
    );
    const expired = result.rowCount ?? 0;
    this.logger.log({ event: 'ai.proposals_expired', tenantId, count: expired });
    return { expired };
  }
}
