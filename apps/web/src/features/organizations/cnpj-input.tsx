'use client';

import { Input } from '@contrataflow/ui';
import { isValidCnpj } from '@contrataflow/validation';

import { formatCnpj } from './organization-form-model';

export interface CnpjInputProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Chamado ao sair do campo com um CNPJ completo e DV inválido (`true`) ou válido (`false`). */
  readonly onValidated?: ((invalid: boolean) => void) | undefined;
}

/**
 * `CnpjInput` (SCR-032 · US-101): máscara `XX.XXX.XXX/XXXX-XX` enquanto digita — aceita o CNPJ
 * alfanumérico — e confere o dígito verificador ao sair do campo (a API reconfere — RN-TEN-40). O
 * `Input` do kit liga rótulo, ajuda e erro pelo `Field` que o contém.
 */
export function CnpjInput({ value, onChange, onValidated }: CnpjInputProps) {
  return (
    <Input
      inputMode="text"
      autoComplete="off"
      spellCheck={false}
      maxLength={18}
      placeholder="00.000.000/0000-00"
      value={value}
      className="font-mono"
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
