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
  toast,
} from '@contrataflow/ui';
import { PRICE_RESEARCH_MESSAGES, PRICE_SOURCE_MESSAGES } from '@contrataflow/validation';
import type { PriceItemDto, PriceResearchDto, PriceSourceDto } from '@contrataflow/validation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { formatCivilDate, formatDateTime } from '@/lib/i18n/format';
import { useShellSession } from '@/lib/session/session-context';

import { ImportQuotationsDialog } from './import-quotations-dialog';
import { priceResearchKeys } from './price-research.api';
import { PriceSourceFormDialog } from './price-source-form-dialog';
import { optionOfSource, sourceTypeOptions } from './price-source-model';
import type { SourceTypeOption } from './price-source-model';
import { deletePriceSource, priceSourceKeys, usePriceSources } from './price-sources.api';
import { QuotationGrid } from './quotation-grid';
import { AttachmentsSection } from '../attachments/attachments-section';
import {
  WIZARD_CATALOG_STALE_TIME_MS,
  fetchActiveCatalog,
  processKeys,
} from '../processes/processes.api';

type FormTarget =
  { readonly mode: 'create' } | { readonly mode: 'edit'; readonly source: PriceSourceDto };

/**
 * Aba "Fontes" da SCR-009 (US-026): `PriceSourceList` com "Nova fonte", edição e remoção (FA-01/02),
 * a grade de preços de cada fonte (`QuotationGrid`), a importação por planilha com ao menos uma
 * fonte (US-028 — `ImportQuotationsDialog`) e o anexo de evidência pelo fluxo genérico de
 * upload (US-068, alvo `PRICE_SOURCE` — só depois de a fonte existir, RN-PRICE-28). Sem
 * `meta.allowedActions` (permissão, etapa, documento não editável ou POL-09) tudo fica somente
 * leitura. Estados: skeleton, vazio, erro com "Tentar novamente".
 */
