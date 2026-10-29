'use client';

import { Button, toast } from '@contrataflow/ui';
import {
  PRICE_DEFAULT_METHODS,
  PRICE_RESEARCH_MESSAGES,
  PRICE_ROUNDING_MODES,
} from '@contrataflow/validation';
import type {
  PriceDefaultMethod,
  PriceResearchParameters,
  PriceRoundingMode,
} from '@contrataflow/validation';
import { useMutation } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { formatDate } from '@/lib/i18n/format';

import { parametersDraftOf, parametersPatchOf } from './price-research-model';
import type { ParametersDraft } from './price-research-model';
import { updatePriceResearch } from './price-research.api';
import { FormField, INPUT_CLASS } from '../processes/form-field';

const percentFormat = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 4 });

/**
 * `ParametersPanel` (US-024 · FA-06): o snapshot dos parâmetros `priceResearch.*` fixado na criação
 * (RN-PRICE-05), com a nota de que mudanças posteriores nas configurações não afetam esta pesquisa.
 * US-029 (FA-03 · RN-PRICE-47): com `UPDATE`, os parâmetros de cálculo são editáveis pelo PRS-04 —
 * salvar recalcula todos os itens.
 */
export function ParametersPanel({
  researchId,
  parameters,
  createdAt,
  timeZone,
  version,
  canUpdate = false,
  onSaved,
  onWriteError,
}: {
  readonly researchId?: string;
  readonly parameters: PriceResearchParameters;
  readonly createdAt: string;
  readonly timeZone: string;
  /** `version` da pesquisa (o `If-Match` do PRS-04). */
  readonly version?: number;
  readonly canUpdate?: boolean;
  readonly onSaved?: () => Promise<void>;
  readonly onWriteError?: (error: unknown, fallback: string) => void;
}) {
  const t = useTranslations('priceResearch.parameters');
  const [editing, setEditing] = useState(false);
  const percent = (value: string) => t('percent', { value: percentFormat.format(Number(value)) });
  const percentOfMedian = (value: string) =>
    t('percentOfMedian', { value: percentFormat.format(Number(value)) });
  const entries: readonly (readonly [string, string])[] = [
    [t('defaultMethod'), t(`methods.${parameters.defaultMethod}`)],
    [t('cvThreshold'), percent(parameters.cvThresholdPercent)],
    [t('minQuotations'), String(parameters.minQuotations)],
    [t('directQuoteMaxAgeDays'), t('days', { count: parameters.directQuoteMaxAgeDays })],
    [t('similarContractMaxAgeDays'), t('days', { count: parameters.similarContractMaxAgeDays })],
    [t('outlierLower'), percentOfMedian(parameters.outlierLowerPercent)],
    [t('outlierUpper'), percentOfMedian(parameters.outlierUpperPercent)],
    [t('unitPriceDecimals'), String(parameters.unitPriceDecimals)],
    [t('roundingMode'), t(`roundingModes.${parameters.roundingMode}`)],
  ];
  const editable =
    canUpdate && researchId !== undefined && version !== undefined && onSaved !== undefined;
  return (
    <section
      aria-labelledby="pr-parameters-title"
      className="flex min-w-0 flex-col gap-3 rounded-card bg-surface p-5 shadow-card"
    >
      <h2 id="pr-parameters-title" className="text-base font-semibold">
        {t('title')}
      </h2>
      {editing && editable ? (
        <ParametersEditor
          researchId={researchId}
          parameters={parameters}
          version={version}
          onClose={() => {
            setEditing(false);
          }}
          onSaved={onSaved}
          onWriteError={onWriteError}
        />
      ) : (
        <>
          <dl className="flex flex-col gap-2 text-sm">
            {entries.map(([label, value]) => (
              <div key={label} className="flex flex-col">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="font-medium">{value}</dd>
              </div>
            ))}
          </dl>
          {editable ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setEditing(true);
              }}
            >
              {t('edit.action')}
            </Button>
          ) : null}
        </>
      )}
      <p className="text-xs text-muted-foreground">
        {PRICE_RESEARCH_MESSAGES.parametersNote(formatDate(createdAt, timeZone))}
      </p>
    </section>
  );
}

