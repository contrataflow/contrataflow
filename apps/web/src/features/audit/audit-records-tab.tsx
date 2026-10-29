'use client';

import type { AuditCategory, AuditResult } from '@contrataflow/types';
import {
  Alert,
  Button,
  Download,
  EmptyState,
  FilterToolbar,
  History,
  ListPage,
  toast,
} from '@contrataflow/ui';
import type { FilterToolbarChip } from '@contrataflow/ui';
import type { AuditExportFormat, AuditLogDto } from '@contrataflow/validation';
import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { isApiError } from '@/lib/api/api-error';
import { formatDate } from '@/lib/i18n/format';
import { usePermission } from '@/lib/permissions/use-permission';
import { useShellSession } from '@/lib/session/session-context';

import { AuditDetailPanel } from './audit-detail-panel';
import type { AuditQuickFilter } from './audit-detail-panel';
import { AuditExportDialog } from './audit-export-dialog';
import { AUDIT_PERIOD_FIELD_ID, AuditFiltersPanel } from './audit-filters-panel';
import {
  actorOptions,
  classifyAuditError,
  defaultAuditFilters,
  saveFile,
  validateAuditFilters,
} from './audit-log-model';
import type { AuditFilterField, AuditFilterInput, AuditQuery } from './audit-log-model';
import {
  AUDIT_LOGS_STALE_TIME_MS,
  auditLogKeys,
  exportAuditLogs,
  fetchAuditLogs,
} from './audit-logs.api';
import { AuditResultsTable, useActionLabel } from './audit-results-table';
import { isoToLocalInput } from './seal-model';

/**
 * Exportação pendente durante o step-up de MFA (FA-04): o 403 `MFA_REQUIRED` leva ao step-up
 * global e, na volta a `/auditoria`, a aba repete a exportação com os mesmos filtros e formato.
 */
const PENDING_EXPORT_KEY = 'cf.audit.pendingExport';

interface PendingExport {
  readonly tenantId: string;
  readonly query: AuditQuery;
  readonly format: AuditExportFormat;
}

function readPendingExport(tenantId: string): PendingExport | null {
  try {
    // Sem remover aqui: a exportação repetida regrava ou limpa a pendência ao concluir.
    const raw = sessionStorage.getItem(PENDING_EXPORT_KEY);
    const parsed = raw === null ? null : (JSON.parse(raw) as PendingExport);
    return parsed?.tenantId === tenantId ? parsed : null;
  } catch {
    return null;
  }
}

function writePendingExport(pending: PendingExport | null): void {
  try {
    if (pending === null) sessionStorage.removeItem(PENDING_EXPORT_KEY);
    else sessionStorage.setItem(PENDING_EXPORT_KEY, JSON.stringify(pending));
  } catch {
    // Armazenamento indisponível: o usuário repete a exportação manualmente.
  }
}

/** Painel de filtros a partir de uma query aplicada (exportação retomada após o step-up). */
function inputOfQuery(base: AuditFilterInput, query: AuditQuery): AuditFilterInput {
  return {
    ...base,
    actions: query.action?.split(',') ?? [],
    category: query.category ?? '',
    result: query.result ?? '',
    actorUserId: query.actorUserId ?? '',
    entityType: query.entityType ?? '',
    entityId: query.entityId ?? '',
    processId: query.processId ?? '',
  };
}

/**
 * Aba "Registros" de SCR-037 (US-075) no `ListPage` (prd-5): barra com "Filtros" (painel lateral
 * `AuditFiltersPanel`) e os chips do que está aplicado, `AuditResultsTable` (AUD-01 por cursor),
 * `AuditDetailPanel` (AUD-02) e `ExportDialog` (AUD-03, só com `AUDIT_EXPORT`, no cabeçalho).
 * Período padrão: últimos 7 dias. Estados: skeleton, vazio (FA-01), erro com "Tentar novamente" e
 * o `correlationId`, carregando mais. "Exportar" usa os filtros da última pesquisa.
 */
