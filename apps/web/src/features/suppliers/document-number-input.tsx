'use client';

import { Input, cx } from '@contrataflow/ui';
import type { SupplierDocumentType } from '@contrataflow/validation';

import { formatDocument, isDocumentComplete } from './supplier-form-model';

const PLACEHOLDERS: Readonly<Record<SupplierDocumentType, string>> = {
  CNPJ: '00.000.000/0000-00',
  CPF: '000.000.000-00',
  FOREIGN: '',
};

const MAX_LENGTH: Readonly<Record<SupplierDocumentType, number>> = {
  CNPJ: 18,
  CPF: 14,
  FOREIGN: 20,
};

export interface DocumentNumberInputProps {
  readonly documentType: SupplierDocumentType;
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Chamado ao sair do campo com o número completo do tipo (conferência e consulta SUP-06). */
  readonly onComplete?: ((value: string) => void) | undefined;
  /** Chamado ao sair do campo com o número incompleto (limpa a conferência anterior). */
  readonly onIncomplete?: (() => void) | undefined;
  readonly readOnly?: boolean | undefined;
}

/**
 * `DocumentNumberInput` (SCR-107 · US-025 · passo 3): máscara dinâmica pelo tipo — CNPJ numérico
 * `00.000.000/0000-00` ou alfanumérico (IN RFB 2.229/2024), CPF `000.000.000-00` e número livre
 * para estrangeiro — e conferência ao sair do campo (a API reconfere o dígito verificador). O
 * `Input` do kit liga rótulo, ajuda e erro pelo `Field` que o contém.
 */
export function DocumentNumberInput({
  documentType,
  value,
  onChange,
  onComplete,
  onIncomplete,
  readOnly,
}: DocumentNumberInputProps) {
  return (
    <Input
      inputMode={documentType === 'CPF' ? 'numeric' : 'text'}
      autoComplete="off"
      spellCheck={false}
      maxLength={MAX_LENGTH[documentType]}
      placeholder={PLACEHOLDERS[documentType]}
      value={value}
      readOnly={readOnly}
      aria-readonly={readOnly ? true : undefined}
      className={cx('font-mono', readOnly ? 'bg-muted text-muted-foreground' : undefined)}
      onChange={(event) => {
        onChange(formatDocument(documentType, event.target.value));
      }}
      onBlur={() => {
        if (readOnly) return;
        if (isDocumentComplete(documentType, value)) onComplete?.(value);
        else onIncomplete?.();
      }}
    />
  );
}
