import { isXlsxFileName, QUOTATION_IMPORT_MESSAGES } from '@contrataflow/validation';
import type { QuotationImportIssue, QuotationImportPreview } from '@contrataflow/validation';

import { isApiError } from '@/lib/api/api-error';

import { DEFAULT_MAX_FILE_SIZE_MB } from '../attachments/upload-rules';

/*
 * Regras do diálogo "Importar planilha" (US-028 · SCR-009), sem React: a conferência local do arquivo
 * (V-01/V-02 — a regra que vale é a da API, com o limite do tenant), a lista de problemas da prévia
 * na ordem da planilha e a tradução das recusas da API para a próxima etapa do diálogo.
 */

export type LocalImportFileCheck =
  { readonly ok: true } | { readonly ok: false; readonly message: string };

/** V-01/V-02 no seletor: `.xlsx`, não vazio e dentro do limite padrão de `uploads.maxFileSizeMb`. */
export function checkImportFile(
  file: Pick<File, 'name' | 'size'>,
  maxFileSizeMb: number = DEFAULT_MAX_FILE_SIZE_MB,
): LocalImportFileCheck {
  if (!isXlsxFileName(file.name) || file.size === 0) {
    return { ok: false, message: QUOTATION_IMPORT_MESSAGES.fileType };
  }
  if (file.size > maxFileSizeMb * 1024 * 1024) {
    return { ok: false, message: QUOTATION_IMPORT_MESSAGES.fileTooLarge };
  }
  return { ok: true };
}

/** Problemas da prévia: os das colunas primeiro, depois os das linhas na ordem da planilha. */
export function previewIssues(preview: QuotationImportPreview): QuotationImportIssue[] {
  return [...preview.columnIssues, ...preview.rows.flatMap((row) => row.issues)];
}

/** FA-04: só há o que aplicar com ao menos uma célula válida. */
export function canApply(preview: QuotationImportPreview): boolean {
  return preview.summary.valid > 0;
}

/** Para onde o diálogo vai depois de uma recusa da API. */
export type ImportFailure =
  /** Volta ao envio da planilha com a mensagem (arquivo recusado ou prévia vencida). */
  | { readonly step: 'upload'; readonly message: string }
  /** Fecha o diálogo e avisa a tela (documento não editável, sem permissão). */
  | { readonly step: 'close'; readonly code: string }
  /** Mantém a etapa atual com "Tentar novamente" (indisponibilidade, erro inesperado). */
  | {
      readonly step: 'retry';
      readonly message: string;
      readonly correlationId: string | null;
    };

export function classifyImportError(
  error: unknown,
  messages: { readonly unavailable: string; readonly unexpected: string },
): ImportFailure {
  if (!isApiError(error)) {
    return { step: 'retry', message: messages.unexpected, correlationId: null };
  }
  switch (error.code) {
    case 'FILE_TYPE_NOT_ALLOWED':
      return { step: 'upload', message: QUOTATION_IMPORT_MESSAGES.fileType };
    case 'FILE_TOO_LARGE':
    case 'PAYLOAD_TOO_LARGE':
      return { step: 'upload', message: QUOTATION_IMPORT_MESSAGES.fileTooLarge };
    case 'IMPORT_PREVIEW_EXPIRED':
      return { step: 'upload', message: QUOTATION_IMPORT_MESSAGES.expired };
    case 'VALIDATION_ERROR':
      return {
        step: 'upload',
        message: error.errors[0]?.message ?? error.problem?.detail ?? messages.unexpected,
      };
    case 'DOCUMENT_NOT_EDITABLE':
    case 'PERMISSION_DENIED':
    case 'INVALID_PROCESS_STATUS':
      return { step: 'close', code: error.code };
    case 'NOT_FOUND':
      return { step: 'upload', message: QUOTATION_IMPORT_MESSAGES.notFound };
    default:
      return {
        step: 'retry',
        message: error.status === 503 ? messages.unavailable : messages.unexpected,
        correlationId: error.correlationId,
      };
  }
}
