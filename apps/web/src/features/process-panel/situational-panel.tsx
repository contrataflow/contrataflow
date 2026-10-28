'use client';

import {
  Avatar,
  Button,
  Card as UiCard,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
  StatusChip,
  cx,
} from '@contrataflow/ui';
import type { PendingItem, ProcessSummaryDto } from '@contrataflow/validation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useId } from 'react';
import type { ReactNode } from 'react';

import { formatCivilDate, formatDate } from '@/lib/i18n/format';

import { SafeMarkdown } from './safe-markdown';
import { DOCUMENT_STATUS_TONE } from '../documents/document-status-badge';
import { StageChecklist } from '../process-actions/stage-checklist';
import { DueDateBadge } from '../process-list/process-list-badges';

const LOCK = 'M5 7V5a3 3 0 1 1 6 0v2h1v7H4V7h1Zm1.5 0h3V5a1.5 1.5 0 0 0-3 0v2Z';

/**
 * Cartão do painel: o `Card` do design system v2 como seção com `h2` navegável por leitor de tela
 * (DEC-180 · "Acessibilidade").
 */
function Card({
  title,
  id,
  children,
}: {
  readonly title: string;
  readonly id?: string;
  readonly children: ReactNode;
}) {
  const autoId = useId();
  return (
    <UiCard id={id ?? autoId} title={title} className="min-w-0 scroll-mt-4 gap-3">
      {children}
    </UiCard>
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
      <>
        <p className="text-sm font-medium">{t('awaiting', { name: responsible.approver.label })}</p>
        {/* US-008 · FA-01: a aprovação segue pendente, mas a decisão fica congelada. */}
        {summary.where.status === 'SUSPENDED' ? (
          <p className="text-sm text-warning">{t('approvalFrozen')}</p>
        ) : null}
      </>
    );
  } else if (responsible.user !== null) {
    body = (
      <div className="flex min-w-0 items-center gap-3">
        <Avatar name={responsible.user.name} />
        <p className="min-w-0 text-sm">
          <span className="font-medium">{responsible.user.name}</span>
          {responsible.user.jobTitle ? ` · ${responsible.user.jobTitle}` : null}
          {responsible.since ? (
            <span className="text-muted-foreground">
              {' '}
              {t('since', { date: formatDate(responsible.since, timeZone) })}
            </span>
          ) : null}
        </p>
      </div>
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
                    'flex flex-col items-start gap-1.5 rounded-control border border-l-4 border-border p-3 text-sm',
                    blocking ? 'border-l-destructive' : 'border-l-warning',
                  )}
                >
                  <StatusChip tone={blocking ? 'danger' : 'warning'}>
                    {t(blocking ? 'blocking' : 'warning')}
                  </StatusChip>
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

/**
 * (6) Documentos da etapa como cartões: tipo, código (link — ou cadeado nos restritos), status em
 * chip, versão e "Em aprovação". O PDF é gerado na aba Documentos, que tem a versão de cada um.
 */
function DocumentsCard({
  summary,
  processId,
  onOpenDocuments,
}: {
  readonly summary: ProcessSummaryDto;
  readonly processId: string;
  readonly onOpenDocuments?: (() => void) | undefined;
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
        <ul className="grid gap-3 sm:grid-cols-2">
          {summary.documents.map((document) => {
            const code = document.code ?? `${document.typeName} · ${t('noCode')}`;
            const label = [
              t('item', { code, status: statuses(document.status) }),
              document.versionNumber === null
                ? null
                : t('version', { number: document.versionNumber }),
            ]
              .filter(Boolean)
              .join(' — ');
            return (
              <li
                key={document.id}
                className="flex min-w-0 flex-col gap-2 rounded-control border border-border p-3 text-sm"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-label font-semibold text-muted-foreground uppercase">
                    {document.typeName}
                  </span>
                  <StatusChip tone={DOCUMENT_STATUS_TONE[document.status]}>
                    {statuses(document.status)}
                  </StatusChip>
                </div>
                {document.restricted ? (
                  <span className="inline-flex items-center gap-1 font-semibold">
                    <LockIcon />
                    {label}
                  </span>
                ) : (
                  <Link
                    href={`/processos/${processId}/documentos/${document.id}`}
                    aria-label={label}
                    className="font-semibold break-words text-primary hover:text-primary-hover hover:underline"
                  >
                    {code}
                  </Link>
                )}
                <span className="text-xs break-words text-muted-foreground">{document.title}</span>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {document.versionNumber === null
                      ? t('noVersion')
                      : t('version', { number: document.versionNumber })}
                  </span>
                  {document.inApproval ? (
                    <StatusChip tone="approval">{t('inApproval')}</StatusChip>
                  ) : null}
                </div>
                {document.restricted ? (
                  <span className="text-xs text-muted-foreground">{t('restricted')}</span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {onOpenDocuments && summary.documents.length > 0 ? (
        <Button variant="ghost" size="sm" className="self-start" onClick={onOpenDocuments}>
          {t('seeAll')}
        </Button>
      ) : null}
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
            <li
              key={approval.id}
              className="flex flex-col gap-1 rounded-control border border-border p-3 text-sm"
            >
              <span className="font-medium">{approval.title}</span>
              {approval.isMine ? (
                <StatusChip tone="approval" className="self-start">
                  {t('mine')}
                </StatusChip>
              ) : null}
              <span className="text-xs text-muted-foreground">
                {t('approver', { name: approval.approverLabel })} ·{' '}
                {t('requestedAt', { date: formatDate(approval.requestedAt, timeZone) })}
                {approval.dueAt
                  ? ` · ${t('dueAt', { date: formatDate(approval.dueAt, timeZone) })}`
                  : ''}
              </span>
              {approval.isOverdue ? (
                <StatusChip tone="danger" className="self-start">
                  {t('overdue')}
                </StatusChip>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * `SituationalPanel` (SCR-006 · DEC-180 · RN-PROC-48 · repaginação prd-4): a visão geral com as
 * 7 perguntas, cada uma numa seção com `h2`. No centro, o que fazer agora (próximo passo, o que
 * falta, documentos e aprovações); no resumo lateral, onde está, responsável, prazos e o que vier
 * em `aside` (dados do processo). Abaixo de 1024 px o resumo lateral desce para depois do centro.
 */
export function SituationalPanel({
  summary,
  processId,
  timeZone,
  aside,
  onOpenDocuments,
}: {
  readonly summary: ProcessSummaryDto;
  readonly processId: string;
  readonly timeZone: string;
  readonly aside?: ReactNode;
  /** "Ver todos os documentos": leva à aba Documentos. */
  readonly onOpenDocuments?: (() => void) | undefined;
}) {
  const t = useTranslations('processes.panel');
  return (
    <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="flex min-w-0 flex-col gap-6">
        <NextStepCard summary={summary} />
        <PendingCard summary={summary} processId={processId} />
        <DocumentsCard summary={summary} processId={processId} onOpenDocuments={onOpenDocuments} />
        <ApprovalsCard summary={summary} timeZone={timeZone} />
      </div>
      <aside aria-label={t('asideLabel')} className="flex min-w-0 flex-col gap-4">
        <WhereCard summary={summary} timeZone={timeZone} />
        <ResponsibleCard summary={summary} timeZone={timeZone} />
        <DeadlinesCard summary={summary} timeZone={timeZone} />
        {aside}
      </aside>
    </div>
  );
}
