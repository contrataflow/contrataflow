'use client';

import { Checkbox, Field, Label, RadioGroup, RadioGroupItem, Textarea, cx } from '@contrataflow/ui';
import { APPROVAL_DECISION_LIMITS } from '@contrataflow/validation';
import type { ApprovalDecisionOption } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';

import { optionKey, blockingViolations } from './decision-model';
import type { DecisionWarning } from './decision-model';

/*
 * Campos do painel "Decidir aprovação" (SCR-015), com os controles do kit (prd-5): comentário,
 * etapa de destino e avisos. Só apresentação — o estado, a validação e o envio ficam em
 * `ApprovalDecisionPanel`.
 */

/**
 * `CommentField`: obrigatório para devolver e indeferir, opcional para aprovar (RN-TRAM-55), com
 * contador (máx. 5.000). Ajuda e erro ligados ao campo pelo `Field`.
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
  return (
    <Field
      id={id}
      label={required ? t('labelRequired') : t('labelOptional')}
      required={required}
      requiredMark=""
      error={error}
      description={
        <span className="flex justify-between gap-2">
          <span>{required ? t('hintRequired') : t('hintOptional')}</span>
          <span className="flex-none whitespace-nowrap">
            {t('counter', {
              count: value.trim().length,
              max: APPROVAL_DECISION_LIMITS.commentMax,
            })}
          </span>
        </span>
      }
    >
      <Textarea
        value={value}
        rows={4}
        maxLength={APPROVAL_DECISION_LIMITS.commentMax}
        className="max-md:text-base"
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </Field>
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
  return (
    <Field id={name} label={t('legend')} description={t('hint')} error={error} group>
      <RadioGroup
        id={name}
        name={name}
        value={selected ?? ''}
        onValueChange={onSelect}
        className="gap-2"
      >
        {options.map((option) => {
          const key = optionKey(option);
          const optionId = `${name}-${key}`;
          const blocking = blockingViolations(option);
          const disabled = !option.enabled || blocking.length > 0;
          return (
            <div
              key={key}
              className={cx(
                'flex items-start gap-3 rounded-control border p-3 max-md:min-h-14',
                disabled ? 'opacity-70' : undefined,
                key === selected ? 'border-primary bg-primary-soft/40' : 'border-border',
              )}
            >
              <RadioGroupItem id={optionId} value={key} disabled={disabled} className="mt-0.5" />
              <span className="flex min-w-0 flex-col">
                <Label
                  htmlFor={optionId}
                  className={cx(
                    'font-medium break-words',
                    disabled ? 'cursor-not-allowed' : 'cursor-pointer',
                  )}
                >
                  {option.toStage?.name ?? option.label}
                </Label>
                {blocking.map((violation) => (
                  <span key={violation.ruleId} className="text-xs break-words text-destructive">
                    {t('optionBlocked', { message: violation.message })}
                  </span>
                ))}
              </span>
            </div>
          );
        })}
      </RadioGroup>
    </Field>
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
          const checkboxId = `${messageId}-ack`;
          return (
            <li
              key={warning.ruleId}
              className="flex min-w-0 flex-col gap-2 rounded-control bg-warning-soft p-3 text-sm text-warning-soft-foreground"
            >
              <span className="text-xs font-semibold uppercase">{t('warning')}</span>
              <span id={messageId} className="break-words">
                {warning.message}
              </span>
              <span className="flex items-center gap-2 max-md:min-h-10">
                <Checkbox
                  id={checkboxId}
                  data-warning-rule={warning.ruleId}
                  checked={acknowledged.includes(warning.ruleId)}
                  aria-describedby={messageId}
                  onCheckedChange={(checked) => {
                    onToggle(warning.ruleId, checked === true);
                  }}
                />
                <Label htmlFor={checkboxId} className="cursor-pointer font-medium text-inherit">
                  {t('acknowledge')}
                </Label>
              </span>
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
