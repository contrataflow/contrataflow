'use client';

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
  cx,
} from '@contrataflow/ui';
import type { PendingItem, ProcessSummaryDto } from '@contrataflow/validation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useId } from 'react';
import type { ReactNode } from 'react';

import { formatCivilDate, formatDate } from '@/lib/i18n/format';

import { SafeMarkdown } from './safe-markdown';
import { StageChecklist } from '../process-actions/stage-checklist';
import { DueDateBadge } from '../process-list/process-list-badges';

const LOCK = 'M5 7V5a3 3 0 1 1 6 0v2h1v7H4V7h1Zm1.5 0h3V5a1.5 1.5 0 0 0-3 0v2Z';

/** Cartão do painel: uma seção com `h2` navegável por leitor de tela (DEC-180 · "Acessibilidade"). */
function Card({
  title,
  id,
  children,
}: {
  readonly title: string;
  readonly id?: string;
  readonly children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className="flex min-w-0 scroll-mt-4 flex-col gap-3 rounded-card border border-border bg-surface p-4 shadow-card"
    >
      <h2 id={headingId} className="text-base font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

function LockIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3 flex-none fill-current">
      <path d={LOCK} />
    </svg>
  );
}

/** (1) Onde está: etapa — unidade — status; suspensão, conclusão e cancelamento (FA-06/07). */
function WhereCard({
  summary,
  timeZone,
}: {
  readonly summary: ProcessSummaryDto;
  readonly timeZone: string;
}) {
  const t = useTranslations('processes.panel.where');
  const status = useTranslations('processes.statuses');
  const { where } = summary;
  const lines: string[] = [];
  if (where.status === 'SUSPENDED' && where.suspendedAt !== null) {
    lines.push(
      t('suspended', {
        date: formatDate(where.suspendedAt, timeZone),
        reason: where.suspensionReason ?? '—',
      }),
    );
  }
  if (where.status === 'COMPLETED' && where.completedAt !== null) {
    lines.push(
      t('completed', {
        stage: where.stage?.name ?? status('COMPLETED'),
        date: formatDate(where.completedAt, timeZone),
      }),
    );
  }
  if (where.status === 'CANCELED' && where.canceledAt !== null) {
    lines.push(
      t('canceled', {
        date: formatDate(where.canceledAt, timeZone),
        reason: where.cancellationReason ?? '—',
      }),
    );
  }
  return (
    <Card title={t('title')}>
      {where.stage === null ? (
        <p className="text-sm text-muted-foreground">{t('noStage')}</p>
      ) : (
        <p className="text-sm font-medium">
          {t('summary', {
            stage: where.stage.name,
            department: where.department.name,
            status: status(where.status),
          })}
        </p>
      )}
      {where.stage?.groupLabel ? (
        <p className="text-xs text-muted-foreground">
          {t('group', { group: where.stage.groupLabel })}
        </p>
      ) : null}
      {lines.map((line) => (
        <p key={line} className="text-sm">
          {line}
        </p>
      ))}
    </Card>
  );
}

/** (2) Responsável: pessoa desde a data, fila da unidade ou o aprovador designado. */
function ResponsibleCard({
  summary,
  timeZone,
}: {
  readonly summary: ProcessSummaryDto;
  readonly timeZone: string;
}) {
  const t = useTranslations('processes.panel.responsible');
  const { responsible } = summary;
  let body: ReactNode;
  if (responsible.approver !== null) {
    body = (
      <p className="text-sm font-medium">{t('awaiting', { name: responsible.approver.label })}</p>
    );
  } else if (responsible.user !== null) {
    body = (
      <p className="text-sm">
        <span className="font-medium">{responsible.user.name}</span>
        {responsible.user.jobTitle ? ` · ${responsible.user.jobTitle}` : null}
        {responsible.since ? (
          <span className="text-muted-foreground">
            {' '}
            {t('since', { date: formatDate(responsible.since, timeZone) })}
          </span>
        ) : null}
      </p>
    );
  } else if (responsible.queueDepartment !== null) {
    body = (
      <p className="text-sm font-medium">
        {t('queue', { department: responsible.queueDepartment.name })}
      </p>
    );
  } else {
    body = <p className="text-sm text-muted-foreground">{t('none')}</p>;
  }
  return <Card title={t('title')}>{body}</Card>;
}

