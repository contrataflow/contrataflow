'use client';

import { localDateOf } from '@contrataflow/types';
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Skeleton,
  buttonClassName,
  cx,
  toast,
} from '@contrataflow/ui';
import { PRICE_RESEARCH_MESSAGES, referenceDateIssue } from '@contrataflow/validation';
import type { PriceItemDto, PriceResearchDto } from '@contrataflow/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { formatCivilDate, formatMoney } from '@/lib/i18n/format';
import { useShellSession } from '@/lib/session/session-context';

import { ParametersPanel } from './parameters-panel';
import { PriceItemsTable } from './price-items-table';
import { addItemsPayload, missingProcessItems } from './price-research-model';
import {
  addPriceItems,
  deletePriceItem,
  priceResearchKeys,
  updatePriceResearch,
  usePriceItems,
  usePriceResearch,
} from './price-research.api';
import type { PriceResearchResult } from './price-research.api';
import { PriceSourcesPanel } from './price-sources-panel';
import { DocumentStatusBadge, PendingApprovalBadge } from '../documents/document-status-badge';
import { useProcessItems } from '../process-items/process-items.api';
import { useInvalidateProcess } from '../process-panel/process-panel.api';
import { FormField, INPUT_CLASS } from '../processes/form-field';
import { fetchProcess, processKeys } from '../processes/processes.api';

interface Notice {
  readonly tone: 'warning' | 'error' | 'info';
  readonly text: string;
}

const TABS = ['items', 'sources', 'document'] as const;
type Tab = (typeof TABS)[number];

/**
 * SCR-009 — Pesquisa de preços (`/processos/[id]/pesquisa-precos/[researchId]`, US-024): cabeçalho
 * com a data-base editável, painel "Parâmetros" (snapshot) e as abas Itens, Fontes e Documento.
 * As ações vêm de `meta.allowedActions` (a UI nunca recalcula a regra); sem elas, a tela é somente
 * leitura com o motivo em `meta.lockReason`. A aba Fontes (fontes, grade de preços e anexos) é da
 * US-026.
 */
export function PriceResearchView({
  processId,
  researchId,
}: {
  readonly processId: string;
  readonly researchId: string;
}) {
  const t = useTranslations('priceResearch.page');
  const research = usePriceResearch(researchId);
  const items = usePriceItems(researchId);

  if (research.data === undefined) {
    if (research.isPending) {
      return (
        <div role="status" className="mx-auto flex w-full max-w-6xl flex-col gap-3">
          <span className="sr-only">{t('loading')}</span>
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      );
    }
    const error = research.error;
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-3">
        <Link href={`/processos/${processId}`} className="text-sm text-primary underline">
          {t('backToProcess')}
        </Link>
        <Alert
          tone="error"
          title={isApiError(error) && error.status === 404 ? t('notFound') : t('loadError')}
        >
          {isApiError(error) && error.status === 404 ? null : (
            <Button
              size="sm"
              variant="secondary"
              className="mt-2"
              onClick={() => {
                void research.refetch();
              }}
            >
              {t('retry')}
            </Button>
          )}
        </Alert>
      </div>
    );
  }
  return (
    <LoadedView
      processId={processId}
      result={research.data}
      items={items.data}
      itemsStatus={items.isPending ? 'pending' : items.isError ? 'error' : 'ready'}
      onRetryItems={() => {
        void items.refetch();
      }}
    />
  );
}

