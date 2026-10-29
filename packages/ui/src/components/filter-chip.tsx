'use client';

import type { ReactNode } from 'react';

import { X } from '../icons.js';
import { cx } from '../lib/cx.js';

export interface FilterChipProps {
  /** Filtro aplicado, com o campo e o valor (ex.: "Situação: Em andamento"). */
  readonly children: ReactNode;
  readonly onRemove: () => void;
  /** Nome acessível do botão de remover (ex.: "Remover filtro de situação"). */
  readonly removeLabel: string;
  readonly className?: string | undefined;
}

/** Chip de filtro aplicado, removível (prd-4 · padrão 6). O botão de remover tem 24 px úteis. */
export function FilterChip({ children, onRemove, removeLabel, className }: FilterChipProps) {
  return (
    <span
      className={cx(
        'inline-flex h-9 items-center gap-1.5 rounded-full bg-primary-soft pr-1.5 pl-3 text-[0.8125rem] font-semibold text-primary-soft-foreground',
        className,
      )}
    >
      {children}
      <button
        type="button"
        aria-label={removeLabel}
        onClick={onRemove}
        className="grid size-6 place-items-center rounded-full hover:bg-primary-soft-foreground/10"
      >
        <X className="size-3.5" strokeWidth={2.5} />
      </button>
    </span>
  );
}
