'use client';

import { Button, cx, toast } from '@contrataflow/ui';
import { PRICE_CALCULATION_METHODS, PRICE_RESEARCH_MESSAGES } from '@contrataflow/validation';
import type { PriceCalculationMethod, PriceItemDto } from '@contrataflow/validation';
import { useMutation } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { isApiError } from '@/lib/api/api-error';

import {
  isItemMasked,
  methodBadge,
  methodBodyOf,
  methodChanged,
  methodDraftOf,
  methodIssues,
} from './price-research-model';
import type { MethodDraft } from './price-research-model';
import { recalculatePriceResearch, updatePriceItem } from './price-research.api';
import { FormField, INPUT_CLASS, TEXTAREA_CLASS } from '../processes/form-field';

/*
 * Cálculo por item da SCR-009 (US-029): `PriceItemStatsCard` (média, mediana, menor, maior,
 * desvio, CV e o card "Valor recomendado", com `aria-live="polite"` para anunciar o recálculo),
 * `MethodSelect` + `ManualPriceFieldset` (PRS-07, só com `UPDATE`) e `RecalculateButton` (PRS-20).
 * A tela nunca calcula: mostra o que a API devolveu e invalida a consulta dos itens depois de gravar.
 */

const decimalFormat = (decimals: number) =>
  new Intl.NumberFormat('pt-BR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

function moneyFormat(decimals: number): Intl.NumberFormat {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

const SELECT_CLASS = INPUT_CLASS;

export interface PriceItemCalculationProps {
  readonly item: PriceItemDto;
  readonly unitPriceDecimals: 2 | 4;
  /** `UPDATE` em `meta.allowedActions` (sem ela, somente leitura). */
  readonly canUpdate: boolean;
  /** Recarregar itens e cabeçalho depois de gravar. */
  readonly onSaved: () => Promise<void>;
  readonly onWriteError: (error: unknown, fallback: string) => void;
}

/** Painel de cálculo do item selecionado: estatísticas + método. */
export function PriceItemCalculation({
  item,
  unitPriceDecimals,
  canUpdate,
  onSaved,
  onWriteError,
}: PriceItemCalculationProps) {
  const t = useTranslations('priceResearch.calculation');
  return (
    <section
      aria-labelledby={`pr-calc-${item.id}`}
      className="flex min-w-0 flex-col gap-4 rounded-card border border-border bg-surface p-4"
    >
      <h3 id={`pr-calc-${item.id}`} className="text-base font-semibold">
        {t('title', { number: item.sequence })}
      </h3>
      <PriceItemStatsCard item={item} unitPriceDecimals={unitPriceDecimals} />
      {canUpdate ? (
        <MethodForm
          // Novo rascunho quando o item gravado muda (outra versão).
          key={`${item.id}-${String(item.version)}`}
          item={item}
          unitPriceDecimals={unitPriceDecimals}
          onSaved={onSaved}
          onWriteError={onWriteError}
        />
      ) : null}
    </section>
  );
}

/** `PriceItemStatsCard`: estatísticas e valor recomendado (RN-PRICE-41..44). */
export function PriceItemStatsCard({
  item,
  unitPriceDecimals,
}: {
  readonly item: PriceItemDto;
  readonly unitPriceDecimals: 2 | 4;
}) {
  const t = useTranslations('priceResearch.calculation');
  const masked = isItemMasked(item);
  const price = moneyFormat(4);
  const recommended = moneyFormat(unitPriceDecimals);
  const total = moneyFormat(2);
  const value = (text: string | null, format: Intl.NumberFormat) =>
    masked ? t('masked') : text === null ? t('notAvailable') : format.format(Number(text));
  const badge = methodBadge(item);
  const stats: readonly (readonly [string, string])[] = [
    [t('stats.count'), String(item.validQuotationsCount)],
    [t('stats.mean'), value(item.meanPrice, price)],
    [t('stats.median'), value(item.medianPrice, price)],
    [t('stats.lowest'), value(item.lowestPrice, price)],
    [t('stats.highest'), value(item.highestPrice, price)],
    [t('stats.stdDeviation'), value(item.stdDeviation, price)],
    [
      t('stats.cv'),
      masked
        ? t('masked')
        : item.coefficientOfVariation === null
          ? t('notAvailable')
          : t('percent', { value: decimalFormat(2).format(Number(item.coefficientOfVariation)) }),
    ],
  ];
  return (
    <div aria-live="polite" className="grid min-w-0 gap-4 md:grid-cols-[minmax(0,1fr)_16rem]">
      {item.validQuotationsCount === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
          {stats.map(([label, text]) => (
            <div key={label} className="flex flex-col">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="font-medium">{text}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="flex flex-col gap-1 rounded-card border border-border p-3">
        <span className="text-sm text-muted-foreground">{t('recommended')}</span>
        <span className="text-xl font-semibold">
          {value(item.recommendedUnitPrice, recommended)}
        </span>
        <span className="text-sm">
          {t('totalLabel')}: <strong>{value(item.totalPrice, total)}</strong>
        </span>
        {item.effectiveMethod === null ? null : (
          <span className="text-sm text-muted-foreground">
            {t('effectiveMethod', { method: t(`methods.${item.effectiveMethod}`) })}
          </span>
        )}
        <span
          className={cx(
            'mt-1 inline-flex w-fit rounded-control border px-2 py-0.5 text-xs font-medium',
            badge === 'MANUAL' ? 'border-warning/30 bg-warning-soft' : 'border-border',
          )}
        >
          {t(`badges.${badge}`)}
        </span>
        {badge === 'MANUAL' && item.manualJustification !== null ? (
          <p className="text-xs break-words text-muted-foreground">
            {t('manualJustification', { text: item.manualJustification })}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** `MethodSelect` + `ManualPriceFieldset` (PRS-07 · FA-01/FA-02 · V-01/V-02). */
function MethodForm({
  item,
  unitPriceDecimals,
  onSaved,
  onWriteError,
}: {
  readonly item: PriceItemDto;
  readonly unitPriceDecimals: 2 | 4;
  readonly onSaved: () => Promise<void>;
  readonly onWriteError: (error: unknown, fallback: string) => void;
}) {
  const t = useTranslations('priceResearch.calculation');
  const [draft, setDraft] = useState<MethodDraft>(() => methodDraftOf(item));
  const [touched, setTouched] = useState(false);
  const [serverIssues, setServerIssues] = useState<Record<string, string>>({});
  const issues = { ...methodIssues(draft, unitPriceDecimals), ...serverIssues };
  const changed = methodChanged(draft, item);
  const save = useMutation({
    mutationFn: () => updatePriceItem(item.id, methodBodyOf(draft), item.version),
    onSuccess: async () => {
      toast({ title: t('saved', { number: item.sequence }), tone: 'success' });
      await onSaved();
    },
    onError: (error: unknown) => {
      if (isApiError(error) && error.status === 422) {
        const mapped: Record<string, string> = {};
        for (const entry of error.errors) mapped[entry.field] ??= entry.message;
        setServerIssues(mapped);
        return;
      }
      if (isApiError(error) && error.status === 412) {
        onWriteError(error, PRICE_RESEARCH_MESSAGES.itemVersionConflict);
        return;
      }
      if (isApiError(error) && error.status === 503) {
        toast({
          title: PRICE_RESEARCH_MESSAGES.recalculateUnavailable,
          description:
            error.correlationId === null
              ? undefined
              : t('correlation', { id: error.correlationId }),
          tone: 'error',
        });
        return;
      }
      onWriteError(error, t('failed'));
    },
  });
  const update = (patch: Partial<MethodDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setServerIssues({});
  };
  const shown = (field: 'manualUnitPrice' | 'manualJustification') =>
    touched ? issues[field] : undefined;
  return (
    <form
      noValidate
      className="flex min-w-0 flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        setTouched(true);
        if (!changed || save.isPending) return;
        if (Object.keys(methodIssues(draft, unitPriceDecimals)).length > 0) return;
        save.mutate();
      }}
    >
      <FormField id={`pr-method-${item.id}`} label={t('method')} hint={t('methodHint')}>
        {(control) => (
          <select
            {...control}
            className={SELECT_CLASS}
            value={draft.methodOverride}
            onChange={(event) => {
              update({ methodOverride: event.target.value as PriceCalculationMethod | '' });
            }}
          >
            <option value="">{t('followDefault')}</option>
            {PRICE_CALCULATION_METHODS.map((method) => (
              <option key={method} value={method}>
                {t(`methods.${method}`)}
              </option>
            ))}
          </select>
        )}
      </FormField>
      {draft.methodOverride === 'MANUAL' ? (
        <fieldset className="flex min-w-0 flex-col gap-3">
          <legend className="text-sm font-medium">{t('manualLegend')}</legend>
          <FormField
            id={`pr-manual-price-${item.id}`}
            label={t('manualUnitPrice')}
            hint={t('manualUnitPriceHint', { decimals: unitPriceDecimals })}
            error={shown('manualUnitPrice')}
            required
            className="w-56"
          >
            {(control) => (
              <input
                {...control}
                inputMode="decimal"
                className={INPUT_CLASS}
                value={draft.manualUnitPrice}
                onChange={(event) => {
                  update({ manualUnitPrice: event.target.value });
                }}
              />
            )}
          </FormField>
          <FormField
            id={`pr-manual-justification-${item.id}`}
            label={t('manualJustificationLabel')}
            error={shown('manualJustification')}
            required
          >
            {(control) => (
              <textarea
                {...control}
                rows={3}
                className={TEXTAREA_CLASS}
                value={draft.manualJustification}
                onChange={(event) => {
                  update({ manualJustification: event.target.value });
                }}
              />
            )}
          </FormField>
        </fieldset>
      ) : null}
      <div>
        <Button type="submit" variant="secondary" disabled={!changed || save.isPending}>
          {save.isPending ? t('saving') : t('save')}
        </Button>
      </div>
    </form>
  );
}

/** `RecalculateButton` (PRS-20 · FA-04): "Recalcular agora". */
export function RecalculateButton({
  researchId,
  onDone,
  onWriteError,
}: {
  readonly researchId: string;
  readonly onDone: () => Promise<void>;
  readonly onWriteError: (error: unknown, fallback: string) => void;
}) {
  const t = useTranslations('priceResearch.calculation');
  const run = useMutation({
    mutationFn: () => recalculatePriceResearch(researchId),
    onSuccess: async () => {
      toast({ title: t('recalculated'), tone: 'success' });
      await onDone();
    },
    onError: (error: unknown) => {
      if (isApiError(error) && error.status === 503) {
        toast({
          title: PRICE_RESEARCH_MESSAGES.recalculateUnavailable,
          description:
            error.correlationId === null
              ? undefined
              : t('correlation', { id: error.correlationId }),
          tone: 'error',
        });
        return;
      }
      onWriteError(error, PRICE_RESEARCH_MESSAGES.recalculateUnavailable);
    },
  });
  return (
    <Button
      size="sm"
      variant="secondary"
      disabled={run.isPending}
      onClick={() => {
        run.mutate();
      }}
    >
      {run.isPending ? t('recalculating') : t('recalculate')}
    </Button>
  );
}
