import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { Readable } from 'node:stream';

import { AUDIT_LOG_MESSAGES } from '@contrataflow/validation';
import type {
  AuditChangeDto,
  AuditLogDto,
  AuditLogExportQuery,
  AuditLogSearchQuery,
} from '@contrataflow/validation';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';
import { AUDIT_TRAIL } from '#shared/audit/audit-trail.js';
import type { AuditTrailPort } from '#shared/audit/audit-trail.js';
import { requireRequestContext } from '#shared/context/request-context.js';
import { DatabaseUnavailableError, isTransientDatabaseError } from '#shared/database/errors.js';
import { ApiError, validationError } from '#shared/errors/api-error.js';
import { cursorResult, decodeCursor } from '#shared/http/pagination.js';
import type { CursorResult } from '#shared/http/pagination.js';

import { auditQueryMetrics } from './audit-telemetry.js';
import { AUDIT_CLOCK, AUDIT_LOG_STORE, AUDIT_TRANSACTIONS } from './ports.js';
import type { AuditClock, AuditLogStore, AuditTransactions } from './ports.js';
import {
  auditExportFileName,
  auditExportWriter,
  exportedRecord,
} from '../domain/audit-export-writer.js';
import type { AuditExportWriter } from '../domain/audit-export-writer.js';
import {
  auditCriteriaOf,
  auditFilterKeys,
  auditFiltersMetadata,
} from '../domain/audit-log-query.js';
import type { AuditCursorPosition, AuditLogCriteria } from '../domain/audit-log-query.js';
import type { SealedAuditRecord } from '../domain/audit-record.js';
import type { JsonValue } from '../domain/canonical-json.js';

/** Registros lidos por transação na exportação: memória constante, qualquer que seja o total. */
export const AUDIT_EXPORT_BATCH_SIZE = 1_000;

/** Até quanto a contagem da exportação vai além do teto (só para informar o total na recusa). */
const TOO_LARGE_COUNT_FACTOR = 10;

function tenantOfContext(): string {
  const { tenantId } = requireRequestContext();
  if (tenantId === null) throw new Error('A trilha de auditoria exige o tenant do contexto.');
  return tenantId;
}

/** Posição opaca do cursor de AUD-01 (o cliente nunca interpreta): instante e id do último. */
const cursorPosition = z.strictObject({ o: z.iso.datetime(), i: z.uuid() });

function decodeAuditCursor(cursor: string): AuditCursorPosition {
  try {
    const position = decodeCursor(cursor, cursorPosition);
    return { occurredAt: new Date(position.o), id: position.i };
  } catch {
    throw validationError([
      { field: 'cursor', code: 'INVALID_FORMAT', message: AUDIT_LOG_MESSAGES.invalidCursor },
    ]);
  }
}

/** Entrada de `changes` como gravada (`{ path, old, new }`), já mascarada (RN-AUD-18). */
function toChangeDto(value: JsonValue): AuditChangeDto {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if (typeof value.path === 'string') {
      return { path: value.path, old: value.old ?? null, new: value.new ?? null };
    }
  }
  return { path: '', old: null, new: value };
}

/**
 * `AuditLogPresenter` (RN-AUD-18): o `AuditLog` completo, exatamente como gravado — o mascaramento
 * da gravação (US-073) é definitivo; nada aqui o desfaz. O tenant é implícito (o da sessão).
 */
export function toAuditLogDto(record: SealedAuditRecord): AuditLogDto {
  const row = exportedRecord(record);
  return {
    ...(row as Omit<AuditLogDto, 'changes' | 'metadata'>),
    changes: record.changes === null ? null : record.changes.map(toChangeDto),
    metadata: { ...record.metadata },
  };
}

/**
 * O arquivo é lido DEPOIS de o handler devolver, conforme o socket drena: cada passo do gerador
 * roda no contexto da requisição capturado aqui (tenant da transação, ator, `correlationId`).
 */
function inCurrentContext<T>(source: AsyncGenerator<T>): AsyncIterable<T> {
  const run = AsyncLocalStorage.snapshot();
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => run(() => source.next()),
      return: (value?: T) => run(() => source.return(value as T)),
      throw: (error?: unknown) => run(() => source.throw(error)),
    }),
  };
}

/** Banco fora do ar → 503 `DEPENDENCY_UNAVAILABLE`; erro de contrato (4xx) segue como está. */
function queryFailure(logger: Logger, operation: string, error: unknown): unknown {
  if (error instanceof ApiError && error.status < 500) return error;
  const mapped = isTransientDatabaseError(error) ? new DatabaseUnavailableError(error) : error;
  logger.error(
    {
      event: 'audit.query_failed',
      operation,
      errorCode: mapped instanceof ApiError ? mapped.code : 'INTERNAL_ERROR',
      correlationId: requireRequestContext().correlationId,
    },
    'audit.query_failed',
  );
  return mapped;
}

