'use client';

import { Card, Skeleton } from '@contrataflow/ui';
import type { ProcessDto } from '@contrataflow/validation';
import type { UseQueryResult } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId } from 'react';
import type { ReactNode } from 'react';

import { formatCivilDate, formatDate } from '@/lib/i18n/format';

import { EstimatedValueBadge } from './estimated-value-badge';
import { PanelError } from '../process-actions/panel-error';

/** Situação no PCA em uma linha ("Previsto no PCA — exercício 2026, item 12"). */
function PcaValue({ process }: { readonly process: ProcessDto }) {
  const t = useTranslations('processes');
  if (process.pcaStatus === 'PLANNED') {
    return process.pcaItemCode
      ? t('review.pcaDetail.PLANNED_ITEM', {
          year: process.pcaYear ?? '—',
          item: process.pcaItemCode,
        })
      : t('review.pcaDetail.PLANNED', { year: process.pcaYear ?? '—' });
  }
  return t(`pcaStatuses.${process.pcaStatus}`);
}

/**
 * "Dados do processo" (PRC-04) no resumo lateral: secretaria e unidade requisitantes, objeto,
 * catálogos, PCA, fluxo, datas e valor estimado (mascarado — POL-09). `children` vem ao pé do
 * cartão (o "Orçamento sigiloso" da US-013).
 */
export function ProcessDataCard({
  query,
  timeZone,
  children,
}: {
  readonly query: UseQueryResult<ProcessDto>;
  readonly timeZone: string;
  readonly children?: ReactNode;
}) {
  const t = useTranslations('processes.panel.data');
  const id = useId();
  const process = query.data;
  let body;
  if (process === undefined && query.isPending) {
    body = <Skeleton className="h-40 w-full" />;
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
    const rows: { readonly label: string; readonly value: ReactNode }[] = [
      { label: t('secretariat'), value: process.requestingSecretariat.name },
      { label: t('department'), value: process.requestingDepartment.name },
      { label: t('object'), value: process.object },
      { label: t('contractingType'), value: process.contractingType.label },
      { label: t('modality'), value: process.modality?.label ?? t('undefinedModality') },
      { label: t('origin'), value: process.origin.label },
      { label: t('pca'), value: <PcaValue process={process} /> },
      {
        label: t('workflow'),
        value: t('workflowValue', {
          name: process.workflow.name,
          version: process.workflow.versionNumber,
        }),
      },
      {
        label: t('openedAt'),
        value: formatDate(process.openedAt ?? process.createdAt, timeZone),
      },
      {
        label: t('targetDate'),
        value: process.targetDate === null ? t('noTarget') : formatCivilDate(process.targetDate),
      },
      {
        label: t('estimatedValue'),
        // US-017: o valor propagado pela aprovação do DFD sai com a origem "DFD".
        value: (
          <EstimatedValueBadge
            value={process.estimatedValue}
            masked={process.estimatedValueMasked}
            source={process.estimatedValueSource}
          />
        ),
      },
    ];
    body = (
      <dl className="flex flex-col gap-3 text-sm">
        {rows.map((row) => (
          <div key={row.label} className="flex min-w-0 flex-col gap-0.5">
            <dt className="text-label font-semibold text-muted-foreground uppercase">
              {row.label}
            </dt>
            <dd className="min-w-0 break-words">{row.value}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <Card id={id} title={t('title')} className="min-w-0 gap-3">
      {body}
      {children ? <div className="border-t border-border pt-3">{children}</div> : null}
    </Card>
  );
}
