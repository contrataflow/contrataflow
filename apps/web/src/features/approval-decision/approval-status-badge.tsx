import type { ApprovalDto } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';

import { Icon } from '@/components/shell/icons';
import type { IconName } from '@/components/shell/icons';

type ApprovalStatus = ApprovalDto['status'];

const TONES: Readonly<
  Record<ApprovalStatus, { readonly icon: IconName; readonly classes: string }>
> = {
  PENDING: { icon: 'clock', classes: 'bg-warning-soft text-foreground' },
  APPROVED: { icon: 'check', classes: 'bg-success-soft text-foreground' },
  RETURNED: { icon: 'alert', classes: 'bg-warning-soft text-foreground' },
  REJECTED: { icon: 'close', classes: 'bg-destructive-soft text-foreground' },
  CANCELED: { icon: 'archive', classes: 'bg-muted text-muted-foreground' },
};

/**
 * `ApprovalStatusBadge` (SCR-015): situação da aprovação com ícone E texto — a cor nunca é a
 * única informação.
 */
export function ApprovalStatusBadge({ status }: { readonly status: ApprovalStatus }) {
  const t = useTranslations('approvals.detail.status');
  const tone = TONES[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-control px-2 py-0.5 text-xs font-medium whitespace-nowrap ${tone.classes}`}
    >
      <Icon name={tone.icon} className="size-3.5" />
      {t(status)}
    </span>
  );
}
