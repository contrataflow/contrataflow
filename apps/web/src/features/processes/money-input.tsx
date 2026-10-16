'use client';

import { cx } from '@contrataflow/ui';
import type { ComponentPropsWithoutRef } from 'react';

import { INPUT_CLASS } from './form-field';
import { normalizeMoneyText } from './money';

export interface MoneyInputProps extends Omit<
  ComponentPropsWithoutRef<'input'>,
  'value' | 'onChange' | 'type' | 'inputMode'
> {
  /** Texto exibido (formato brasileiro: "15.000,50"). */
  readonly value: string;
  readonly onValueChange: (text: string) => void;
}

/**
 * `MoneyInput` (BRL): a pessoa digita em reais ("15000,5" ou "15.000,50") e, ao sair do campo, o
 * valor válido é normalizado para duas casas. O wizard envia a API a string decimal com ponto
 * (`buildCreateBody` → `"15000.50"`); valor inválido recebe a mensagem V-08 ao validar o passo.
 */
export function MoneyInput({ value, onValueChange, onBlur, className, ...props }: MoneyInputProps) {
  return (
    <div className="relative">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-muted-foreground"
      >
        R$
      </span>
      <input
        type="text"
        inputMode="decimal"
        autoComplete="off"
        placeholder="0,00"
        {...props}
        className={cx(INPUT_CLASS, 'pl-10', className)}
        value={value}
        onChange={(event) => {
          onValueChange(event.target.value);
        }}
        onBlur={(event) => {
          const normalized = normalizeMoneyText(event.target.value);
          if (normalized !== event.target.value) onValueChange(normalized);
          onBlur?.(event);
        }}
      />
    </div>
  );
}
