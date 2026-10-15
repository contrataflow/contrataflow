'use client';

import { isValidCnpj } from '@contrataflow/validation';

import { formatCnpj } from './organization-form-model';

const INPUT = 'h-10 rounded-control border border-border bg-surface px-3 text-sm';

export interface CnpjInputProps {
  readonly id: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Chamado ao sair do campo com um CNPJ completo e DV inválido (`true`) ou válido (`false`). */
  readonly onValidated?: ((invalid: boolean) => void) | undefined;
  readonly invalid?: boolean | undefined;
  readonly describedBy?: string | undefined;
}

/**
 * `CnpjInput` (SCR-032 · US-101): máscara `XX.XXX.XXX/XXXX-XX` enquanto digita — aceita o CNPJ
 * alfanumérico — e confere o dígito verificador ao sair do campo (a API reconfere — RN-TEN-40).
 */
export function CnpjInput({
  id,
  value,
  onChange,
  onValidated,
  invalid,
  describedBy,
}: CnpjInputProps) {
  return (
    <input
      id={id}
      type="text"
      inputMode="text"
      autoComplete="off"
      spellCheck={false}
      maxLength={18}
      placeholder="00.000.000/0000-00"
      value={value}
      aria-invalid={invalid ? true : undefined}
      aria-describedby={describedBy}
      className={`${INPUT} font-mono`}
      onChange={(event) => {
        onChange(formatCnpj(event.target.value));
      }}
      onBlur={() => {
        const complete = value.replace(/[^0-9A-Za-z]/g, '').length === 14;
        if (complete) onValidated?.(!isValidCnpj(value));
        else onValidated?.(false);
      }}
    />
  );
}