function PendingLink({
  item,
  processId,
}: {
  readonly item: PendingItem;
  readonly processId: string;
}) {
  const t = useTranslations('processes.panel.pending');
  const { link } = item;
  if (link === null) return null;
  if ('createDocumentTypeCode' in link) {
    return (
      <span className="text-xs text-muted-foreground">
        {t('createDocument', { type: link.createDocumentTypeCode })}
      </span>
    );
  }
  if (link.restricted) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <LockIcon />
        {t('restricted')}
      </span>
    );
  }
  return (
    <Link
      href={`/processos/${processId}/documentos/${link.documentId}`}
      className="text-xs text-primary underline"
    >
      {t('openDocument')}
    </Link>
  );
}

/** (3) O que falta: contagens, itens não satisfeitos com atalho e o checklist completo (PRC-09). */
function PendingCard({
  summary,
  processId,
}: {
  readonly summary: ProcessSummaryDto;
  readonly processId: string;
}) {
  const t = useTranslations('processes.panel.pending');
  const { pending } = summary;
  return (
    <Card title={t('title')} id="pendencias">
      {pending.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('none')}</p>
      ) : (
        <>
          <p className="text-sm">
            {t('counts', { blocking: pending.blockingCount, warnings: pending.warningCount })}
          </p>
          <ul className="flex flex-col gap-2">
            {pending.items.map((item) => {
              const blocking = item.severity === 'BLOCKING';
              return (
                <li
                  key={item.ruleId}
                  className={cx(
                    'flex flex-col gap-1 rounded-control border p-2 text-sm',
                    blocking ? 'border-destructive/40 bg-destructive-soft' : 'border-warning/30',
                  )}
                >
                  <span className="text-xs font-semibold uppercase">
                    {t(blocking ? 'blocking' : 'warning')}
                  </span>
                  <span>{item.message}</span>
                  <PendingLink item={item} processId={processId} />
                </li>
              );
            })}
          </ul>
        </>
      )}
      <Dialog>
        <DialogTrigger asChild>
          <Button variant="ghost" size="sm" className="self-start">
            {t('checklist')}
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogTitle>{t('checklist')}</DialogTitle>
          <DialogDescription>{t('checklistDescription')}</DialogDescription>
          <StageChecklist processId={processId} />
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/** (4) Próximo passo: as instruções da etapa (Markdown sanitizado). */
function NextStepCard({ summary }: { readonly summary: ProcessSummaryDto }) {
  const t = useTranslations('processes.panel.next');
  const instructions = summary.nextStep.instructions?.trim();
  return (
    <Card title={t('title')}>
      {instructions ? (
        <SafeMarkdown text={instructions} />
      ) : (
        <p className="text-sm text-muted-foreground">{t('none')}</p>
      )}
    </Card>
  );
}

/** (5) Prazos: badge da etapa (US-002) e o prazo alvo; sem badges em status final (RN-PROC-53). */
function DeadlinesCard({
  summary,
  timeZone,
}: {
  readonly summary: ProcessSummaryDto;
  readonly timeZone: string;
}) {
  const t = useTranslations('processes.panel.deadlines');
  const { deadline, target } = summary;
  if (deadline === null) {
    return (
      <Card title={t('title')}>
        <p className="text-sm text-muted-foreground">{t('final')}</p>
      </Card>
    );
  }
  return (
    <Card title={t('title')}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">{t('stage')}:</span>
        <DueDateBadge deadline={deadline} />
        {deadline.dueAt ? (
          <span className="text-xs text-muted-foreground">
            {t('dueAt', { date: formatDate(deadline.dueAt, timeZone) })}
          </span>
        ) : null}
      </div>
      <p className="text-sm">
        {target === null
          ? t('noTarget')
          : target.isOverdue
            ? t('targetOverdue', { count: target.overdueDays ?? 0 })
            : t('target', { date: formatCivilDate(target.targetDate) })}
      </p>
    </Card>
  );
}

