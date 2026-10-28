'use client';

import { isAuditAction } from '@contrataflow/types';
import type { AuditResult } from '@contrataflow/types';
import { Button } from '@contrataflow/ui';
import type { AuditLogDto } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';

import { Icon } from '@/components/shell/icons';
import type { IconName } from '@/components/shell/icons';
import { formatDateTime } from '@/lib/i18n/format';

const RESULT_TONES: Readonly<
  Record<AuditResult, { readonly icon: IconName; readonly classes: string }>
> = {
  SUCCESS: { icon: 'check', classes: 'bg-success-soft text-foreground' },
  DENIED: { icon: 'alert', classes: 'bg-warning-soft text-foreground' },
  FAILURE: { icon: 'alert', classes: 'bg-destructive-soft text-foreground' },
};

/** Resultado com ícone E texto — a cor nunca é a única informação (SCR-037). */
export function AuditResultBadge({ result }: { readonly result: AuditResult }) {
  const t = useTranslations('audit.results');
  const tone = RESULT_TONES[result];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-control px-2 py-0.5 text-xs font-medium whitespace-nowrap ${tone.classes}`}
    >
      <Icon name={tone.icon} className="size-3.5" />
      {t(result)}
    </span>
  );
}

/** Rótulo pt-BR da ação (catálogo de events.md §7); ação desconhecida mostra o código. */
export function useActionLabel(): (action: string) => string {
  const t = useTranslations('audit.actions');
  return (action) => (isAuditAction(action) ? t(action) : action);
}

export interface AuditResultsTableProps {
  readonly records: readonly AuditLogDto[];
  readonly timeZone: string;
  readonly onOpen: (record: AuditLogDto) => void;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly onLoadMore: () => void;
  readonly busy: boolean;
}

/**
 * `AuditResultsTable` (SCR-037 · AUD-01): data/hora no fuso da instituição, ator, ação (rótulo
 * pt-BR), categoria, resultado e entidade/processo; abrir uma linha mostra o detalhe (AUD-02).
 * Paginação por cursor com "Carregar mais". Abaixo de 768 px ficam data, ação e resultado; a
 * tabela rola na horizontal se precisar.
 */
export function AuditResultsTable({
  records,
  timeZone,
  onOpen,
  hasMore,
  loadingMore,
  onLoadMore,
  busy,
}: AuditResultsTableProps) {
  const t = useTranslations('audit.records.table');
  const tCategories = useTranslations('audit.categories');
  const actionLabel = useActionLabel();

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="text-sm text-muted-foreground" aria-live="polite">
        {t('count', { count: records.length })}
      </p>
      <div
        aria-busy={busy}
        className="relative overflow-x-auto rounded-card border border-border bg-surface shadow-card"
      >
        <table className="w-full text-left text-sm">
          <caption className="sr-only">{t('caption')}</caption>
          <thead className="bg-muted text-xs text-muted-foreground uppercase">
            <tr>
              <th scope="col" className="px-3 py-2">
                {t('occurredAt')}
              </th>
              <th scope="col" className="hidden px-3 py-2 md:table-cell">
                {t('actor')}
              </th>
              <th scope="col" className="px-3 py-2">
                {t('action')}
              </th>
              <th scope="col" className="hidden px-3 py-2 md:table-cell">
                {t('category')}
              </th>
              <th scope="col" className="px-3 py-2">
                {t('result')}
              </th>
              <th scope="col" className="hidden px-3 py-2 lg:table-cell">
                {t('target')}
              </th>
            </tr>
          </thead>
          <tbody>
            {records.map((record) => {
              const date = formatDateTime(record.occurredAt, timeZone);
              const action = actionLabel(record.action);
              return (
                <tr
                  key={record.id}
                  className="border-t border-border align-middle hover:bg-muted/50"
                >
                  <th scope="row" className="px-3 py-2 font-normal whitespace-nowrap">
                    <button
                      type="button"
                      className="text-left font-medium text-primary underline-offset-2 hover:underline"
                      aria-label={t('open', { action, date })}
                      onClick={() => {
                        onOpen(record);
                      }}
                    >
                      <time dateTime={record.occurredAt}>{date}</time>
                    </button>
                  </th>
                  <td className="hidden px-3 py-2 md:table-cell">
                    {record.actorName ?? (record.actorType === 'SYSTEM' ? t('system') : '—')}
                  </td>
                  <td className="px-3 py-2">{action}</td>
                  <td className="hidden px-3 py-2 md:table-cell">{tCategories(record.category)}</td>
                  <td className="px-3 py-2">
                    <AuditResultBadge result={record.result} />
                  </td>
                  <td className="hidden px-3 py-2 font-mono text-xs break-all lg:table-cell">
                    {record.entityType === null ? (
                      record.processId === null ? (
                        '—'
                      ) : (
                        `${t('process')} ${record.processId}`
                      )
                    ) : (
                      <>
                        <span className="font-sans text-sm">{record.entityType}</span>
                        {record.entityId === null ? null : ` ${record.entityId}`}
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {loadingMore ? (
        <p role="status" className="text-center text-sm text-muted-foreground">
          {t('loadingMore')}
        </p>
      ) : hasMore ? (
        <Button variant="secondary" className="self-center" onClick={onLoadMore}>
          {t('loadMore')}
        </Button>
      ) : null}
    </div>
  );
}
