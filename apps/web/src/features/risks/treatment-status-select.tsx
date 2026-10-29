'use client';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@contrataflow/ui';
import { TREATMENT_STATUS_LABELS, isTerminalTreatmentStatus } from '@contrataflow/validation';
import type { TreatmentStatus } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';

import { statusOptionsOf } from './treatments-model';

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
    <Select
      value={status}
      disabled={disabled ?? false}
      onValueChange={(value) => {
        const next = value as TreatmentStatus;
        if (next !== status) onChange(next);
      }}
    >
      <SelectTrigger
        aria-label={label}
        aria-describedby={describedBy}
        className="min-h-9 py-1 text-sm"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {statusOptionsOf(status).map((option) => (
          <SelectItem key={option} value={option}>
            {TREATMENT_STATUS_LABELS[option]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
