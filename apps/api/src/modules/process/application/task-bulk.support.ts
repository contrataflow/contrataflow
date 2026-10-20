import type { BulkItemResultDto, ProcessDto } from '@contrataflow/validation';
import type { Logger } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import type { Counter, Histogram } from '@opentelemetry/api';

import { requireRequestContext } from '#shared/context/request-context.js';
import { ApiError } from '#shared/errors/api-error.js';

import {
  bulkItemFailureOf,
  isUnavailable,
  notAttempted,
  summarizeBulk,
} from '../domain/task-bulk.js';
import type { BulkItemRefusal, BulkItemResult, BulkSummary } from '../domain/task-bulk.js';

/*
 * Orquestração das ações em lote (US-058 · TSK-03/TSK-04): cada `processId` passa, em sequência,
 * pelo comando do PRC-21/PRC-22 na SUA transação (RN-INBOX-22) — sucesso e erro convivem; a falha
 * de um item nunca desfaz os demais. Banco fora no meio do lote: os itens seguintes não são
 * tentados e saem como `DEPENDENCY_UNAVAILABLE` (cenário [Falha de banco]).
 */

/** Item de um lote: o que a auditoria `process.claim`/`process.assign` registra (US-058). */
export interface BulkItemContext {
  readonly batchId: string;
  readonly idempotencyKey: string | null;
}

/** `metadata.batchId`/`metadata.idempotencyKey` da auditoria do item (nada fora de um lote). */
export function batchAuditMetadata(
  batch: BulkItemContext | undefined,
): Readonly<Record<string, string>> {
  if (batch === undefined) return {};
  return {
    batchId: batch.batchId,
    ...(batch.idempotencyKey === null ? {} : { idempotencyKey: batch.idempotencyKey }),
  };
}

export type BulkProcessRef = NonNullable<BulkItemResultDto['process']>;

export interface BulkOutcome {
  readonly items: BulkItemResultDto[];
  readonly summary: BulkSummary;
}

/** O processo depois do item: o que a lista precisa para se atualizar (sem valores). */
export function bulkProcessRefOf(dto: ProcessDto): BulkProcessRef {
  return {
    id: dto.id,
    code: dto.code,
    version: dto.version,
    currentResponsible:
      dto.currentResponsible === null
        ? null
        : { id: dto.currentResponsible.id, name: dto.currentResponsible.name },
  };
}

function refusalOf(error: unknown): BulkItemRefusal | null {
  if (!(error instanceof ApiError)) return null;
  return {
    code: error.code,
    status: error.status,
    detail: error.detail,
    fieldMessage: error.errors[0]?.message,
  };
}

/** Executa os itens em sequência, cada um isolado (RN-INBOX-22). */
export async function runBulkItems(
  processIds: readonly string[],
  attempt: (processId: string) => Promise<BulkProcessRef>,
): Promise<BulkItemResult<BulkProcessRef>[]> {
  const results: BulkItemResult<BulkProcessRef>[] = [];
  let unavailable = false;
  for (const processId of processIds) {
    if (unavailable) {
      results.push(notAttempted(processId));
      continue;
    }
    try {
      results.push({ processId, ok: true, process: await attempt(processId) });
    } catch (error) {
      const refusal = refusalOf(error);
      unavailable = isUnavailable(refusal);
      results.push({ processId, ok: false, ...bulkItemFailureOf(refusal) });
    }
  }
  return results;
}

export function toBulkOutcome(results: readonly BulkItemResult<BulkProcessRef>[]): BulkOutcome {
  return {
    items: results.map((result) =>
      result.ok
        ? { processId: result.processId, ok: true, process: result.process }
        : {
            processId: result.processId,
            ok: false,
            code: result.code,
            message: result.message,
          },
    ),
    summary: summarizeBulk(results),
  };
}

let bulkItems: Counter | undefined;
let bulkSize: Histogram | undefined;

/** `cf_task_bulk_items_total{action,outcome}` e `cf_task_bulk_size{action}` (DoD da US-058). */
function recordBulk(action: 'claim' | 'assign', batchSize: number, summary: BulkSummary): void {
  const meter = metrics.getMeter('contrataflow-api');
  bulkItems ??= meter.createCounter('cf_task_bulk_items_total', {
    description: 'Itens das ações em lote da caixa de tarefas, por resultado (TSK-03/TSK-04).',
  });
  bulkSize ??= meter.createHistogram('cf_task_bulk_size', {
    description: 'Tamanho dos lotes da caixa de tarefas (2 a 50 processos).',
  });
  bulkSize.record(batchSize, { action });
  bulkItems.add(summary.successCount, { action, outcome: 'success' });
  bulkItems.add(summary.errorCount, { action, outcome: 'error' });
}

/**
 * Logs da story: `info` `tasks.bulk_<ação>` e `warn` `tasks.bulk_partial_failure` quando algum item
 * falhou. Só contagens, duração e correlação — nunca o motivo da atribuição.
 */
export function reportBulk(
  logger: Logger,
  action: 'claim' | 'assign',
  batchId: string,
  outcome: BulkOutcome,
  durationMs: number,
): void {
  const { correlationId } = requireRequestContext();
  const batchSize = outcome.items.length;
  recordBulk(action, batchSize, outcome.summary);
  const fields = {
    batchId,
    batchSize,
    successCount: outcome.summary.successCount,
    errorCount: outcome.summary.errorCount,
    durationMs,
    correlationId,
  };
  logger.log({ event: `tasks.bulk_${action}`, ...fields }, `tasks.bulk_${action}`);
  if (outcome.summary.errorCount > 0) {
    const codes = [
      ...new Set(outcome.items.flatMap((item) => (item.code === undefined ? [] : [item.code]))),
    ];
    logger.warn(
      { event: 'tasks.bulk_partial_failure', action, ...fields, codes },
      'tasks.bulk_partial_failure',
    );
  }
}

/** `error` `tasks.bulk_failed`: falha que impediu o lote inteiro (não as recusas de regra). */
export function reportBulkFailed(
  logger: Logger,
  action: 'claim' | 'assign',
  error: unknown,
  batchSize: number,
): void {
  if (error instanceof ApiError && error.status < 500) return;
  logger.error(
    {
      event: 'tasks.bulk_failed',
      action,
      batchSize,
      errorCode: error instanceof ApiError ? error.code : 'INTERNAL_ERROR',
      correlationId: requireRequestContext().correlationId,
    },
    'tasks.bulk_failed',
  );
}
