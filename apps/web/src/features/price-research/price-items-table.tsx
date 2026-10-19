'use client';

import { Button, cx } from '@contrataflow/ui';
import { PRICE_RESEARCH_MESSAGES } from '@contrataflow/validation';
import type { PriceItemAlertCode, PriceItemDto } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';

import { isItemMasked } from './price-research-model';

const quantityFormat = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 4 });

function priceFormat(decimals: number): Intl.NumberFormat {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** `MaskedValue`: "Sigiloso" em texto (nunca só um ícone) quando POL-09 mascarou o valor. */
function RecommendedValue({
  item,
  format,
}: {
  readonly item: PriceItemDto;
  readonly format: Intl.NumberFormat;
}) {
  const t = useTranslations('priceResearch.items');
  if (isItemMasked(item)) {
    return (
      <span title={t('maskedHint')} className="text-muted-foreground">
        {t('masked')}
      </span>
    );
  }
  if (item.recommendedUnitPrice === null) {
    return <span className="text-muted-foreground">{t('notCalculated')}</span>;
  }
  return <span>{format.format(Number(item.recommendedUnitPrice))}</span>;
}

function AlertChips({ item }: { readonly item: PriceItemDto }) {
  const t = useTranslations('priceResearch.items');
  if (item.alerts.length === 0) {
    return <span className="text-sm text-muted-foreground">{t('noAlerts')}</span>;
  }
  const labels: Record<PriceItemAlertCode, string> = {
    NO_VALID_QUOTES: t('alerts.NO_VALID_QUOTES'),
    BELOW_MINIMUM_QUOTES: t('alerts.BELOW_MINIMUM_QUOTES'),
    HIGH_CV: t('alerts.HIGH_CV'),
    HAS_OUTLIERS: t('alerts.HAS_OUTLIERS'),
    EXPIRED_QUOTES: t('alerts.EXPIRED_QUOTES'),
  };
  return (
    <ul className="flex flex-wrap gap-1">
      {item.alerts.map((alert) => (
        <li
          key={alert.code}
          className="rounded-control border border-warning/30 bg-warning-soft px-2 py-0.5 text-xs font-medium"
        >
          {labels[alert.code]}
        </li>
      ))}
    </ul>
  );
}

export interface PriceItemsTableProps {
  readonly items: readonly PriceItemDto[];
  /** Casas decimais do preço unitário do snapshot (RN-PRICE-05). */
  readonly unitPriceDecimals: number;
  /** `REMOVE_ITEMS` em `meta.allowedActions`. */
  readonly canRemove: boolean;
  readonly removing: boolean;
  readonly onRemove: (item: PriceItemDto) => void;
  /** US-029: item cujo cálculo está aberto abaixo da tabela. */
  readonly selectedId?: string | null;
  readonly onSelect?: (item: PriceItemDto) => void;
}

/**
 * `PriceItemsTable` (US-024 · SCR-009 aba "Itens"): nº, lote, descrição, unidade, quantidade,
 * alertas e valor recomendado ("Sigiloso" sob POL-09). Tabela com `caption` a partir de 768 px;
 * abaixo disso, um cartão por item. "Remover" só com `REMOVE_ITEMS` e nunca no último item
 * (RN-PRICE-11). "Ver cálculo" (US-029) abre as estatísticas e o método do item.
 */
export function PriceItemsTable({
  items,
  unitPriceDecimals,
  canRemove,
  removing,
  onRemove,
  selectedId = null,
  onSelect,
}: PriceItemsTableProps) {
  const t = useTranslations('priceResearch.items');
  const tCalc = useTranslations('priceResearch.calculation');
  const format = priceFormat(unitPriceDecimals);
  const isLast = items.length <= 1;
  return (
    <table className="block w-full md:table">
      <caption className="sr-only">{t('caption')}</caption>
      <thead className="hidden text-left text-sm text-muted-foreground md:table-header-group">
        <tr>
          <th scope="col" className="px-3 py-2">
            {t('columns.sequence')}
          </th>
          <th scope="col" className="px-3 py-2">
            {t('columns.lot')}
          </th>
          <th scope="col" className="px-3 py-2">
            {t('columns.description')}
          </th>
          <th scope="col" className="px-3 py-2">
            {t('columns.unit')}
          </th>
          <th scope="col" className="px-3 py-2 text-right">
            {t('columns.quantity')}
          </th>
          <th scope="col" className="px-3 py-2">
            {t('columns.alerts')}
          </th>
          <th scope="col" className="px-3 py-2 text-right">
            {t('columns.recommended')}
          </th>
          {onSelect === undefined ? null : (
            <th scope="col" className="px-3 py-2">
              <span className="sr-only">{tCalc('details')}</span>
            </th>
          )}
          {canRemove ? (
            <th scope="col" className="px-3 py-2">
              {t('columns.actions')}
            </th>
          ) : null}
        </tr>
      </thead>
      <tbody className="block md:table-row-group">
        {items.map((item) => (
          <tr
            key={item.id}
            className={cx(
              'grid grid-cols-1 gap-1 rounded-card border border-border p-3',
              'mb-2 md:mb-0 md:table-row md:rounded-none md:border-0 md:border-b md:p-0',
            )}
          >
            <td className="font-medium md:table-cell md:px-3 md:py-2">
              <span className="text-muted-foreground md:hidden">{t('columns.sequence')} </span>
              {item.sequence}
            </td>
            <td className="text-sm md:table-cell md:px-3 md:py-2">
              <span className="text-muted-foreground md:hidden">{t('columns.lot')}: </span>
              {item.lotNumber === null
                ? t('noLot')
                : item.lotName === null
                  ? t('lot', { number: item.lotNumber })
                  : t('lotNamed', { number: item.lotNumber, name: item.lotName })}
            </td>
            <td className="min-w-0 text-sm break-words md:table-cell md:px-3 md:py-2">
              {item.description}
            </td>
            <td className="text-sm md:table-cell md:px-3 md:py-2">
              <span className="text-muted-foreground md:hidden">{t('columns.unit')}: </span>
              {item.unit.label}
            </td>
            <td className="text-sm md:table-cell md:px-3 md:py-2 md:text-right">
              <span className="text-muted-foreground md:hidden">{t('columns.quantity')}: </span>
              {quantityFormat.format(Number(item.quantity))}
            </td>
            <td className="md:table-cell md:px-3 md:py-2">
              <AlertChips item={item} />
            </td>
            <td className="text-sm md:table-cell md:px-3 md:py-2 md:text-right">
              <span className="text-muted-foreground md:hidden">{t('columns.recommended')}: </span>
              <RecommendedValue item={item} format={format} />
            </td>
            {onSelect === undefined ? null : (
              <td className="md:table-cell md:px-3 md:py-2">
                <Button
                  size="sm"
                  variant="ghost"
                  aria-expanded={selectedId === item.id}
                  aria-label={tCalc('detailsItem', { number: item.sequence })}
                  onClick={() => {
                    onSelect(item);
                  }}
                >
                  {tCalc('details')}
                </Button>
              </td>
            )}
            {canRemove ? (
              <td className="md:table-cell md:px-3 md:py-2">
                {isLast ? (
                  <span className="text-xs text-muted-foreground">
                    {PRICE_RESEARCH_MESSAGES.lastItem}
                  </span>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={removing}
                    aria-label={t('removeItem', { number: item.sequence })}
                    onClick={() => {
                      onRemove(item);
                    }}
                  >
                    {t('remove')}
                  </Button>
                )}
              </td>
            ) : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
