'use client';

import {
  Alert,
  Button,
  Dialog,
  DialogDescription,
  DialogTitle,
  SheetContent,
  Skeleton,
} from '@contrataflow/ui';
import type { AuditLogDto } from '@contrataflow/validation';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect } from 'react';
import type { ReactNode } from 'react';

import { formatDateTime } from '@/lib/i18n/format';
import { useTenantId } from '@/lib/session/session-context';

import {
  changeValueText,
  classifyAuditError,
  coalescedRange,
  summarizedValue,
} from './audit-log-model';
import { AUDIT_LOGS_STALE_TIME_MS, auditLogKeys, fetchAuditLog } from './audit-logs.api';
import { AuditResultBadge, useActionLabel } from './audit-results-table';

/** Quick filters a partir do registro aberto (menos cliques até o que o auditor procura). */
export type AuditQuickFilter =
  | { readonly kind: 'actor'; readonly id: string; readonly name: string }
  | { readonly kind: 'process'; readonly id: string }
  | { readonly kind: 'entity'; readonly type: string; readonly id: string };

export interface AuditDetailPanelProps {
  /** Registro aberto (da lista); `null` = painel fechado. */
  readonly record: AuditLogDto | null;
  readonly timeZone: string;
  readonly onClose: () => void;
  /** 404 de AUD-02 (V-06): o painel fecha e a aba avisa. */
  readonly onNotFound: () => void;
  readonly onFilter: (filter: AuditQuickFilter) => void;
}

/** Valor do diff: vazio, resumido (hash + tamanho — nunca desmascarado) ou texto. */
function ChangeValue({ value }: { readonly value: unknown }) {
  const t = useTranslations('audit.records.detail');
  const summarized = summarizedValue(value);
  if (summarized) {
    return (
      <span className="text-muted-foreground italic">
        {t('summarized', { length: summarized.length, hash: summarized.hash.slice(0, 12) })}
      </span>
    );
  }
  const text = changeValueText(value);
  return text === null ? (
    <span className="text-muted-foreground italic">{t('empty')}</span>
  ) : (
    <span className="font-mono text-xs break-all whitespace-pre-wrap">{text}</span>
  );
}

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:gap-3">
      <dt className="shrink-0 text-xs font-medium text-muted-foreground sm:w-32">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  );
}

/**
 * `AuditDetailPanel` (SCR-037 · AUD-02 · RN-AUD-18): o registro completo num painel lateral — campos,
 * diff de `changes` em tabela com rótulos "Antes"/"Depois" (não só cor), `metadata` e o aviso de
 * registro coalescido (FA-05). O conteúdo vem já mascarado da API; nada é desmascarado aqui.
 */
