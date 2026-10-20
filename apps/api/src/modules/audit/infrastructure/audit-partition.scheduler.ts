import { Injectable } from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';

import { EnsureAuditPartitionsJob } from '../application/ensure-audit-partitions.job.js';

/** Cadência do job (diária — US-073 · Banco de dados). */
export const AUDIT_PARTITIONS_INTERVAL_MS = 24 * 3_600_000;

/**
 * Agenda o `EnsureAuditPartitionsJob` no processo da API: uma vez ao subir e depois a cada 24 h.
 * Idempotente e serializado no banco (trava consultiva), então várias réplicas podem rodá-lo. Vai
 * para os agendadores do worker quando a US-083 existir (DEC-071).
 */
@Injectable()
export class AuditPartitionScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly job: EnsureAuditPartitionsJob) {}

  onApplicationBootstrap(): void {
    void this.job.run();
    this.timer = setInterval(() => void this.job.run(), AUDIT_PARTITIONS_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }
}
