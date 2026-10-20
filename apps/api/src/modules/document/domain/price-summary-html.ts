import { escapeHtml } from '@contrataflow/editor';
import {
  COMPARATIVE_MAP_LABELS,
  COMPARATIVE_MAP_MESSAGES,
  PRICE_CALCULATION_METHODS,
  PRICE_ITEM_ALERT_CODES,
  PRICE_SUMMARY_COLLECTIONS,
} from '@contrataflow/validation';
import type { DocumentSnapshot } from '@contrataflow/validation';

/*
 * Seção computada `PRICE_SUMMARY` do PDF da pesquisa de preços (US-031 · RN-PRICE-55): o mapa
 * comparativo a partir das coleções `priceSummary*` que o módulo `price-research` grava no snapshot
 * (`PRICE_SUMMARY_COLLECTIONS`). Duas tabelas — a matriz de preços (itens × fontes F1..Fn) e as
 * estatísticas/valor estimado por item — mais a legenda das fontes e o total. Os valores chegam já
 * mascarados quando a rendition é `masked` (`maskConfidentialSnapshot`: `<campo>: null` +
 * `<campo>Masked: true`) e saem como "Valor sigiloso" (RN-PRICE-56). O snapshot é JSON gravado:
 * tudo é conferido e escapado aqui. Função pura.
 */

export const MASKED_LABEL = 'Valor sigiloso';

type Row = Readonly<Record<string, unknown>>;

const asRows = (value: readonly unknown[] | undefined): Row[] =>
  (value ?? []).filter((entry): entry is Row => typeof entry === 'object' && entry !== null);

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** Número ou texto do snapshot como texto (qualquer outra coisa = vazio). */
const text = (value: unknown): string =>
  typeof value === 'number' || typeof value === 'string' ? String(value) : '';

const DECIMAL = /^-?\d+(?:\.\d+)?$/;

