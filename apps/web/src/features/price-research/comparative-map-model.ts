import { COMPARATIVE_MAP_MESSAGES } from '@contrataflow/validation';
import type { ComparativeMapCell, ComparativeMapDto } from '@contrataflow/validation';

import { isApiError } from '@/lib/api/api-error';

/*
 * Regras da SCR-010 (US-031), sem React: o índice das células da matriz (item × fonte), a navegação
 * por teclado entre células (setas, Home/End, Ctrl+Home/End — padrão de grade do WAI-ARIA) e a
 * tradução das recusas da exportação XLSX (PRS-22) para a mensagem e a ação da tela.
 */

const keyOf = (priceItemId: string, priceSourceId: string) => `${priceItemId}:${priceSourceId}`;

/** As células do mapa por cruzamento item × fonte (cruzamento sem cotação = ausente). */
export function cellIndex(
  map: Pick<ComparativeMapDto, 'cells'>,
): (priceItemId: string, priceSourceId: string) => ComparativeMapCell | undefined {
  const cells = new Map(
    map.cells.map((cell) => [keyOf(cell.priceItemId, cell.priceSourceId), cell]),
  );
  return (priceItemId, priceSourceId) => cells.get(keyOf(priceItemId, priceSourceId));
}

export interface GridPosition {
  readonly row: number;
  readonly column: number;
}

/**
 * A próxima célula focada para a tecla (ou `null` se a tecla não navega). `rows`/`columns` contam
 * todas as linhas e colunas navegáveis (cabeçalhos incluídos).
 */
export function nextGridPosition(
  position: GridPosition,
  key: { readonly key: string; readonly ctrlKey?: boolean; readonly metaKey?: boolean },
  size: { readonly rows: number; readonly columns: number },
): GridPosition | null {
  const lastRow = size.rows - 1;
  const lastColumn = size.columns - 1;
  const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max);
  const control = key.ctrlKey === true || key.metaKey === true;
  switch (key.key) {
    case 'ArrowUp':
      return { row: clamp(position.row - 1, lastRow), column: position.column };
    case 'ArrowDown':
      return { row: clamp(position.row + 1, lastRow), column: position.column };
    case 'ArrowLeft':
      return { row: position.row, column: clamp(position.column - 1, lastColumn) };
    case 'ArrowRight':
      return { row: position.row, column: clamp(position.column + 1, lastColumn) };
    case 'Home':
      return control ? { row: 0, column: 0 } : { row: position.row, column: 0 };
    case 'End':
      return control
        ? { row: lastRow, column: lastColumn }
        : { row: position.row, column: lastColumn };
    default:
      return null;
  }
}

/** Resultado de uma exportação XLSX recusada. */
export type ExportFailure =
  /** FA-01 (V-01): acima de 500 itens/50 fontes — sugere o PDF ou reduzir o recorte. */
  | { readonly kind: 'tooLarge'; readonly message: string }
  /** Pesquisa não visível/outro tenant: volta à lista de processos. */
  | { readonly kind: 'notFound'; readonly message: string }
  /** Indisponibilidade ou erro inesperado: mantém o mapa e oferece "Tentar novamente". */
  | {
      readonly kind: 'retry';
      readonly message: string;
      readonly correlationId: string | null;
    };

export function describeExportError(error: unknown): ExportFailure {
  if (!isApiError(error)) {
    return { kind: 'retry', message: COMPARATIVE_MAP_MESSAGES.unavailable, correlationId: null };
  }
  if (error.code === 'EXPORT_TOO_LARGE') {
    return { kind: 'tooLarge', message: COMPARATIVE_MAP_MESSAGES.tooLarge };
  }
  if (error.status === 404) {
    return { kind: 'notFound', message: COMPARATIVE_MAP_MESSAGES.notFound };
  }
  return {
    kind: 'retry',
    message: COMPARATIVE_MAP_MESSAGES.unavailable,
    correlationId: error.correlationId,
  };
}