/** (6) Documentos: tipo, código, status, versão, "Em aprovação" e o cadeado dos restritos. */
function DocumentsCard({
  summary,
  processId,
}: {
  readonly summary: ProcessSummaryDto;
  readonly processId: string;
}) {
  const t = useTranslations('processes.panel.documents');
  const statuses = useTranslations('documents.statuses');
  return (
    <Card title={t('title')}>
      {summary.documents.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('empty')} — {t('create')}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {summary.documents.map((document) => {
            const label = [
              t('item', {
                code: document.code ?? `${document.typeName} · ${t('noCode')}`,
                status: statuses(document.status),
              }),
              document.versionNumber === null
                ? null
                : t('version', { number: document.versionNumber }),
            ]
              .filter(Boolean)
              .join(' — ');
            return (
              <li key={document.id} className="flex flex-col gap-0.5 text-sm">
                {document.restricted ? (
                  <span className="inline-flex items-center gap-1 font-medium">
                    <LockIcon />
                    {label}
                  </span>
                ) : (
                  <Link
                    href={`/processos/${processId}/documentos/${document.id}`}
                    className="font-medium text-primary underline"
                  >
                    {label}
                  </Link>
                )}
                <span className="text-xs text-muted-foreground">{document.title}</span>
                {document.restricted ? (
                  <span className="text-xs text-muted-foreground">{t('restricted')}</span>
                ) : null}
                {document.inApproval ? (
                  <span className="self-start rounded-control bg-warning-soft px-2 py-0.5 text-xs font-medium text-warning">
                    {t('inApproval')}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/** (7) Aprovações pendentes: título, aprovador, solicitação, prazo e "Aguardando sua decisão". */
function ApprovalsCard({
  summary,
  timeZone,
}: {
  readonly summary: ProcessSummaryDto;
  readonly timeZone: string;
}) {
  const t = useTranslations('processes.panel.approvals');
  return (
    <Card title={t('title')}>
      {summary.approvals.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {summary.approvals.map((approval) => (
            <li key={approval.id} className="flex flex-col gap-0.5 text-sm">
              <span className="font-medium">{approval.title}</span>
              {approval.isMine ? (
                <span className="self-start rounded-control bg-primary-soft px-2 py-0.5 text-xs font-medium text-primary">
                  {t('mine')}
                </span>
              ) : null}
              <span className="text-xs text-muted-foreground">
                {t('approver', { name: approval.approverLabel })} ·{' '}
                {t('requestedAt', { date: formatDate(approval.requestedAt, timeZone) })}
                {approval.dueAt
                  ? ` · ${t('dueAt', { date: formatDate(approval.dueAt, timeZone) })}`
                  : ''}
              </span>
              {approval.isOverdue ? (
                <span className="text-xs font-medium text-destructive">{t('overdue')}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * `SituationalPanel` (SCR-006 · DEC-180 · RN-PROC-48): as 7 perguntas na primeira dobra, cada uma
 * numa seção com `h2` — empilhadas no mobile na ordem das perguntas (FA-12).
 */
export function SituationalPanel({
  summary,
  processId,
  timeZone,
}: {
  readonly summary: ProcessSummaryDto;
  readonly processId: string;
  readonly timeZone: string;
}) {
  return (
    <div className="grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-3">
      <WhereCard summary={summary} timeZone={timeZone} />
      <ResponsibleCard summary={summary} timeZone={timeZone} />
      <PendingCard summary={summary} processId={processId} />
      <NextStepCard summary={summary} />
      <DeadlinesCard summary={summary} timeZone={timeZone} />
      <DocumentsCard summary={summary} processId={processId} />
      <ApprovalsCard summary={summary} timeZone={timeZone} />
    </div>
  );
}
