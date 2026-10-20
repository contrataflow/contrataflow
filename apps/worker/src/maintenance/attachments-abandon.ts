import { ATTACHMENT_ABANDON_AFTER_HOURS, ATTACHMENT_ABANDONED_REASON } from '@contrataflow/types';
import { Logger } from '@nestjs/common';

import type { SqlClient } from '#shared/database/outbox-database.js';

import type { HousekeepingTask } from './tenant-housekeeping.job.js';

/**
 * `attachments-abandon` (US-068 · RN-DOC-78 · storage.md §5.1 · tarefa diária do
 * `tenant-housekeeping`): intenção de upload sem confirmação há mais de 24 h vira `DELETED`, com o
 * motivo "Upload não concluído" e ator de sistema (`deleted_by_id` nulo). O objeto da quarentena,
 * se houver, já expira pelo lifecycle do bucket (1 dia). Idempotente — `UPDATE … WHERE status =
 * 'PENDING_UPLOAD'` — e dentro da `tenantTransaction` (RLS do tenant do job). Sem evento: o anexo
 * nunca esteve disponível nem na timeline.
 */
export class AttachmentsAbandonTask implements HousekeepingTask {
  readonly name = 'attachments-abandon';
  private readonly logger = new Logger('FilesMaintenance');

  constructor(private readonly now: () => Date = () => new Date()) {}

  async run(client: SqlClient, tenantId: string): Promise<Readonly<Record<string, number>>> {
    const now = this.now();
    const cutoff = new Date(now.getTime() - ATTACHMENT_ABANDON_AFTER_HOURS * 3_600_000);
    const result = await client.query(
      `UPDATE attachments
          SET status = 'DELETED', deleted_at = $2, deletion_reason = $4,
              updated_at = $2, version = version + 1
        WHERE tenant_id = $1 AND status = 'PENDING_UPLOAD' AND created_at < $3`,
      [tenantId, now, cutoff, ATTACHMENT_ABANDONED_REASON],
    );
    const abandoned = result.rowCount ?? 0;
    this.logger.log({ event: 'attachment.abandoned_intents', tenantId, count: abandoned });
    return { abandoned };
  }
}
