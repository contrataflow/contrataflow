import type { ComponentPropsWithoutRef } from 'react';

import type { AutosavePhase } from '../autosave/autosave-queue.js';
import { cx } from '../lib/cx.js';

/*
 * `AutosaveIndicator` (US-015 · DEC-182 · P03): o estado do autosave sempre visível no cabeçalho do
 * editor, sem jargão — "Alterações não salvas", "Salvando…", "Salvo às 14:32", "Erro ao salvar",
 * "Sem conexão — alterações guardadas neste navegador". Região `aria-live="polite"`: anuncia sem
 * interromper. Abaixo de 768 px fica compacto (ícone + "Salvo"). O horário é o local do navegador.
 */

export interface AutosaveIndicatorLabels {
  readonly dirty: string;
  readonly saving: string;
  readonly saved: (time: string) => string;
  readonly savedShort: string;
  readonly error: string;
  readonly offline: string;
  readonly offlineShort: string;
  readonly conflict: string;
  readonly blocked: string;
}

export const AUTOSAVE_INDICATOR_LABELS: AutosaveIndicatorLabels = {
  dirty: 'Alterações não salvas',
  saving: 'Salvando…',
  saved: (time) => `Salvo às ${time}`,
  savedShort: 'Salvo',
  error: 'Erro ao salvar',
  offline: 'Sem conexão — alterações guardadas neste navegador',
  offlineShort: 'Sem conexão',
  conflict: 'Conflito de edição — escolha qual versão manter',
  blocked: 'Edição interrompida',
};

export interface AutosaveIndicatorProps extends ComponentPropsWithoutRef<'div'> {
  readonly status: AutosavePhase;
  /** Última gravação confirmada (ms). */
  readonly savedAt: number | null;
  /** Explicação do "Erro ao salvar" (ex.: "O texto excede 50.000 caracteres."). */
  readonly message?: string | null | undefined;
  readonly labels?: Partial<AutosaveIndicatorLabels> | undefined;
  /** Fuso do horário exibido (padrão: o do navegador). */
  readonly timeZone?: string | undefined;
}

const TONE: Partial<Record<AutosavePhase, string>> = {
  error: 'text-destructive',
  conflict: 'text-warning',
  offline: 'text-warning',
  blocked: 'text-destructive',
};

function Dot({ status }: { readonly status: AutosavePhase }) {
  const color =
    status === 'saved'
      ? 'bg-success'
      : status === 'error' || status === 'blocked'
        ? 'bg-destructive'
        : status === 'offline' || status === 'conflict'
          ? 'bg-warning'
          : 'bg-muted-foreground';
  return (
    <span
      aria-hidden="true"
      className={cx(
        'inline-block size-2 shrink-0 rounded-full',
        color,
        status === 'saving' ? 'animate-pulse' : undefined,
      )}
    />
  );
}

export function AutosaveIndicator({
  status,
  savedAt,
  message,
  labels: overrides,
  timeZone,
  className,
  ...props
}: AutosaveIndicatorProps) {
  const labels = { ...AUTOSAVE_INDICATOR_LABELS, ...overrides };
  const time =
    savedAt === null
      ? ''
      : new Intl.DateTimeFormat('pt-BR', {
          hour: '2-digit',
          minute: '2-digit',
          ...(timeZone === undefined ? {} : { timeZone }),
        }).format(new Date(savedAt));
  const full: Record<AutosavePhase, string> = {
    idle: savedAt === null ? '' : labels.saved(time),
    dirty: labels.dirty,
    saving: labels.saving,
    saved: labels.saved(time),
    error: message ? `${labels.error}: ${message}` : labels.error,
    offline: labels.offline,
    conflict: labels.conflict,
    blocked: labels.blocked,
  };
  const short: Partial<Record<AutosavePhase, string>> = {
    saved: labels.savedShort,
    idle: savedAt === null ? '' : labels.savedShort,
    offline: labels.offlineShort,
    error: labels.error,
  };
  const text = full[status];
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={cx(
        'inline-flex min-h-6 items-center gap-2 text-sm text-muted-foreground',
        TONE[status],
        className,
      )}
      {...props}
    >
      {text === '' ? null : (
        <>
          <Dot status={status} />
          {short[status] === undefined || short[status] === text ? (
            <span>{text}</span>
          ) : (
            <>
              <span className="hidden md:inline">{text}</span>
              <span className="md:hidden">{short[status]}</span>
            </>
          )}
        </>
      )}
    </div>
  );
}
