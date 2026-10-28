import { StatusChip } from '@contrataflow/ui';
import type { StatusTone } from '@contrataflow/ui';
import type { ProcessStatus } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';

/** Tom semântico de cada situação (design system v2 — prd-4): o mesmo do donut do painel. */
export const PROCESS_STATUS_TONE: Readonly<Record<ProcessStatus, StatusTone>> = {
  DRAFT: 'neutral',
  IN_PROGRESS: 'info',
  AWAITING_APPROVAL: 'approval',
  RETURNED: 'warning',
  SUSPENDED: 'danger',
  CANCELED: 'neutral',
  COMPLETED: 'success',
  PUBLISHED: 'success',
};

/** Situação macro do processo (DEC-013): chip com ícone + texto, nunca só cor. */
export function ProcessStatusBadge({ status }: { readonly status: ProcessStatus }) {
  const t = useTranslations('processes.statuses');
  return (
    <StatusChip tone={PROCESS_STATUS_TONE[status]} className="gap-1">
      <svg aria-hidden="true" viewBox="0 0 16 16" className="size-2.5 fill-current">
        <circle cx="8" cy="8" r="4" />
      </svg>
      {t(status)}
    </StatusChip>
  );
}
