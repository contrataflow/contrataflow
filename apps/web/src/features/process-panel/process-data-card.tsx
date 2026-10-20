'use client';

import { Skeleton } from '@contrataflow/ui';
import type { ProcessDto } from '@contrataflow/validation';
import type { UseQueryResult } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId } from 'react';

import { EstimatedValueBadge } from './estimated-value-badge';
import { PanelError } from '../process-actions/panel-error';

/** "Dados do processo" (PRC-04): objeto, catálogos, fluxo e valor estimado (mascarado — POL-09). */
export function ProcessDataCard({ query }: { readonly query: UseQueryResult<ProcessDto> }) {
  const t = useTranslations('processes.panel.data');
  const headingId = useId();
  const process = query.data;
  let body;
  if (process === undefined && query.isPending) {
    body = <Skeleton className="h-24 w-full" />;
  } else if (process === undefined) {
    body = (
      <PanelError
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  } else {
    const rows = [
      { label: t('object'), value: process.object },
      { label: t('contractingType'), value: process.contractingType.label },
      { label: t('modality'), value: process.modality?.label ?? t('undefinedModality') },
      { label: t('origin'), value: process.origin.label },
      {
        label: t('workflow'),
        value: t('workflowValue', {
          name: process.workflow.name,
          version: process.workflow.versionNumber,
        }),
      },
    ];
    body = (
      <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
        {rows.map((row) => (
          <div key={row.label} className="contents">
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="min-w-0 break-words">{row.value}</dd>
          </div>
        ))}
        <div className="contents">
          <dt className="text-muted-foreground">{t('estimatedValue')}</dt>
          <dd>
            {/* US-017: o valor propagado pela aprovação do DFD sai com a origem "DFD". */}
            <EstimatedValueBadge
              value={process.estimatedValue}
              masked={process.estimatedValueMasked}
              source={process.estimatedValueSource}
            />
          </dd>
        </div>
      </dl>
    );
  }
  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-3 rounded-card border border-border bg-surface p-4 shadow-card"
    >
      <h2 id={headingId} className="text-base font-semibold">
        {t('title')}
      </h2>
      {body}
    </section>
  );
}
