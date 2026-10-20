import { hasImportSelection, TERM_IMPORT_MESSAGES } from '@contrataflow/validation';
import type {
  TermImportApplyInput,
  TermImportField,
  TermImportPreviewDto,
} from '@contrataflow/validation';

import { isApiError } from '@/lib/api/api-error';

/*
 * Regras puras do painel "Importar do ETP" (US-037 · SCR-012): a seleção inicial (tudo marcado,
 * menos o valor mascarado — FA-05), a habilitação de "Aplicar importação" (V-01), o aviso de troca
 * da origem do valor (RN-TR-22 · V-05) e para onde o painel vai depois de uma recusa da API.
 */

export interface EtpImportSelection {
  readonly sections: readonly string[];
  readonly fields: readonly TermImportField[];
  readonly copyItems: boolean;
  readonly overwriteExisting: boolean;
}

/** Fluxo principal 3: seções, campos (exceto o mascarado) e itens pré-marcados. */
export function initialSelection(preview: TermImportPreviewDto): EtpImportSelection {
  return {
    sections: preview.sections.map((section) => section.target),
    fields: preview.fields.filter((field) => !field.valueMasked).map((field) => field.target),
    copyItems: preview.items.count > 0,
    overwriteExisting: false,
  };
}

/** V-01: ao menos uma seção, campo ou os itens. */
export function canApplySelection(selection: EtpImportSelection): boolean {
  return hasImportSelection(selection);
}

/** RN-TR-22: importar o valor sobre a origem `PRICE_RESEARCH` pede a confirmação. */
export function needsValueSourceConfirmation(
  preview: TermImportPreviewDto,
  selection: EtpImportSelection,
): boolean {
  return preview.replacesPriceResearchValue && selection.fields.includes('estimatedTotalValue');
}

export function toApplyBody(
  preview: TermImportPreviewDto,
  selection: EtpImportSelection,
  confirmReplaceValueSource: boolean,
): TermImportApplyInput {
  return {
    importToken: preview.importToken,
    sections: [...selection.sections],
    fields: [...selection.fields],
    copyItems: selection.copyItems,
    ...(selection.copyItems && selection.overwriteExisting ? { overwriteExisting: true } : {}),
    ...(confirmReplaceValueSource ? { confirmReplaceValueSource: true } : {}),
  };
}

/** Itens que a aplicação vai gravar com a seleção atual (FA-04). */
export function itemsToImport(
  preview: TermImportPreviewDto,
  selection: EtpImportSelection,
): number {
  if (!selection.copyItems) return 0;
  return preview.items.preview.filter((item) => !item.specified || selection.overwriteExisting)
    .length;
}

export function toggle<T>(list: readonly T[], value: T, checked: boolean): T[] {
  return checked ? [...new Set([...list, value])] : list.filter((item) => item !== value);
}

/** Para onde o painel vai depois de uma recusa da API. */
export type EtpImportFailure =
  /** 410 (FA-03): recarrega a prévia automaticamente, com o aviso. */
  | { readonly kind: 'reload'; readonly message: string }
  /** 422 `ETP_REQUIRED_FOR_IMPORT`: estado vazio com o atalho para o ETP. */
  | { readonly kind: 'noEtp' }
  /** 412/428: o TR mudou — recarregar o documento. */
  | { readonly kind: 'conflict'; readonly message: string }
  /** Recusa que fecha o painel (sem permissão, não editável, fora da etapa). */
  | { readonly kind: 'blocked'; readonly message: string }
  /** 422 do corpo: a mensagem do campo, mantendo a seleção. */
  | { readonly kind: 'invalid'; readonly message: string; readonly field: string | null }
  /** Indisponibilidade ou erro inesperado: "Tentar novamente". */
  | { readonly kind: 'retry'; readonly message: string; readonly correlationId: string | null };

export function classifyEtpImportError(error: unknown, unexpected: string): EtpImportFailure {
  if (!isApiError(error)) return { kind: 'retry', message: unexpected, correlationId: null };
  switch (error.code) {
    case 'IMPORT_PREVIEW_EXPIRED':
      return { kind: 'reload', message: TERM_IMPORT_MESSAGES.expired };
    case 'ETP_REQUIRED_FOR_IMPORT':
      return { kind: 'noEtp' };
    case 'VERSION_CONFLICT':
      return { kind: 'conflict', message: TERM_IMPORT_MESSAGES.versionConflict };
    case 'PRECONDITION_REQUIRED':
      return { kind: 'conflict', message: TERM_IMPORT_MESSAGES.preconditionRequired };
    case 'DOCUMENT_NOT_EDITABLE':
      return { kind: 'blocked', message: TERM_IMPORT_MESSAGES.notEditable };
    case 'DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE':
      return { kind: 'blocked', message: TERM_IMPORT_MESSAGES.typeNotAllowedInStage };
    case 'PERMISSION_DENIED':
    case 'NOT_PROCESS_CUSTODIAN':
    case 'NOT_FOUND':
      return { kind: 'blocked', message: TERM_IMPORT_MESSAGES.permissionDenied };
    case 'IDEMPOTENCY_KEY_REUSED':
      return { kind: 'invalid', message: TERM_IMPORT_MESSAGES.keyReused, field: null };
    case 'IDEMPOTENCY_IN_PROGRESS':
      return { kind: 'retry', message: TERM_IMPORT_MESSAGES.inProgress, correlationId: null };
    case 'VALIDATION_ERROR': {
      const [first] = error.errors;
      return {
        kind: 'invalid',
        message: first?.message ?? TERM_IMPORT_MESSAGES.selectionInvalid,
        field: first?.field ?? null,
      };
    }
    default:
      return {
        kind: 'retry',
        message: error.status === 503 ? TERM_IMPORT_MESSAGES.unavailable : unexpected,
        correlationId: error.correlationId,
      };
  }
}
