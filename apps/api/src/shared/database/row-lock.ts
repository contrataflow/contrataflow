import { Logger } from '@nestjs/common';

import { currentRequestContext } from '#shared/context/request-context.js';

const logger = new Logger('Database');

/** Espera de trava acima deste limite gera `warn db.lock_wait` (Logs da US-081). */
export const LOCK_WAIT_WARN_MS = 200;

export interface LockTarget {
  /** `FOR UPDATE`, `FOR NO KEY UPDATE`, `advisory`… */
  readonly lockType: string;
  readonly tableName: string;
}

/**
 * Mede a obtenção de uma trava pessimista pontual (DEC-055: `SELECT … FOR UPDATE` no processo e
 * na sequência de numeração) e registra `db.lock_wait` quando passa de 200 ms. A trava vive até o
 * fim da transação: se ela falhar, o rollback a libera e nada é consumido (FA-04).
 *
 * ```ts
 * const [row] = await withLockTiming({ lockType: 'FOR UPDATE', tableName: 'processes' }, () =>
 *   tx.$queryRaw`SELECT … FROM processes WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`,
 * );
 * ```
 */
export async function withLockTiming<T>(target: LockTarget, acquire: () => Promise<T>): Promise<T> {
  const startedAt = process.hrtime.bigint();
  try {
    return await acquire();
  } finally {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    if (durationMs > LOCK_WAIT_WARN_MS) {
      logger.warn(
        [
          'db.lock_wait',
          `lockType=${target.lockType}`,
          `tableName=${target.tableName}`,
          `durationMs=${durationMs.toFixed(1)}`,
          `correlationId=${currentRequestContext()?.correlationId ?? '-'}`,
        ].join(' '),
      );
    }
  }
}