export function PriceSourcesPanel({
  processId,
  research,
  items,
  editable,
  allowedActions,
}: {
  readonly processId: string;
  readonly research: PriceResearchDto;
  readonly items: readonly PriceItemDto[] | undefined;
  readonly editable: boolean;
  readonly allowedActions: readonly string[];
}) {
  const t = useTranslations('priceResearch.sources');
  const session = useShellSession();
  const tenantId = session.activeTenant.id;
  const timeZone = session.activeTenant.timezone;
  const queryClient = useQueryClient();
  const sources = usePriceSources(research.id);
  const catalog = useQuery({
    queryKey: processKeys.activeCatalog(tenantId, 'PRICE_SOURCE_TYPE'),
    queryFn: ({ signal }) => fetchActiveCatalog('PRICE_SOURCE_TYPE', signal),
    staleTime: WIZARD_CATALOG_STALE_TIME_MS,
    enabled: editable,
    throwOnError: false,
  });
  const [form, setForm] = useState<FormTarget | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [removing, setRemoving] = useState<PriceSourceDto | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  /** Fontes, itens (cotações válidas, alertas) e o cabeçalho (totais — US-029) depois de gravar. */
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: priceSourceKeys.list(tenantId, research.id) }),
      queryClient.invalidateQueries({ queryKey: priceResearchKeys.detail(tenantId, research.id) }),
    ]);
  };

  /** Recusas das escritas ("Casos de erro"): a mensagem da story e os dados recarregados. */
  const handleError = (error: unknown, fallback: string) => {
    if (isApiError(error) && error.status === 412) {
      setNotice(PRICE_SOURCE_MESSAGES.versionConflict);
    } else if (isApiError(error) && error.code === 'DOCUMENT_NOT_EDITABLE') {
      setNotice(PRICE_SOURCE_MESSAGES.notEditable);
    } else if (isApiError(error) && error.code === 'INVALID_STATE') {
      // O `detail` do 409 traz o estado atual ("Esta cotação já está {estado}.").
      setNotice(error.problem?.detail ?? PRICE_SOURCE_MESSAGES.quotationExcluded);
    } else if (isApiError(error) && error.status === 403) {
      setNotice(PRICE_SOURCE_MESSAGES.permissionDenied);
    } else if (isApiError(error) && error.status === 422) {
      setNotice(error.errors[0]?.message ?? fallback);
    } else {
      setNotice(fallback);
      return;
    }
    void refresh();
  };

  const types = (source: PriceSourceDto | null): SourceTypeOption[] => {
    const active = sourceTypeOptions(catalog.data);
    // O tipo inativo de uma fonte gravada continua selecionável na edição (RN-TEN-61).
    if (source !== null && !active.some((option) => option.id === source.sourceTypeId)) {
      return [optionOfSource(source), ...active];
    }
    return active;
  };

  const remove = async (source: PriceSourceDto) => {
    setRemoveBusy(true);
    try {
      await deletePriceSource(source.id, source.version);
      toast({ title: t('toast.removed'), tone: 'success' });
      setRemoving(null);
      await refresh();
    } catch (error) {
      setRemoving(null);
      handleError(error, t('errors.removeFailed'));
    } finally {
      setRemoveBusy(false);
    }
  };

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">{t('title')}</h2>
        <p className="text-sm text-muted-foreground">{PRICE_RESEARCH_MESSAGES.instructions}</p>
      </div>
      {editable ? (
        <div className="flex flex-wrap gap-2">
          {sources.data !== undefined && sources.data.length > 0 ? (
            <Button
              variant="secondary"
              onClick={() => {
                setImporting(true);
              }}
            >
              {t('import.open')}
            </Button>
          ) : null}
          <Button
            onClick={() => {
              setForm({ mode: 'create' });
            }}
          >
            {t('register')}
          </Button>
        </div>
      ) : null}
    </div>
  );

  let body;
  if (sources.data === undefined) {
    body = sources.isPending ? (
      <div role="status" className="flex flex-col gap-2">
        <span className="sr-only">{t('loading')}</span>
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    ) : (
      <Alert tone="error" title={t('loadError')}>
        <Button
          size="sm"
          variant="secondary"
          className="mt-2"
          onClick={() => {
            void sources.refetch();
          }}
        >
          {t('retry')}
        </Button>
      </Alert>
    );
  } else if (sources.data.length === 0) {
    body = (
      <div className="rounded-card border border-border p-4">
        <p className="font-medium">{t('empty')}</p>
      </div>
    );
  } else {
    body = (
      <ul aria-label={t('listLabel')} className="flex min-w-0 flex-col gap-3">
        {sources.data.map((source) => {
          const open = expanded === source.id;
          const expired = source.quotations.filter((quotation) => quotation.isExpired).length;
          const outliers = source.quotations.filter(
            (quotation) => quotation.status === 'VALID' && quotation.outlierFlag !== 'NONE',
          ).length;
          return (
            <li
              key={source.id}
              className="flex min-w-0 flex-col gap-3 rounded-card border border-border p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex min-w-0 flex-col gap-1">
                  <h3 className="font-medium break-words">{source.description}</h3>
                  <p className="text-sm text-muted-foreground">
                    {source.sourceType.label}
                    {source.sourceType.isActive ? null : ` · ${t('inactiveType')}`}
                  </p>
                  <SourceDetails source={source} timeZone={timeZone} />
                  <p className="text-xs text-muted-foreground">
                    {t('quotationsCount', { count: source.quotations.length })}
                    {expired > 0 ? ` · ${t('expiredCount', { count: expired })}` : null}
                    {outliers > 0 ? ` · ${t('outlierCount', { count: outliers })}` : null}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-expanded={open}
                    onClick={() => {
                      setExpanded(open ? null : source.id);
                    }}
                  >
                    {open ? t('actions.hidePrices') : t('actions.prices')}
                  </Button>
                  {editable ? (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setForm({ mode: 'edit', source });
                        }}
                      >
                        {t('actions.edit')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setRemoving(source);
                        }}
                      >
                        {t('actions.remove')}
                      </Button>
                    </>
                  ) : null}
                </div>
              </div>
              {open ? (
                <>
                  {items === undefined ? (
                    <Skeleton className="h-24 w-full" />
                  ) : (
                    <QuotationGrid
                      // Remonta com os valores gravados a cada versão nova da fonte.
                      key={`${source.id}:${String(source.version)}:${String(items.length)}`}
                      source={source}
                      items={items}
                      decimals={research.parameters.unitPriceDecimals}
                      outlierParameters={research.parameters}
                      editable={editable}
                      canExclude={allowedActions.includes('EXCLUDE_QUOTATION')}
                      onSaved={async () => {
                        setNotice(null);
                        await refresh();
                      }}
                      onWriteError={handleError}
                    />
                  )}
                  {source.sourceType.requiredFields.includes('attachment') ? (
                    <p className="text-sm">{t('attachmentRequired')}</p>
                  ) : null}
                  <AttachmentsSection
                    targetType="PRICE_SOURCE"
                    targetId={source.id}
                    processId={processId}
                    action="UPDATE"
                    allowedActions={allowedActions}
                    failedMessage={PRICE_SOURCE_MESSAGES.attachmentFailed}
                  />
                </>
              ) : null}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {header}
      {notice === null ? null : <Alert tone="error" title={notice} />}
      {body}
      {form === null ? null : (
        <PriceSourceFormDialog
          open
          researchId={research.id}
          source={form.mode === 'edit' ? form.source : null}
          types={types(form.mode === 'edit' ? form.source : null)}
          clock={{ now: () => new Date(), today: localDateOf(new Date(), timeZone) }}
          onClose={() => {
            setForm(null);
          }}
          onSaved={(saved, created) => {
            setForm(null);
            toast({ title: created ? t('toast.created') : t('toast.updated'), tone: 'success' });
            // Fluxo principal 6: com a fonte criada, abre a grade de preços dela.
            if (created) setExpanded(saved.id);
            void refresh();
          }}
        />
      )}
      <ImportQuotationsDialog
        open={importing}
        researchId={research.id}
        onClose={() => {
          setImporting(false);
        }}
        onImported={async (result) => {
          setNotice(null);
          toast({ title: t('import.toast', { count: result.appliedCount }), tone: 'success' });
          await refresh();
        }}
        onBlocked={(code) => {
          setNotice(
            code === 'PERMISSION_DENIED'
              ? PRICE_SOURCE_MESSAGES.permissionDenied
              : PRICE_SOURCE_MESSAGES.notEditable,
          );
          void refresh();
        }}
      />
      <Dialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <DialogContent closeLabel={null}>
          <DialogTitle>
            {t('removeDialog.title', { description: removing?.description ?? '' })}
          </DialogTitle>
          <DialogDescription>
            {removing === null
              ? null
              : removing.quotations.length > 0
                ? t('removeDialog.withQuotations', { count: removing.quotations.length })
                : t('removeDialog.simple')}
          </DialogDescription>
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => {
                setRemoving(null);
              }}
            >
              {t('removeDialog.cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={removeBusy}
              onClick={() => {
                if (removing) void remove(removing);
              }}
            >
              {t('removeDialog.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SourceDetails({
  source,
  timeZone,
}: {
  readonly source: PriceSourceDto;
  readonly timeZone: string;
}) {
  const t = useTranslations('priceResearch.sources');
  const lines: string[] = [];
  if (source.supplier !== null) lines.push(t('supplier', { name: source.supplier.legalName }));
  if (source.quoteDate !== null)
    lines.push(t('quoteDate', { date: formatCivilDate(source.quoteDate) }));
  if (source.accessedAt !== null) {
    lines.push(t('accessedAt', { dateTime: formatDateTime(source.accessedAt, timeZone) }));
  }
  if (source.referenceOrganization !== null || source.referenceDocument !== null) {
    lines.push(
      t('reference', {
        organization: source.referenceOrganization ?? '—',
        document: source.referenceDocument ?? '—',
      }),
    );
  }
  if (lines.length === 0 && source.url === null) return null;
  return (
    <div className="flex flex-col gap-0.5 text-sm">
      {lines.map((line) => (
        <span key={line}>{line}</span>
      ))}
      {source.url === null ? null : (
        <a
          href={source.url}
          target="_blank"
          rel="noreferrer noopener"
          className="break-all text-primary underline"
        >
          {source.url}
        </a>
      )}
    </div>
  );
}
