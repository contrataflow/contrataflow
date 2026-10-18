'use client';

import type { ProcessSummaryDto } from '@contrataflow/validation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

import {
  ConfidentialBadge,
  ConfidentialValue,
  PriorityBadge,
} from '../process-list/process-list-badges';
import { ProcessStatusBadge } from '../processes/process-status-badge';
import { TagChip } from '../tags/tag-chip';

/**
 * `ProcessHeader` (SCR-006 · RN-PROC-54): código (ou "Rascunho (sem número)"), título, status,
 * prioridade, etiquetas, "Orçamento sigiloso", órgão (fora do principal) e valor estimado com a
 * origem — "Sigiloso" quando mascarado (POL-09). O foco vai ao título ao carregar. As etiquetas
 * (US-007) aparecem como chips, com a inativa esmaecida, e `tagsAction` traz o botão "Etiquetas".
 */
export function ProcessHeader({
  header,
  tagsAction,
}: {
  readonly header: ProcessSummaryDto['header'];
  readonly tagsAction?: ReactNode;
}) {
  const t = useTranslations('processes.panel');
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  return (
    <header className="flex min-w-0 flex-col gap-2">
      <Link href="/processos" className="text-sm text-primary underline">
        {t('backToList')}
      </Link>
      <p className="text-sm font-medium text-muted-foreground">{header.code ?? t('noNumber')}</p>
      <h1
        ref={titleRef}
        tabIndex={-1}
        className="text-2xl font-semibold tracking-tight break-words outline-none"
      >
        {header.title}
      </h1>
      <div className="flex flex-wrap items-center gap-2">
        <ProcessStatusBadge status={header.status} />
        <PriorityBadge priority={header.priority} />
        {header.isBudgetConfidential ? <ConfidentialBadge /> : null}
        {header.showOrganization ? (
          <span className="text-xs text-muted-foreground">
            {t('header.organization', { name: header.organization.shortName })}
          </span>
        ) : null}
      </div>
      {header.tags.length > 0 || tagsAction ? (
        <div className="flex flex-wrap items-start gap-2">
          {header.tags.length > 0 ? (
            <ul aria-label={t('header.tags')} className="flex flex-wrap gap-1">
              {header.tags.slice(0, 10).map((tag) => (
                <li key={tag.id}>
                  <TagChip name={tag.name} color={tag.color} isActive={tag.isActive} />
                </li>
              ))}
            </ul>
          ) : null}
          {tagsAction}
        </div>
      ) : null}
      <p className="flex flex-wrap items-center gap-x-2 text-sm">
        <span className="text-muted-foreground">{t('header.estimatedValue')}:</span>
        <ConfidentialValue value={header.estimatedValue} masked={header.estimatedValueMasked} />
        {header.estimatedValueSource ? (
          <span className="text-xs text-muted-foreground">
            {t('header.valueSource', {
              source: t(`header.sources.${header.estimatedValueSource}`),
            })}
          </span>
        ) : null}
      </p>
    </header>
  );
}
