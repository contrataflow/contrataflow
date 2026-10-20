'use client';

import { Alert, Button, cx, toast } from '@contrataflow/ui';
import { PRICE_SOURCE_MESSAGES } from '@contrataflow/validation';
import type {
  PriceItemDto,
  PriceResearchParameters,
  PriceSourceDto,
  QuotationDto,
} from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { newIdempotencyKey } from '@/lib/api/client';

import { ExcludeQuotationDialog } from './exclude-quotation-dialog';
import { ExpiredBadge, OutlierBadge } from './price-alert-badges';
import { gridLines, gridRows, initialGridCells, toInputDecimal } from './price-source-model';
import type { GridCell, GridRow } from './price-source-model';
import {
  deleteQuotation,
  restoreQuotation,
  saveQuotationGrid,
  updateQuotation,
} from './price-sources.api';

const quantityFormat = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 4 });

type Column = 'unitPrice' | 'brandModel';

/**
 * `QuotationGrid` (US-026 · fluxo principal 6–9, FA-03/04/05/07): uma linha por item da pesquisa com
 * "Preço unitário" e "Marca/modelo"; edição local e um único envio em "Salvar preços" (PRS-13 com o
 * `If-Match` da fonte e a mesma `Idempotency-Key` ao reenviar os mesmos dados). Uma única célula já
 * gravada vai pelo PRS-14 (FA-03); "Remover" numa célula usa o PRS-15 (FA-04). Cotação desconsiderada
 * fica esmaecida e somente leitura, com o motivo em dica (FA-05); "Desconsiderar" (diálogo com motivo e
 * justificativa — PRS-16) e "Restaurar" (PRS-17) são de quem tem `EXCLUDE_QUOTATION` (US-027). Na
 * "Situação", os selos de destaque e de validade calculados no recálculo (US-030 — `OutlierBadge`/
 * `ExpiredBadge`). Setas para cima/baixo mudam de item; para os lados,
 * mudam de coluna nas bordas do texto. Em telas estreitas a grade rola na horizontal com a coluna
 * "Item" fixa.
 */
