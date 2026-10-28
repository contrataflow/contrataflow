import { StatusChip } from '@contrataflow/ui';
import type { StatusTone } from '@contrataflow/ui';
import type { DocumentStatus } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';

/** Tom semântico de cada status (design system v2 — prd-4). */
export const DOCUMENT_STATUS_TONE: Readonly<Record<DocumentStatus, StatusTone>> = {
  DRAFT: 'neutral',
  IN_REVIEW: 'info',
  RETURNED: 'warning',
  FINALIZED: 'success',
  APPROVED: 'success',
  REJECTED: 'danger',
  CANCELED: 'neutral',
};

/** Status do documento (DEC-018): o texto — nunca só a cor — diz a situação. */
export function DocumentStatusBadge({ status }: { readonly status: DocumentStatus }) {
  const t = useTranslations('documents.statuses');
  return <StatusChip tone={DOCUMENT_STATUS_TONE[status]}>{t(status)}</StatusChip>;
}

/** Selo derivado "Em aprovação" (DEC-018): `pendingApprovalId` preenchido. */
export function PendingApprovalBadge() {
  const t = useTranslations('documents.view');
  return <StatusChip tone="approval">{t('pendingApproval')}</StatusChip>;
}
