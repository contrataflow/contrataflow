import {
  QUOTATION_IMPORT_HEADERS,
  QUOTATION_IMPORT_LIMITS,
  QUOTATION_IMPORT_MESSAGES,
  unitPriceIssue,
} from '@contrataflow/validation';
import type {
  QuotationImportColumn,
  QuotationImportIssue,
  QuotationImportRow,
  QuotationImportSummary,
} from '@contrataflow/validation';
import { Decimal } from 'decimal.js';

import { normalizeUnitPrice } from './price-source.js';
import type { Quotation } from './price-source.js';

/*
 * Importação de cotações por planilha (US-028 · RN-PRICE-35..40): a matriz do modelo (itens nas
 * linhas pela `sequence`, fontes nas colunas pelo cabeçalho = descrição da fonte), a leitura da
 * planilha enviada célula a célula (`QuotationImportPreview` — erros e avisos por linha/célula, sem
 * gravar nada) e o plano da aplicação sobre as cotações vigentes. Puro: sem NestJS, Prisma nem
 * outro módulo; preços com `decimal.js` (DEC-003).
 */

/** Item da pesquisa como aparece na planilha. */
export interface ImportItemRef {
  readonly priceItemId: string;
  readonly sequence: number;
  readonly description: string;
  readonly unitLabel: string;
}

export interface ImportSourceRef {
  readonly id: string;
  readonly description: string;
}

/** Célula da planilha lida (mesma forma do leitor XLSX). */
export interface SheetCell {
  readonly kind: 'text' | 'number' | 'boolean' | 'error';
  readonly text: string;
}

export interface SheetRow {
  readonly row: number;
  readonly cells: ReadonlyMap<number, SheetCell>;
}

/** Célula válida da prévia: o que a aplicação grava (RN-PRICE-38). */
export interface ImportCell {
  readonly priceItemId: string;
  readonly priceSourceId: string;
  /** Decimal(18,4) normalizado. */
  readonly unitPrice: string;
}

// --- Cabeçalhos (RN-PRICE-35 · FA-02) -----------------------------------------------------------

