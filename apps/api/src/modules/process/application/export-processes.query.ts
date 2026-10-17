import { performance } from 'node:perf_hooks';
import { Readable } from 'node:stream';

import {
  PROCESS_DEFAULT_COLUMNS,
  PROCESS_EXPORT_MAX_ROWS,
  PROCESS_EXPORT_MESSAGES,
} from '@contrataflow/validation';
import type { ProcessColumnKey, ProcessExportQuery } from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { TenantCache } from '#shared/cache/tenant-cache.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import {
  DatabaseUnavailableError,
  isStatementTimeout,
  isTransientDatabaseError,
} from '#shared/database/errors.js';
import { inCurrentContext, pullInTransaction } from '#shared/database/transaction-stream.js';
import { ApiError } from '#shared/errors/api-error.js';

import { filterKeysOf, resolveCriteria } from './list-processes.query.js';
import { PROCESS_REPOSITORY, PROCESS_TRANSACTIONS } from './ports.js';
import type { ProcessExportSearch, ProcessRepository, ProcessTransactions } from './ports.js';
import { processExportMetrics } from './process-export-telemetry.js';
import { ProcessListPresenter } from './process-list.presenter.js';
import type { ProcessListContext } from './process-list.presenter.js';
import { AccessFacade } from '../../access/application/access.facade.js';
import { csvRowSerializer, processExportFileName } from '../domain/process-csv.js';
import type { CsvRowSerializer } from '../domain/process-csv.js';
import { effectiveOrder } from '../domain/process-list.js';

/*
 * `ExportProcessesQuery` (US-003 · PRC-34 · RN-PROC-40..46): a lista de processos em CSV, com os
 * mesmos filtros e ordenação de PRC-01, só com as linhas visíveis E cobertas pelo escopo de
 * `PROCESS_EXPORT`. Antes do primeiro byte: trava por usuário (Redis, TTL 2 min — 429 com
 * `Retry-After`; Redis fora = segue sem trava com `warn export.lock_unavailable`) e contagem exata
 * (acima de 10.000 = 422 `EXPORT_TOO_LARGE` com `meta.totalItems`, sem arquivo nem auditoria). O
 * arquivo sai por cursor no servidor em lotes de 500, numa transação `READ ONLY` com
 * `statement_timeout` de 60 s, conforme o socket drena (memória constante). `process.export` é
 * gravado em transação própria: `SUCCESS` ANTES do último lote (sem auditoria, sem arquivo
 * completo) e `FAILURE` com `reasonCode` se o envio é interrompido. Logs sem linhas, `q` nem
 * valores.
 */

/** RN-PROC-45: lote do cursor. */
export const PROCESS_EXPORT_BATCH_SIZE = 500;
/** RN-PROC-45: `statement_timeout` e tempo máximo da leitura. */
export const PROCESS_EXPORT_TIMEOUT_MS = 60_000;
/** Contagem antes do envio (o mesmo limite do PRC-01 seria curto para o conjunto inteiro). */
export const PROCESS_EXPORT_COUNT_TIMEOUT_MS = 15_000;
/** RN-PROC-46: trava de uma exportação em andamento por usuário e tenant. */
export const PROCESS_EXPORT_LOCK_TTL_SECONDS = 120;
/** `Retry-After` da exportação simultânea. */
export const PROCESS_EXPORT_RETRY_AFTER_SECONDS = 30;

const LOCK_MODULE = 'process-export';
const CONTENT_TYPE = 'text/csv; charset=utf-8';

export interface ProcessExport {
  readonly fileName: string;
  readonly contentType: string;
  readonly rowCount: number;
  readonly stream: Readable;
}

interface ExportPlan {
  readonly query: ProcessExportQuery;
  readonly search: ProcessExportSearch;
  readonly context: ProcessListContext;
  readonly columns: readonly ProcessColumnKey[];
  readonly serializer: CsvRowSerializer;
  readonly release: () => Promise<void>;
  readonly startedAt: number;
}

/** Filtros aplicados para a auditoria (inclusive `q` — "Auditoria" da US-003). */
function filtersMetadata(query: ProcessExportQuery): Record<string, unknown> {
  const { columns: _columns, savedViewId: _savedViewId, sort: _sort, ...filters } = query;
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== undefined));
}

const sortText = (query: ProcessExportQuery) =>
  query.sort?.map((term) => `${term.direction === 'desc' ? '-' : ''}${term.field}`).join(',') ??
  null;

@Injectable()
export class ExportProcessesQuery {
  private readonly logger = new Logger('ProcessExport');

  constructor(
    @Inject(PROCESS_TRANSACTIONS) private readonly transactions: ProcessTransactions,
    @Inject(PROCESS_REPOSITORY) private readonly processes: ProcessRepository,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    private readonly access: AccessFacade,
    private readonly presenter: ProcessListPresenter,
    private readonly cache: TenantCache,
  ) {}