function LoadedView({
  processId,
  result,
  items,
  itemsStatus,
  onRetryItems,
}: {
  readonly processId: string;
  readonly result: PriceResearchResult;
  readonly items: readonly PriceItemDto[] | undefined;
  readonly itemsStatus: 'pending' | 'error' | 'ready';
  readonly onRetryItems: () => void;
}) {
  const t = useTranslations('priceResearch.page');
  const tItems = useTranslations('priceResearch.items');
  const session = useShellSession();
  const tenantId = session.activeTenant.id;
  const timeZone = session.activeTenant.timezone;
  const queryClient = useQueryClient();
  const invalidateProcess = useInvalidateProcess(processId);
  const { research, meta } = result;
  const process = useQuery({
    queryKey: processKeys.detail(tenantId, processId),
    queryFn: ({ signal }) => fetchProcess(processId, signal),
    throwOnError: false,
  });
  const [notice, setNotice] = useState<Notice | null>(null);
  const [removing, setRemoving] = useState<PriceItemDto | null>(null);

  const canUpdate = meta.allowedActions.includes('UPDATE');
  const canAdd = meta.allowedActions.includes('ADD_ITEMS');
  const canRemove = meta.allowedActions.includes('REMOVE_ITEMS');
  // `EXCLUDE_QUOTATION` (US-027) é independente da edição: sem as ações de edição a tela segue em
  // leitura e `lockReason` explica o porquê.
  const readOnly = !canUpdate && !canAdd && !canRemove;

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: priceResearchKeys.detail(tenantId, research.id) }),
      invalidateProcess(),
    ]);
  };

  /** Recusas comuns das escritas: versão desatualizada (412) e documento não editável (409). */
  const handleWriteError = (error: unknown, fallback: string) => {
    if (isApiError(error) && error.status === 412) {
      setNotice({ tone: 'warning', text: PRICE_RESEARCH_MESSAGES.versionConflict });
    } else if (isApiError(error) && error.code === 'DOCUMENT_NOT_EDITABLE') {
      setNotice({ tone: 'error', text: PRICE_RESEARCH_MESSAGES.locked });
    } else if (isApiError(error) && error.status === 403) {
      setNotice({ tone: 'error', text: PRICE_RESEARCH_MESSAGES.permissionDenied });
    } else if (isApiError(error) && error.status === 422) {
      setNotice({ tone: 'error', text: error.errors[0]?.message ?? fallback });
    } else {
      setNotice({ tone: 'error', text: fallback });
      return;
    }
    // Estado desatualizado: recarrega a pesquisa e os itens.
    void refresh();
  };

  const remove = useMutation({
    mutationFn: (item: PriceItemDto) => deletePriceItem(item.id, item.version),
    onSuccess: async (_, item) => {
      setRemoving(null);
      setNotice(null);
      toast({ title: tItems('toast.removed', { number: item.sequence }), tone: 'success' });
      await refresh();
    },
    onError: (error: unknown) => {
      setRemoving(null);
      handleWriteError(error, tItems('errors.removeFailed'));
    },
  });

  const [tab, setTab] = useState<Tab>('items');
  const tabsId = useId();

  return (
    <div className="mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Link href={`/processos/${processId}`} className="text-sm text-primary underline">
          {t('backToProcess')}
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold">{research.code ?? t('title')}</h1>
          <DocumentStatusBadge status={research.status} />
          {research.pendingApprovalId === null ? null : <PendingApprovalBadge />}
          {research.confidentiality === 'RESTRICTED' ? (
            <span className="inline-flex items-center rounded-control border border-border px-2 py-0.5 text-xs font-medium">
              {t('confidential')}
            </span>
          ) : null}
        </div>
        <p className="text-base">{research.title}</p>
        {process.data === undefined ? null : (
          <p className="text-sm text-muted-foreground">
            {t('processLine', {
              code: process.data.code ?? t('draftCode'),
              title: process.data.title,
            })}
          </p>
        )}
      </div>
      {readOnly ? (
        <Alert tone="info" title={t('lock.title')}>
          <p>{t(`lock.${meta.lockReason ?? 'READ_ONLY'}`)}</p>
        </Alert>
      ) : null}
      {notice === null ? null : <Alert tone={notice.tone} title={notice.text} />}
      <Summary research={research} />
      <ReferenceDateEditor
        research={research}
        version={result.version}
        canUpdate={canUpdate}
        today={localDateOf(new Date(), timeZone)}
        processId={processId}
        onNotice={setNotice}
        onWriteError={handleWriteError}
      />
      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section aria-label={t('tabs.label')} className="flex min-w-0 flex-col gap-4">
          <Tabs id={tabsId} active={tab} onChange={setTab} />
          <div
            role="tabpanel"
            id={`${tabsId}-panel`}
            aria-labelledby={`${tabsId}-tab-${tab}`}
            className="min-w-0"
          >
            {tab === 'items' ? (
              <ItemsPanel
                processId={processId}
                research={research}
                items={items}
                status={itemsStatus}
                canAdd={canAdd}
                canRemove={canRemove}
                removing={remove.isPending}
                onRetry={onRetryItems}
                onRemove={setRemoving}
                onNotice={setNotice}
                onWriteError={handleWriteError}
                refresh={refresh}
              />
            ) : null}
            {tab === 'sources' ? (
              <PriceSourcesPanel
                processId={processId}
                research={research}
                items={items}
                editable={canUpdate}
                allowedActions={meta.allowedActions}
              />
            ) : null}
            {tab === 'document' ? (
              <DocumentPanel processId={processId} research={research} />
            ) : null}
          </div>
        </section>
        <ParametersPanel
          parameters={research.parameters}
          createdAt={research.createdAt}
          timeZone={timeZone}
        />
      </div>
      <Dialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <DialogContent closeLabel={null}>
          <DialogTitle>
            {tItems('removeDialog.title', { number: removing?.sequence ?? 0 })}
          </DialogTitle>
          <DialogDescription>
            {removing === null
              ? null
              : removing.quotationsCount > 0
                ? tItems('removeDialog.withQuotations', {
                    number: removing.sequence,
                    count: removing.quotationsCount,
                  })
                : tItems('removeDialog.simple', { number: removing.sequence })}
          </DialogDescription>
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => {
                setRemoving(null);
              }}
            >
              {tItems('removeDialog.cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => {
                if (removing) remove.mutate(removing);
              }}
            >
              {tItems('removeDialog.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Summary({ research }: { readonly research: PriceResearchDto }) {
  const t = useTranslations('priceResearch.page.summary');
  const tItems = useTranslations('priceResearch.items');
  const total = research.totalEstimatedValueMasked ? (
    <span title={tItems('maskedHint')}>{tItems('masked')}</span>
  ) : research.totalEstimatedValue === null ? (
    <span className="text-muted-foreground">{t('notCalculated')}</span>
  ) : (
    formatMoney(research.totalEstimatedValue)
  );
  return (
    <dl
      aria-label={t('label')}
      className="grid grid-cols-1 gap-3 rounded-card border border-border bg-surface p-4 text-sm sm:grid-cols-3"
    >
      <div>
        <dt className="text-muted-foreground">{t('items')}</dt>
        <dd className="text-lg font-semibold">{research.itemsCount}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">{t('withAlerts')}</dt>
        <dd className="text-lg font-semibold">{research.itemsWithAlertsCount}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground">{t('total')}</dt>
        <dd className="text-lg font-semibold">{total}</dd>
      </div>
    </dl>
  );
}

/** Data-base (RN-PRICE-06 · FA-07): editável com `UPDATE`; senão, só o texto. */
function ReferenceDateEditor({
  research,
  version,
  canUpdate,
  today,
  processId,
  onNotice,
  onWriteError,
}: {
  readonly research: PriceResearchDto;
  readonly version: number;
  readonly canUpdate: boolean;
  readonly today: string;
  readonly processId: string;
  readonly onNotice: (notice: Notice | null) => void;
  readonly onWriteError: (error: unknown, fallback: string) => void;
}) {
  const t = useTranslations('priceResearch.page.referenceDate');
  const queryClient = useQueryClient();
  const tenantId = useShellSession().activeTenant.id;
  const invalidateProcess = useInvalidateProcess(processId);
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? research.referenceDate;
  const issue =
    value === ''
      ? PRICE_RESEARCH_MESSAGES.referenceDateRequired
      : (referenceDateIssue(value, today)?.message ?? null);
  const changed = value !== research.referenceDate;

  const save = useMutation({
    mutationFn: () => updatePriceResearch(research.id, { referenceDate: value }, version),
    onSuccess: async (saved) => {
      setDraft(null);
      onNotice(null);
      queryClient.setQueryData(priceResearchKeys.detail(tenantId, research.id), saved);
      toast({
        title: t('changed', { date: formatCivilDate(saved.research.referenceDate) }),
        tone: 'success',
      });
      // As validades e os alertas dos itens foram recalculados.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: priceResearchKeys.items(tenantId, research.id) }),
        invalidateProcess(),
      ]);
    },
    onError: (error: unknown) => {
      onWriteError(error, t('failed'));
    },
  });

  if (!canUpdate) {
    return (
      <p className="text-sm">
        <span className="text-muted-foreground">{t('label')}: </span>
        <span className="font-medium">{formatCivilDate(research.referenceDate)}</span>
      </p>
    );
  }
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (changed && issue === null && !save.isPending) save.mutate();
      }}
    >
      <FormField
        id="pr-page-reference-date"
        label={t('label')}
        hint={t('hint')}
        error={changed ? (issue ?? undefined) : undefined}
        className="w-56"
      >
        {(control) => (
          <input
            {...control}
            type="date"
            className={INPUT_CLASS}
            value={value}
            max={today}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
          />
        )}
      </FormField>
      <Button
        type="submit"
        variant="secondary"
        disabled={!changed || issue !== null || save.isPending}
      >
        {save.isPending ? t('saving') : t('save')}
      </Button>
    </form>
  );
}

