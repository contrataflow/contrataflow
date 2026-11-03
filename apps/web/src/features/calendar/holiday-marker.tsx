import type { HolidayScope } from '@contrataflow/types';

/*
 * Marcador por tipo de feriado (prd-6 §2.6): cor **e** forma, para que a cor nunca seja a única
 * informação — nacional ● · estadual ◆ · municipal ▲ · ponto facultativo ○. Decorativo: o tipo
 * também vai por extenso no rótulo acessível do dia e na lista.
 */

export const SCOPE_COLOR: Record<HolidayScope, string> = {
  NATIONAL: 'text-destructive',
  STATE: 'text-approval',
  MUNICIPAL: 'text-warning',
  OPTIONAL: 'text-primary',
};

export function HolidayMarker({
  scope,
  className,
}: {
  readonly scope: HolidayScope;
  readonly className?: string | undefined;
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 10 10"
      data-scope={scope}
      className={`${SCOPE_COLOR[scope]} ${className ?? 'size-2.5'}`}
    >
      {scope === 'NATIONAL' ? <circle cx="5" cy="5" r="4" fill="currentColor" /> : null}
      {scope === 'STATE' ? <path d="M5 0.6 9.4 5 5 9.4 0.6 5Z" fill="currentColor" /> : null}
      {scope === 'MUNICIPAL' ? <path d="M5 0.8 9.4 9.2H0.6Z" fill="currentColor" /> : null}
      {scope === 'OPTIONAL' ? (
        <circle cx="5" cy="5" r="3.4" fill="none" stroke="currentColor" strokeWidth="1.8" />
      ) : null}
    </svg>
  );
}
