'use client';

import { TREATMENT_STATUS_LABELS, isTerminalTreatmentStatus } from '@contrataflow/validation';
import type { TreatmentStatus } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import { useId } from 'react';

import { statusOptionsOf } from './treatments-model';
import { INPUT_CLASS } from '../processes/form-field';

export interface TreatmentStatusSelectProps {
  readonly status: TreatmentStatus;
  /** Rótulo acessível ("Status da ação 1 do risco R01"). */
  readonly label: string;
  readonly onChange: (next: TreatmentStatus) => void;
  /** Sem permissão ou bloqueado: só o texto do status. */
  readonly readOnly: boolean;
  readonly disabled?: boolean | undefined;
  readonly describedBy?: string | undefined;
}

/**
 * `TreatmentStatusSelect` (US-034 · "Atualizar status"): o status atual e só os próximos permitidos
 * pela máquina de RN-RISK-15 (a mesma da API). `DONE`/`CANCELED` são terminais: viram texto com a
 * explicação. Sem permissão ou bloqueado, também só texto. O valor exibido é sempre o do servidor:
 * uma recusa (409/412) "reverte a seleção" ao recarregar a lista.
 */
export function TreatmentStatusSelect({
  status,
  label,
  onChange,
  readOnly,
  disabled,
  describedBy,
}: TreatmentStatusSelectProps) {
  const t = useTranslations('risks.treatments.status');
  const id = useId();
  const terminal = isTerminalTreatmentStatus(status);
  if (readOnly || terminal) {
    return (
      <span className="text-sm">
        <span className="font-medium">{TREATMENT_STATUS_LABELS[status]}</span>
        {terminal && !readOnly ? (
          <span className="block text-xs text-muted-foreground">{t('terminal')}</span>
        ) : null}
      </span>
    );
  }
  return (
    <span className="flex flex-col gap-1">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <select
        id={id}
        className={`${INPUT_CLASS} py-1 text-sm`}
        value={status}
        disabled={disabled}
        aria-describedby={describedBy}
        onChange={(event) => {
          const next = event.target.value as TreatmentStatus;
          if (next !== status) onChange(next);
        }}
      >
        {statusOptionsOf(status).map((option) => (
          <option key={option} value={option}>
            {TREATMENT_STATUS_LABELS[option]}
          </option>
        ))}
      </select>
    </span>
  );
}
