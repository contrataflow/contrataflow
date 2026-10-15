import { z } from 'zod';

import type { SqlClient } from '#shared/database/outbox-database.js';

import type { HandlerResult, JobHandler, JobHandlerContext } from '../queues/run-job.js';

/** Tarefa diária por tenant (queues.md §4.8): idempotente, dentro da `tenantTransaction`. */
export interface HousekeepingTask {
  readonly name: string;
  /** Devolve contagens para o log (`{ '2026': 3 }`). */
  run(client: SqlClient, tenantId: string): Promise<Readonly<Record<string, number>>>;
}

/**
 * `maintenance.tenant-housekeeping` (queues.md §4.8): job por tenant `ACTIVE`/`SUSPENDED`
 * enfileirado pela manutenção diária. Executa as tarefas registradas pelos módulos donos — uma
 * `tenantTransaction` por tarefa, para que uma falha não desfaça as demais (a repetição do job
 * as reexecuta, e todas são idempotentes). Hoje: geração do calendário do ano seguinte (US-106).
 */
export class TenantHousekeepingJob implements JobHandler<Record<string, never>> {
  readonly queue = 'maintenance' as const;
  readonly name = 'tenant-housekeeping';
  readonly payloadSchema = z.strictObject({});
  readonly runsForSuspendedTenant = true;

  constructor(private readonly tasks: readonly HousekeepingTask[]) {}

  async handle(
    _payload: Record<string, never>,
    context: JobHandlerContext,
  ): Promise<HandlerResult> {
    const { tenantId } = context.meta;
    if (tenantId === null) return 'skipped';
    for (const task of this.tasks) {
      const counts = await context.tenantTransaction((client) => task.run(client, tenantId));
      context.logger.log({ event: `housekeeping.${task.name}`, tenantId, ...counts });
    }
    return 'completed';
  }
}
