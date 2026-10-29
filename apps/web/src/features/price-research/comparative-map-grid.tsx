'use client';

import { TableContainer, cx } from '@contrataflow/ui';
import type {
  ComparativeMapCell,
  ComparativeMapDto,
  ComparativeMapItem,
  PriceResearchParameters,
} from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

import { formatCivilDate } from '@/lib/i18n/format';

import { cellIndex, nextGridPosition } from './comparative-map-model';
import type { GridPosition } from './comparative-map-model';
import { AlertBadgeList, ExpiredBadge, OutlierBadge } from './price-alert-badges';

/*
 * `ComparativeMapGrid` (US-031 · SCR-010 · RN-PRICE-53): a matriz itens × fontes — linhas por
 * `sortOrder` do item, colunas por `sortOrder` da fonte — com as estatísticas e os alertas no fim de
 * cada linha. Uma única área de rolagem com o cabeçalho das fontes fixo (`sticky top`) e a coluna do
 * item fixa (`sticky left`): a rolagem horizontal e a vertical andam juntas. Navegável por teclado
 * (setas, Home/End, Ctrl+Home/End) com foco itinerante: só a célula ativa entra na ordem do Tab.
 * `MapCellPrice` mostra o preço (ou "Sigiloso" sob POL-09) e os selos de US-030 com texto.
 */

const STAT_COLUMNS = [
  'validCount',
  'mean',
  'median',
  'lowest',
  'highest',
  'cv',
  'method',
  'recommended',
  'total',
  'alerts',
] as const;

/** Preço a partir da string decimal da API (sem `number`), com as casas da pesquisa. */
export function formatPrice(value: string, decimals: number): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: decimals,
    maximumFractionDigits: 4,
  }).format(value as Intl.StringNumericLiteral);
}

function formatNumber(value: string, maximumFractionDigits = 4): string {
  return new Intl.NumberFormat('pt-BR', { maximumFractionDigits }).format(
    value as Intl.StringNumericLiteral,
  );
}

type OutlierParameters = Pick<
  PriceResearchParameters,
  'outlierLowerPercent' | 'outlierUpperPercent'
>;

/** `MapCellPrice`: valor + selos (desconsiderada, destoante, vencida). */
export function MapCellPrice({
  cell,
  decimals,
  parameters,
}: {
  readonly cell: ComparativeMapCell | undefined;
  readonly decimals: number;
  readonly parameters: OutlierParameters | null;
}): ReactNode {
  const t = useTranslations('priceResearch.map');
  if (cell === undefined) {
    return (
      <span className="text-muted-foreground">
        <span aria-hidden="true">—</span>
        <span className="sr-only">{t('noQuotation')}</span>
      </span>
    );
  }
  const excluded = cell.status === 'EXCLUDED';
  return (
    <span className="flex flex-col items-end gap-1">
      <span className={cx('tabular-nums', excluded && 'text-muted-foreground line-through')}>
        {cell.unitPriceMasked || cell.unitPrice === null
          ? t('masked')
          : formatPrice(cell.unitPrice, decimals)}
      </span>
      {excluded || cell.outlierFlag !== 'NONE' || cell.isExpired ? (
        <span className="flex flex-wrap justify-end gap-1">
          {excluded ? (
            <span className="rounded-control border border-border px-2 py-0.5 text-xs font-medium">
              {cell.exclusionReason === null
                ? t('excluded')
                : t('excludedReason', { reason: t(`reasons.${cell.exclusionReason}`) })}
            </span>
          ) : null}
          <OutlierBadge
            flag={cell.outlierFlag}
            parameters={parameters ?? { outlierLowerPercent: '0', outlierUpperPercent: '0' }}
            masked={cell.unitPriceMasked || parameters === null}
          />
          <ExpiredBadge isExpired={cell.isExpired} />
        </span>
      ) : null}
    </span>
  );
}

interface StatLabels {
  readonly masked: string;
  readonly notCalculated: string;
  readonly percent: (value: string) => string;
  readonly method: (method: NonNullable<ComparativeMapItem['effectiveMethod']>) => string;
}

/** O conteúdo das colunas de estatística do item (na ordem de `STAT_COLUMNS`). */
function statCells(item: ComparativeMapItem, decimals: number, labels: StatLabels): ReactNode[] {
  const masked = item.valuesMasked;
  const money = (value: string | null, scale = decimals) => {
    if (masked) return labels.masked;
    return value === null ? labels.notCalculated : formatPrice(value, scale);
  };
  let cv: string;
  if (masked) cv = labels.masked;
  else if (item.coefficientOfVariation === null) cv = labels.notCalculated;
  else cv = labels.percent(formatNumber(item.coefficientOfVariation, 2));
  return [
    item.validQuotationsCount,
    money(item.meanPrice),
    money(item.medianPrice),
    money(item.lowestPrice),
    money(item.highestPrice),
    cv,
    item.effectiveMethod === null ? labels.notCalculated : labels.method(item.effectiveMethod),
    money(item.recommendedUnitPrice),
    money(item.totalPrice, 2),
    <AlertBadgeList key="alerts" alerts={item.alerts} />,
  ];
}

