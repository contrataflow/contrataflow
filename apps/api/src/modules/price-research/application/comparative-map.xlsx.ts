import { COMPARATIVE_MAP_LABELS, COMPARATIVE_MAP_MESSAGES } from '@contrataflow/validation';
import type { ComparativeMapCell, ComparativeMapDto } from '@contrataflow/validation';

import type { XlsxCellStyle, XlsxCellValue, XlsxSheetInput } from '#shared/spreadsheet/xlsx.js';

/*
 * A planilha do mapa comparativo (US-031 · PRS-22): uma aba com a mesma matriz da SCR-010 — uma
 * linha por item (`sortOrder`), uma coluna de preço por fonte (`sortOrder`), depois as estatísticas,
 * o método, o valor estimado e os alertas do item; os selos de cada célula (desconsiderada, destoante,
 * vencida) vão na coluna "Observações" para os preços continuarem numéricos. Abaixo da matriz, a
 * legenda das fontes e o resumo (data-base, cálculo, total). Recebe o mapa JÁ mascarado (POL-09):
 * valor `null` com a marca de mascarado sai como "Sigiloso". Sem data de geração (conteúdo
 * determinístico — RN-PRICE-57). Função pura.
 */

const SHEET_NAME = 'Mapa comparativo';
const FIXED_HEADERS = ['Item', 'Descrição', 'Unidade', 'Quantidade'] as const;
const STAT_HEADERS = [
  'Cotações válidas',
  'Média',
  'Mediana',
  'Menor preço',
  'Maior preço',
  'Desvio padrão',
  'CV (%)',
  'Método',
  'Valor unitário estimado',
  'Valor total estimado',
  'Alertas',
  'Observações',
] as const;

const text = (value: string, style?: XlsxCellStyle): XlsxCellValue =>
  style === undefined ? { kind: 'text', value } : { kind: 'text', value, style };

/** Data `AAAA-MM-DD` → `DD/MM/AAAA`. */
function civilDate(date: string): string {
  const [year = '', month = '', day = ''] = date.split('-');
  return `${day}/${month}/${year}`;
}

/** Instante ISO → `DD/MM/AAAA HH:mm` (UTC) — referência do último recálculo. */
function instant(iso: string): string {
  return `${civilDate(iso.slice(0, 10))} ${iso.slice(11, 16)} UTC`;
}

/** Colunas com o mesmo cabeçalho ganham ` (n)` (o leitor da planilha distingue as fontes). */
function uniqueHeaders(descriptions: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return descriptions.map((description) => {
    const count = (seen.get(description) ?? 0) + 1;
    seen.set(description, count);
    return count === 1 ? description : `${description} (${String(count)})`;
  });
}

function cellNotes(cell: ComparativeMapCell): string[] {
  const notes: string[] = [];
  if (cell.status === 'EXCLUDED') {
    notes.push(
      cell.exclusionReason === null
        ? COMPARATIVE_MAP_LABELS.excluded
        : `${COMPARATIVE_MAP_LABELS.excluded} (${COMPARATIVE_MAP_LABELS.exclusionReasons[cell.exclusionReason]})`,
    );
  }
  if (cell.outlierFlag === 'HIGH') notes.push(COMPARATIVE_MAP_LABELS.outlierHigh);
  if (cell.outlierFlag === 'LOW') notes.push(COMPARATIVE_MAP_LABELS.outlierLow);
  if (cell.isExpired) notes.push(COMPARATIVE_MAP_LABELS.expired);
  return notes;
}

export function comparativeMapSheet(map: ComparativeMapDto): XlsxSheetInput {
  const priceStyle: XlsxCellStyle = map.unitPriceDecimals === 4 ? 'decimal4' : 'decimal2';
  const money = (
    value: string | null,
    masked: boolean,
    style: XlsxCellStyle = priceStyle,
  ): XlsxCellValue => {
    if (masked) return text(COMPARATIVE_MAP_MESSAGES.masked);
    return value === null ? null : { kind: 'number', value, style };
  };
  const headers = uniqueHeaders(map.sources.map((source) => source.description));
  const cells = new Map<string, ComparativeMapCell>(
    map.cells.map((cell) => [`${cell.priceItemId}:${cell.priceSourceId}`, cell]),
  );

  const rows: XlsxCellValue[][] = [
    [...FIXED_HEADERS, ...headers, ...STAT_HEADERS].map((header) => text(header, 'header')),
  ];
  for (const item of map.items) {
    const notes: string[] = [];
    const prices = map.sources.map((source, index): XlsxCellValue => {
      const cell = cells.get(`${item.id}:${source.id}`);
      if (cell === undefined) return null;
      const flags = cellNotes(cell);
      if (flags.length > 0)
        notes.push(`${headers[index] ?? source.description}: ${flags.join(', ')}`);
      return money(cell.unitPrice, cell.unitPriceMasked);
    });
    rows.push([
      { kind: 'number', value: String(item.sequence) },
      text(item.description),
      text(item.unitLabel),
      { kind: 'number', value: item.quantity },
      ...prices,
      { kind: 'number', value: String(item.validQuotationsCount) },
      money(item.meanPrice, item.valuesMasked),
      money(item.medianPrice, item.valuesMasked),
      money(item.lowestPrice, item.valuesMasked),
      money(item.highestPrice, item.valuesMasked),
      money(item.stdDeviation, item.valuesMasked),
      money(item.coefficientOfVariation, item.valuesMasked, 'decimal2'),
      item.effectiveMethod === null
        ? null
        : text(COMPARATIVE_MAP_LABELS.methods[item.effectiveMethod]),
      money(item.recommendedUnitPrice, item.valuesMasked),
      money(item.totalPrice, item.valuesMasked, 'decimal2'),
      item.alerts.length === 0
        ? null
        : text(item.alerts.map((alert) => COMPARATIVE_MAP_LABELS.alerts[alert.code]).join('; ')),
      notes.length === 0 ? null : text(notes.join('; ')),
    ]);
  }
  if (map.sources.length === 0) rows.push([null, text(COMPARATIVE_MAP_MESSAGES.noSources)]);

  rows.push([]);
  rows.push(
    ['Fonte', 'Descrição', 'Tipo', 'Fornecedor', 'Data'].map((header) => text(header, 'header')),
  );
  map.sources.forEach((source, index) => {
    rows.push([
      text(headers[index] ?? source.description),
      text(source.description),
      text(source.sourceType.label),
      source.supplierName === null ? null : text(source.supplierName),
      source.quoteDate === null ? null : text(civilDate(source.quoteDate)),
    ]);
  });

  rows.push([]);
  rows.push([text('Data-base', 'header'), text(civilDate(map.referenceDate))]);
  rows.push([
    text('Calculado em', 'header'),
    map.lastCalculatedAt === null ? null : text(instant(map.lastCalculatedAt)),
  ]);
  rows.push([
    text('Valor total estimado', 'header'),
    money(map.totalEstimatedValue, map.masked, 'decimal2'),
  ]);

  return {
    name: SHEET_NAME,
    rows,
    columnWidths: [
      8,
      50,
      12,
      14,
      ...map.sources.map(() => 18),
      10,
      14,
      14,
      14,
      14,
      14,
      10,
      14,
      18,
      18,
      30,
      50,
    ],
    freezeHeader: true,
  };
}