export function AuditRecordsTab({
  actionsSlot,
}: {
  /** Espaço de ações do cabeçalho da página, onde entra o "Exportar". */
  readonly actionsSlot: HTMLElement | null;
}) {
  const t = useTranslations('audit.records');
  const tCategories = useTranslations('audit.categories');
  const tResults = useTranslations('audit.results');
  const actionLabel = useActionLabel();
  const session = useShellSession();
  const tenantId = session.activeTenant.id;
  const timeZone = session.activeTenant.timezone;
  const canExport = usePermission('AUDIT_EXPORT').allowed;
  const messages = useMemo(
    () => ({ required: t('filters.required'), invalidId: t('filters.invalidId') }),
    [t],
  );

  const [initial] = useState(() => defaultAuditFilters(new Date(), timeZone));
  // Volta do step-up (FA-04): os filtros da exportação pendente substituem o padrão.
  const [pending] = useState(() => readPendingExport(tenantId));
  const [input, setInput] = useState<AuditFilterInput>(() =>
    pending === null ? initial : inputOfQuery(initial, pending.query),
  );
  const [applied, setApplied] = useState<AuditQuery | null>(() => {
    if (pending !== null) return pending.query;
    const validation = validateAuditFilters(initial, timeZone, messages);
    return validation.ok ? validation.query : null;
  });
  const [errors, setErrors] = useState<Partial<Record<AuditFilterField, string>>>({});
  const [selected, setSelected] = useState<AuditLogDto | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [knownActors, setKnownActors] = useState<readonly AuditLogDto[]>([]);
  /** O painel mudou depois da última pesquisa: o 422 da API deixa de valer para o campo. */
  const [inputDirty, setInputDirty] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);

  /** Período recusado (V-01/V-02): abre o painel e foca o seletor de datas. */
  const focusPeriod = useCallback(() => {
    setFiltersOpen(true);
    // O painel monta o conteúdo ao abrir: o foco vai depois da renderização.
    setTimeout(() => document.getElementById(AUDIT_PERIOD_FIELD_ID)?.focus(), 0);
  }, []);

  const feed = useInfiniteQuery({
    queryKey: auditLogKeys.list(tenantId, applied ?? {}),
    queryFn: async ({ pageParam, signal }) => {
      try {
        const page = await fetchAuditLogs(applied ?? {}, pageParam, signal);
        setKnownActors((known) => [...known, ...page.items]);
        return page;
      } catch (error) {
        // 422 sobre o período (V-01/V-02): foca o seletor de datas.
        if (classifyAuditError(error).kind === 'validation') {
          queueMicrotask(focusPeriod);
        }
        throw error;
      }
    },
    enabled: applied !== null,
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    staleTime: AUDIT_LOGS_STALE_TIME_MS,
    throwOnError: false,
    retry: false,
  });
  const records = useMemo(() => feed.data?.pages.flatMap((page) => page.items) ?? [], [feed.data]);
  const actors = useMemo(
    () => actorOptions(knownActors, input.actorUserId),
    [knownActors, input.actorUserId],
  );
  const feedFailure = feed.error === null ? null : classifyAuditError(feed.error);
  // Erros por campo: os da validação local e, depois da pesquisa, o 422 da API sobre o período.
  const fieldErrors =
    feedFailure?.kind === 'validation' && Object.keys(errors).length === 0 && !inputDirty
      ? { to: feedFailure.message }
      : errors;

  const exporter = useMutation({
    mutationFn: ({ query, format }: { query: AuditQuery; format: AuditExportFormat }) =>
      exportAuditLogs(query, format),
    onSuccess: (file) => {
      writePendingExport(null);
      saveFile(file.blob, file.fileName);
      setExportOpen(false);
      toast({ title: t('export.done', { count: file.rowCount }), tone: 'success' });
    },
    onError: (error) => {
      // FA-04: só o MFA ausente mantém a exportação pendente para depois do step-up.
      if (!(isApiError(error) && error.code === 'MFA_REQUIRED')) writePendingExport(null);
    },
  });
  const exportFailure = exporter.error === null ? null : classifyAuditError(exporter.error);

  const runExport = useCallback(
    (query: AuditQuery, format: AuditExportFormat) => {
      writePendingExport({ tenantId, query, format });
      exporter.mutate({ query, format });
    },
    [exporter, tenantId],
  );

  // Volta do step-up (FA-04): repete a exportação pendente com os mesmos filtros e formato.
  const resumed = useRef(false);
  useEffect(() => {
    if (resumed.current || pending === null) return;
    resumed.current = true;
    runExport(pending.query, pending.format);
  }, [pending, runExport]);

  const apply = (next: AuditFilterInput): boolean => {
    const validation = validateAuditFilters(next, timeZone, messages);
    if (!validation.ok) {
      setErrors(validation.errors);
      if (validation.errors.from !== undefined || validation.errors.to !== undefined) {
        focusPeriod();
      } else {
        setFiltersOpen(true);
      }
      return false;
    }
    setErrors({});
    setInputDirty(false);
    setApplied(validation.query);
    if (JSON.stringify(validation.query) === JSON.stringify(applied)) void feed.refetch();
    return true;
  };

  const search = () => {
    setNotice(null);
    if (apply(input)) setFiltersOpen(false);
  };

  /** Remove um filtro aplicado (chip): parte do que está na tela, não do painel em edição. */
  const removeFilter = (patch: Partial<AuditFilterInput>) => {
    const base =
      applied === null
        ? input
        : inputOfQuery(
            {
              ...initial,
              from: isoToLocalInput(applied.occurredFrom ?? '', timeZone),
              to: isoToLocalInput(applied.occurredTo ?? '', timeZone),
            },
            applied,
          );
    const next = { ...base, ...patch };
    setInput(next);
    apply(next);
  };

  const applyQuickFilter = (filter: AuditQuickFilter) => {
    const next: AuditFilterInput =
      filter.kind === 'actor'
        ? { ...input, actorUserId: filter.id }
        : filter.kind === 'process'
          ? { ...input, processId: filter.id }
          : { ...input, entityType: filter.type, entityId: filter.id };
    setSelected(null);
    setInput(next);
    const validation = validateAuditFilters(next, timeZone, messages);
    if (validation.ok) {
      setErrors({});
      setApplied(validation.query);
    }
  };

  const onNotFound = useCallback(() => {
    setSelected(null);
    setNotice(t('detail.notFound'));
  }, [t]);

  const chips = appliedChips(applied, {
    initial: validateAuditFilters(initial, timeZone, messages),
    timeZone,
    actorName: (id) => actors.find((actor) => actor.id === id)?.name ?? id,
    actionLabel,
    categoryLabel: (category) => tCategories(category),
    resultLabel: (result) => tResults(result),
    label: (key, value) => t(`chips.${key}`, { value }),
    removeLabel: (key, value) => t('chips.remove', { filter: t(`chips.${key}`, { value }) }),
    onRemove: (key) => {
      removeFilter(CHIP_RESET[key](initial));
    },
  });

  const period =
    applied?.occurredFrom === undefined || applied.occurredTo === undefined
      ? null
      : t('table.period', {
          from: formatDate(applied.occurredFrom, timeZone),
          to: formatDate(applied.occurredTo, timeZone),
        });

  const failureAlert =
    feedFailure !== null && feedFailure.kind !== 'validation' && records.length === 0 ? (
      <Alert
        tone="error"
        title={
          feedFailure.kind === 'forbidden'
            ? t('errors.forbidden')
            : feedFailure.kind === 'mfa'
              ? t('errors.mfa')
              : t('errors.unavailable')
        }
      >
        {feedFailure.kind === 'unavailable' || feedFailure.kind === 'unexpected' ? (
          <p className="text-sm">
            {t('errors.code', { correlationId: feedFailure.correlationId ?? '—' })}
          </p>
        ) : null}
        <Button
          size="sm"
          variant="secondary"
          className="mt-2"
          onClick={() => {
            void feed.refetch();
          }}
        >
          {t('errors.retry')}
        </Button>
      </Alert>
    ) : null;

  return (
    <ListPage
      header={
        canExport && actionsSlot !== null
          ? createPortal(
              <Button
                variant="secondary"
                iconLeft={<Download />}
                disabled={applied === null || exporter.isPending}
                onClick={() => {
                  exporter.reset();
                  setExportOpen(true);
                }}
              >
                {exporter.isPending ? t('export.exporting') : t('export.button')}
              </Button>,
              actionsSlot,
            )
          : null
      }
      toolbar={
        <FilterToolbar
          onOpenFilters={() => {
            setFiltersOpen(true);
          }}
          activeCount={chips.length}
          chips={chips}
          onClearAll={() => {
            setInput(initial);
            apply(initial);
          }}
          labels={{ clearAll: t('filters.clear') }}
        />
      }
      notices={notice ? <Alert tone="info" title={notice} /> : null}
      loading={applied !== null && feed.isPending}
      loadingLabel={t('table.loading')}
      error={failureAlert}
      empty={
        feed.data && records.length === 0 && failureAlert === null ? (
          <EmptyState
            icon={<History />}
            title={t('table.empty')}
            description={t('table.emptyHint')}
            action={
              <Button
                variant="secondary"
                onClick={() => {
                  setFiltersOpen(true);
                }}
              >
                {t('table.adjust')}
              </Button>
            }
          />
        ) : null
      }
    >
      {records.length > 0 ? (
        <AuditResultsTable
          records={records}
          timeZone={timeZone}
          onOpen={setSelected}
          hasMore={feed.hasNextPage}
          loadingMore={feed.isFetchingNextPage}
          onLoadMore={() => {
            void feed.fetchNextPage();
          }}
          busy={feed.isFetching}
          period={period}
        />
      ) : null}
      <AuditFiltersPanel
        open={filtersOpen}
        onOpenChange={setFiltersOpen}
        value={input}
        onChange={(next) => {
          setInput(next);
          setInputDirty(true);
          if (Object.keys(errors).length > 0) setErrors({});
        }}
        onSearch={search}
        onClear={() => {
          setInput(initial);
          setErrors({});
        }}
        timeZone={timeZone}
        errors={fieldErrors}
        actors={actors}
        pending={feed.isFetching && !feed.isFetchingNextPage}
      />
      <AuditDetailPanel
        record={selected}
        timeZone={timeZone}
        onClose={() => {
          setSelected(null);
        }}
        onNotFound={onNotFound}
        onFilter={applyQuickFilter}
      />
      {canExport ? (
        <AuditExportDialog
          open={exportOpen}
          onOpenChange={setExportOpen}
          pending={exporter.isPending}
          failure={exportFailure?.kind === 'mfa' ? null : exportFailure}
          onExport={(format) => {
            if (applied !== null) runExport(applied, format);
          }}
        />
      ) : null}
    </ListPage>
  );
}