  async execute(query: ProcessExportQuery): Promise<ProcessExport> {
    const startedAt = performance.now();
    const { actor } = requireRequestContext();
    const userId = actor.userId;
    if (userId === null) throw new ApiError('UNAUTHENTICATED');
    const permissions = await this.access.effectivePermissions();
    const budget = await this.access.confidentialBudgetAccess();
    const release = await this.acquireLock(userId);
    let plan: ExportPlan;
    try {
      const prepared = await this.transactions.read(async (tx) => {
        const context = await this.presenter.loadContext(tx);
        const criteria = resolveCriteria(query, {
          userId,
          ownDepartmentIds: permissions.snapshot.ownDepartmentIds,
          stages: context.stages,
        });
        const search: ProcessExportSearch = {
          criteria,
          order: effectiveOrder(query.sort, criteria.search !== null),
          now: context.now,
          timezone: context.timezone,
          today: context.today,
          visibility: permissions.visibilityScope(),
          exportCoverage: permissions.processScopeOf('PROCESS_EXPORT'),
          historicalDepartmentsCanView: context.historicalDepartmentsCanView,
          budget: { ...budget.scope, custodyDepartmentIds: budget.custodyDepartmentIds },
          statementTimeoutMs: PROCESS_EXPORT_COUNT_TIMEOUT_MS,
        };
        return { context, search, total: await this.processes.countForExport(tx, search) };
      });
      if (prepared.total > PROCESS_EXPORT_MAX_ROWS) {
        processExportMetrics().exports.add(1, { outcome: 'too_large' });
        this.logger.warn(
          { event: 'process.export_too_large', totalItems: prepared.total },
          'process.export_too_large',
        );
        throw new ApiError('EXPORT_TOO_LARGE', {
          status: 422,
          title: 'Exportação acima do limite',
          detail: PROCESS_EXPORT_MESSAGES.tooLarge(prepared.total),
          extensions: {
            meta: { totalItems: prepared.total },
            maxRows: PROCESS_EXPORT_MAX_ROWS,
          },
        });
      }
      const columns = query.columns ?? PROCESS_DEFAULT_COLUMNS;
      plan = {
        query,
        search: { ...prepared.search, statementTimeoutMs: PROCESS_EXPORT_TIMEOUT_MS },
        context: prepared.context,
        columns,
        serializer: csvRowSerializer(columns, {
          timezone: prepared.context.timezone,
          labels: prepared.context.labels,
        }),
        release,
        startedAt,
      };
      return {
        fileName: processExportFileName(prepared.context.now, prepared.context.timezone),
        contentType: CONTENT_TYPE,
        rowCount: prepared.total,
        stream: Readable.from(inCurrentContext(this.lines(plan))),
      };
    } catch (error) {
      await release();
      throw this.beforeSendFailure(error, query);
    }
  }

  /** RN-PROC-46: uma exportação em andamento por usuário (Redis fora = sem trava, com aviso). */
  private async acquireLock(userId: string): Promise<() => Promise<void>> {
    const key = `lock:${userId}`;
    let acquired: boolean;
    try {
      acquired = await this.cache.setIfAbsent(
        LOCK_MODULE,
        key,
        { at: new Date().toISOString() },
        { ttlSeconds: PROCESS_EXPORT_LOCK_TTL_SECONDS },
      );
    } catch (error) {
      this.logger.warn(
        {
          event: 'export.lock_unavailable',
          cause: error instanceof Error ? error.name : typeof error,
          correlationId: requireRequestContext().correlationId,
        },
        'export.lock_unavailable',
      );
      return () => Promise.resolve();
    }
    if (!acquired) {
      throw new ApiError('RATE_LIMITED', {
        status: 429,
        detail: PROCESS_EXPORT_MESSAGES.inProgress,
        headers: { 'Retry-After': String(PROCESS_EXPORT_RETRY_AFTER_SECONDS) },
      });
    }
    return async () => {
      try {
        await this.cache.delete(LOCK_MODULE, key);
      } catch {
        // A trava expira sozinha (TTL).
      }
    };
  }

  /** Falha antes do primeiro byte: banco fora = 503; regra (4xx) segue como está. */
  private beforeSendFailure(error: unknown, query: ProcessExportQuery): unknown {
    if (error instanceof ApiError && error.status < 500) return error;
    const mapped =
      isTransientDatabaseError(error) || isStatementTimeout(error)
        ? new DatabaseUnavailableError(error)
        : error;
    processExportMetrics().exports.add(1, { outcome: 'failed' });
    this.logger.error(
      {
        event: 'process.export_failed',
        rowsSent: 0,
        filterKeys: filterKeysOf({ ...query, page: 1, pageSize: 1 }),
        errorCode: mapped instanceof ApiError ? mapped.code : 'INTERNAL_ERROR',
        correlationId: requireRequestContext().correlationId,
      },
      'process.export_failed',
    );
    return mapped;
  }

