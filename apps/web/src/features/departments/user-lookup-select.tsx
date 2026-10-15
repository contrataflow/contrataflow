'use client';

import { Button } from '@contrataflow/ui';
import { useTranslations } from 'next-intl';

export interface UserLookupSelectProps {
  readonly id: string;
  readonly label: string;
  /** `userId` atual (vazio = sem pessoa). */
  readonly value: string;
  readonly onClear: () => void;
  readonly error?: string | undefined;
}

/**
 * `UserLookupSelect` (SCR-032 · US-102 — titular/substituto). A busca de pessoas (`USR-02`) chega
 * com o cadastro de usuários (US-092): até lá o seletor mostra se há pessoa definida e permite
 * removê-la; a definição pela API (DEP-03/05) já valida lotação/escopo (RN-TEN-48). Mesmo padrão
 * dos seletores de usuário do tipo de documento (US-061).
 */
export function UserLookupSelect({ id, label, value, onClear, error }: UserLookupSelectProps) {
  const t = useTranslations('departments');
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          readOnly
          disabled
          value={value === '' ? t('people.none') : t('people.defined')}
          aria-invalid={error ? true : undefined}
          aria-describedby={[hintId, error ? errorId : undefined].filter(Boolean).join(' ')}
          className="h-10 flex-1 rounded-control border border-border bg-muted px-3 text-sm"
        />
        {value === '' ? null : (
          <Button type="button" variant="secondary" size="sm" onClick={onClear}>
            {t('people.clear', { field: label.toLowerCase() })}
          </Button>
        )}
      </div>
      <p id={hintId} className="text-xs text-muted-foreground">
        {t('people.pending')}
      </p>
      {error ? (
        <p id={errorId} className="text-sm text-destructive" aria-live="polite">
          {error}
        </p>
      ) : null}
    </div>
  );
}