/**
 * `SearchAuditLogsHandler` — AUD-01 (US-075 · RN-AUD-17): registros do tenant no período (≤ 90
 * dias, conferido pelo schema), mais recentes primeiro, por cursor, com os filtros combinados.
 * `AUDIT_VIEW` (e o MFA — POL-14) já conferidos pelo guard. Somente leitura; a consulta é ela
 * própria auditada como `audit.search` com os filtros em `metadata` (RN-AUD-23).
 */
@Injectable()
export class SearchAuditLogsHandler {
  private readonly logger = new Logger('Audit');

  constructor(
    @Inject(AUDIT_LOG_STORE) private readonly logs: AuditLogStore,
    @Inject(AUDIT_TRANSACTIONS) private readonly transactions: AuditTransactions,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
  ) {}

  async execute(query: AuditLogSearchQuery): Promise<CursorResult<AuditLogDto>> {
    const tenantId = tenantOfContext();
    const after = query.cursor === undefined ? null : decodeAuditCursor(query.cursor);
    const started = performance.now();
    try {
      const fetched = await this.transactions.read((tx) =>
        this.logs.search(tx, {
          ...auditCriteriaOf(tenantId, query),
          after,
          take: query.limit + 1,
        }),
      );
      const result = cursorResult(fetched.map(toAuditLogDto), query.limit, (item) => ({
        o: item.occurredAt,
        i: item.id,
      }));
      await this.audit.recordStandalone({
        action: 'audit.search',
        metadata: {
          target: 'logs',
          ...auditFiltersMetadata(query),
          page: after === null ? 'first' : 'next',
        },
      });
      const durationMs = Math.round(performance.now() - started);
      const metrics = auditQueryMetrics();
      metrics.searches.add(1, { operation: 'list' });
      metrics.duration.record(durationMs, { operation: 'list' });
      this.logger.log(
        {
          event: 'audit.search_executed',
          tenantId,
          userId: requireRequestContext().actor.userId,
          filterCount: auditFilterKeys(query).length,
          count: result.items.length,
          hasMore: result.meta.hasMore,
          durationMs,
        },
        'audit.search_executed',
      );
      return result;
    } catch (error) {
      throw queryFailure(this.logger, 'list', error);
    }
  }
}

/**
 * `GetAuditLogHandler` — AUD-02 (US-075 · RN-AUD-18): o registro completo, com o diff de
 * `changes` já mascarado. De outro tenant ou inexistente → 404 `NOT_FOUND`, sem distinguir (V-06).
 * Auditado como `audit.search` (`metadata.target = 'record'`).
 */
@Injectable()
export class GetAuditLogHandler {
  private readonly logger = new Logger('Audit');

  constructor(
    @Inject(AUDIT_LOG_STORE) private readonly logs: AuditLogStore,
    @Inject(AUDIT_TRANSACTIONS) private readonly transactions: AuditTransactions,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
  ) {}

  async execute(id: string): Promise<AuditLogDto> {
    const tenantId = tenantOfContext();
    const started = performance.now();
    try {
      const record = await this.transactions.read((tx) => this.logs.findById(tx, tenantId, id));
      if (record === null) {
        throw new ApiError('NOT_FOUND', { detail: AUDIT_LOG_MESSAGES.notFound });
      }
      await this.audit.recordStandalone({
        action: 'audit.search',
        entityType: 'AuditLog',
        metadata: { target: 'record', auditLogId: id },
      });
      const metrics = auditQueryMetrics();
      metrics.searches.add(1, { operation: 'detail' });
      metrics.duration.record(Math.round(performance.now() - started), { operation: 'detail' });
      return toAuditLogDto(record);
    } catch (error) {
      throw queryFailure(this.logger, 'detail', error);
    }
  }
}

/** Exportação pronta para o *streaming*: o arquivo é lido do banco em lotes enquanto é enviado. */
export interface AuditExport {
  readonly fileName: string;
  readonly contentType: string;
  readonly rowCount: number;
  readonly stream: Readable;
}

/**
 * `ExportAuditLogsHandler` — AUD-03 (US-075 · RN-AUD-19/20/23): os mesmos filtros de AUD-01, sem
 * paginação. Antes de enviar qualquer byte: conta (limitado) e recusa acima de
 * `audit.export.maxRows` com 422 `EXPORT_TOO_LARGE`, e grava `audit.export` (filtros, formato e
 * `rowCount`) — sem auditoria, sem arquivo. O período é fixado no instante do pedido (`occurredTo`
 * até "agora"): a própria consulta/exportação não entra no arquivo e repetir o pedido de um
 * período passado gera o mesmo conteúdo. As linhas saem em lotes de `AUDIT_EXPORT_BATCH_SIZE`,
 * cada um numa transação curta de leitura por cursor — memória constante até 100 mil linhas.
 */