/** Decimal com ponto → pt-BR (`1234.5000` → `1.234,50`), sem passar por `float`: corta os zeros à direita além de `minDecimals`. */
export function brazilianDecimal(value: string, minDecimals: number): string {
  if (!DECIMAL.test(value)) return value;
  const negative = value.startsWith('-');
  const [integer = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.');
  let digits = fraction;
  while (digits.length > minDecimals && digits.endsWith('0')) digits = digits.slice(0, -1);
  digits = digits.padEnd(minDecimals, '0');
  let grouped = '';
  for (let index = 0; index < integer.length; index += 1) {
    const fromEnd = integer.length - index;
    grouped += integer.charAt(index) + (fromEnd > 1 && (fromEnd - 1) % 3 === 0 ? '.' : '');
  }
  return `${negative ? '-' : ''}${grouped}${digits === '' ? '' : `,${digits}`}`;
}

/** `AAAA-MM-DD` → `DD/MM/AAAA`. */
function civilDate(value: string): string {
  const [year = '', month = '', day = ''] = value.slice(0, 10).split('-');
  return `${day}/${month}/${year}`;
}

/** Campo monetário com a POL-09 aplicada (`<campo>Masked`). */
function money(row: Row, field: string, decimals: number): string {
  if (row[`${field}Masked`] === true) return MASKED_LABEL;
  const value = str(row[field]);
  return value === null ? '—' : escapeHtml(brazilianDecimal(value, decimals));
}

function isMethod(value: unknown): value is (typeof PRICE_CALCULATION_METHODS)[number] {
  return (PRICE_CALCULATION_METHODS as readonly unknown[]).includes(value);
}

function isAlert(value: unknown): value is (typeof PRICE_ITEM_ALERT_CODES)[number] {
  return (PRICE_ITEM_ALERT_CODES as readonly unknown[]).includes(value);
}

function cellHtml(cell: unknown, decimals: number): string {
  if (typeof cell !== 'object' || cell === null) return '<td class="cf-num">—</td>';
  const record = cell as Row;
  const notes: string[] = [];
  if (record.status === 'EXCLUDED') notes.push(COMPARATIVE_MAP_LABELS.excluded);
  if (record.outlierFlag === 'HIGH') notes.push(COMPARATIVE_MAP_LABELS.outlierHigh);
  if (record.outlierFlag === 'LOW') notes.push(COMPARATIVE_MAP_LABELS.outlierLow);
  if (record.isExpired === true) notes.push(COMPARATIVE_MAP_LABELS.expired);
  const price = money(record, 'unitPrice', decimals);
  const badges =
    notes.length === 0
      ? ''
      : `<br><span class="cf-badge">${notes.map((note) => escapeHtml(note)).join(' · ')}</span>`;
  const excluded = record.status === 'EXCLUDED' ? ' cf-excluded' : '';
  return `<td class="cf-num${excluded}">${price}${badges}</td>`;
}

export const PRICE_SUMMARY_STYLE =
  '.cf-map{font-size:.8em;}.cf-map th,.cf-map td{padding:2pt 3pt;}.cf-num{text-align:right;}' +
  '.cf-badge{font-size:.85em;color:#444;}.cf-excluded{text-decoration:line-through;color:#555;}';

/** O mapa comparativo da seção `PRICE_SUMMARY`. */
export function priceSummaryHtml(collections: DocumentSnapshot['collections']): string {
  const summary = asRows(collections[PRICE_SUMMARY_COLLECTIONS.summary])[0] ?? {};
  const sources = asRows(collections[PRICE_SUMMARY_COLLECTIONS.sources]);
  const items = asRows(collections[PRICE_SUMMARY_COLLECTIONS.items]);
  const decimals = summary.unitPriceDecimals === 4 ? 4 : 2;
  const parts: string[] = [`<style>${PRICE_SUMMARY_STYLE}</style>`];

  const referenceDate = str(summary.referenceDate);
  const calculatedAt = str(summary.lastCalculatedAt);
  const meta = [
    referenceDate === null ? null : `Data-base: ${civilDate(referenceDate)}`,
    calculatedAt === null
      ? null
      : `Calculado em ${civilDate(calculatedAt)} ${calculatedAt.slice(11, 16)} UTC`,
  ].filter((part): part is string => part !== null);
  if (meta.length > 0) parts.push(`<p class="cf-meta">${escapeHtml(meta.join(' · '))}</p>`);

  if (items.length === 0) {
    parts.push('<p class="cf-empty">A pesquisa não tem itens.</p>');
    return parts.join('');
  }

  // Legenda das fontes (colunas F1..Fn da matriz).
  if (sources.length === 0) {
    parts.push(`<p class="cf-empty">${escapeHtml(COMPARATIVE_MAP_MESSAGES.noSources)}.</p>`);
  } else {
    parts.push(
      '<table class="cf-grid cf-map"><thead><tr><th>Fonte</th><th>Descrição</th><th>Tipo</th>' +
        '<th>Fornecedor</th><th>Data</th></tr></thead><tbody>' +
        sources
          .map((source, index) => {
            const quoteDate = str(source.quoteDate);
            return (
              `<tr><td>F${String(index + 1)}</td>` +
              `<td>${escapeHtml(str(source.description) ?? '')}</td>` +
              `<td>${escapeHtml(str(source.sourceTypeLabel) ?? '')}</td>` +
              `<td>${escapeHtml(str(source.supplierName) ?? '—')}</td>` +
              `<td>${quoteDate === null ? '—' : escapeHtml(civilDate(quoteDate))}</td></tr>`
            );
          })
          .join('') +
        '</tbody></table>',
    );
    // Matriz itens × fontes.
    parts.push(
      '<table class="cf-grid cf-map"><thead><tr><th>Item</th><th>Descrição</th>' +
        sources.map((_, index) => `<th>F${String(index + 1)}</th>`).join('') +
        '</tr></thead><tbody>' +
        items
          .map((item) => {
            const cells = Array.isArray(item.cells) ? (item.cells as unknown[]) : [];
            return (
              `<tr><td>${escapeHtml(text(item.sequence))}</td>` +
              `<td>${escapeHtml(str(item.description) ?? '')}</td>` +
              sources.map((_, index) => cellHtml(cells[index], decimals)).join('') +
              '</tr>'
            );
          })
          .join('') +
        '</tbody></table>',
    );
  }

  // Estatísticas, método e valor estimado por item.
  parts.push(
    '<table class="cf-grid cf-map"><thead><tr><th>Item</th><th>Un.</th><th>Qtd.</th>' +
      '<th>Válidas</th><th>Média</th><th>Mediana</th><th>Menor</th><th>Maior</th><th>CV (%)</th>' +
      '<th>Método</th><th>Valor unitário</th><th>Valor total</th><th>Alertas</th></tr></thead><tbody>' +
      items
        .map((item) => {
          const alerts = Array.isArray(item.alerts)
            ? (item.alerts as unknown[])
                .filter(isAlert)
                .map((code) => COMPARATIVE_MAP_LABELS.alerts[code])
            : [];
          const quantity = str(item.quantity);
          return (
            `<tr><td>${escapeHtml(text(item.sequence))}</td>` +
            `<td>${escapeHtml(str(item.unitLabel) ?? '')}</td>` +
            `<td class="cf-num">${quantity === null ? '—' : escapeHtml(brazilianDecimal(quantity, 0))}</td>` +
            `<td class="cf-num">${escapeHtml(text(item.validQuotationsCount) || '0')}</td>` +
            `<td class="cf-num">${money(item, 'meanPrice', decimals)}</td>` +
            `<td class="cf-num">${money(item, 'medianPrice', decimals)}</td>` +
            `<td class="cf-num">${money(item, 'lowestPrice', decimals)}</td>` +
            `<td class="cf-num">${money(item, 'highestPrice', decimals)}</td>` +
            `<td class="cf-num">${money(item, 'coefficientOfVariation', 2)}</td>` +
            `<td>${isMethod(item.effectiveMethod) ? escapeHtml(COMPARATIVE_MAP_LABELS.methods[item.effectiveMethod]) : '—'}</td>` +
            `<td class="cf-num">${money(item, 'recommendedUnitPrice', decimals)}</td>` +
            `<td class="cf-num">${money(item, 'totalPrice', 2)}</td>` +
            `<td>${alerts.length === 0 ? '—' : escapeHtml(alerts.join('; '))}</td></tr>`
          );
        })
        .join('') +
      '</tbody></table>',
  );
  parts.push(
    `<p><strong>Valor total estimado:</strong> ${money(summary, 'totalEstimatedValue', 2)}</p>`,
  );
  return parts.join('');
}
