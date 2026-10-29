'use client';

import { Label as LabelPrimitive } from 'radix-ui';
import { createContext, useContext, useId } from 'react';
import type { ComponentPropsWithRef, ReactNode } from 'react';

import { cx } from '../lib/cx.js';

/*
 * Campo de formulário (prd-5 · kit): rótulo, texto de ajuda e mensagem de erro ligados ao controle
 * por `id`, `aria-describedby` e `aria-invalid`. Os controles do kit (`Input`, `Textarea`,
 * `SelectTrigger`, `Combobox`, `DatePicker`, `RadioGroup`…) leem o contexto do `Field` e se ligam
 * sozinhos; fora de um `Field`, recebem as mesmas props à mão.
 */

export interface FieldControlState {
  /** `id` do controle (o `htmlFor` do rótulo). */
  readonly id: string;
  /** Ids da ajuda e do erro, na ordem de leitura. */
  readonly describedBy: string | undefined;
  readonly invalid: boolean;
  readonly required: boolean;
  readonly disabled: boolean;
}

const FieldContext = createContext<FieldControlState | null>(null);

/** Estado do `Field` mais próximo, ou `null` fora de um. */
export function useFieldControl(): FieldControlState | null {
  return useContext(FieldContext);
}

/** Props de acessibilidade do controle: as passadas à mão vencem as do `Field`. */
export function fieldControlProps(
  field: FieldControlState | null,
  props: {
    readonly id?: string | undefined;
    readonly 'aria-describedby'?: string | undefined;
    readonly 'aria-invalid'?: boolean | 'true' | 'false' | 'grammar' | 'spelling' | undefined;
    readonly 'aria-required'?: boolean | 'true' | 'false' | undefined;
    readonly disabled?: boolean | undefined;
  },
) {
  return {
    id: props.id ?? field?.id,
    'aria-describedby': props['aria-describedby'] ?? field?.describedBy,
    'aria-invalid': props['aria-invalid'] ?? (field?.invalid ? true : undefined),
    // `aria-required`, não `required`: o formulário valida (zod) sem o balão nativo do navegador.
    'aria-required': props['aria-required'] ?? (field?.required ? true : undefined),
    disabled: props.disabled ?? (field?.disabled ? true : undefined),
  };
}

/** Rótulo (Radix Label): clicar foca o controle. */
export function Label({ className, ...props }: ComponentPropsWithRef<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      className={cx('text-sm font-semibold text-foreground', className)}
      {...props}
    />
  );
}

export interface FieldProps {
  readonly label: ReactNode;
  /** Ajuda curta sob o controle (prefira tooltip para textos longos — prd-5 · regra 7). */
  readonly description?: ReactNode;
  /** Mensagem de erro; com ela o controle fica `aria-invalid`. */
  readonly error?: ReactNode;
  readonly required?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  /** Marca visual do campo obrigatório (o `required` do controle é o que o leitor de tela anuncia). */
  readonly requiredMark?: string | undefined;
  /** `id` do controle; gerado quando omitido. */
  readonly id?: string | undefined;
  /**
   * Grupo de opções (RadioGroup, várias Checkbox): `fieldset` + `legend` em vez de `label`, e o
   * contexto liga a ajuda e o erro ao grupo.
   */
  readonly group?: boolean | undefined;
  /** Elemento extra ao lado do rótulo (ex.: `InfoTooltip`). */
  readonly labelAddon?: ReactNode;
  readonly className?: string | undefined;
  readonly children: ReactNode;
}

export function Field({
  label,
  description,
  error,
  required = false,
  disabled = false,
  requiredMark = '*',
  id,
  group = false,
  labelAddon,
  className,
  children,
}: FieldProps) {
  const generated = useId();
  const controlId = id ?? `campo-${generated}`;
  const descriptionId = description ? `${controlId}-ajuda` : undefined;
  const errorId = error ? `${controlId}-erro` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(' ') || undefined;
  const state: FieldControlState = {
    id: controlId,
    describedBy,
    invalid: Boolean(error),
    required,
    disabled,
  };

  const mark = required ? (
    <span aria-hidden="true" className="ml-0.5 text-destructive">
      {requiredMark}
    </span>
  ) : null;
  const help = (
    <>
      {description ? (
        <p id={descriptionId} className="text-[0.8125rem] text-muted-foreground">
          {description}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-[0.8125rem] font-semibold text-destructive">
          {error}
        </p>
      ) : null}
    </>
  );
  const classes = cx('flex min-w-0 flex-col gap-1.5', className);

  if (group) {
    return (
      <FieldContext.Provider value={state}>
        <fieldset
          className={cx(classes, 'm-0 border-0 p-0')}
          aria-describedby={describedBy}
          disabled={disabled}
        >
          <legend className="mb-1.5 flex items-center gap-1.5 p-0 text-sm font-semibold text-foreground">
            <span>
              {label}
              {mark}
            </span>
            {labelAddon}
          </legend>
          {children}
          {help}
        </fieldset>
      </FieldContext.Provider>
    );
  }

  return (
    <FieldContext.Provider value={state}>
      <div className={classes}>
        <div className="flex items-center gap-1.5">
          <Label htmlFor={controlId}>
            {label}
            {mark}
          </Label>
          {labelAddon}
        </div>
        {children}
        {help}
      </div>
    </FieldContext.Provider>
  );
}
