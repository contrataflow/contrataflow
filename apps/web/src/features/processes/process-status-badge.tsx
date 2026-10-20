import type { ProcessStatus } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';

/** Situação macro do processo (DEC-013): ícone + texto, nunca só cor. */
export function ProcessStatusBadge({ status }: { readonly status: ProcessStatus }) {
  const t = useTranslations('processes.statuses');
  return (
    <span className="inline-flex items-center gap-1 rounded-control bg-muted px-2 py-0.5 text-xs font-medium text-foreground">
      <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3 fill-current">
        <circle cx="8" cy="8" r="4" />
      </svg>
      {t(status)}
    </span>
  );
}