export function AuditDetailPanel({
  record,
  timeZone,
  onClose,
  onNotFound,
  onFilter,
}: AuditDetailPanelProps) {
  const t = useTranslations('audit.records.detail');
  const tCategories = useTranslations('audit.categories');
  const tActorTypes = useTranslations('audit.actorTypes');
  const tErrors = useTranslations('audit.records.errors');
  const actionLabel = useActionLabel();
  const tenantId = useTenantId();
  const id = record?.id ?? null;

  const detail = useQuery({
    queryKey: auditLogKeys.detail(tenantId, id ?? '-'),
    queryFn: ({ signal }) => fetchAuditLog(id ?? '', signal),
    enabled: id !== null,
    staleTime: AUDIT_LOGS_STALE_TIME_MS,
    throwOnError: false,
    retry: false,
  });

  const failure = detail.error === null ? null : classifyAuditError(detail.error);
  useEffect(() => {
    if (failure?.kind === 'notFound') onNotFound();
  }, [failure?.kind, onNotFound]);

  const data = detail.data;
  const coalesced = data ? coalescedRange(data.metadata) : null;
  const metadataEntries = data ? Object.entries(data.metadata) : [];

  return (
    <Dialog
      open={record !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent closeLabel={t('close')} className="overflow-y-auto">
        <div className="flex flex-col gap-4 p-6 pr-12">
          <DialogTitle className="text-lg font-semibold">{t('title')}</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            {record
              ? `${actionLabel(record.action)} · ${formatDateTime(record.occurredAt, timeZone)}`
              : ''}
          </DialogDescription>

          {detail.isPending && id !== null ? (
            <div role="status" className="flex flex-col gap-2">
              <span className="sr-only">{t('loading')}</span>
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : null}

          {failure !== null && failure.kind !== 'notFound' ? (
            <Alert
              tone="error"
              title={
                failure.kind === 'unavailable'
                  ? tErrors('unavailable')
                  : failure.kind === 'forbidden'
                    ? tErrors('forbidden')
                    : failure.kind === 'mfa'
                      ? tErrors('mfa')
                      : tErrors('unexpected', { correlationId: '—' })
              }
            >
              {failure.kind === 'unavailable' && failure.correlationId ? (
                <p className="text-sm">
                  {tErrors('code', { correlationId: failure.correlationId })}
                </p>
              ) : null}
              <Button
                size="sm"
                variant="secondary"
                className="mt-2"
                onClick={() => {
                  void detail.refetch();
                }}
              >
                {tErrors('retry')}
              </Button>
            </Alert>
          ) : null}

          {data ? (
            <>
              {coalesced ? (
                <Alert
                  tone="info"
                  title={t('coalesced', {
                    first: formatDateTime(coalesced.first, timeZone),
                    last: formatDateTime(coalesced.last, timeZone),
                  })}
                />
              ) : null}
              <dl className="flex flex-col gap-2">
                <Field label={t('occurredAt')}>
                  <time dateTime={data.occurredAt}>
                    {formatDateTime(data.occurredAt, timeZone)}
                  </time>
                </Field>
                <Field label={t('action')}>
                  {actionLabel(data.action)}{' '}
                  <code className="text-xs text-muted-foreground">{data.action}</code>
                </Field>
                <Field label={t('category')}>{tCategories(data.category)}</Field>
                <Field label={t('result')}>
                  <AuditResultBadge result={data.result} />
                </Field>
                {data.reasonCode ? (
                  <Field label={t('reasonCode')}>
                    <code className="text-xs">{data.reasonCode}</code>
                  </Field>
                ) : null}
                <Field label={t('actor')}>
                  {data.actorName ?? '—'} ({tActorTypes(data.actorType)})
                </Field>
                {data.onBehalfOfUserId ? (
                  <Field label={t('onBehalfOf')}>
                    <code className="text-xs">{data.onBehalfOfUserId}</code>
                  </Field>
                ) : null}
                {data.entityType ? (
                  <Field label={t('entity')}>
                    {data.entityType}{' '}
                    {data.entityId ? (
                      <code className="text-xs break-all">{data.entityId}</code>
                    ) : null}
                  </Field>
                ) : null}
                {data.processId ? (
                  <Field label={t('process')}>
                    <code className="text-xs break-all">{data.processId}</code>
                  </Field>
                ) : null}
                {data.ip ? <Field label={t('ip')}>{data.ip}</Field> : null}
                {data.userAgent ? <Field label={t('userAgent')}>{data.userAgent}</Field> : null}
                {data.correlationId ? (
                  <Field label={t('correlationId')}>
                    <code className="text-xs break-all">{data.correlationId}</code>
                  </Field>
                ) : null}
                {data.requestId ? (
                  <Field label={t('requestId')}>
                    <code className="text-xs break-all">{data.requestId}</code>
                  </Field>
                ) : null}
                <Field label={t('rowHash')}>
                  <code className="text-xs break-all">{data.rowHash}</code>
                </Field>
              </dl>

              <div className="flex flex-wrap gap-2">
                {data.actorUserId ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      onFilter({
                        kind: 'actor',
                        id: data.actorUserId ?? '',
                        name: data.actorName ?? data.actorUserId ?? '',
                      });
                    }}
                  >
                    {t('filterActor')}
                  </Button>
                ) : null}
                {data.processId ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      onFilter({ kind: 'process', id: data.processId ?? '' });
                    }}
                  >
                    {t('filterProcess')}
                  </Button>
                ) : null}
                {data.entityType && data.entityId ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      onFilter({
                        kind: 'entity',
                        type: data.entityType ?? '',
                        id: data.entityId ?? '',
                      });
                    }}
                  >
                    {t('filterEntity')}
                  </Button>
                ) : null}
              </div>

              <section aria-labelledby="audit-detail-changes" className="flex flex-col gap-2">
                <h3 id="audit-detail-changes" className="text-base font-semibold">
                  {t('changes')}
                </h3>
                {data.changes === null || data.changes.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('noChanges')}</p>
                ) : (
                  <div className="overflow-x-auto rounded-card border border-border">
                    <table className="w-full text-left text-sm">
                      <caption className="sr-only">{t('changesCaption')}</caption>
                      <thead className="bg-muted text-xs text-muted-foreground uppercase">
                        <tr>
                          <th scope="col" className="px-3 py-2">
                            {t('field')}
                          </th>
                          <th scope="col" className="px-3 py-2">
                            {t('before')}
                          </th>
                          <th scope="col" className="px-3 py-2">
                            {t('after')}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.changes.map((change, index) => (
                          <tr
                            key={`${change.path}-${String(index)}`}
                            className="border-t border-border align-top"
                          >
                            <th
                              scope="row"
                              className="px-3 py-2 font-mono text-xs font-normal break-all"
                            >
                              {change.path}
                            </th>
                            <td className="px-3 py-2">
                              <ChangeValue value={change.old} />
                            </td>
                            <td className="px-3 py-2">
                              <ChangeValue value={change.new} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <section aria-labelledby="audit-detail-metadata" className="flex flex-col gap-2">
                <h3 id="audit-detail-metadata" className="text-base font-semibold">
                  {t('metadata')}
                </h3>
                {metadataEntries.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('noMetadata')}</p>
                ) : (
                  <dl className="flex flex-col gap-1">
                    {metadataEntries.map(([key, value]) => (
                      <Field key={key} label={key}>
                        <ChangeValue value={value} />
                      </Field>
                    ))}
                  </dl>
                )}
              </section>
            </>
          ) : null}
        </div>
      </SheetContent>
    </Dialog>
  );
}