function Tabs({
  id,
  active,
  onChange,
}: {
  readonly id: string;
  readonly active: Tab;
  readonly onChange: (tab: Tab) => void;
}) {
  const t = useTranslations('priceResearch.page.tabs');
  const refs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = TABS.indexOf(active);
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TABS.length - 1;
    else return;
    event.preventDefault();
    const tab = TABS[next] ?? 'items';
    onChange(tab);
    refs.current[tab]?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label={t('label')}
      className="flex gap-1 overflow-x-auto border-b border-border"
    >
      {TABS.map((tab) => (
        <button
          key={tab}
          ref={(element) => {
            refs.current[tab] = element;
          }}
          type="button"
          role="tab"
          id={`${id}-tab-${tab}`}
          aria-selected={active === tab}
          aria-controls={`${id}-panel`}
          onKeyDown={onKeyDown}
          tabIndex={active === tab ? 0 : -1}
          className={cx(
            'min-h-10 px-4 text-sm font-medium whitespace-nowrap',
            active === tab ? 'border-b-2 border-primary text-foreground' : 'text-muted-foreground',
          )}
          onClick={() => {
            onChange(tab);
          }}
        >
          {t(tab)}
        </button>
      ))}
    </div>
  );
}

function ItemsPanel({
  processId,
  research,
  items,
  status,
  canAdd,
  canRemove,
  removing,
  onRetry,
  onRemove,
  onNotice,
  onWriteError,
  refresh,
}: {
  readonly processId: string;
  readonly research: PriceResearchDto;
  readonly items: readonly PriceItemDto[] | undefined;
  readonly status: 'pending' | 'error' | 'ready';
  readonly canAdd: boolean;
  readonly canRemove: boolean;
  readonly removing: boolean;
  readonly onRetry: () => void;
  readonly onRemove: (item: PriceItemDto) => void;
  readonly onNotice: (notice: Notice | null) => void;
  readonly onWriteError: (error: unknown, fallback: string) => void;
  readonly refresh: () => Promise<void>;
}) {
  const t = useTranslations('priceResearch.items');
  if (items === undefined) {
    if (status === 'pending') {
      return (
        <div role="status" className="flex flex-col gap-2">
          <span className="sr-only">{t('caption')}</span>
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      );
    }
    return (
      <Alert tone="error" title={t('errors.load')}>
        <Button size="sm" variant="secondary" className="mt-2" onClick={onRetry}>
          {t('retry')}
        </Button>
      </Alert>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <MissingItemsBanner
        processId={processId}
        researchId={research.id}
        items={items}
        canAdd={canAdd}
        onNotice={onNotice}
        onWriteError={onWriteError}
        refresh={refresh}
      />
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">{t('count', { count: items.length })}</p>
          <PriceItemsTable
            items={items}
            unitPriceDecimals={research.parameters.unitPriceDecimals}
            canRemove={canRemove}
            removing={removing}
            onRemove={onRemove}
          />
        </>
      )}
    </div>
  );
}

