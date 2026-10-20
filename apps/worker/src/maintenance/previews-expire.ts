import { Logger } from '@nestjs/common';

import type { SqlClient } from '#shared/database/outbox-database.js';

import type { HousekeepingTask } from './tenant-housekeeping.job.js';

/**
 * `previews-expire` (US-067 · RN-DOC-68 · queues.md §4.8 · tarefa diária do `tenant-housekeeping`):
 * prévias em PDF com `expires_at` vencido viram `EXPIRED`. A validade já é conferida pela API em
 * todo download (`RENDITION_NOT_READY`); aqui o estado só é materializado. Idempotente —
 * `UPDATE … WHERE status NOT IN ('EXPIRED','FAILED')` — e dentro da `tenantTransaction` (RLS do
 * tenant do job). O binário expira pelo *lifecycle* do bucket (`cf-retention=ephemeral`). Sem
 * evento nem notificação; só `document.previews_expired` no log.
 */
export class PreviewsExpireTask implements HousekeepingTask {
  readonly name = 'previews-expire';
  private readonly logger = new Logger('DocumentMaintenance');

  constructor(private readonly now: () => Date = () => new Date()) {}

  async run(client: SqlClient, tenantId: string): Promise<Readonly<Record<string, number>>> {
    const now = this.now();
    const result = await client.query(
      `UPDATE document_renditions
          SET status = 'EXPIRED', updated_at = $2, version = version + 1
        WHERE tenant_id = $1 AND kind = 'PREVIEW' AND status NOT IN ('EXPIRED', 'FAILED')
          AND expires_at <= $2`,
      [tenantId, now],
    );
    const expired = result.rowCount ?? 0;
    this.logger.log({ event: 'document.previews_expired', tenantId, count: expired });
    return { expired };
  }
}
