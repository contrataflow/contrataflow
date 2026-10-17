import type { AuditExportFormat } from '@contrataflow/validation';

import type { SealedAuditRecord } from './audit-record.js';

/*
 * `AuditExportWriter` (US-075 · AUD-03): o arquivo da exportação, uma linha por registro, montado
 * aos pedaços (cabeçalho + linhas) para o *streaming* — nunca o resultado inteiro em memória.
 * `CsvInjectionEscaper` (RN-AUD-20): no CSV, todo valor textual iniciado por `=`, `+`, `-`, `@`,
 * tabulação ou retorno de carro ganha um apóstrofo antes — inclusive o JSON de `changes`/`metadata`
 * e os nomes congelados. O NDJSON leva o registro como está (é dado, não planilha).
 */

/** Gatilhos de fórmula em Excel/Sheets/LibreOffice (OWASP "CSV Injection"). */
const FORMULA_TRIGGERS = new Set(['=', '+', '-', '@', '\t', '\r']);

/** RN-AUD-20: prefixa `'` no valor que o aplicativo de planilha interpretaria como fórmula. */
export function escapeCsvFormula(value: string): string {
  return value.length > 0 && FORMULA_TRIGGERS.has(value.charAt(0)) ? `'${value}` : value;
}

/** Célula RFC 4180: entre aspas quando houver separador, aspas ou quebra de linha. */
export function csvCell(value: string | null): string {
  if (value === null) return '';
  const escaped = escapeCsvFormula(value);
  return /[",\r\n]/.test(escaped) ? `"${escaped.replaceAll('"', '""')}"` : escaped;
}

/** Colunas do CSV, na ordem (nomes de entities.md §4; o tenant é implícito). */
export const AUDIT_EXPORT_COLUMNS = [
  'id',
  'occurredAt',
  'actorType',
  'actorUserId',
  'actorName',
  'actorMembershipId',
  'onBehalfOfUserId',
  'action',
  'category',
  'result',
  'entityType',
  'entityId',
  'processId',
  'reasonCode',
  'changes',
  'metadata',
  'ip',
  'userAgent',
  'correlationId',
  'requestId',
  'sessionIdHash',
  'rowHash',
] as const;

type ExportColumn = (typeof AUDIT_EXPORT_COLUMNS)[number];

/** O registro exportado: o mesmo `AuditLog` de AUD-02, sem o tenant (o da sessão). */
export function exportedRecord(record: SealedAuditRecord): Record<ExportColumn, unknown> {
  return {
    id: record.id,
    occurredAt: record.occurredAt.toISOString(),
    actorType: record.actorType,
    actorUserId: record.actorUserId,
    actorName: record.actorName,
    actorMembershipId: record.actorMembershipId,
    onBehalfOfUserId: record.onBehalfOfUserId,
    action: record.action,
    category: record.category,
    result: record.result,
    entityType: record.entityType,
    entityId: record.entityId,
    processId: record.processId,
    reasonCode: record.reasonCode,
    changes: record.changes,
    metadata: record.metadata,
    ip: record.ip,
    userAgent: record.userAgent,
    correlationId: record.correlationId,
    requestId: record.requestId,
    sessionIdHash: record.sessionIdHash,
    rowHash: record.rowHash,
  };
}

function cellText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** BOM UTF-8: o Excel abre o CSV com acentos corretos. Fim de linha CRLF (RFC 4180). */
const CSV_BOM = String.fromCharCode(0xfeff);
const CRLF = '\r\n';

export interface AuditExportWriter {
  readonly contentType: string;
  readonly extension: string;
  /** Início do arquivo (cabeçalho do CSV; vazio no NDJSON). */
  header(): string;
  /** Uma linha completa (com o terminador). */
  line(record: SealedAuditRecord): string;
}

const csvWriter: AuditExportWriter = {
  contentType: 'text/csv; charset=utf-8',
  extension: 'csv',
  header: () => `${CSV_BOM}${AUDIT_EXPORT_COLUMNS.join(',')}${CRLF}`,
  line: (record) => {
    const row = exportedRecord(record);
    return `${AUDIT_EXPORT_COLUMNS.map((column) => csvCell(cellText(row[column]))).join(',')}${CRLF}`;
  },
};

const ndjsonWriter: AuditExportWriter = {
  contentType: 'application/x-ndjson; charset=utf-8',
  extension: 'ndjson',
  header: () => '',
  line: (record) => `${JSON.stringify(exportedRecord(record))}\n`,
};

export function auditExportWriter(format: AuditExportFormat): AuditExportWriter {
  return format === 'csv' ? csvWriter : ndjsonWriter;
}

/** `auditoria-AAAAMMDD-AAAAMMDD.csv` — o período exportado, em UTC. */
export function auditExportFileName(
  occurredFrom: Date,
  occurredTo: Date,
  writer: AuditExportWriter,
): string {
  const day = (date: Date) => date.toISOString().slice(0, 10).replaceAll('-', '');
  return `auditoria-${day(occurredFrom)}-${day(occurredTo)}.${writer.extension}`;
}
