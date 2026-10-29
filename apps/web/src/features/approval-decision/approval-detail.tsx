'use client';

import { Alert, Button, DetailPage, Skeleton } from '@contrataflow/ui';
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
 * `ApprovalDetail` (US-052 · SCR-015) no modelo `DetailPage` (prd-5): faixa com trilha, assunto,
 * situação, processo e fatos-chave (solicitante, data, prazo, aprovador); no conteúdo, os documentos
 * cobertos (versão analisada e PDF) e o histórico compacto da aprovação; à direita, o cartão de
 * decisão (Aprovar / Devolver / Indeferir). "Retirar"/"Redirecionar" (US-053) ficam no menu "Mais".
 * Sem `DECIDE` em `meta.allowedActions` o cartão não aparece: a tela explica por que a pessoa não
 * pode decidir, e a decisão registrada entra no histórico. Skeleton na carga; 404 e erro de carga
 * com "Tentar novamente"; 409/412 recarregam os dados.
 */
export function ApprovalDetail({ approvalId, retry }: ApprovalDetailProps) {
  const t = useTranslations('approvals.detail');
  const timeZone = useShellSession().activeTenant.timezone;
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
  const pending = approval.status === 'PENDING';
  const decidable = canDecide(meta) && pending;
  const refresh = () => {
    void query.refetch();
  };
  const processLabel =
    approval.process.code === null
      ? t('processNoCode', { title: approval.process.title })
      : t('process', { code: approval.process.code, title: approval.process.title });

  return (
    <DetailPage
      breadcrumbs={[{ label: t('breadcrumb'), href: '/aprovacoes' }, { label: approval.title }]}
      breadcrumbLabel={t('breadcrumbLabel')}
      linkComponent={Link}
      title={approval.title}
      status={<ApprovalStatusBadge status={approval.status} />}
      subtitle={
        <Link
          href={`/processos/${approval.process.id}`}
          className="break-words text-primary-soft-foreground underline-offset-2 hover:underline"
        >
          {processLabel}
        </Link>
      }
      actions={
        <ApprovalPendingActions
          approval={approval}
          meta={meta}
          retry={retry}
          onNotice={setActionNotice}
          onRefresh={refresh}
        />
      }
      facts={[
        {
          id: 'requestedBy',
          label: t('facts.requestedBy'),
          value: approval.requestedBy.name ?? t('unknownPerson'),
        },
        {
          id: 'requestedAt',
          label: t('facts.requestedAt'),
          value: formatDateTime(approval.requestedAt, timeZone),
        },
        {
          id: 'dueAt',
          label: t('facts.dueAt'),
          value:
            approval.dueAt === null ? t('facts.noDueAt') : formatDateTime(approval.dueAt, timeZone),
        },
        { id: 'approver', label: t('facts.approver'), value: approval.approver.label },
      ]}
      notices={
        <div aria-live="polite" className="flex flex-col gap-2 empty:hidden">
          {notice === null ? null : <NoticeAlert problem={notice} />}
          {actionNotice === null ? null : <ActionNoticeAlert notice={actionNotice} />}
          {pending && approval.allowDeputy ? (
            <Alert tone="info" live={false} title={t('allowDeputy')} />
          ) : null}
          {pending && meta.decidesAsDeputy ? (
            <Alert tone="info" live={false} title={t('decidesAsDeputy')} />
          ) : null}
          {approval.status === 'CANCELED' ? <CanceledNotice /> : null}
          {pending && !decidable ? <BlockedExplanation blocker={meta.decisionBlocker} /> : null}
        </div>
      }
      aside={
        decidable ? (
          <ApprovalDecisionPanel
            approval={approval}
            meta={meta}
            retry={retry}
            onNotice={setNotice}
            onRefresh={refresh}
          />
        ) : null
      }
      asideLabel={t('decisionAside')}
    >
      <DocumentCoverageList processId={approval.process.id} documents={approval.documents} />
      <ApprovalHistory approval={approval} />
    </DetailPage>
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
    <div role="status" className="flex w-full flex-col gap-5">
      <span className="sr-only">{t('loading')}</span>
      <Skeleton className="h-4 w-48 max-w-full" />
      <Skeleton className="h-8 w-96 max-w-full" />
      <Skeleton className="h-24 w-full" />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Skeleton className="h-56 w-full" />
        <Skeleton className="h-56 w-full" />
      </div>
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
          <Link href="/aprovacoes" className="text-sm font-medium underline">
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

/**
 * Histórico compacto da aprovação: o comentário da solicitação e, quando houver, a decisão
 * registrada (decisor, data, substituto e comentário). Solicitante e data já estão nos fatos.
 */
function ApprovalHistory({ approval }: { readonly approval: ApprovalDto }) {
  const t = useTranslations('approvals.detail');
  const headingId = useId();
  const comment = approval.requestComment?.trim() ?? '';
  if (comment === '' && approval.decision === null) return null;
  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-4 rounded-card bg-surface p-5 shadow-card"
    >
      <h2 id={headingId} className="text-base font-semibold">
        {t('history')}
      </h2>
      <ol className="flex flex-col gap-4 border-l-2 border-border pl-4">
        {comment === '' ? null : (
          <li className="flex min-w-0 flex-col gap-1">
            <h3 className="text-sm font-semibold">{t('requestComment')}</h3>
            <p className="text-sm break-words whitespace-pre-line">{approval.requestComment}</p>
          </li>
        )}
        {approval.decision === null ? null : (
          <li className="flex min-w-0 flex-col gap-1">
            <DecisionRecord approval={approval} />
          </li>
        )}
      </ol>
    </section>
  );
}

function DecisionRecord({ approval }: { readonly approval: ApprovalDto }) {
  const t = useTranslations('approvals.record');
  const timeZone = useShellSession().activeTenant.timezone;
  const headingId = useId();
  if (approval.decision === null) return null;
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2">
      <h3 id={headingId} className="text-sm font-semibold">
        {t('heading')}
      </h3>
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
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

function CanceledNotice() {
  const t = useTranslations('approvals.record');
  return <Alert tone="info" title={t('canceled')} />;
}

/** Pendente, mas fora da designação/segregação/situação do processo: explica o motivo. */
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