/** Comparação de cabeçalhos: sem acento, caixa, espaços extras nem quebra de linha. */
export function normalizeHeader(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Cabeçalho de cada fonte (RN-PRICE-35): a descrição; descrições repetidas ganham o ordinal entre
 * as iguais (`Painel de Preços (2)`) — o modelo e a leitura usam a mesma regra.
 */
export function sourceHeaders(
  sources: readonly ImportSourceRef[],
): { readonly sourceId: string; readonly header: string }[] {
  const totals = new Map<string, number>();
  for (const source of sources) {
    const key = normalizeHeader(source.description);
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return sources.map((source) => {
    const key = normalizeHeader(source.description);
    const ordinal = (seen.get(key) ?? 0) + 1;
    seen.set(key, ordinal);
    const header =
      (totals.get(key) ?? 0) > 1
        ? `${source.description.trim()} (${String(ordinal)})`
        : source.description.trim();
    return { sourceId: source.id, header };
  });
}

// --- Modelo (PRS-24) ----------------------------------------------------------------------------

export interface ImportTemplateMatrix {
  readonly headers: readonly string[];
  readonly rows: readonly {
    readonly sequence: number;
    readonly description: string;
    readonly unitLabel: string;
    /** Preço vigente por fonte (na ordem dos cabeçalhos); `null` = sem cotação. */
    readonly prices: readonly (string | null)[];
  }[];
}

/**
 * RN-PRICE-35: colunas fixas (item, descrição, unidade) + uma por fonte; os preços já lançados
 * pré-preenchidos (também os desconsiderados, que a importação ignora com aviso — RN-PRICE-39).
 */
export function importTemplateMatrix(input: {
  readonly items: readonly ImportItemRef[];
  readonly sources: readonly ImportSourceRef[];
  readonly quotations: readonly Pick<Quotation, 'priceItemId' | 'priceSourceId' | 'unitPrice'>[];
  readonly unitPriceDecimals: 2 | 4;
}): ImportTemplateMatrix {
  const headers = sourceHeaders(input.sources);
  const prices = new Map(
    input.quotations.map((quotation) => [
      `${quotation.priceItemId}:${quotation.priceSourceId}`,
      new Decimal(quotation.unitPrice).toFixed(input.unitPriceDecimals),
    ]),
  );
  return {
    headers: [
      QUOTATION_IMPORT_HEADERS.item,
      QUOTATION_IMPORT_HEADERS.description,
      QUOTATION_IMPORT_HEADERS.unit,
      ...headers.map((entry) => entry.header),
    ],
    rows: [...input.items]
      .sort((a, b) => a.sequence - b.sequence)
      .map((item) => ({
        sequence: item.sequence,
        description: item.description,
        unitLabel: item.unitLabel,
        prices: headers.map((entry) => prices.get(`${item.priceItemId}:${entry.sourceId}`) ?? null),
      })),
  };
}

// --- Leitura da planilha (PRS-18 · RN-PRICE-36/37) ----------------------------------------------

/** Planilha sem a estrutura mínima (RN-PRICE-36): 422 antes de qualquer célula. */
export type ImportStructureProblem = 'NO_ITEM_COLUMN' | 'NO_SOURCE_COLUMN' | 'TOO_MANY_SOURCES';

export interface ImportPreviewPlan {
  readonly columns: readonly QuotationImportColumn[];
  readonly columnIssues: readonly QuotationImportIssue[];
  readonly rows: readonly QuotationImportRow[];
  readonly summary: QuotationImportSummary;
  readonly cells: readonly ImportCell[];
}

export type ImportPreviewResult =
  | ({ readonly kind: 'ok' } & ImportPreviewPlan)
  | { readonly kind: 'invalid'; readonly problem: ImportStructureProblem };

/** Letra da coluna a partir do índice 0 (`0` → `A`). */
function letterOf(index: number): string {
  let value = index + 1;
  let letters = '';
  while (value > 0) {
    const rest = (value - 1) % 26;
    letters = String.fromCharCode(65 + rest) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}

const FIXED_HEADERS = new Set([
  normalizeHeader(QUOTATION_IMPORT_HEADERS.description),
  normalizeHeader(QUOTATION_IMPORT_HEADERS.unit),
]);
const ITEM_HEADERS = new Set([normalizeHeader(QUOTATION_IMPORT_HEADERS.item), 'sequencia']);

/** Sequência do item na célula: inteiro positivo (número ou texto de dígitos). */
export function sequenceOf(cell: SheetCell | undefined): number | null {
  if (cell === undefined) return null;
  const text = cell.text.trim();
  if (cell.kind === 'number') {
    try {
      const value = new Decimal(text);
      return value.isInteger() && value.gt(0) && value.lte(1_000_000) ? value.toNumber() : null;
    } catch {
      return null;
    }
  }
  return cell.kind === 'text' && /^\d{1,7}$/.test(text) && Number(text) > 0 ? Number(text) : null;
}

/**
 * Preço da célula como texto decimal com ponto, para a validação da grade (`unitPriceIssue`):
 * número da planilha arredondado a 15 dígitos significativos (o que o Excel exibe — remove o ruído
 * de ponto flutuante); texto aceita `R$`, separador de milhar e vírgula decimal (`1.234,56`).
 */
export function cellPriceText(cell: SheetCell): string | null {
  const text = cell.text.trim();
  if (cell.kind === 'number') {
    try {
      const value = new Decimal(text);
      return value.isFinite() ? value.toSignificantDigits(15).toFixed() : null;
    } catch {
      return null;
    }
  }
  if (cell.kind !== 'text') return null;
  const plain = text.replace(/^R\$\s*/i, '').replace(/\s/g, '');
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(plain))
    return plain.replaceAll('.', '').replace(',', '.');
  if (/^-?\d+,\d+$/.test(plain)) return plain.replace(',', '.');
  return plain;
}

/**
 * RN-PRICE-37: lê a planilha inteira sem gravar — a primeira linha não vazia é o cabeçalho; a coluna
 * do item e as das fontes são achadas pelo cabeçalho (FA-02: ordem livre; coluna sem fonte = aviso);
 * cada linha seguinte é um item pela `sequence` e cada célula de fonte, um preço. Erros: item não
 * encontrado ou repetido (a linha inteira), preço inválido (a célula). Aviso: cotação `EXCLUDED`
 * (RN-PRICE-39). Célula vazia não altera nada.
 */
export function planQuotationImport(input: {
  readonly rows: readonly SheetRow[];
  readonly items: readonly ImportItemRef[];
  readonly sources: readonly ImportSourceRef[];
  readonly quotations: readonly Pick<Quotation, 'priceItemId' | 'priceSourceId' | 'status'>[];
  readonly unitPriceDecimals: 2 | 4;
}): ImportPreviewResult {
  const [header, ...dataRows] = [...input.rows].sort((a, b) => a.row - b.row);
  if (header === undefined) return { kind: 'invalid', problem: 'NO_ITEM_COLUMN' };

  const byHeader = new Map(
    sourceHeaders(input.sources).map((entry) => [normalizeHeader(entry.header), entry]),
  );
  let itemColumn: number | null = null;
  const columns: QuotationImportColumn[] = [];
  const columnIssues: QuotationImportIssue[] = [];
  const sourceColumns: { index: number; sourceId: string; header: string }[] = [];
  const matched = new Set<string>();
  for (const [index, cell] of [...header.cells.entries()].sort((a, b) => a[0] - b[0])) {
    const text = cell.text.trim();
    const key = normalizeHeader(text);
    if (key === '') continue;
    if (ITEM_HEADERS.has(key)) {
      itemColumn ??= index;
      continue;
    }
    if (FIXED_HEADERS.has(key)) continue;
    const entry = byHeader.get(key);
    const column = letterOf(index);
    if (entry !== undefined && !matched.has(entry.sourceId)) {
      matched.add(entry.sourceId);
      sourceColumns.push({ index, sourceId: entry.sourceId, header: entry.header });
      columns.push({ column, header: text, priceSourceId: entry.sourceId });
      continue;
    }
    columns.push({ column, header: text, priceSourceId: null });
    columnIssues.push({
      severity: 'WARNING',
      code: 'REFERENCE_NOT_FOUND',
      row: null,
      column,
      header: text,
      priceSourceId: null,
      message: QUOTATION_IMPORT_MESSAGES.sourceNotFound(text),
    });
  }
  if (itemColumn === null) return { kind: 'invalid', problem: 'NO_ITEM_COLUMN' };
  if (sourceColumns.length === 0) return { kind: 'invalid', problem: 'NO_SOURCE_COLUMN' };
  if (sourceColumns.length > QUOTATION_IMPORT_LIMITS.maxSources) {
    return { kind: 'invalid', problem: 'TOO_MANY_SOURCES' };
  }

  const itemsBySequence = new Map(input.items.map((item) => [item.sequence, item]));
  const statusOf = new Map(
    input.quotations.map((quotation) => [
      `${quotation.priceItemId}:${quotation.priceSourceId}`,
      quotation.status,
    ]),
  );
  const seenItems = new Set<string>();
  const rows: QuotationImportRow[] = [];
  const cells: ImportCell[] = [];
  const summary = { total: 0, valid: 0, errors: 0, empty: 0, warnings: 0, rows: 0 };

  for (const sheetRow of dataRows) {
    const filled = sourceColumns.filter((column) => sheetRow.cells.has(column.index));
    const itemCell = sheetRow.cells.get(itemColumn);
    // Linha só com texto fora das fontes (anotação, total) e sem item: não é linha de item.
    if (itemCell === undefined && filled.length === 0) continue;

    const sequence = sequenceOf(itemCell);
    const item = sequence === null ? undefined : itemsBySequence.get(sequence);
    const row = {
      row: sheetRow.row,
      sequence,
      priceItemId: item?.priceItemId ?? null,
      valid: 0,
      errors: 0,
      empty: sourceColumns.length - filled.length,
      warnings: 0,
      issues: [] as QuotationImportIssue[],
    };
    const rowError = (code: 'REFERENCE_NOT_FOUND' | 'DUPLICATE_IN_LIST', message: string) => {
      row.priceItemId = null;
      row.errors = filled.length;
      row.issues.push({
        severity: 'ERROR',
        code,
        row: sheetRow.row,
        column: letterOf(itemColumn),
        header: null,
        priceSourceId: null,
        message,
      });
    };

    if (item === undefined) {
      rowError('REFERENCE_NOT_FOUND', QUOTATION_IMPORT_MESSAGES.itemNotFound(sheetRow.row));
    } else if (seenItems.has(item.priceItemId)) {
      rowError('DUPLICATE_IN_LIST', QUOTATION_IMPORT_MESSAGES.itemDuplicated(sheetRow.row));
    } else {
      seenItems.add(item.priceItemId);
      for (const column of filled) {
        const cell = sheetRow.cells.get(column.index);
        if (cell === undefined) continue;
        const issue = (
          severity: 'ERROR' | 'WARNING',
          code: 'INVALID_DECIMAL' | 'QUOTATION_EXCLUDED',
          message: string,
        ) =>
          row.issues.push({
            severity,
            code,
            row: sheetRow.row,
            column: letterOf(column.index),
            header: column.header,
            priceSourceId: column.sourceId,
            message,
          });
        const price = cellPriceText(cell);
        if (unitPriceIssue(price, input.unitPriceDecimals) !== null) {
          row.errors += 1;
          issue(
            'ERROR',
            'INVALID_DECIMAL',
            QUOTATION_IMPORT_MESSAGES.priceInvalid(sheetRow.row, column.header),
          );
          continue;
        }
        if (statusOf.get(`${item.priceItemId}:${column.sourceId}`) === 'EXCLUDED') {
          row.warnings += 1;
          issue(
            'WARNING',
            'QUOTATION_EXCLUDED',
            QUOTATION_IMPORT_MESSAGES.quotationExcluded(sheetRow.row, column.header),
          );
          continue;
        }
        row.valid += 1;
        cells.push({
          priceItemId: item.priceItemId,
          priceSourceId: column.sourceId,
          unitPrice: normalizeUnitPrice(price ?? ''),
        });
      }
    }
    rows.push(row);
    summary.rows += 1;
    summary.total += sourceColumns.length;
    summary.valid += row.valid;
    summary.errors += row.errors;
    summary.empty += row.empty;
    summary.warnings += row.warnings;
  }
  return { kind: 'ok', columns, columnIssues, rows, summary, cells };
}

// --- Aplicação (PRS-19 · RN-PRICE-38..40) -------------------------------------------------------

export interface ImportApplicationPlan {
  /** Células sem cotação do item na fonte: cotação nova. */
  readonly creates: readonly ImportCell[];
  /** Células sobre cotação `VALID` com outro preço: `Quotation.upsertPrice`. */
  readonly updates: readonly { readonly cell: ImportCell; readonly existing: Quotation }[];
  /** Células da prévia não aplicadas: item/fonte removidos, cotação `EXCLUDED` ou preço igual. */
  readonly unchanged: number;
}

/**
 * Sobre as cotações VIGENTES (a pesquisa está travada): a edição manual feita entre a prévia e a
 * aplicação é sobrescrita pelo valor da planilha — o último aplicado vale ("[Concorrência]"); item
 * ou fonte removidos e cotação desconsiderada depois da prévia são ignorados.
 */
export function planImportApplication(input: {
  readonly cells: readonly ImportCell[];
  readonly itemIds: ReadonlySet<string>;
  readonly sourceIds: ReadonlySet<string>;
  readonly quotations: readonly Quotation[];
}): ImportApplicationPlan {
  const existing = new Map(
    input.quotations.map((quotation) => [
      `${quotation.priceItemId}:${quotation.priceSourceId}`,
      quotation,
    ]),
  );
  const creates: ImportCell[] = [];
  const updates: { cell: ImportCell; existing: Quotation }[] = [];
  let unchanged = 0;
  const seen = new Set<string>();
  for (const cell of input.cells) {
    const key = `${cell.priceItemId}:${cell.priceSourceId}`;
    if (
      seen.has(key) ||
      !input.itemIds.has(cell.priceItemId) ||
      !input.sourceIds.has(cell.priceSourceId)
    ) {
      unchanged += 1;
      continue;
    }
    seen.add(key);
    const current = existing.get(key);
    if (current === undefined) {
      creates.push(cell);
    } else if (current.status === 'EXCLUDED' || current.unitPrice === cell.unitPrice) {
      unchanged += 1;
    } else {
      updates.push({ cell, existing: current });
    }
  }
  return { creates, updates, unchanged };
}
