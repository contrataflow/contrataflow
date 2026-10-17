import { AUDIT_LOG_PAGE_SIZE } from '@contrataflow/validation';
import type { AuditExportFormat, AuditLogDto } from '@contrataflow/validation';

import { apiDownload, apiRequest, newCorrelationId } from '@/lib/api/client';
import { tenantKey } from '@/lib/query/keys';

import { countExportedRows } from './audit-log-model';
import type { AuditQuery } from './audit-log-model';

/*
 * Trilha de auditoria (US-075 · SCR-037, aba "Registros"): AUD-01 (pesquisa por cursor —
 * `useInfiniteQuery`), AUD-02 (detalhe) e AUD-03 (exportação — download do arquivo). Chaves
 * `['t', tenantId, 'audit', filtros]` (RN-FND-90): trocar o filtro troca a chave e reinicia a lista.
 */

export const auditLogKeys = {
  list: (tenantId: string, query: AuditQuery) => tenantKey(tenantId, 'audit', query),
  detail: (tenantId: string, id: string) => tenantKey(tenantId, 'audit', 'record', id),
};

/** A trilha só cresce: janela curta; nada de sondagem. */
export const AUDIT_LOGS_STALE_TIME_MS = 30_000;

export interface AuditLogPage {
  readonly items: readonly AuditLogDto[];
  readonly nextCursor: string | null;
}

/** AUD-01 (`AUDIT_VIEW`). */
export async function fetchAuditLogs(
  query: AuditQuery,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<AuditLogPage> {
  const result = await apiRequest<AuditLogDto[]>('/audit', {
    query: { ...query, limit: AUDIT_LOG_PAGE_SIZE, cursor: cursor ?? undefined },
    signal,
  });
  const nextCursor = result.meta.nextCursor;
  return {
    items: Array.isArray(result.data) ? result.data : [],
    nextCursor: typeof nextCursor === 'string' ? nextCursor : null,
  };
}

/** AUD-02 (`AUDIT_VIEW`). */
export async function fetchAuditLog(id: string, signal?: AbortSignal): Promise<AuditLogDto> {
  return (await apiRequest<AuditLogDto>(`/audit/${id}`, { signal })).data;
}

export interface AuditExportResult {
  readonly blob: Blob;
  readonly fileName: string;
  readonly rowCount: number;
}

/** AUD-03 (`AUDIT_EXPORT` + MFA, POL-14): o arquivo dos filtros, sem paginação. */
export async function exportAuditLogs(
  query: AuditQuery,
  format: AuditExportFormat,
): Promise<AuditExportResult> {
  const file = await apiDownload('/audit/export', {
    query: { ...query, format },
    correlationId: newCorrelationId(),
  });
  return {
    blob: file.blob,
    fileName: file.fileName ?? `auditoria.${format}`,
    rowCount: countExportedRows(await file.blob.text(), format),
  };
}
