'use client';

import {
  Button,
  SelectContent,
  SelectItem,
  SelectLabel,
  Select as KitSelect,
  SelectGroup as KitSelectGroup,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  Skeleton,
  cx,
} from '@contrataflow/ui';
import type { ReactNode } from 'react';

export const INPUT_CLASS =
  'h-10 w-full min-w-0 rounded-control border border-border bg-surface px-3 text-sm';
export const TEXTAREA_CLASS =
  'min-h-24 w-full min-w-0 rounded-control border border-border bg-surface px-3 py-2 text-sm';

/** Atributos que o controle recebe para ficar associado ao rótulo, à dica e ao erro. */
export interface FieldControlProps {
  readonly id: string;
  readonly 'aria-describedby': string | undefined;
  readonly 'aria-invalid': true | undefined;
  readonly 'aria-required': true | undefined;
}

export interface FormFieldProps {
  readonly id: string;
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  readonly error?: string | undefined;
  readonly required?: boolean | undefined;
  readonly className?: string | undefined;
  readonly children: (control: FieldControlProps) => ReactNode;
}

/**
 * Campo do wizard: rótulo associado, dica e erro ligados por `aria-describedby`; o erro é anunciado
 * (`aria-live`) e marca o controle com `aria-invalid` (US-001 · "Acessibilidade").
 */
export function FormField({
  id,
  label,
  hint,
  error,
  required,
  className,
  children,
}: FormFieldProps) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy =
    [hint ? hintId : undefined, error ? errorId : undefined].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cx('flex min-w-0 flex-col gap-1', className)}>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children({
        id,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : undefined,
        'aria-required': required ? true : undefined,
      })}
      {hint ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-sm text-destructive" aria-live="polite">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Valor da opção que limpa o campo (o Radix não aceita `SelectItem value=""`). */
const CLEAR_VALUE = '__clear__';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export interface SelectGroup {
  readonly label: string;
  readonly options: readonly SelectOption[];
}

export interface SelectFieldProps {
  readonly id: string;
  readonly label: ReactNode;
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Opções soltas ou agrupadas (`SelectGroup` com rótulo). */
  readonly options: readonly SelectOption[];
  readonly groups?: readonly SelectGroup[] | undefined;
  readonly placeholder: string;
  /** Campo opcional: texto da primeira opção, que devolve o campo a vazio (ex.: "A definir"). */
  readonly clearLabel?: string | undefined;
  readonly status: 'pending' | 'error' | 'ready';
  /** Lista pronta porém vazia: mensagem no lugar do campo (ex.: "Nenhum tipo de contratação ativo"). */
  readonly emptyMessage?: string | undefined;
  readonly loadingLabel: string;
  readonly errorLabel: string;
  readonly retryLabel: string;
  readonly onRetry: () => void;
  readonly hint?: ReactNode;
  readonly error?: string | undefined;
  readonly required?: boolean | undefined;
  readonly className?: string | undefined;
}

/**
 * Seleção com os estados de carga do wizard: skeleton enquanto carrega, erro com "Tentar novamente"
 * e vazio com a orientação do que fazer (US-001 · "Estados").
 */
export function SelectField(props: SelectFieldProps) {
  const { id, label, status, emptyMessage, options, groups } = props;
  if (status === 'pending') {
    return (
      <div className={cx('flex min-w-0 flex-col gap-1', props.className)}>
        <span className="text-sm font-medium">{label}</span>
        <div role="status">
          <span className="sr-only">{props.loadingLabel}</span>
          <Skeleton className="h-10 w-full" />
        </div>
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div className={cx('flex min-w-0 flex-col gap-1', props.className)}>
        <span className="text-sm font-medium">{label}</span>
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 rounded-card border border-destructive/30 bg-destructive-soft p-2 text-sm"
        >
          <span>{props.errorLabel}</span>
          <Button size="sm" variant="secondary" onClick={props.onRetry}>
            {props.retryLabel}
          </Button>
        </div>
      </div>
    );
  }
  const hasOptions = options.length > 0 || (groups ?? []).some((group) => group.options.length > 0);
  if (!hasOptions && emptyMessage) {
    return (
      <div className={cx('flex min-w-0 flex-col gap-1', props.className)}>
        <span className="text-sm font-medium">{label}</span>
        <p
          id={id}
          role="status"
          className="rounded-card border border-dashed border-border p-3 text-sm text-muted-foreground"
        >
          {emptyMessage}
        </p>
      </div>
    );
  }
  return (
    <FormField
      id={id}
      label={label}
      hint={props.hint}
      error={props.error}
      required={props.required}
      className={props.className}
    >
      {(control) => (
        <KitSelect
          value={props.value}
          onValueChange={(value) => {
            props.onChange(value === CLEAR_VALUE ? '' : value);
          }}
        >
          <SelectTrigger {...control}>
            <SelectValue placeholder={props.placeholder} />
          </SelectTrigger>
          <SelectContent>
            {props.clearLabel ? (
              <SelectItem value={CLEAR_VALUE}>{props.clearLabel}</SelectItem>
            ) : null}
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
            {(groups ?? [])
              .filter((group) => group.options.length > 0)
              .map((group, index) => (
                <KitSelectGroup key={group.label}>
                  {index > 0 || options.length > 0 ? <SelectSeparator /> : null}
                  <SelectLabel>{group.label}</SelectLabel>
                  {group.options.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </KitSelectGroup>
              ))}
          </SelectContent>
        </KitSelect>
      )}
    </FormField>
  );
}
