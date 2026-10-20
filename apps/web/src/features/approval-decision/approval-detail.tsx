'use client';

import { Alert, Button, Skeleton } from '@contrataflow/ui';
import type { ApprovalDto, ApprovalMeta } from '@contrataflow/validation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import type { ReactNode } from 'react';

import { isApiError } from '@/lib/api/api-error';
import type { RetryOptions } from '@/lib/api/client';
import { formatDateTime } from '@/lib/i18n/format';
import { useShellSession } from '@/lib/session/session-context';

import { ApprovalDecisionPanel } from './approval-decision-panel';
import { useApproval } from './approval-decision.api';
import { ApprovalPendingActions } from './approval-pending-actions';
import type { PendingActionNotice } from './approval-pending-actions';
import { ApprovalStatusBadge } from './approval-status-badge';
import { canDecide } from './decision-model';
import type { DecisionProblem } from './decision-model';
import { DocumentCoverageList } from './document-coverage-list';

export interface ApprovalDetailProps {
  readonly approvalId: string;
  /** Retentativas automáticas da mutação (testes: `{ retries: 0 }`). */
  readonly retry?: RetryOptions | undefined;
}

/**
 * `ApprovalDetail` (US-052 · SCR-015): detalhe da aprovação — título, solicitante, prazo, situação,
 * aviso de substituto, comentário da solicitação, documentos cobertos (com a versão analisada) e
 * o painel de decisão e, na US-053, as ações "Retirar"/"Redirecionar" (`WITHDRAW`/`REASSIGN`).
 * Sem `DECIDE` em `meta.allowedActions` o painel não aparece: a tela mostra a
 * decisão registrada (já decidida) ou explica por que a pessoa não pode decidir. Skeleton no
 * carregamento; 404 e erro de carga com "Tentar novamente"; 409/412 recarregam os dados.
 */
export function ApprovalDetail({ approvalId, retry }: ApprovalDetailProps) {
  const query = useApproval(approvalId);
  const [notice, setNotice] = useState<DecisionProblem | null>(null);
  const [actionNotice, setActionNotice] = useState<PendingActionNotice | null>(null);

  if (query.data === undefined) {
    if (query.isError) {
      return (
        <LoadFailure
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      );
    }
    return <DetailSkeleton />;
  }

  const { approval, meta } = query.data;
  const decidable = canDecide(meta) && approval.status === 'PENDING';
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <ApprovalHeader approval={approval} meta={meta} />
      <div aria-live="polite" className="flex flex-col gap-2">
        {notice === null ? null : <NoticeAlert problem={notice} />}
        {actionNotice === null ? null : <ActionNoticeAlert notice={actionNotice} />}
      </div>
      <RequestComment comment={approval.requestComment} />
      {decidable ? null : <ClosedSection approval={approval} meta={meta} />}
      <DocumentCoverageList processId={approval.process.id} documents={approval.documents} />
      {decidable ? (
        <ApprovalDecisionPanel
          approval={approval}
          meta={meta}
          retry={retry}
          onNotice={setNotice}
          onRefresh={() => {
            void query.refetch();
          }}
        />
      ) : null}
      <ApprovalPendingActions
        approval={approval}
        meta={meta}
        retry={retry}
        onNotice={setActionNotice}
        onRefresh={() => {
          void query.refetch();
        }}
      />
    </div>
  );
}

/** Recusa da retirada/do redirecionamento explicada pela tela (US-053 · "Casos de erro"). */
function ActionNoticeAlert({ notice }: { readonly notice: PendingActionNotice }) {
  const t = useTranslations('approvals.pendingActions.notice');
  return <Alert tone={notice.kind === 'denied' ? 'error' : 'warning'} title={t(notice.kind)} />;
}

function DetailSkeleton() {
  const t = useTranslations('approvals.detail');
  return (
    <div role="status" className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <span className="sr-only">{t('loading')}</span>
      <Skeleton className="h-8 w-96 max-w-full" />
      <Skeleton className="h-4 w-64 max-w-full" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

/** 404 → "Não encontramos a aprovação solicitada."; demais falhas → "Tentar novamente". */
function LoadFailure({
  error,
  onRetry,
}: {
  readonly error: unknown;
  readonly onRetry: () => void;
}) {
  const t = useTranslations('approvals.detail');
  if (isApiError(error) && error.status === 404) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
        <Alert tone="error" title={t('notFound')}>
          <Link href="/aprovacoes" className="text-sm text-primary underline">
            {t('backToApprovals')}
          </Link>
        </Alert>
      </div>
    );
  }
  const correlationId = isApiError(error) ? (error.correlationId ?? '—') : '—';
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
      <Alert tone="error" title={t('loadFailed')}>
        <p className="text-sm">{t('code', { correlationId })}</p>
        <Button size="sm" variant="secondary" className="mt-3" onClick={onRetry}>
          {t('retry')}
        </Button>
      </Alert>
    </div>
  );
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium break-words">{children}</dd>
    </div>
  );
}

