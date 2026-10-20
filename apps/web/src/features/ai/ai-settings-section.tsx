'use client';

import {
  AI_MONTHLY_TOKEN_LIMIT_MIN,
  AI_PLATFORM_MAX_MONTHLY_TOKENS_DEFAULT,
  AI_USER_DAILY_REQUEST_LIMIT_MAX,
  AI_USER_DAILY_REQUEST_LIMIT_MIN,
} from '@contrataflow/types';
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  toast,
} from '@contrataflow/ui';
import { AI_TERMS_CURRENT_VERSION } from '@contrataflow/validation';
import type { SettingsMapDto, SettingsMetaDto } from '@contrataflow/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { updateSettings } from '@/features/settings/settings.api';
import { isApiError } from '@/lib/api/api-error';
import { useTenantId } from '@/lib/session/session-context';

import { AiTermsDialog } from './ai-terms-dialog';
import { AiUsageCard } from './ai-usage-card';
import { aiKeys, fetchAiUsage } from './ai.api';

const ENABLED = 'ai.enabled';
const TERMS = 'ai.termsAcceptedVersion';
const MONTHLY = 'ai.monthlyTokenLimit';
const DAILY = 'ai.userDailyRequestLimit';

export interface AiSettingsSectionProps {
  /** SET-01 (todas as chaves; usa as `ai.*`). */
  readonly values: SettingsMapDto;
  readonly aiTerms: SettingsMetaDto['aiTerms'] | null;
  /** Chaves salvas (SET-02) para mesclar no cache do SET-01. */
  readonly onSaved: (saved: SettingsMapDto) => void;
  /** 412: a tela oferece recarregar. */
  readonly onConflict: () => void;
}

/** Inteiro positivo digitado (sem separadores), ou `null`. */
export function parseLimit(text: string): number | null {
  const digits = text.replace(/[.\s]/g, '');
  return /^\d+$/.test(digits) ? Number(digits) : null;
}

/**
 * `AiSettingsSection` (US-116 · SCR-041, grupo "Inteligência artificial"): o interruptor
 * "Usar IA neste órgão" (ligar abre o `AiTermsDialog` se a versão vigente ainda não foi aceita;
 * desligar pede confirmação), o aviso de nova versão dos termos (FA-02), o aviso de provedor
 * indisponível (FA-03), os limites mensal e diário (com o aviso de limite abaixo do consumo —
 * FA-04) e o `AiUsageCard`. Cada ação salva por SET-02 com a versão de cada chave.
 */