@Injectable()
export class ExportAuditLogsHandler {
  private readonly logger = new Logger('Audit');

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AUDIT_LOG_STORE) private readonly logs: AuditLogStore,
    @Inject(AUDIT_TRANSACTIONS) private readonly transactions: AuditTransactions,
    @Inject(AUDIT_TRAIL) private readonly audit: AuditTrailPort,
    @Inject(AUDIT_CLOCK) private readonly clock: AuditClock,
  ) {}

  async execute(query: AuditLogExportQuery): Promise<AuditExport> {
    const tenantId = tenantOfContext();
    const maxRows = this.config.audit.exportMaxRows;
    const requested = auditCriteriaOf(tenantId, query);
    // Fixa o fim no instante anterior ao pedido: a gravação de `audit.export` abaixo (e as
    // consultas que chegarem durante o envio) nunca entram no arquivo.
    const snapshot = new Date(this.clock().getTime() - 1);
    const criteria: AuditLogCriteria = {
      ...requested,
      occurredTo: requested.occurredTo > snapshot ? snapshot : requested.occurredTo,
    };
    const writer = auditExportWriter(query.format);
    const started = performance.now();
    let rowCount: number;
    try {
      rowCount = await this.transactions.read((tx) =>
        this.logs.count(tx, criteria, maxRows * TOO_LARGE_COUNT_FACTOR),
      );
      if (rowCount > maxRows) {
        auditQueryMetrics().exports.add(1, { format: query.format, outcome: 'too_large' });
        this.logger.warn(
          { event: 'audit.export_too_large', tenantId, estimatedCount: rowCount, maxRows },
          'audit.export_too_large',
        );
        throw new ApiError('EXPORT_TOO_LARGE', {
          status: 422,
          title: 'Exportação acima do limite',
          detail: AUDIT_LOG_MESSAGES.exportTooLarge(rowCount),
          extensions: { estimatedCount: rowCount, maxRows },
        });
      }
      await this.audit.recordStandalone({
        action: 'audit.export',
        metadata: { ...auditFiltersMetadata(query), format: query.format, rowCount },
      });
    } catch (error) {
      throw queryFailure(this.logger, 'export', error);
    }
    return {
      fileName: auditExportFileName(requested.occurredFrom, requested.occurredTo, writer),
      contentType: writer.contentType,
      rowCount,
      stream: Readable.from(
        inCurrentContext(this.lines(criteria, writer, maxRows, started, query.format)),
      ),
    };
  }

  /** O arquivo, lote a lote; uma falha no meio interrompe a resposta (arquivo nunca truncado). */
  private async *lines(
    criteria: AuditLogCriteria,
    writer: AuditExportWriter,
    maxRows: number,
    started: number,
    format: string,
  ): AsyncGenerator<string> {
    const userId = requireRequestContext().actor.userId;
    yield writer.header();
    let after: AuditCursorPosition | null = null;
    let sent = 0;
    try {
      while (sent < maxRows) {
        const take = Math.min(AUDIT_EXPORT_BATCH_SIZE, maxRows - sent);
        const position: AuditCursorPosition | null = after;
        const batch: SealedAuditRecord[] = await this.transactions.read((tx) =>
          this.logs.search(tx, { ...criteria, after: position, take }),
        );
        if (batch.length > 0) yield batch.map((record) => writer.line(record)).join('');
        sent += batch.length;
        const last = batch.at(-1);
        if (last === undefined || batch.length < take) break;
        after = { occurredAt: last.occurredAt, id: last.id };
      }
    } catch (error) {
      auditQueryMetrics().exports.add(1, { format, outcome: 'failed' });
      this.logger.error(
        {
          event: 'audit.query_failed',
          operation: 'export_stream',
          tenantId: criteria.tenantId,
          rowsSent: sent,
        },
        'audit.query_failed',
      );
      throw error;
    }
    const durationMs = Math.round(performance.now() - started);
    const metrics = auditQueryMetrics();
    metrics.exports.add(1, { format, outcome: 'completed' });
    metrics.duration.record(durationMs, { operation: 'export' });
    this.logger.log(
      {
        event: 'audit.export_executed',
        tenantId: criteria.tenantId,
        userId,
        format,
        rowCount: sent,
        durationMs,
      },
      'audit.export_executed',
    );
  }
}