function ApprovalHeader({
  approval,
  meta,
}: {
  readonly approval: ApprovalDto;
  readonly meta: ApprovalMeta;
}) {
  const t = useTranslations('approvals.detail');
  const timeZone = useShellSession().activeTenant.timezone;
  const pending = approval.status === 'PENDING';
  const processLabel =
    approval.process.code === null
      ? t('processNoCode', { title: approval.process.title })
      : t('process', { code: approval.process.code, title: approval.process.title });
  return (
    <header className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold break-words">{approval.title}</h1>
        <ApprovalStatusBadge status={approval.status} />
      </div>
      <Link
        href={`/processos/${approval.process.id}`}
        className="w-fit text-sm break-words text-primary underline"
      >
        {processLabel}
      </Link>
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
        <Fact label={t('facts.requestedBy')}>
          {approval.requestedBy.name ?? t('unknownPerson')}
        </Fact>
        <Fact label={t('facts.requestedAt')}>{formatDateTime(approval.requestedAt, timeZone)}</Fact>
        <Fact label={t('facts.dueAt')}>
          {approval.dueAt === null ? t('facts.noDueAt') : formatDateTime(approval.dueAt, timeZone)}
        </Fact>
        <Fact label={t('facts.approver')}>{approval.approver.label}</Fact>
      </dl>
      {pending && approval.allowDeputy ? (
        <Alert tone="info" live={false} title={t('allowDeputy')} />
      ) : null}
      {pending && meta.decidesAsDeputy ? (
        <Alert tone="info" live={false} title={t('decidesAsDeputy')} />
      ) : null}
    </header>
  );
}

function RequestComment({ comment }: { readonly comment: string | null }) {
  const t = useTranslations('approvals.detail');
  const headingId = useId();
  if (comment === null || comment.trim() === '') return null;
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-1">
      <h2 id={headingId} className="text-sm font-semibold">
        {t('requestComment')}
      </h2>
      <p className="text-sm break-words whitespace-pre-line">{comment}</p>
    </section>
  );
}

/**
 * Aprovação que a pessoa não decide: já decidida (mostra a decisão registrada), cancelada ou
 * fora da designação/segregação/situação do processo (explica o motivo — "oculta ações").
 */
function ClosedSection({
  approval,
  meta,
}: {
  readonly approval: ApprovalDto;
  readonly meta: ApprovalMeta;
}) {
  if (approval.status !== 'PENDING') return <DecisionRecord approval={approval} />;
  return <BlockedExplanation blocker={meta.decisionBlocker} />;
}

function DecisionRecord({ approval }: { readonly approval: ApprovalDto }) {
  const t = useTranslations('approvals.record');
  const timeZone = useShellSession().activeTenant.timezone;
  const headingId = useId();
  if (approval.decision === null) {
    return <Alert tone="info" title={t('canceled')} />;
  }
  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-surface p-4 md:p-6"
    >
      <h2 id={headingId} className="text-base font-semibold">
        {t('heading')}
      </h2>
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
        <Fact label={t('decision')}>{t(`decisions.${approval.decision}`)}</Fact>
        <Fact label={t('decidedBy')}>
          {t(approval.decidedAsDeputy ? 'byDeputy' : 'byName', {
            name: approval.decidedBy?.name ?? '—',
          })}
        </Fact>
        {approval.decidedAt === null ? null : (
          <Fact label={t('decidedAt')}>{formatDateTime(approval.decidedAt, timeZone)}</Fact>
        )}
        {approval.decisionComment === null ? null : (
          <div className="flex min-w-0 flex-col sm:col-span-2">
            <dt className="text-xs text-muted-foreground">{t('comment')}</dt>
            <dd className="text-sm break-words whitespace-pre-line">{approval.decisionComment}</dd>
          </div>
        )}
      </dl>
    </section>
  );
}

function BlockedExplanation({ blocker }: { readonly blocker: ApprovalMeta['decisionBlocker'] }) {
  const t = useTranslations('approvals.blocked');
  return (
    <Alert tone="warning" title={t('title')}>
      <p className="text-sm">{t(`reasons.${blocker ?? 'UNKNOWN'}`)}</p>
    </Alert>
  );
}

/** Resultado da recusa que a tela inteira explica (a aprovação já foi relida). */
function NoticeAlert({ problem }: { readonly problem: DecisionProblem }) {
  const t = useTranslations('approvals.notice');
  switch (problem.kind) {
    case 'notPending':
    case 'stale':
    case 'precondition':
    case 'processStatus':
    case 'notFound':
      return <Alert tone="warning" title={t(problem.kind)} />;
    case 'denied':
      return <Alert tone="error" title={t('denied')} />;
    default:
      return null;
  }
}
