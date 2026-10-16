import type { Priority, ProcessDeadlineDto } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';

/*
 * Badges da lista de processos (US-002): prazo da etapa (`DueDateBadge`, compartilhado com o painel
 * situacional — US-004), prioridade e valor sigiloso. Sempre ícone + texto, nunca só cor (DEC-183).
 */

type DeadlineTone = 'ok' | 'soon' | 'late' | 'neutral';

const TONES: Readonly<Record<DeadlineTone, string>> = {
  ok: 'bg-muted text-foreground',
  soon: 'bg-warning-soft text-warning',
  late: 'bg-destructive-soft text-destructive',
  neutral: 'bg-muted text-muted-foreground',
};

const ICONS: Readonly<Record<DeadlineTone, string>> = {
  // relógio
  ok: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Zm.75 3v3.19l2.03 2.03-1.06 1.06L7.25 8.31V4.5h1.5Z',
  // ampulheta
  soon: 'M4 1.5h8v2.2L9.4 8 12 12.3v2.2H4v-2.2L6.6 8 4 3.7V1.5Zm1.5 1.5v.3L8 7.1l2.5-3.8V3h-5Z',
  // alerta
  late: 'M8 1 15 14H1L8 1Zm-.75 5v4h1.5V6h-1.5Zm0 5v1.5h1.5V11h-1.5Z',
  // pausa / traço
  neutral: 'M5 3h2v10H5V3Zm4 0h2v10H9V3Z',
};

/** Rótulo e tom do badge de prazo ("No prazo", "Vence em N dias úteis", "Atrasado há N…"). */
export function useDeadlineLabel(deadline: ProcessDeadlineDto): {
  readonly label: string;
  readonly tone: DeadlineTone;
} {
  const t = useTranslations('processList.deadline');
  const calendar = deadline.slaType === 'CALENDAR';
  if (deadline.isPaused) return { label: t('paused'), tone: 'neutral' };
  if (deadline.isOverdue) {
    const count = deadline.overdueDays ?? 0;
    return { label: t(calendar ? 'overdueCalendar' : 'overdue', { count }), tone: 'late' };
  }
  if (deadline.dueAt === null || deadline.daysLeft === null) {
    return { label: t('none'), tone: 'neutral' };
  }
  if (deadline.daysLeft === 0) return { label: t('dueToday'), tone: 'soon' };
  if (deadline.isDueSoon) {
    return {
      label: t(calendar ? 'dueInCalendar' : 'dueIn', { count: deadline.daysLeft }),
      tone: 'soon',
    };
  }
  return { label: t('onTime'), tone: 'ok' };
}

export function DueDateBadge({ deadline }: { readonly deadline: ProcessDeadlineDto }) {
  const { label, tone } = useDeadlineLabel(deadline);
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-control px-2 py-0.5 text-xs font-medium ${TONES[tone]}`}
    >
      <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3 fill-current">
        <path d={ICONS[tone]} />
      </svg>
      {label}
    </span>
  );
}

const PRIORITY_BARS: Readonly<Record<Priority, number>> = { LOW: 1, MEDIUM: 2, HIGH: 3, URGENT: 4 };

export function PriorityBadge({ priority }: { readonly priority: Priority }) {
  const t = useTranslations('processes.priorities');
  const bars = PRIORITY_BARS[priority];
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium">
      <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3 fill-current">
        {[0, 1, 2, 3].map((index) => (
          <rect
            key={index}
            x={1 + index * 4}
            y={12 - index * 3}
            width="2.5"
            height={3 + index * 3}
            opacity={index < bars ? 1 : 0.25}
          />
        ))}
      </svg>
      {t(priority)}
    </span>
  );
}

const LOCK = 'M5 7V5a3 3 0 1 1 6 0v2h1v7H4V7h1Zm1.5 0h3V5a1.5 1.5 0 0 0-3 0v2Z';

/** "Orçamento sigiloso": o fato do sigilo é público (RN-PROC-33). */
export function ConfidentialBadge() {
  const t = useTranslations('processList.table');
  return (
    <span className="inline-flex items-center gap-1 rounded-control bg-muted px-2 py-0.5 text-xs font-medium">
      <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3 fill-current">
        <path d={LOCK} />
      </svg>
      {t('confidentialBadge')}
    </span>
  );
}

/** Valor estimado: "R$ 1.200.000,00" ou "Sigiloso" com cadeado (POL-09 · FA-06). */
export function ConfidentialValue({
  value,
  masked,
}: {
  readonly value: string | null;
  readonly masked: boolean;
}) {
  const t = useTranslations('processList.table');
  if (masked) {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3 fill-current">
          <path d={LOCK} />
        </svg>
        {t('confidentialValue')}
      </span>
    );
  }
  if (value === null) return <span className="text-muted-foreground">{t('none')}</span>;
  return <span className="tabular-nums">{formatBrl(value)}</span>;
}

/** "1200000.00" → "R$ 1.200.000,00" (sem ponto flutuante). */
export function formatBrl(decimal: string): string {
  const [whole = '0', cents = '00'] = decimal.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `R$ ${grouped},${cents.padEnd(2, '0').slice(0, 2)}`;
}