export function ComparativeMapGrid({
  map,
  parameters,
}: {
  readonly map: ComparativeMapDto;
  readonly parameters: OutlierParameters | null;
}): ReactNode {
  const t = useTranslations('priceResearch.map');
  const tMethod = useTranslations('priceResearch.calculation.methods');
  const labels: StatLabels = {
    masked: t('masked'),
    notCalculated: t('notCalculated'),
    percent: (value) => t('percent', { value }),
    method: (method) => tMethod(method),
  };
  const cellOf = cellIndex(map);
  const noSources = map.sources.length === 0;
  // Colunas navegáveis: item + fontes (ou a coluna vazia do FA-04) + estatísticas.
  const columns = 1 + (noSources ? 1 : map.sources.length) + STAT_COLUMNS.length;
  const rows = 1 + map.items.length;
  const [active, setActive] = useState<GridPosition>({ row: 0, column: 0 });
  const cellKey = (row: number, column: number) => `${String(row)}:${String(column)}`;

  const onKeyDown = (event: KeyboardEvent<HTMLTableElement>) => {
    const next = nextGridPosition(active, event, { rows, columns });
    if (next === null) return;
    event.preventDefault();
    setActive(next);
    event.currentTarget
      .querySelector<HTMLElement>(`[data-cell="${cellKey(next.row, next.column)}"]`)
      ?.focus();
  };

  /** Props de foco itinerante de cada célula. */
  const cellProps = (row: number, column: number) => ({
    'data-cell': cellKey(row, column),
    tabIndex: active.row === row && active.column === column ? 0 : -1,
    onFocus: () => {
      setActive({ row, column });
    },
    'aria-colindex': column + 1,
  });

  const stickyItem = 'sticky left-0 z-10 bg-surface';
  const headClass =
    'border-b border-border bg-muted px-3 py-2 text-left align-bottom text-xs font-semibold';
  const cellClass =
    'border-b border-border px-3 py-2 align-top text-sm focus:outline-2 focus:outline-primary';

  return (
    // Só a página rola na vertical (prd-5 · regra 8): o `TableContainer` rola apenas na horizontal
    // (mapa mais largo que a tela), por isso o cabeçalho não é fixo no topo, só a coluna do item.
    <TableContainer label={t('caption')} className="min-w-0">
      <table
        // Padrão de grade do WAI-ARIA sobre a tabela de dados: navegação por setas entre células.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-element-to-interactive-role -- grade somente leitura navegável (SCR-010)
        role="grid"
        aria-label={t('caption')}
        aria-rowcount={rows}
        aria-colcount={columns}
        className="min-w-max border-separate border-spacing-0"
        onKeyDown={onKeyDown}
      >
        <caption className="sr-only">{t('caption')}</caption>
        <thead>
          <tr aria-rowindex={1}>
            <th
              scope="col"
              className={cx(headClass, 'sticky left-0 z-10 min-w-56')}
              {...cellProps(0, 0)}
            >
              {t('columns.item')}
            </th>
            {noSources ? (
              <th scope="col" className={headClass} {...cellProps(0, 1)}>
                {t('columns.sources')}
              </th>
            ) : (
              map.sources.map((source, index) => (
                <th
                  key={source.id}
                  scope="col"
                  className={cx(headClass, 'min-w-40 text-right')}
                  {...cellProps(0, index + 1)}
                >
                  <span className="block">{source.description}</span>
                  <span className="block font-normal text-muted-foreground">
                    {source.sourceType.label}
                  </span>
                  {source.supplierName === null ? null : (
                    <span className="block font-normal text-muted-foreground">
                      {source.supplierName}
                    </span>
                  )}
                  {source.quoteDate === null ? null : (
                    <span className="block font-normal text-muted-foreground">
                      {formatCivilDate(source.quoteDate)}
                    </span>
                  )}
                </th>
              ))
            )}
            {STAT_COLUMNS.map((column, index) => (
              <th
                key={column}
                scope="col"
                className={cx(headClass, 'min-w-28', column !== 'alerts' && 'text-right')}
                {...cellProps(0, columns - STAT_COLUMNS.length + index)}
              >
                {t(`columns.${column}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {map.items.map((item, rowIndex) => {
            const row = rowIndex + 1;
            const stats = statCells(item, map.unitPriceDecimals, labels);
            return (
              <tr key={item.id} aria-rowindex={row + 1}>
                <th
                  scope="row"
                  className={cx(cellClass, stickyItem, 'text-left font-normal')}
                  {...cellProps(row, 0)}
                >
                  <span className="block font-medium">
                    {t('itemLabel', { number: item.sequence, description: item.description })}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {t('quantity', { quantity: formatNumber(item.quantity), unit: item.unitLabel })}
                  </span>
                </th>
                {noSources ? (
                  // FA-04: a mensagem fica acima da grade; a coluna segue navegável, vazia.
                  <td className={cx(cellClass, 'text-muted-foreground')} {...cellProps(row, 1)}>
                    <MapCellPrice
                      cell={undefined}
                      decimals={map.unitPriceDecimals}
                      parameters={null}
                    />
                  </td>
                ) : (
                  map.sources.map((source, index) => (
                    <td
                      key={source.id}
                      className={cx(cellClass, 'text-right')}
                      {...cellProps(row, index + 1)}
                    >
                      <MapCellPrice
                        cell={cellOf(item.id, source.id)}
                        decimals={map.unitPriceDecimals}
                        parameters={parameters}
                      />
                    </td>
                  ))
                )}
                {stats.map((content, index) => (
                  <td
                    key={STAT_COLUMNS[index]}
                    className={cx(
                      cellClass,
                      STAT_COLUMNS[index] !== 'alerts' && 'text-right tabular-nums',
                    )}
                    {...cellProps(row, columns - STAT_COLUMNS.length + index)}
                  >
                    {content}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableContainer>
  );
}
