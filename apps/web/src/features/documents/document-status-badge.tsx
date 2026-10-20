import type { DocumentStatus } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';

const TONES: Record<DocumentStatus, string> = {
  DRAFT: 'bg-muted text-foreground',
  IN_REVIEW: 'bg-primary-soft text-foreground',
  RETURNED: 'bg-warning-soft text-foreground',
  FINALIZED: 'bg-success-soft text-foreground',
  APPROVED: 'bg-success-soft text-foreground',
  REJECTED: 'bg-destructive-soft text-foreground',
  CANCELED: 'bg-muted text-muted-foreground',
};

const BASE =
  'inline-flex items-center rounded-control px-2 py-0.5 text-xs font-medium whitespace-nowrap';

/** Status do documento (DEC-018): o texto — nunca só a cor — diz a situação. */
export function DocumentStatusBadge({ status }: { readonly status: DocumentStatus }) {
  const t = useTranslations('documents.statuses');
  return <span className={`${BASE} ${TONES[status]}`}>{t(status)}</span>;
}

/** Selo derivado "Em aprovação" (DEC-018): `pendingApprovalId` preenchido. */
export function PendingApprovalBadge() {
  const t = useTranslations('documents.view');
  return (
    <span className={`${BASE} border border-primary/30 bg-primary-soft`}>
      {t('pendingApproval')}
    </span>
  );
}
