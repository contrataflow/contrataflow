'use client';

import { cx } from '@contrataflow/ui';
import { APPROVAL_DECISION_LIMITS } from '@contrataflow/validation';
import type { ApprovalDecisionOption } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';

import { optionKey, blockingViolations } from './decision-model';
import type { DecisionWarning } from './decision-model';
import { TEXTAREA_CLASS } from '../processes/form-field';

/*
 * Campos do painel "Decidir aprovação" (SCR-015): comentário, etapa de destino e avisos. Só
 * apresentação — o estado, a validação e o envio ficam em `ApprovalDecisionPanel`.
 */

/**
 * `CommentField`: obrigatório para devolver e indeferir, opcional para aprovar (RN-TRAM-55), com
 * contador (máx. 5.000). O erro fica ligado ao campo por `aria-describedby`.
 */
export function CommentField({
  id,
  value,
  required,
  error,
  onChange,
}: {
  readonly id: string;
  readonly value: string;
  readonly required: boolean;
  readonly error: string | undefined;
  readonly onChange: (value: string) => void;
}) {
  const t = useTranslations('approvals.panel.comment');
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {required ? t('labelRequired') : t('labelOptional')}
      </label>
      <textarea
        id={id}
        value={value}
        maxLength={APPROVAL_DECISION_LIMITS.commentMax}
        aria-required={required ? true : undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={[hintId, error ? errorId : undefined].filter(Boolean).join(' ')}
        className={cx(TEXTAREA_CLASS, 'max-md:text-base')}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
      <p id={hintId} className="flex justify-between gap-2 text-xs text-muted-foreground">
        <span>{required ? t('hintRequired') : t('hintOptional')}</span>
        <span>
          {t('counter', { count: value.trim().length, max: APPROVAL_DECISION_LIMITS.commentMax })}
        </span>
      </p>
      {error ? (
        <p id={errorId} className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Etapa de destino quando a decisão tem mais de uma opção (devolução: uma por etapa já percorrida
 * — RN-TRAM-56). Opção com regra bloqueante fica desabilitada com a mensagem da regra.
 */
export function TargetSelector({
  name,
  options,
  selected,
  error,
  onSelect,
}: {
  readonly name: string;
  readonly options: readonly ApprovalDecisionOption[];
  readonly selected: string | null;
  readonly error: string | undefined;
  readonly onSelect: (key: string) => void;
}) {
  const t = useTranslations('approvals.panel.target');
  const errorId = `${name}-error`;
  return (
    <fieldset
      className="flex min-w-0 flex-col gap-2"
      aria-describedby={error ? errorId : undefined}
    >
      <legend className="text-sm font-medium">{t('legend')}</legend>
      <p className="text-xs text-muted-foreground">{t('hint')}</p>
      {options.map((option) => {
        const key = optionKey(option);
        const optionId = `${name}-${key}`;
        const blocking = blockingViolations(option);
        const disabled = !option.enabled || blocking.length > 0;
        return (
          <label
            key={key}
            htmlFor={optionId}
            className={cx(
              'flex items-start gap-3 rounded-control border p-3 max-md:min-h-14',
              disabled ? 'cursor-not-allowed opacity-70' : 'cursor-pointer',
              key === selected ? 'border-primary bg-muted' : 'border-border',
            )}
          >
            <input
              type="radio"
              id={optionId}
              name={name}
              value={key}
              checked={key === selected}
              disabled={disabled}
              className="mt-1 size-4 flex-none"
              onChange={() => {
                onSelect(key);
              }}
            />
            <span className="flex min-w-0 flex-col">
              <span className="text-sm font-medium break-words">
                {option.toStage?.name ?? option.label}
              </span>
              {blocking.map((violation) => (
                <span key={violation.ruleId} className="text-xs break-words text-destructive">
                  {t('optionBlocked', { message: violation.message })}
                </span>
              ))}
            </span>
          </label>
        );
      })}
      {error ? (
        <p id={errorId} className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

/**
 * `WarningsChecklist` (FA-03 · DEC-016): avisos `WARNING` da transição; cada um exige "Estou
 * ciente e desejo continuar" antes de o botão de confirmar habilitar.
 */
export function WarningsChecklist({
  id,
  warnings,
  acknowledged,
  error,
  onToggle,
}: {
  readonly id: string;
  readonly warnings: readonly DecisionWarning[];
  readonly acknowledged: readonly string[];
  readonly error: string | undefined;
  readonly onToggle: (ruleId: string, checked: boolean) => void;
}) {
  const t = useTranslations('approvals.panel.warnings');
  if (warnings.length === 0) return null;
  const errorId = `${id}-error`;
  return (
    <section aria-labelledby={`${id}-heading`} className="flex min-w-0 flex-col gap-2">
      <h3 id={`${id}-heading`} className="text-sm font-semibold">
        {t('heading')}
      </h3>
      <p className="text-xs text-muted-foreground">{t('intro')}</p>
      <ul id={id} aria-describedby={error ? errorId : undefined} className="flex flex-col gap-2">
        {warnings.map((warning) => {
          const messageId = `${id}-${warning.ruleId}`;
          return (
            <li
              key={warning.ruleId}
              className="flex min-w-0 flex-col gap-2 rounded-control border border-warning/30 bg-warning-soft p-3 text-sm"
            >
              <span className="text-xs font-semibold uppercase">{t('warning')}</span>
              <span id={messageId} className="break-words">
                {warning.message}
              </span>
              <label className="flex items-center gap-2 max-md:min-h-10">
                <input
                  type="checkbox"
                  data-warning-rule={warning.ruleId}
                  className="size-4 flex-none"
                  checked={acknowledged.includes(warning.ruleId)}
                  aria-describedby={messageId}
                  onChange={(event) => {
                    onToggle(warning.ruleId, event.target.checked);
                  }}
                />
                {t('acknowledge')}
              </label>
            </li>
          );
        })}
      </ul>
      {error ? (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
