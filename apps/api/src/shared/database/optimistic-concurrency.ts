import { Logger } from '@nestjs/common';

import { currentRequestContext } from '#shared/context/request-context.js';

import { VersionConflictError } from './errors.js';
import type { VersionedTarget } from './errors.js';

const logger = new Logger('Database');

/** Resultado de `updateMany`/`$executeRaw`: contagem de linhas afetadas. */
export type AffectedRows = number | { readonly count: number };

/**
 * Concorrência otimista (DEC-055 · RN-FND-42): o `UPDATE` do repositório filtra por
 * `version = @expected` e incrementa `version` no mesmo comando; 0 linhas afetadas ⇒ outra pessoa
 * gravou antes → `VersionConflictError` (412 `VERSION_CONFLICT`). Nunca por trigger.
 *
 * ```ts
 * await updateVersioned({ aggregateType: 'Process', aggregateId: id, expectedVersion }, () =>
 *   tx.process.updateMany({
 *     where: { id, version: expectedVersion },
 *     data: { title, version: { increment: 1 } },
 *   }),
 * );
 * ```
 */
export async function updateVersioned(
  target: VersionedTarget,
  update: () => Promise<AffectedRows>,
): Promise<void> {
  assertVersionMatched(await update(), target);
}

/** Verifica as linhas afetadas por um `UPDATE … WHERE version = @expected`. */
export function assertVersionMatched(affected: AffectedRows, target: VersionedTarget): void {
  const rows = typeof affected === 'number' ? affected : affected.count;
  if (rows === 1) return;
  if (rows > 1) {
    // Filtro sem a chave primária: erro de programação, nunca conflito de versão.
    throw new Error(`UPDATE versionado de ${target.aggregateType} afetou ${rows} linhas.`);
  }
  // Evento esperado do fluxo (não é erro): sem valores de colunas de negócio (Logs da US-081).
  logger.log(
    [
      'db.optimistic_concurrency_conflict',
      `aggregateType=${target.aggregateType}`,
      `aggregateId=${target.aggregateId}`,
      `expectedVersion=${target.expectedVersion}`,
      `correlationId=${currentRequestContext()?.correlationId ?? '-'}`,
    ].join(' '),
  );
  throw new VersionConflictError(target);
}