export function AiSettingsSection({
  values,
  aiTerms,
  onSaved,
  onConflict,
}: AiSettingsSectionProps) {
  const t = useTranslations('ai.admin');
  const format = useFormatter();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const ids = useId();

  const entry = (key: string) => values[key] ?? { value: null, version: 0 };
  const enabled = entry(ENABLED).value === true;
  const acceptedValue = entry(TERMS).value;
  const accepted = typeof acceptedValue === 'string' ? acceptedValue : null;
  const currentTerms = aiTerms?.currentVersion ?? AI_TERMS_CURRENT_VERSION;
  const maxMonthly = aiTerms?.maxMonthlyTokens ?? AI_PLATFORM_MAX_MONTHLY_TOKENS_DEFAULT;
  const storedMonthly = Number(entry(MONTHLY).value);
  const storedDaily = Number(entry(DAILY).value);

  const [termsMode, setTermsMode] = useState<'enable' | 'accept' | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const [monthly, setMonthly] = useState(String(storedMonthly));
  const [daily, setDaily] = useState(String(storedDaily));
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({});
  const [error, setError] = useState<string | null>(null);

  const usage = useQuery({
    queryKey: aiKeys.usage(tenantId, null),
    queryFn: ({ signal }) => fetchAiUsage(null, signal),
  });

  const save = useMutation({
    mutationFn: (changes: Readonly<Record<string, unknown>>) =>
      updateSettings(
        changes,
        Object.fromEntries(Object.keys(changes).map((key) => [key, entry(key).version])),
      ),
    onSuccess: (result) => {
      onSaved(result.data);
      setTermsMode(null);
      setConfirmOff(false);
      setError(null);
      setFieldErrors({});
      toast({ title: t('saved'), tone: 'success' });
      void queryClient.invalidateQueries({ queryKey: aiKeys.availabilityAll(tenantId) });
    },
    onError: (failure) => {
      if (!isApiError(failure)) {
        setError(t('errors.generic'));
        return;
      }
      if (failure.code === 'VERSION_CONFLICT' || failure.code === 'PRECONDITION_REQUIRED') {
        setTermsMode(null);
        setConfirmOff(false);
        setError(t('errors.conflict'));
        onConflict();
        return;
      }
      if (failure.code === 'AI_TERMS_NOT_ACCEPTED') {
        setTermsMode('enable');
        setError(t('terms.required'));
        return;
      }
      if (failure.code === 'MFA_REQUIRED') {
        setError(t('errors.mfa'));
        return;
      }
      if (failure.code === 'PERMISSION_DENIED') {
        setError(t('errors.permission'));
        return;
      }
      if (failure.status === 422) {
        const next: Record<string, string> = {};
        for (const item of failure.errors) next[item.field.replace(/^values\./, '')] = item.message;
        setFieldErrors(next);
        return;
      }
      setError(failure.status === 503 ? t('errors.unavailable') : t('errors.generic'));
    },
  });

  const monthlyValue = parseLimit(monthly);
  const dailyValue = parseLimit(daily);
  const limits = { min: format.number(AI_MONTHLY_TOKEN_LIMIT_MIN), max: format.number(maxMonthly) };
  const monthlyError =
    fieldErrors[MONTHLY] ??
    (monthlyValue === null || monthlyValue < AI_MONTHLY_TOKEN_LIMIT_MIN || monthlyValue > maxMonthly
      ? t('limits.monthlyInvalid', limits)
      : null);
  const dailyError =
    fieldErrors[DAILY] ??
    (dailyValue === null ||
    dailyValue < AI_USER_DAILY_REQUEST_LIMIT_MIN ||
    dailyValue > AI_USER_DAILY_REQUEST_LIMIT_MAX
      ? t('limits.dailyInvalid')
      : null);
  const limitChanges: Record<string, number> = {};
  if (monthlyValue !== null && monthlyValue !== storedMonthly) limitChanges[MONTHLY] = monthlyValue;
  if (dailyValue !== null && dailyValue !== storedDaily) limitChanges[DAILY] = dailyValue;
  const belowUsage =
    monthlyValue !== null &&
    usage.data !== undefined &&
    monthlyValue !== storedMonthly &&
    monthlyValue < usage.data.usedTokens;

  const toggle = () => {
    setError(null);
    if (enabled) {
      setConfirmOff(true);
    } else if (accepted === currentTerms) {
      save.mutate({ [ENABLED]: true });
    } else {
      setTermsMode('enable');
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">{t('description')}</p>

      {aiTerms?.provider === 'none' ? (
        <Alert tone="warning" title={t('providerUnavailable.title')}>
          {t('providerUnavailable.description')}
        </Alert>
      ) : null}

      {enabled && accepted !== currentTerms ? (
        <Alert tone="info" title={t('newTerms.title')}>
          <p>{t('newTerms.description', { version: currentTerms })}</p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-2"
            onClick={() => {
              setTermsMode('accept');
            }}
          >
            {t('newTerms.action')}
          </Button>
        </Alert>
      ) : null}

      {error === null || termsMode !== null ? null : <Alert tone="error" title={error} />}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span id={`${ids}-switch`} className="font-medium">
            {t('switch')}
          </span>
          <span className="text-sm text-muted-foreground">
            {accepted === null ? t('termsNone') : t('termsAccepted', { version: accepted })}
          </span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-labelledby={`${ids}-switch`}
          disabled={save.isPending}
          onClick={toggle}
          className={`inline-flex h-8 min-w-24 items-center justify-center rounded-full border px-3 text-sm font-medium ${
            enabled
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-border bg-surface text-foreground'
          }`}
        >
          {enabled ? t('switchOn') : t('switchOff')}
        </button>
      </div>

      <form
        className="flex flex-col gap-4"
        aria-labelledby={`${ids}-limits`}
        onSubmit={(event) => {
          event.preventDefault();
          if (monthlyError !== null || dailyError !== null) return;
          if (Object.keys(limitChanges).length === 0) return;
          setError(null);
          save.mutate(limitChanges);
        }}
      >
        <h3 id={`${ids}-limits`} className="font-semibold">
          {t('limits.title')}
        </h3>
        <LimitField
          id={`${ids}-monthly`}
          label={t('limits.monthly')}
          hint={t('limits.monthlyHint', limits)}
          value={monthly}
          error={monthlyError}
          disabled={save.isPending}
          onChange={(next) => {
            setMonthly(next);
            setFieldErrors(({ [MONTHLY]: _removed, ...rest }) => rest);
          }}
        />
        {belowUsage ? (
          <Alert
            tone="warning"
            title={t('limits.belowUsage', { used: format.number(usage.data.usedTokens) })}
          />
        ) : null}
        <LimitField
          id={`${ids}-daily`}
          label={t('limits.daily')}
          hint={t('limits.dailyHint')}
          value={daily}
          error={dailyError}
          disabled={save.isPending}
          onChange={(next) => {
            setDaily(next);
            setFieldErrors(({ [DAILY]: _removed, ...rest }) => rest);
          }}
        />
        <div>
          <Button
            type="submit"
            disabled={
              save.isPending ||
              monthlyError !== null ||
              dailyError !== null ||
              Object.keys(limitChanges).length === 0
            }
            aria-busy={save.isPending}
          >
            {save.isPending ? t('limits.saving') : t('limits.save')}
          </Button>
        </div>
      </form>

      <AiUsageCard />

      <AiTermsDialog
        key={termsMode ?? 'closed'}
        open={termsMode !== null}
        version={currentTerms}
        mode={termsMode ?? 'enable'}
        pending={save.isPending}
        error={termsMode === null ? null : error}
        onCancel={() => {
          setTermsMode(null);
          setError(null);
        }}
        onConfirm={() => {
          save.mutate(
            termsMode === 'accept'
              ? { [TERMS]: currentTerms }
              : { [ENABLED]: true, [TERMS]: currentTerms },
          );
        }}
      />

      <Dialog
        open={confirmOff}
        onOpenChange={(next) => {
          if (!next) setConfirmOff(false);
        }}
      >
        <DialogContent style={{ maxWidth: '28rem' }}>
          <DialogTitle>{t('disable.title')}</DialogTitle>
          <DialogDescription>{t('disable.description')}</DialogDescription>
          <DialogFooter className="mt-6">
            <Button
              variant="secondary"
              onClick={() => {
                setConfirmOff(false);
              }}
            >
              {t('disable.cancel')}
            </Button>
            <Button
              disabled={save.isPending}
              aria-busy={save.isPending}
              onClick={() => {
                save.mutate({ [ENABLED]: false });
              }}
            >
              {t('disable.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function LimitField({
  id,
  label,
  hint,
  value,
  error,
  disabled,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly value: string;
  readonly error: string | null;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        inputMode="numeric"
        className="h-10 max-w-xs rounded-control border border-border bg-surface px-3 text-sm"
        value={value}
        disabled={disabled}
        aria-invalid={error !== null}
        aria-describedby={`${id}-hint${error === null ? '' : ` ${id}-error`}`}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      <span id={`${id}-hint`} className="text-xs text-muted-foreground">
        {hint}
      </span>
      {error === null ? null : (
        <span id={`${id}-error`} className="text-sm text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}
