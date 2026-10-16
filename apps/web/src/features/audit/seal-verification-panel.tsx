'use client';

import { Button } from '@contrataflow/ui';
import type { VerifyAuditSeals } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import type { SyntheticEvent } from 'react';

import { validateRange } from './seal-model';
import type { RangeErrors, RangeInput } from './seal-model';

const CONTROL = 'h-10 rounded-control border border-border bg-surface px-3 text-sm';

export interface SealVerificationPanelProps {
  readonly timeZone: string;
  /** Início e fim digitados (`datetime-local`, no fuso da instituição). */
  readonly value: RangeInput;
  readonly onChange: (next: RangeInput) => void;
  readonly onVerify: (body: VerifyAuditSeals) => void;
  /** Verificação em andamento: o botão fica desabilitado. */
  readonly pending: boolean;
  /** Mensagem da API para o intervalo (422 — ex.: máximo de selos por verificação). */
  readonly serverError: string | null;
}

/**
 * `SealVerificationPanel` (SCR-037 · AUD-05): intervalo (data/hora de início e fim) e o botão
 * "Verificar integridade". A ordem das datas é validada com o MESMO schema da API
 * (`verifyAuditSealsSchema` — V-02); o limite de selos por verificação é da API (422).
 */
export function SealVerificationPanel({
  timeZone,
  value,
  onChange,
  onVerify,
  pending,
  serverError,
}: SealVerificationPanelProps) {
  const t = useTranslations('audit.seals.panel');
  const ids = useId();
  const [errors, setErrors] = useState<RangeErrors>({});

  const change = (next: RangeInput) => {
    setErrors({});
    onChange(next);
  };

  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const validation = validateRange(value, timeZone, { required: t('required') });
    if (!validation.ok) {
      setErrors(validation.errors);
      return;
    }
    setErrors({});
    onVerify(validation.body);
  };

  const startError = errors.start;
  const endError = errors.end ?? serverError ?? undefined;

  return (
    <section aria-labelledby={`${ids}-title`} className="flex min-w-0 flex-col gap-3">
      <div>
        <h2 id={`${ids}-title`} className="text-lg font-semibold">
          {t('title')}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('description', { timeZone })}</p>
      </div>
      <form
        noValidate
        onSubmit={submit}
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_auto] lg:items-start"
      >
        <div className="flex flex-col gap-1">
          <label htmlFor={`${ids}-start`} className="text-sm font-medium">
            {t('start')}
          </label>
          <input
            id={`${ids}-start`}
            type="datetime-local"
            className={CONTROL}
            value={value.start}
            aria-invalid={startError !== undefined}
            aria-describedby={startError ? `${ids}-start-error` : undefined}
            onChange={(event) => {
              change({ ...value, start: event.target.value });
            }}
          />
          {startError ? (
            <p id={`${ids}-start-error`} role="alert" className="text-sm text-destructive">
              {startError}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${ids}-end`} className="text-sm font-medium">
            {t('end')}
          </label>
          <input
            id={`${ids}-end`}
            type="datetime-local"
            className={CONTROL}
            value={value.end}
            aria-invalid={endError !== undefined}
            aria-describedby={endError ? `${ids}-end-error` : undefined}
            onChange={(event) => {
              change({ ...value, end: event.target.value });
            }}
          />
          {endError ? (
            <p id={`${ids}-end-error`} role="alert" className="text-sm text-destructive">
              {endError}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-1 sm:col-span-2 lg:col-span-1">
          {/* Reserva a altura do rótulo para alinhar o botão aos campos em telas largas. */}
          <span aria-hidden="true" className="hidden text-sm lg:block">
            &nbsp;
          </span>
          <Button type="submit" disabled={pending} aria-busy={pending}>
            {pending ? t('submitting') : t('submit')}
          </Button>
        </div>
      </form>
    </section>
  );
}
