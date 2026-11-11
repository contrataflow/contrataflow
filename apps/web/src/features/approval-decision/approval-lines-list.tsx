'use client';

import {
  Archive,
  Check,
  Clock,
  CornerDownLeft,
  Hourglass,
  Minus,
  StatusChip,
  Users,
  X,
} from '@contrataflow/ui';
import type { IconComponent, StatusTone } from '@contrataflow/ui';
import type {
  ApprovalApproverDto,
  ApprovalApproverStatus,
  ApprovalDecisionPolicy,
} from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import { useId } from 'react';

import { formatDateTime } from '@/lib/i18n/format';
import { useShellSession } from '@/lib/session/session-context';

const LINE_TONES: Readonly<
  Record<ApprovalApproverStatus, { readonly icon: IconComponent; readonly tone: StatusTone }>
> = {
  WAITING: { icon: Hourglass, tone: 'neutral' },
  PENDING: { icon: Clock, tone: 'warning' },
  APPROVED: { icon: Check, tone: 'success' },
  RETURNED: { icon: CornerDownLeft, tone: 'approval' },
  REJECTED: { icon: X, tone: 'danger' },
  SKIPPED: { icon: Minus, tone: 'neutral' },
  CANCELED: { icon: Archive, tone: 'neutral' },
};

/**
 * `ApprovalPolicyBadge` (US-133 · SCR-014/SCR-015): como a decisão é tomada — "Qualquer um
 * aprova", "Todos aprovam" ou "Aprovam em sequência" — com ícone e texto.
 */
export function ApprovalPolicyBadge({ policy }: { readonly policy: ApprovalDecisionPolicy }) {
  const t = useTranslations('approvals.lines.policy');
  return (
    <StatusChip tone="info" icon={<Users aria-hidden="true" />}>
      {t(policy)}
    </StatusChip>
  );
}

/**
 * `ApprovalLinesList` (US-133 · SCR-015): as linhas da aprovação em ordem — posição, aprovador e
 * estado por texto e ícone (nunca só por cor; `WAITING` = "Aguardando a vez"), quando foi ativada
 * e, decidida, por quem. Coluna única abaixo de 768 px.
 */
export function ApprovalLinesList({
  policy,
  approvers,
}: {
  readonly policy: ApprovalDecisionPolicy;
  readonly approvers: readonly ApprovalApproverDto[];
}) {
  const t = useTranslations('approvals.lines');
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={headingId} className="text-base font-semibold">
          {t('heading')}
        </h2>
        <ApprovalPolicyBadge policy={policy} />
      </div>
      <p className="text-sm text-muted-foreground">{t(`help.${policy}`)}</p>
      <ol className="flex flex-col gap-2">
        {approvers.map((line) => (
          <ApprovalLineItem key={line.id} line={line} total={approvers.length} />
        ))}
      </ol>
    </section>
  );
}

function ApprovalLineItem({
  line,
  total,
}: {
  readonly line: ApprovalApproverDto;
  readonly total: number;
}) {
  const t = useTranslations('approvals.lines');
  const timeZone = useShellSession().activeTenant.timezone;
  const { icon: Icon, tone } = LINE_TONES[line.status];
  return (
    <li
      aria-label={t('lineLabel', { line: line.sequence, total, approver: line.label })}
      className="flex min-w-0 flex-col gap-1 rounded-md border border-border p-3 md:flex-row md:items-center md:justify-between"
    >
      <div className="flex min-w-0 flex-col">
        <span className="text-xs text-muted-foreground">{t('line', { line: line.sequence })}</span>
        <span className="text-sm font-medium break-words">{line.label}</span>
        {line.decidedBy === null ? null : (
          <span className="text-xs text-muted-foreground">
            {t(line.decidedAsDeputy ? 'decidedByDeputy' : 'decidedBy', {
              name: line.decidedBy.name ?? '—',
            })}
          </span>
        )}
        {line.activatedAt === null || line.status !== 'PENDING' ? null : (
          <span className="text-xs text-muted-foreground">
            {t('activatedAt', { date: formatDateTime(line.activatedAt, timeZone) })}
          </span>
        )}
      </div>
      <StatusChip tone={tone} icon={<Icon aria-hidden="true" />}>
        {t(`status.${line.status}`)}
      </StatusChip>
    </li>
  );
}