export function QuotationGrid({
  source,
  items,
  decimals,
  outlierParameters,
  editable,
  canExclude,
  onSaved,
  onWriteError,
}: {
  readonly source: PriceSourceDto;
  readonly items: readonly PriceItemDto[];
  readonly decimals: 2 | 4;
  /** Limiares de destaque do snapshot (US-030 — tooltip do `OutlierBadge`). */
  readonly outlierParameters: Pick<
    PriceResearchParameters,
    'outlierLowerPercent' | 'outlierUpperPercent'
  >;
  readonly editable: boolean;
  /** `EXCLUDE_QUOTATION` em `meta.allowedActions` (US-027): desconsiderar e restaurar. */
  readonly canExclude: boolean;
  /** Recarregar fontes, itens e totais (US-029) depois de gravar. */
  readonly onSaved: () => Promise<void>;
  readonly onWriteError: (error: unknown, fallback: string) => void;
}) {
  const t = useTranslations('priceResearch.sources.grid');
  const tSources = useTranslations('priceResearch.sources');
  const rows = gridRows(items, source);
  const [cells, setCells] = useState<Record<string, GridCell>>(() =>
    initialGridCells(rows, decimals),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [excluding, setExcluding] = useState<GridRow | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const attempt = useRef<{ readonly json: string; readonly key: string } | null>(null);
  const inputs = useRef(new Map<string, HTMLInputElement>());
  const editableRows = rows.filter((row) => !row.excluded);

  const setCell = (itemId: string, column: Column, value: string) => {
    setCells((current) => ({
      ...current,
      [itemId]: { ...(current[itemId] ?? { unitPrice: '', brandModel: '' }), [column]: value },
    }));
    setErrors((current) => ({ ...current, [itemId]: '' }));
    setInfo(null);
  };

  const focus = (rowIndex: number, column: Column) => {
    const row = editableRows[rowIndex];
    if (row) inputs.current.get(`${row.item.id}:${column}`)?.focus();
  };

  /** Setas entre células ("Acessibilidade e responsividade"). */
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>, itemId: string, column: Column) => {
    const index = editableRows.findIndex((row) => row.item.id === itemId);
    const input = event.currentTarget;
    const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
    const atEnd = input.selectionStart === input.value.length;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focus(index + 1, column);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focus(index - 1, column);
    } else if (event.key === 'ArrowRight' && atEnd && column === 'unitPrice') {
      event.preventDefault();
      focus(index, 'brandModel');
    } else if (event.key === 'ArrowLeft' && atStart && column === 'brandModel') {
      event.preventDefault();
      focus(index, 'unitPrice');
    }
  };

  const save = async () => {
    const { lines, errors: invalid } = gridLines(rows, cells, decimals);
    if (Object.keys(invalid).length > 0) {
      setErrors(invalid);
      return;
    }
    if (lines.length === 0) {
      setInfo(t('nothingToSave'));
      return;
    }
    setSaving(true);
    try {
      const [line] = lines;
      const single =
        lines.length === 1 && line !== undefined
          ? rows.find((row) => row.item.id === line.priceItemId)?.quotation
          : null;
      if (single !== null && single !== undefined && line !== undefined) {
        // FA-03: uma única célula já gravada vai pelo PRS-14.
        await updateQuotation(
          single.id,
          { unitPrice: line.unitPrice ?? undefined, brandModel: line.brandModel ?? null },
          single.version,
        );
      } else {
        const json = JSON.stringify({ version: source.version, lines });
        if (attempt.current?.json !== json) attempt.current = { json, key: newIdempotencyKey() };
        await saveQuotationGrid(source.id, lines, source.version, attempt.current.key);
      }
      attempt.current = null;
      toast({ title: tSources('toast.pricesSaved'), tone: 'success' });
      await onSaved();
    } catch (error) {
      if (isApiError(error) && error.code === 'VALIDATION_ERROR') {
        const byIndex: Record<string, string> = {};
        for (const item of error.errors) {
          const match = /^items\[(\d+)]\./.exec(item.field);
          const target = match ? lines[Number(match[1])]?.priceItemId : line0(lines);
          if (target !== undefined) byIndex[target] = item.message;
        }
        setErrors(byIndex);
      } else if (isApiError(error) && error.code === 'INVALID_STATE') {
        onWriteError(error, PRICE_SOURCE_MESSAGES.quotationExcluded);
      } else {
        onWriteError(error, tSources('errors.saveFailed'));
      }
    } finally {
      setSaving(false);
    }
  };

  const remove = async (quotation: QuotationDto) => {
    try {
      await deleteQuotation(quotation.id, quotation.version);
      toast({ title: tSources('toast.quotationRemoved'), tone: 'success' });
      await onSaved();
    } catch (error) {
      onWriteError(error, tSources('errors.saveFailed'));
    }
  };

  /** PRS-17 (fluxo principal 5): "Restaurar" volta a cotação ao cálculo, sem diálogo. */
  const restore = async (quotation: QuotationDto) => {
    setRestoring(quotation.id);
    try {
      await restoreQuotation(quotation.id, quotation.version);
      toast({ title: t('toast.restored'), tone: 'success' });
      await onSaved();
    } catch (error) {
      onWriteError(error, t('errors.restoreFailed'));
    } finally {
      setRestoring(null);
    }
  };

  const reasonOf = (quotation: QuotationDto | null) =>
    t(`reasons.${quotation?.exclusionReason ?? 'OTHER'}` as 'reasons.OTHER');

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="text-xs text-muted-foreground">{t('keyboardHint')}</p>
      <div className="min-w-0 overflow-x-auto rounded-card border border-border">
        <table className="w-full min-w-[40rem] text-sm">
          <caption className="sr-only">{t('label', { description: source.description })}</caption>
          <thead>
            <tr className="border-b border-border text-left">
              <th scope="col" className="sticky left-0 bg-surface px-3 py-2">
                {t('item')}
              </th>
              <th scope="col" className="px-3 py-2">
                {t('quantity')}
              </th>
              <th scope="col" className="px-3 py-2">
                {t('unitPrice')}
              </th>
              <th scope="col" className="px-3 py-2">
                {t('brandModel')}
              </th>
              <th scope="col" className="px-3 py-2">
                {t('status')}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const cell = cells[row.item.id] ?? { unitPrice: '', brandModel: '' };
              const error = errors[row.item.id];
              const errorId = `grid-${source.id}-${row.item.id}-error`;
              const masked = row.quotation?.unitPriceMasked === true;
              const readOnly = !editable || row.excluded || masked;
              return (
                <tr
                  key={row.item.id}
                  className={cx(
                    'border-b border-border align-top last:border-b-0',
                    row.excluded && 'text-muted-foreground opacity-60',
                  )}
                >
                  <th
                    scope="row"
                    className="sticky left-0 bg-surface px-3 py-2 text-left font-normal"
                  >
                    <span className="font-medium">{row.item.sequence}.</span> {row.item.description}
                  </th>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {quantityFormat.format(Number(row.item.quantity))} {row.item.unit.label}
                  </td>
                  <td className="px-3 py-2">
                    {readOnly ? (
                      <span
                        title={
                          row.excluded
                            ? t('excludedHint', { reason: reasonOf(row.quotation) })
                            : undefined
                        }
                      >
                        {masked
                          ? t('masked')
                          : toInputDecimal(row.quotation?.unitPrice ?? null, decimals) || '—'}
                      </span>
                    ) : (
                      <>
                        <input
                          ref={(element) => {
                            if (element) inputs.current.set(`${row.item.id}:unitPrice`, element);
                          }}
                          inputMode="decimal"
                          className={cx(
                            'h-9 w-32 rounded-control border bg-surface px-2 text-right',
                            error ? 'border-destructive' : 'border-border',
                          )}
                          aria-label={t('unitPriceLabel', { number: row.item.sequence })}
                          aria-invalid={error ? true : undefined}
                          aria-describedby={error ? errorId : undefined}
                          value={cell.unitPrice}
                          onChange={(event) => {
                            setCell(row.item.id, 'unitPrice', event.target.value);
                          }}
                          onKeyDown={(event) => {
                            onKeyDown(event, row.item.id, 'unitPrice');
                          }}
                        />
                        {error ? (
                          <p
                            id={errorId}
                            className="mt-1 text-xs text-destructive"
                            aria-live="polite"
                          >
                            {error}
                          </p>
                        ) : null}
                      </>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {readOnly ? (
                      <span>{row.quotation?.brandModel ?? '—'}</span>
                    ) : (
                      <input
                        ref={(element) => {
                          if (element) inputs.current.set(`${row.item.id}:brandModel`, element);
                        }}
                        className="h-9 w-48 rounded-control border border-border bg-surface px-2"
                        maxLength={200}
                        aria-label={t('brandModelLabel', { number: row.item.sequence })}
                        value={cell.brandModel}
                        onChange={(event) => {
                          setCell(row.item.id, 'brandModel', event.target.value);
                        }}
                        onKeyDown={(event) => {
                          onKeyDown(event, row.item.id, 'brandModel');
                        }}
                      />
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      {row.excluded ? (
                        <span
                          className="rounded-control border border-border px-2 py-0.5 text-xs"
                          title={t('excludedHint', { reason: reasonOf(row.quotation) })}
                        >
                          {t('excluded')}
                        </span>
                      ) : null}
                      {row.quotation?.status === 'VALID' ? (
                        <OutlierBadge
                          flag={row.quotation.outlierFlag}
                          parameters={outlierParameters}
                          masked={row.quotation.unitPriceMasked}
                        />
                      ) : null}
                      <ExpiredBadge isExpired={row.quotation?.isExpired === true} />
                      {canExclude && row.quotation?.status === 'VALID' ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={t('excludeQuotation', { number: row.item.sequence })}
                          onClick={() => {
                            setExcluding(row);
                          }}
                        >
                          {t('exclude')}
                        </Button>
                      ) : null}
                      {canExclude && row.excluded && row.quotation !== null ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={restoring === row.quotation.id}
                          aria-label={t('restoreQuotation', { number: row.item.sequence })}
                          onClick={() => {
                            if (row.quotation) void restore(row.quotation);
                          }}
                        >
                          {t('restore')}
                        </Button>
                      ) : null}
                      {editable && row.quotation !== null ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={t('removeQuotation', { number: row.item.sequence })}
                          onClick={() => {
                            if (row.quotation) void remove(row.quotation);
                          }}
                        >
                          {tSources('actions.remove')}
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {info === null ? null : <Alert tone="info" title={info} />}
      <ExcludeQuotationDialog
        row={excluding}
        onClose={() => {
          setExcluding(null);
        }}
        onExcluded={onSaved}
        onWriteError={onWriteError}
      />
      {editable ? (
        <div>
          <Button
            disabled={saving}
            onClick={() => {
              void save();
            }}
          >
            {saving ? t('saving') : t('save')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

const line0 = (lines: readonly { readonly priceItemId: string }[]) => lines[0]?.priceItemId;