/** Parâmetros de cálculo editáveis (PRS-04 · FA-03). */
function ParametersEditor({
  researchId,
  parameters,
  version,
  onClose,
  onSaved,
  onWriteError,
}: {
  readonly researchId: string;
  readonly parameters: PriceResearchParameters;
  readonly version: number;
  readonly onClose: () => void;
  readonly onSaved: () => Promise<void>;
  readonly onWriteError: ((error: unknown, fallback: string) => void) | undefined;
}) {
  const t = useTranslations('priceResearch.parameters');
  const [draft, setDraft] = useState<ParametersDraft>(() => parametersDraftOf(parameters));
  const { body, issues } = parametersPatchOf(draft, parameters);
  const hasChanges = Object.keys(body).length > 0;
  const valid = Object.keys(issues).length === 0;
  const save = useMutation({
    mutationFn: () => updatePriceResearch(researchId, body, version),
    onSuccess: async () => {
      toast({ title: t('edit.saved'), tone: 'success' });
      onClose();
      await onSaved();
    },
    onError: (error: unknown) => {
      onClose();
      onWriteError?.(error, t('edit.failed'));
    },
  });
  const update = (patch: Partial<ParametersDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
  };
  return (
    <form
      noValidate
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (hasChanges && valid && !save.isPending) save.mutate();
      }}
    >
      <p className="text-xs text-muted-foreground">{t('edit.hint')}</p>
      <FormField id="pr-param-method" label={t('defaultMethod')}>
        {(control) => (
          <select
            {...control}
            className={INPUT_CLASS}
            value={draft.defaultMethod}
            onChange={(event) => {
              update({ defaultMethod: event.target.value as PriceDefaultMethod });
            }}
          >
            {PRICE_DEFAULT_METHODS.map((method) => (
              <option key={method} value={method}>
                {t(`methods.${method}`)}
              </option>
            ))}
          </select>
        )}
      </FormField>
      <FormField id="pr-param-cv" label={t('cvThreshold')} error={issues.cvThresholdPercent}>
        {(control) => (
          <input
            {...control}
            inputMode="decimal"
            className={INPUT_CLASS}
            value={draft.cvThresholdPercent}
            onChange={(event) => {
              update({ cvThresholdPercent: event.target.value });
            }}
          />
        )}
      </FormField>
      <FormField id="pr-param-min" label={t('minQuotations')} error={issues.minQuotations}>
        {(control) => (
          <input
            {...control}
            type="number"
            min={1}
            max={10}
            className={INPUT_CLASS}
            value={draft.minQuotations}
            onChange={(event) => {
              update({ minQuotations: event.target.value });
            }}
          />
        )}
      </FormField>
      <FormField id="pr-param-decimals" label={t('unitPriceDecimals')}>
        {(control) => (
          <select
            {...control}
            className={INPUT_CLASS}
            value={String(draft.unitPriceDecimals)}
            onChange={(event) => {
              update({ unitPriceDecimals: event.target.value === '4' ? 4 : 2 });
            }}
          >
            <option value="2">2</option>
            <option value="4">4</option>
          </select>
        )}
      </FormField>
      <FormField id="pr-param-rounding" label={t('roundingMode')}>
        {(control) => (
          <select
            {...control}
            className={INPUT_CLASS}
            value={draft.roundingMode}
            onChange={(event) => {
              update({ roundingMode: event.target.value as PriceRoundingMode });
            }}
          >
            {PRICE_ROUNDING_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {t(`roundingModes.${mode}`)}
              </option>
            ))}
          </select>
        )}
      </FormField>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={!hasChanges || !valid || save.isPending}>
          {save.isPending ? t('edit.saving') : t('edit.save')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          {t('edit.cancel')}
        </Button>
      </div>
    </form>
  );
}
