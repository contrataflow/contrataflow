'use client';

import {
  Alert,
  Archive,
  Button,
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
  ApprovalProgressDto,
} from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { formatDateTime } from '@/lib/i18n/format';
import { useShellSession } from '@/lib/session/session-context';

import { useApprovalLines } from './approval-decision.api';

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
 * `ApprovalLinesList` (US-133 · US-136 · SCR-015): as linhas vigentes da aprovação em ordem —
 * posição, aprovador e estado por texto e ícone (nunca só por cor; `WAITING` = "Aguardando a
 * vez"; dispensada com o motivo — RN-APV-71), quando foi ativada e, decidida, por quem e com qual
 * comentário. O andamento (texto do servidor — RN-APV-70) é anunciado em `aria-live`; em
 * `SEQUENTIAL` a linha corrente recebe `aria-current="step"`. Coluna única abaixo de 768 px.
 */
export function ApprovalLinesList({
  approvalId,
  policy,
  approvers,
  progress,
  currentLineId = null,
}: {
  readonly approvalId: string;
  readonly policy: ApprovalDecisionPolicy;
  readonly approvers: readonly ApprovalApproverDto[];
  readonly progress?: ApprovalProgressDto | undefined;
  /** A linha corrente em `SEQUENTIAL` pendente (`meta.waitingFor`). */
  readonly currentLineId?: string | null;
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
      <p aria-live="polite" className="text-sm font-medium empty:hidden">
        {progress?.label === undefined ? null : t('progress', { label: progress.label })}
      </p>
      <ol className="flex flex-col gap-2">
        {approvers.map((line) => (
          <ApprovalLineItem
            key={line.id}
            line={line}
            total={approvers.length}
            current={line.id === currentLineId}
          />
        ))}
      </ol>
      <ApprovalLinesHistory approvalId={approvalId} />
    </section>
  );
}

/** RN-APV-71: a situação da linha por texto (a dispensada com o motivo; a substituída). */
function useLineSituation() {
  const t = useTranslations('approvals.lines');
  return (line: ApprovalApproverDto): string => {
    if (line.status === 'SKIPPED' && line.skippedReason !== null) {
      return t(`skipped.${line.skippedReason}`);
    }
    if (line.status === 'CANCELED' && line.skippedReason === 'REASSIGNED') return t('replaced');
    return t(`status.${line.status}`);
  };
}

function ApprovalLineItem({
  line,
  total,
  current,
  replacedBy = null,
}: {
  readonly line: ApprovalApproverDto;
  readonly total: number;
  readonly current: boolean;
  /** Histórico: o rótulo da linha que substituiu esta (redirecionamento). */
  readonly replacedBy?: string | null;
}) {
  const t = useTranslations('approvals.lines');
  const situation = useLineSituation();
  const timeZone = useShellSession().activeTenant.timezone;
  const { icon: Icon, tone } = LINE_TONES[line.status];
  const comment = line.decisionComment ?? null;
  return (
    <li
      aria-label={t('lineLabel', { line: line.sequence, total, approver: line.label })}
      aria-current={current ? 'step' : undefined}
      className="flex min-w-0 flex-col gap-1 rounded-md border border-border p-3 md:flex-row md:items-center md:justify-between"
    >
      <div className="flex min-w-0 flex-col">
        <span className="text-xs text-muted-foreground">
          {t('line', { line: line.sequence })}
          {current ? ` · ${t('current')}` : ''}
        </span>
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
        {comment === null ? null : (
          <span className="text-xs break-words whitespace-pre-line text-muted-foreground">
            {t('comment', { comment })}
          </span>
        )}
        {replacedBy === null ? null : (
          <span className="text-xs text-muted-foreground">
            {t('replacedBy', { approver: replacedBy })}
          </span>
        )}
      </div>
      <StatusChip tone={tone} icon={<Icon aria-hidden="true" />}>
        {situation(line)}
      </StatusChip>
    </li>
  );
}

/**
 * `ApprovalLinesHistory` (US-136 · APV-31): "Histórico de linhas" sob demanda — todas as linhas,
 * inclusive as substituídas por redirecionamento ("Substituída por {rótulo}"). O motivo do
 * redirecionamento não é exibido (não é persistido — RN-APV-69).
 */
function ApprovalLinesHistory({ approvalId }: { readonly approvalId: string }) {
  const t = useTranslations('approvals.lines.history');
  const [open, setOpen] = useState(false);
  const headingId = useId();
  const query = useApprovalLines(approvalId, open);
  const lines = query.data?.data ?? [];
  const replacement = new Map<string, string>();
  for (const line of lines) {
    if (line.reassignedFromId !== null && line.reassignedFromId !== undefined) {
      replacement.set(line.reassignedFromId, line.label);
    }
  }
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div>
        <Button
          size="sm"
          variant="secondary"
          aria-expanded={open}
          onClick={() => {
            setOpen((value) => !value);
          }}
        >
          {open ? t('close') : t('open')}
        </Button>
      </div>
      {!open ? null : (
        <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2">
          <h3 id={headingId} className="text-sm font-semibold">
            {t('heading')}
          </h3>
          {query.isError ? (
            <Alert tone="error" title={t('failed')}>
              <Button
                size="sm"
                variant="secondary"
                className="mt-2"
                onClick={() => {
                  void query.refetch();
                }}
              >
                {t('retry')}
              </Button>
            </Alert>
          ) : query.data === undefined ? (
            <p role="status" className="text-sm text-muted-foreground">
              {t('loading')}
            </p>
          ) : (
            <ol className="flex flex-col gap-2">
              {lines.map((line) => (
                <ApprovalLineItem
                  key={line.id}
                  line={line}
                  total={query.data.meta.totalLines}
                  current={false}
                  replacedBy={replacement.get(line.id) ?? null}
                />
              ))}
            </ol>
          )}
        </section>
      )}
    </div>
  );
}