/** `MissingItemsBanner` (FA-04): itens do processo que ainda não estão na pesquisa. */
function MissingItemsBanner({
  processId,
  researchId,
  items,
  canAdd,
  onNotice,
  onWriteError,
  refresh,
}: {
  readonly processId: string;
  readonly researchId: string;
  readonly items: readonly PriceItemDto[];
  readonly canAdd: boolean;
  readonly onNotice: (notice: Notice | null) => void;
  readonly onWriteError: (error: unknown, fallback: string) => void;
  readonly refresh: () => Promise<void>;
}) {
  const t = useTranslations('priceResearch.items');
  const processItems = useProcessItems(processId);
  const missing = missingProcessItems(processItems.data?.items ?? [], items);
  const add = useMutation({
    mutationFn: () => addPriceItems(researchId, { items: addItemsPayload(missing) }),
    onSuccess: async (added) => {
      onNotice(null);
      toast({ title: t('toast.added', { count: added.length }), tone: 'success' });
      await refresh();
    },
    onError: (error: unknown) => {
      onWriteError(error, t('errors.addFailed'));
    },
  });
  if (missing.length === 0) return null;
  return (
    <Alert tone="info" title={t('missing.message', { count: missing.length })}>
      {canAdd ? (
        <Button
          size="sm"
          variant="secondary"
          className="mt-2"
          disabled={add.isPending}
          onClick={() => {
            add.mutate();
          }}
        >
          {add.isPending ? t('missing.adding') : t('missing.action')}
        </Button>
      ) : null}
    </Alert>
  );
}

/** Aba "Documento": abre o documento (seções, versões e ciclo de vida) no visualizador do documento. */
function DocumentPanel({
  processId,
  research,
}: {
  readonly processId: string;
  readonly research: PriceResearchDto;
}) {
  const t = useTranslations('priceResearch.document');
  return (
    <div className="flex flex-col items-start gap-3 rounded-card border border-border p-4">
      <h2 className="text-base font-semibold">{t('title')}</h2>
      <p className="text-sm text-muted-foreground">{t('description')}</p>
      <Link
        href={`/processos/${processId}/documentos/${research.documentId}`}
        className={buttonClassName({ variant: 'secondary' })}
      >
        {t('open')}
      </Link>
    </div>
  );
}
