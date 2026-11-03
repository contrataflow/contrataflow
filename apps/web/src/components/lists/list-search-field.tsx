'use client';

import { Field, Input } from '@contrataflow/ui';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

import { Icon } from '@/components/shell/icons';

/**
 * Busca do `FilterPanel` (prd-6 §2.4): rótulo visível "Buscar", dica sob o campo e duas colunas
 * na grade do cartão. O nome acessível (`ariaLabel`) diz o que se busca ("Buscar processos").
 */
export function ListSearchField({
  value,
  onChange,
  ariaLabel,
  placeholder,
  description,
  label,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Nome acessível do campo; deve começar pelo rótulo visível (WCAG 2.5.3). */
  readonly ariaLabel: string;
  readonly placeholder?: string | undefined;
  /** Dica sob o campo (ex.: "Número, título ou objeto. Acentos não importam."). */
  readonly description?: ReactNode;
  /** Rótulo visível; padrão "Buscar". */
  readonly label?: string | undefined;
}) {
  const t = useTranslations('shell.listFilters');
  return (
    <Field label={label ?? t('searchLabel')} description={description} className="sm:col-span-2">
      <Input
        type="search"
        icon={<Icon name="search" />}
        aria-label={ariaLabel}
        placeholder={placeholder}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </Field>
  );
}
