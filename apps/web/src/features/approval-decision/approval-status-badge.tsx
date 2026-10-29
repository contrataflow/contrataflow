import { Archive, Check, Clock, CornerDownLeft, StatusChip, X } from '@contrataflow/ui';
import type { IconComponent, StatusTone } from '@contrataflow/ui';
import type { ApprovalDto } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';

type ApprovalStatus = ApprovalDto['status'];

const TONES: Readonly<
  Record<ApprovalStatus, { readonly icon: IconComponent; readonly tone: StatusTone }>
> = {
  PENDING: { icon: Clock, tone: 'warning' },
  APPROVED: { icon: Check, tone: 'success' },
  RETURNED: { icon: CornerDownLeft, tone: 'approval' },
  REJECTED: { icon: X, tone: 'danger' },
  CANCELED: { icon: Archive, tone: 'neutral' },
};

/**
 * `ApprovalStatusBadge` (SCR-014/SCR-015): situação da aprovação no `StatusChip` do kit, com ícone
 * E texto — a cor nunca é a única informação.
 */
export function ApprovalStatusBadge({ status }: { readonly status: ApprovalStatus }) {
  const t = useTranslations('approvals.detail.status');
  const { icon: Icon, tone } = TONES[status];
  return (
    <StatusChip tone={tone} icon={<Icon aria-hidden="true" />}>
      {t(status)}
    </StatusChip>
  );
}
