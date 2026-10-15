import { Inject, Injectable, Logger } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';
import { runAsSystem } from '#shared/context/request-context.js';

import { AUDIT_PARTITIONS } from './ports.js';
import type { AuditPartitionsPort } from './ports.js';

export const AUDIT_PARTITIONS_JOB_NAME = 'Job de partições da auditoria';

/**
 * Criação antecipada das partições mensais de `audit_logs` (US-073 · Impacto técnico · FA-03):
 * garante o mês corrente e os `audit.partitionMonthsAhead` seguintes, de forma idempotente. A
 * ausência da partição faz toda escrita auditada falhar — falha aqui é `error` (alerta).
 */
@Injectable()
export class EnsureAuditPartitionsJob {
  private readonly logger = new Logger('AuditPartitions');

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AUDIT_PARTITIONS) private readonly partitions: AuditPartitionsPort,
  ) {}

  /** Devolve quantas partições criou, ou `null` se falhou (já registrado em log). */
  run(): Promise<number | null> {
    return runAsSystem({ name: AUDIT_PARTITIONS_JOB_NAME, tenantId: null }, async () => {
      const monthsAhead = this.config.audit.partitionMonthsAhead;
      try {
        const created = await this.partitions.ensure(monthsAhead);
        this.logger.log(
          { event: 'audit.partitions_ensured', created, monthsAhead },
          'audit.partitions_ensured',
        );
        return created;
      } catch (error) {
        this.logger.error(
          {
            event: 'audit.partition_ensure_failed',
            monthsAhead,
            errorName: error instanceof Error ? error.name : 'unknown',
          },
          'audit.partition_ensure_failed',
        );
        return null;
      }
    });
  }
}
