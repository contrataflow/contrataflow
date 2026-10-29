'use client';

import { Button, Combobox, Field } from '@contrataflow/ui';
import { useTranslations } from 'next-intl';

export interface UserLookupSelectProps {
  readonly label: string;
  /** `userId` atual (vazio = sem pessoa). */
  readonly value: string;
  readonly onClear: () => void;
  readonly error?: string | undefined;
}

/**
 * `UserLookupSelect` (SCR-032 · US-102 — titular/substituto). A busca de pessoas (`USR-02`) chega
 * com o cadastro de usuários (US-092): até lá o `Combobox` do kit mostra se há pessoa definida
 * (única opção, sem busca de outras) e permite removê-la; a definição pela API (DEP-03/05) já
 * valida lotação/escopo (RN-TEN-48). Mesmo padrão dos seletores de usuário do tipo de documento
 * (US-061).
 */
export function UserLookupSelect({ label, value, onClear, error }: UserLookupSelectProps) {
  const t = useTranslations('departments');
  const defined = value !== '';
  return (
    <Field label={label} description={t('people.pending')} error={error}>
      <div className="flex items-center gap-2">
        <Combobox
          className="flex-1"
          disabled={!defined}
          clearable
          options={defined ? [{ value, label: t('people.defined') }] : []}
          value={defined ? value : undefined}
          onValueChange={(next) => {
            if (next === undefined) onClear();
          }}
          labels={{
            placeholder: t('people.none'),
            search: t('people.search'),
            empty: t('people.empty'),
          }}
        />
        {defined ? (
          <Button type="button" variant="secondary" size="sm" onClick={onClear}>
            {t('people.clear', { field: label.toLowerCase() })}
          </Button>
        ) : null}
      </div>
    </Field>
  );
}
