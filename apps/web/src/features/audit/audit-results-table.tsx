'use client';

import { isAuditAction } from '@contrataflow/types';
import type { AuditResult } from '@contrataflow/types';
import {
  Button,
  CircleAlert,
  CircleCheck,
  CircleX,
  StatusChip,
  Table,
  TableBody,
  TableContainer,
  TableFooter,
  TableHead,
  Td,
  Th,
  Tr,
} from '@contrataflow/ui';
import type { StatusTone } from '@contrataflow/ui';
import type { AuditLogDto } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

import { formatDateTime } from '@/lib/i18n/format';

const RESULT_TONES: Readonly<
  Record<AuditResult, { readonly icon: ReactNode; readonly tone: StatusTone }>
> = {
  SUCCESS: { icon: <CircleCheck aria-hidden="true" />, tone: 'success' },
  DENIED: { icon: <CircleAlert aria-hidden="true" />, tone: 'warning' },
  FAILURE: { icon: <CircleX aria-hidden="true" />, tone: 'danger' },
};

/** Resultado com ícone E texto — a cor nunca é a única informação (SCR-037). */
export function AuditResultBadge({ result }: { readonly result: AuditResult }) {
  const t = useTranslations('audit.results');
  const tone = RESULT_TONES[result];
  return (
    <StatusChip tone={tone.tone} icon={tone.icon}>
      {t(result)}
    </StatusChip>
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
  /** Período pesquisado, no rodapé (ex.: "10/10/2026 a 17/10/2026"). */
  readonly period?: string | null | undefined;
}

/**
 * `AuditResultsTable` (SCR-037 · AUD-01 · prd-5): data/hora no fuso da instituição, ator, ação
 * (rótulo pt-BR), categoria, resultado e entidade/processo; abrir uma linha mostra o detalhe
 * (AUD-02). Rodapé com a contagem, o período e "Carregar mais" (cursor). Abaixo de 768 px ficam
 * data, ação e resultado; a caixa do kit rola na horizontal se ainda precisar.
 */
export function AuditResultsTable({
  records,
  timeZone,
  onOpen,
  hasMore,
  loadingMore,
  onLoadMore,
  busy,
  period,
}: AuditResultsTableProps) {
  const t = useTranslations('audit.records.table');
  const tCategories = useTranslations('audit.categories');
  const actionLabel = useActionLabel();

  return (
    <TableContainer
      label={t('caption')}
      aria-busy={busy}
      footer={
        <TableFooter
          summary={
            <span aria-live="polite">
              <span>{t('count', { count: records.length })}</span>
              {period ? <span> · {period}</span> : null}
            </span>
          }
        >
          {loadingMore ? (
            <span role="status">{t('loadingMore')}</span>
          ) : hasMore ? (
            <Button variant="secondary" size="sm" onClick={onLoadMore}>
              {t('loadMore')}
            </Button>
          ) : null}
        </TableFooter>
      }
    >
      <Table>
        <caption className="sr-only">{t('caption')}</caption>
        <TableHead>
          <Tr>
            <Th>{t('occurredAt')}</Th>
            <Th className="hidden md:table-cell">{t('actor')}</Th>
            <Th>{t('action')}</Th>
            <Th className="hidden md:table-cell">{t('category')}</Th>
            <Th>{t('result')}</Th>
            <Th className="hidden lg:table-cell">{t('target')}</Th>
          </Tr>
        </TableHead>
        <TableBody>
          {records.map((record) => {
            const date = formatDateTime(record.occurredAt, timeZone);
            const action = actionLabel(record.action);
            return (
              <Tr key={record.id}>
                <th scope="row" className="px-3.5 py-3 text-left font-normal whitespace-nowrap">
                  <button
                    type="button"
                    className="text-left font-semibold text-primary-soft-foreground underline-offset-2 hover:underline"
                    aria-label={t('open', { action, date })}
                    onClick={() => {
                      onOpen(record);
                    }}
                  >
                    <time dateTime={record.occurredAt}>{date}</time>
                  </button>
                </th>
                <Td className="hidden md:table-cell">
                  {record.actorName ?? (record.actorType === 'SYSTEM' ? t('system') : '—')}
                </Td>
                <Td className="font-semibold">{action}</Td>
                <Td className="hidden text-muted-foreground md:table-cell">
                  {tCategories(record.category)}
                </Td>
                <Td>
                  <AuditResultBadge result={record.result} />
                </Td>
                <Td className="hidden font-mono text-xs break-all lg:table-cell">
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
                </Td>
              </Tr>
            );
          })}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