  /**
   * O arquivo, lote a lote. O último pedaço só sai depois de `process.export` (`SUCCESS`)
   * gravado; falha ou desistência no meio grava `FAILURE` e interrompe a resposta.
   */
  private async *lines(plan: ExportPlan): AsyncGenerator<string> {
    const exportsValue = plan.columns.includes('estimatedValue');
    let rowCount = 0;
    let maskedRowCount = 0;
    let bytes = 0;
    let completed = false;
    let failure: unknown = null;
    const emit = (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      return chunk;
    };
    try {
      let pending = emit(plan.serializer.header());
      const cursor = this.processes.exportCursor(plan.search, PROCESS_EXPORT_BATCH_SIZE);
      const batches = pullInTransaction(
        (work) => this.transactions.longRead(work, PROCESS_EXPORT_TIMEOUT_MS),
        {
          open: (tx) => cursor.open(tx),
          next: async (tx) => this.presenter.present(tx, await cursor.next(tx), plan.context),
        },
      );
      for await (const batch of batches) {
        const rows = batch.slice(0, PROCESS_EXPORT_MAX_ROWS - rowCount);
        yield pending;
        pending = emit(rows.map((item) => plan.serializer.line(item)).join(''));
        rowCount += rows.length;
        if (exportsValue) maskedRowCount += rows.filter((item) => item.estimatedValueMasked).length;
        if (rowCount >= PROCESS_EXPORT_MAX_ROWS) break;
      }
      await this.record(plan, 'SUCCESS', { rowCount, maskedRowCount }, null);
      completed = true;
      yield pending;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      await plan.release();
      const durationMs = Math.round(performance.now() - plan.startedAt);
      if (completed) {
        this.completed(plan, { rowCount, maskedRowCount, bytes, durationMs });
      } else {
        await this.interrupted(plan, failure, { rowCount, maskedRowCount, durationMs });
      }
    }
  }

  private async record(
    plan: ExportPlan,
    result: 'SUCCESS' | 'FAILURE',
    counts: { readonly rowCount: number; readonly maskedRowCount: number },
    reasonCode: string | null,
  ): Promise<void> {
    await this.audit.recordStandalone({
      action: 'process.export',
      result,
      reasonCode,
      metadata: {
        filters: filtersMetadata(plan.query),
        sort: sortText(plan.query),
        columns: [...plan.columns],
        rowCount: counts.rowCount,
        maskedRowCount: counts.maskedRowCount,
        durationMs: Math.round(performance.now() - plan.startedAt),
        ...(plan.query.savedViewId === undefined ? {} : { savedViewId: plan.query.savedViewId }),
      },
    });
  }

  private completed(
    plan: ExportPlan,
    stats: {
      readonly rowCount: number;
      readonly maskedRowCount: number;
      readonly bytes: number;
      readonly durationMs: number;
    },
  ): void {
    const metrics = processExportMetrics();
    metrics.exports.add(1, { outcome: 'completed' });
    metrics.duration.record(stats.durationMs);
    metrics.bytes.record(stats.bytes);
    const { tenantId, actor, correlationId } = requireRequestContext();
    this.logger.log(
      {
        event: 'process.export_completed',
        ...stats,
        columnsCount: plan.columns.length,
        tenantId,
        userId: actor.userId,
        correlationId,
      },
      'process.export_completed',
    );
  }

  /** RN-PROC-45: envio interrompido (banco, auditoria ou cliente que desistiu) = `FAILURE`. */
  private async interrupted(
    plan: ExportPlan,
    failure: unknown,
    counts: {
      readonly rowCount: number;
      readonly maskedRowCount: number;
      readonly durationMs: number;
    },
  ): Promise<void> {
    const reasonCode =
      failure === null
        ? 'CLIENT_ABORTED'
        : isTransientDatabaseError(failure) || isStatementTimeout(failure)
          ? 'DEPENDENCY_UNAVAILABLE'
          : failure instanceof ApiError
            ? failure.code
            : 'INTERNAL_ERROR';
    processExportMetrics().exports.add(1, { outcome: failure === null ? 'aborted' : 'failed' });
    this.logger.error(
      {
        event: 'process.export_failed',
        rowsSent: counts.rowCount,
        errorCode: reasonCode,
        durationMs: counts.durationMs,
        correlationId: requireRequestContext().correlationId,
      },
      'process.export_failed',
    );
    try {
      await this.record(plan, 'FAILURE', counts, reasonCode);
    } catch {
      // Já registrado (`audit.write_failed`) pelo serviço; a resposta já foi interrompida.
    }
  }
}