type ChipKey =
  'period' | 'action' | 'category' | 'result' | 'actor' | 'entityType' | 'entityId' | 'process';

/** O que cada chip zera no painel ao ser removido (o período volta ao padrão de 7 dias). */
const CHIP_RESET: Readonly<
  Record<ChipKey, (initial: AuditFilterInput) => Partial<AuditFilterInput>>
> = {
  period: (initial) => ({ from: initial.from, to: initial.to }),
  action: () => ({ actions: [] }),
  category: () => ({ category: '' }),
  result: () => ({ result: '' }),
  actor: () => ({ actorUserId: '' }),
  entityType: () => ({ entityType: '' }),
  entityId: () => ({ entityId: '' }),
  process: () => ({ processId: '' }),
};

/** Chips dos filtros aplicados (prd-5 · regra 2); o período só aparece quando sai do padrão. */
function appliedChips(
  applied: AuditQuery | null,
  options: {
    readonly initial: ReturnType<typeof validateAuditFilters>;
    readonly timeZone: string;
    readonly actorName: (id: string) => string;
    readonly actionLabel: (action: string) => string;
    readonly categoryLabel: (category: AuditCategory) => string;
    readonly resultLabel: (result: AuditResult) => string;
    readonly label: (key: ChipKey, value: string) => string;
    readonly removeLabel: (key: ChipKey, value: string) => string;
    readonly onRemove: (key: ChipKey) => void;
  },
): FilterToolbarChip[] {
  if (applied === null) return [];
  const entries: [ChipKey, string | undefined][] = [];
  const initial = options.initial.ok ? options.initial.query : null;
  if (
    applied.occurredFrom !== undefined &&
    applied.occurredTo !== undefined &&
    (applied.occurredFrom !== initial?.occurredFrom || applied.occurredTo !== initial.occurredTo)
  ) {
    entries.push([
      'period',
      `${formatDate(applied.occurredFrom, options.timeZone)} – ${formatDate(applied.occurredTo, options.timeZone)}`,
    ]);
  }
  entries.push(
    ['action', applied.action?.split(',').map(options.actionLabel).join(', ')],
    [
      'category',
      applied.category === undefined
        ? undefined
        : options.categoryLabel(applied.category as AuditCategory),
    ],
    [
      'result',
      applied.result === undefined ? undefined : options.resultLabel(applied.result as AuditResult),
    ],
    [
      'actor',
      applied.actorUserId === undefined ? undefined : options.actorName(applied.actorUserId),
    ],
    ['entityType', applied.entityType],
    ['entityId', applied.entityId],
    ['process', applied.processId],
  );
  return entries
    .filter((entry): entry is [ChipKey, string] => entry[1] !== undefined)
    .map(([key, value]) => ({
      id: key,
      label: options.label(key, value),
      removeLabel: options.removeLabel(key, value),
      onRemove: () => {
        options.onRemove(key);
      },
    }));
}
