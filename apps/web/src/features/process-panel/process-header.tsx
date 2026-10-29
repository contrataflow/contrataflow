'use client';

import { Avatar, DetailPage } from '@contrataflow/ui';
import type { DetailFact } from '@contrataflow/ui';
import type { ProcessSummaryDto } from '@contrataflow/validation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

import { HOME_PATH } from '@/lib/routes';

import { EstimatedValueBadge } from './estimated-value-badge';
import {
  ConfidentialBadge,
  DueDateBadge,
  PriorityBadge,
} from '../process-list/process-list-badges';
import { ProcessStatusBadge } from '../processes/process-status-badge';
import { TagChip } from '../tags/tag-chip';

/** Chips de situação: recebem o foco depois de uma ação que muda o processo (US-047). */
export const PROCESS_STATUS_HEADER_ID = 'process-status-header';

/** Quem está com o processo: pessoa com avatar, aprovador designado ou a fila da unidade. */
function Responsible({ summary }: { readonly summary: ProcessSummaryDto }) {
  const t = useTranslations('processes.panel.header');
  const { responsible } = summary;
  if (responsible.approver !== null) {
    return (
      <>
        <Avatar name={responsible.approver.label} size="sm" />
        <span className="min-w-0 break-words">
          {t('approver', { name: responsible.approver.label })}
        </span>
      </>
    );
  }
  if (responsible.user !== null) {
    return (
      <>
        <Avatar name={responsible.user.name} size="sm" />
        <span className="min-w-0 break-words">{responsible.user.name}</span>
      </>
    );
  }
  return (
    <span className="text-muted-foreground">
      {responsible.queueDepartment === null
        ? t('noResponsible')
        : t('queue', { department: responsible.queueDepartment.name })}
    </span>
  );
}

export interface ProcessDetailPageProps {
  readonly summary: ProcessSummaryDto;
  /** Ação primária + "Mais" (`ProcessActionBar`). */
  readonly actions?: ReactNode;
  /** Botão "Etiquetas" (US-007), ao lado das etiquetas aplicadas. */
  readonly tagsAction?: ReactNode;
  /** Barra de etapas (`StageStepper`). */
  readonly progress?: ReactNode;
  readonly notices?: ReactNode;
  readonly tabs?: ReactNode;
  readonly children?: ReactNode;
}

/**
 * Página do processo no modelo `DetailPage` (SCR-006 · RN-PROC-54 · prd-5 · prancheta `Processo`):
 * faixa de cabeçalho com a trilha (Painel › Processos › número ou "Rascunho (sem número)"), o
 * título 28/800 com o foco ao carregar, os chips de situação, prioridade e "Orçamento sigiloso",
 * a linha de identificação (número · unidade · órgão fora do principal) e a ação primária + "Mais".
 * Abaixo, num cartão só, a barra de etapas e os fatos-chave em linha — etapa com o prazo colorido,
 * responsável com avatar, valor estimado com a origem ("Sigiloso" quando mascarado — POL-09) e as
 * etiquetas —; depois os avisos, as abas e o conteúdo da aba.
 */
export function ProcessDetailPage({
  summary,
  actions,
  tagsAction,
  progress,
  notices,
  tabs,
  children,
}: ProcessDetailPageProps) {
  const t = useTranslations('processes.panel');
  const tShell = useTranslations('shell');
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    titleRef.current?.focus();
  }, []);
  const { header, where, deadline } = summary;
  const code = header.code ?? t('noNumber');

  const facts: DetailFact[] = [
    {
      id: 'etapa',
      label: t('header.stage'),
      value: (
        <>
          <span className="min-w-0 break-words">{where.stage?.name ?? t('header.noStage')}</span>
          {deadline === null ? null : <DueDateBadge deadline={deadline} />}
        </>
      ),
    },
    { id: 'responsavel', label: t('header.responsible'), value: <Responsible summary={summary} /> },
    {
      id: 'valor',
      label: t('header.estimatedValue'),
      value: (
        <EstimatedValueBadge
          value={header.estimatedValue}
          masked={header.estimatedValueMasked}
          source={header.estimatedValueSource}
        />
      ),
    },
  ];
  if (header.tags.length > 0 || tagsAction) {
    facts.push({
      id: 'etiquetas',
      label: t('header.tags'),
      value: (
        <>
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
        </>
      ),
    });
  }

  return (
    <DetailPage
      linkComponent={Link}
      breadcrumbLabel={tShell('pageHeader.breadcrumb')}
      breadcrumbs={[
        { label: tShell('nav.dashboard'), href: HOME_PATH },
        { label: t('backToList'), href: '/processos' },
        { label: code },
      ]}
      title={header.title}
      titleRef={titleRef}
      status={
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
        </div>
      }
      subtitle={[
        code,
        where.department.name,
        header.showOrganization
          ? t('header.organization', { name: header.organization.shortName })
          : null,
      ]
        .filter(Boolean)
        .join(' · ')}
      actions={actions}
      progress={progress}
      facts={facts}
      notices={notices}
      tabs={tabs}
    >
      {children}
    </DetailPage>
  );
}
