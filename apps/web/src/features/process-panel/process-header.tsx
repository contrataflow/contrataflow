'use client';

import { Avatar } from '@contrataflow/ui';
import type { ProcessSummaryDto } from '@contrataflow/validation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

import { EstimatedValueBadge } from './estimated-value-badge';
import {
  ConfidentialBadge,
  DueDateBadge,
  PriorityBadge,
} from '../process-list/process-list-badges';
import { ProcessStatusBadge } from '../processes/process-status-badge';
import { TagChip } from '../tags/tag-chip';

/** Linha de status do cabeçalho: recebe o foco depois de uma ação que muda o processo (US-047). */
export const PROCESS_STATUS_HEADER_ID = 'process-status-header';

const FACT_LABEL = 'text-label font-semibold text-muted-foreground uppercase';

/** Um fato do cabeçalho (etapa, responsável, valor): rótulo 12/600 caixa alta e o valor. */
function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className={FACT_LABEL}>{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-2 text-sm font-medium">{children}</dd>
    </div>
  );
}

/** Quem está com o processo: pessoa com avatar, aprovador designado ou a fila da unidade. */
function ResponsibleFact({ summary }: { readonly summary: ProcessSummaryDto }) {
  const t = useTranslations('processes.panel.header');
  const { responsible } = summary;
  if (responsible.approver !== null) {
    return (
      <Fact label={t('responsible')}>
        <Avatar name={responsible.approver.label} size="sm" />
        <span className="min-w-0 break-words">
          {t('approver', { name: responsible.approver.label })}
        </span>
      </Fact>
    );
  }
  if (responsible.user !== null) {
    return (
      <Fact label={t('responsible')}>
        <Avatar name={responsible.user.name} size="sm" />
        <span className="min-w-0 break-words">{responsible.user.name}</span>
      </Fact>
    );
  }
  return (
    <Fact label={t('responsible')}>
      <span className="text-muted-foreground">
        {responsible.queueDepartment === null
          ? t('noResponsible')
          : t('queue', { department: responsible.queueDepartment.name })}
      </span>
    </Fact>
  );
}

/**
 * `ProcessHeader` (SCR-006 · RN-PROC-54 · repaginação prd-4): trilha (Painel / Processos / número
 * ou "Rascunho (sem número)"), título 28/800 com o foco ao carregar, chips de situação, prioridade
 * e "Orçamento sigiloso", órgão (fora do principal) e a ação primária à direita (`actions`). Abaixo,
 * a faixa de fatos — etapa atual com o prazo colorido, responsável com avatar e valor estimado com
 * a origem ("Sigiloso" quando mascarado — POL-09) —, as etiquetas (US-007) e as ações secundárias
 * (`toolbar`).
 */
export function ProcessHeader({
  summary,
  actions,
  tagsAction,
  toolbar,
}: {
  readonly summary: ProcessSummaryDto;
  readonly actions?: ReactNode;
  readonly tagsAction?: ReactNode;
  readonly toolbar?: ReactNode;
}) {
  const t = useTranslations('processes.panel');
  const tShell = useTranslations('shell');
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    titleRef.current?.focus();
  }, []);
  const { header, where, deadline } = summary;

  return (
    <header className="flex min-w-0 flex-col gap-4">
      <nav aria-label={tShell('pageHeader.breadcrumb')}>
        <ol className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
          <li className="flex items-center gap-1.5">
            <Link href="/painel" className="rounded-sm hover:text-primary-hover hover:underline">
              {tShell('nav.dashboard')}
            </Link>
            <span aria-hidden="true">/</span>
          </li>
          <li className="flex items-center gap-1.5">
            <Link href="/processos" className="rounded-sm hover:text-primary-hover hover:underline">
              {t('backToList')}
            </Link>
            <span aria-hidden="true">/</span>
          </li>
          <li>
            <span aria-current="page" className="font-semibold text-brand-ink tabular-nums">
              {header.code ?? t('noNumber')}
            </span>
          </li>
        </ol>
      </nav>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 basis-80 flex-col gap-2.5">
          <h1
            ref={titleRef}
            tabIndex={-1}
            className="text-page-title break-words text-brand-ink outline-none"
          >
            {header.title}
          </h1>
          <div
            id={PROCESS_STATUS_HEADER_ID}
            role="group"
            aria-label={t('header.statusLabel')}
            tabIndex={-1}
            className="flex flex-wrap items-center gap-2 rounded-control outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
          >
            <ProcessStatusBadge status={header.status} />
            <PriorityBadge priority={header.priority} />
            {header.isBudgetConfidential ? <ConfidentialBadge /> : null}
            {header.showOrganization ? (
              <span className="text-xs text-muted-foreground">
                {t('header.organization', { name: header.organization.shortName })}
              </span>
            ) : null}
          </div>
        </div>
        {actions}
      </div>
      <dl className="grid gap-4 rounded-card border border-border bg-surface p-4 shadow-card sm:grid-cols-2 lg:grid-cols-3">
        <Fact label={t('header.stage')}>
          <span className="min-w-0 break-words">{where.stage?.name ?? t('header.noStage')}</span>
          {deadline === null ? null : <DueDateBadge deadline={deadline} />}
        </Fact>
        <ResponsibleFact summary={summary} />
        <Fact label={t('header.estimatedValue')}>
          <EstimatedValueBadge
            value={header.estimatedValue}
            masked={header.estimatedValueMasked}
            source={header.estimatedValueSource}
          />
        </Fact>
      </dl>
      {header.tags.length > 0 || tagsAction || toolbar ? (
        <div className="flex flex-wrap items-start gap-2">
          {header.tags.length > 0 ? (
            <ul aria-label={t('header.tags')} className="flex flex-wrap items-center gap-1">
              {header.tags.slice(0, 10).map((tag) => (
                <li key={tag.id}>
                  <TagChip name={tag.name} color={tag.color} isActive={tag.isActive} />
                </li>
              ))}
            </ul>
          ) : null}
          {tagsAction}
          {toolbar}
        </div>
      ) : null}
    </header>
  );
}
