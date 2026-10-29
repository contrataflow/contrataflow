'use client';

import { Alert, Button, Checkbox, Skeleton } from '@contrataflow/ui';
import type { AuditSealDto } from '@contrataflow/validation';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { RefObject } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { formatDateTime } from '@/lib/i18n/format';
import { useTenantId } from '@/lib/session/session-context';

import {
  AUDIT_SEALS_STALE_TIME_MS,
  SEAL_PAGE_SIZE,
  auditKeys,
  fetchAuditSeals,
} from './audit-seals.api';
import { sealStatusOf } from './seal-model';
import type { VerificationIndex } from './seal-model';
import { SealStatusBadge } from './seal-status-badge';

export interface SealListProps {
  readonly timeZone: string;
  /** Selos marcados para preencher o intervalo da verificação (de qualquer página). */
  readonly selected: ReadonlyMap<string, AuditSealDto>;
  readonly onToggle: (seal: AuditSealDto) => void;
  readonly onClearSelection: () => void;
  /** Resultado da última verificação: define "Íntegro"/"Quebrado" dos selos cobertos. */
  readonly verification: VerificationIndex;
  /** Recebe o foco ao voltar à lista (404 da verificação). */
  readonly headingRef: RefObject<HTMLHeadingElement | null>;
}

/**
 * `SealList` (SCR-037 · aba "Selos" · AUD-04): período no fuso da instituição, quantidade de
 * registros e status ("Não verificado" até uma verificação cobrir o selo), com paginação por
 * página e seleção de selos para preencher o intervalo. Estados: skeleton, vazio, erro com
 * "Tentar novamente". A tabela rola na horizontal em telas estreitas.
 */
export function SealList({
  timeZone,
  selected,
  onToggle,
  onClearSelection,
  verification,
  headingRef,
}: SealListProps) {
  const t = useTranslations('audit.seals.list');
  const tenantId = useTenantId();
  const [page, setPage] = useState(1);

  const filters = { page, pageSize: SEAL_PAGE_SIZE };
  const seals = useQuery({
    queryKey: auditKeys.sealList(tenantId, filters),
    queryFn: ({ signal }) => fetchAuditSeals(filters, signal),
    staleTime: AUDIT_SEALS_STALE_TIME_MS,
    placeholderData: keepPreviousData,
    // Erros (403, 5xx) são tratados aqui, com "Tentar novamente".
    throwOnError: false,
  });

  const items = seals.data?.items ?? [];
  const totalPages = seals.data?.totalPages ?? 1;
  const periodOf = (seal: AuditSealDto) =>
    t('periodRange', {
      start: formatDateTime(seal.periodStart, timeZone),
      end: formatDateTime(seal.periodEnd, timeZone),
    });

  return (
    <section aria-labelledby="audit-seal-list-title" className="flex min-w-0 flex-col gap-3">
      <h2
        id="audit-seal-list-title"
        ref={headingRef}
        tabIndex={-1}
        className="text-lg font-semibold outline-none"
      >
        {t('title')}
      </h2>

      {seals.isPending ? (
        <div role="status" className="flex flex-col gap-2">
          <span className="sr-only">{t('loading')}</span>
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : null}

      {seals.isError ? (
        <Alert
          tone="error"
          title={
            isApiError(seals.error) && seals.error.status === 403 ? t('forbidden') : t('loadFailed')
          }
        >
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void seals.refetch();
            }}
          >
            {t('retry')}
          </Button>
        </Alert>
      ) : null}

      {seals.data && items.length === 0 ? (
        <div className="rounded-card border border-dashed border-border p-6 text-center">
          <p className="font-medium">{t('empty')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('emptyHint')}</p>
        </div>
      ) : null}

      {items.length > 0 ? (
        <>
          <div className="flex min-h-8 flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {selected.size > 0
                ? t('selectedCount', { count: selected.size })
                : t('selectionHint')}
            </p>
            {selected.size > 0 ? (
              <Button variant="ghost" size="sm" onClick={onClearSelection}>
                {t('clearSelection')}
              </Button>
            ) : null}
          </div>
          <div
            aria-busy={seals.isPlaceholderData}
            className="relative overflow-x-auto rounded-card border border-border bg-surface shadow-card"
          >
            <table className="w-full min-w-[34rem] text-left text-sm">
              <caption className="sr-only">{t('caption')}</caption>
              <thead className="bg-muted text-xs text-muted-foreground uppercase">
                <tr>
                  <th scope="col" className="w-10 px-3 py-2">
                    <span className="sr-only">{t('select')}</span>
                  </th>
                  <th scope="col" className="px-3 py-2">
                    {t('period')}
                  </th>
                  <th scope="col" className="px-3 py-2 text-right">
                    {t('records')}
                  </th>
                  <th scope="col" className="px-3 py-2">
                    {t('status')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((seal) => (
                  <tr key={seal.id} className="border-t border-border align-middle">
                    <td className="px-3 py-2">
                      <Checkbox
                        checked={selected.has(seal.id)}
                        aria-label={t('selectRow', { period: periodOf(seal) })}
                        onCheckedChange={() => {
                          onToggle(seal);
                        }}
                      />
                    </td>
                    <th scope="row" className="px-3 py-2 font-medium whitespace-nowrap">
                      <time dateTime={seal.periodStart}>
                        {formatDateTime(seal.periodStart, timeZone)}
                      </time>
                      {' – '}
                      <time dateTime={seal.periodEnd}>
                        {formatDateTime(seal.periodEnd, timeZone)}
                      </time>
                    </th>
                    <td className="px-3 py-2 text-right tabular-nums">{seal.recordCount}</td>
                    <td className="px-3 py-2">
                      <SealStatusBadge status={sealStatusOf(seal, verification)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {totalPages > 1 ? (
        <nav aria-label={t('pager')} className="flex items-center justify-between gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={page <= 1}
            onClick={() => {
              setPage(Math.max(1, page - 1));
            }}
          >
            {t('previous')}
          </Button>
          <span className="text-sm text-muted-foreground">
            {t('pageOf', { page, total: totalPages })}
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => {
              setPage(page + 1);
            }}
          >
            {t('next')}
          </Button>
        </nav>
      ) : null}
    </section>
  );
}
