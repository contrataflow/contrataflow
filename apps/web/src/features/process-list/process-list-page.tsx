'use client';

import { Alert, Button, Skeleton, buttonClassName } from '@contrataflow/ui';
import { PROCESS_LIST_MESSAGES } from '@contrataflow/validation';
import type {
  ProcessListItemDto,
  ProcessListParamKey,
  ProcessListSortField,
  ProcessStageOptionDto,
  ProcessStatus,
} from '@contrataflow/validation';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState } from 'react';

import { CorrelationCode } from '@/components/errors/correlation-code';
import { ErrorView } from '@/components/errors/error-view';
import { ProcessStatusBadge } from '@/features/processes/process-status-badge';
import type { Messages } from '@/i18n/messages';
import { isApiError } from '@/lib/api/api-error';
import { usePermission } from '@/lib/permissions/use-permission';
import { HOME_PATH } from '@/lib/routes';
import { useShellSession, useTenantId } from '@/lib/session/session-context';

import { ProcessFiltersPanel } from './process-filters-panel';
import type { FilterOptions } from './process-filters-panel';
import {
  ConfidentialBadge,
  ConfidentialValue,
  DueDateBadge,
  PriorityBadge,
  formatBrl,
} from './process-list-badges';
import {
  activeFilterKeys,
  clearFilters,
  hasValueFilter,
  isQuickFilterActive,
  primarySort,
  resolveListState,
  searchValue,
  toApiQuery,
  toSearchString,
  toggleQuickFilter,
  toggleSort,
  valuesOf,
  withParam,
} from './process-list-state';
import type { ListParams, QuickFilter } from './process-list-state';
import {
  FILTER_OPTIONS_STALE_TIME_MS,
  PROCESS_LIST_STALE_TIME_MS,
  fetchCatalogOptions,
  fetchOrganizations,
  fetchProcessList,
  fetchUnitOptions,
  processListKeys,
  readStoredColumns,
  saveColumnsPreference,
} from './process-list.api';
import {
  buildAvailability,
  columnKeyOf,
  columnKeysFromVisible,
  exportQuery,
  summarizeCriteria,
} from './saved-views-model';
import type { CriteriaLabels } from './saved-views-model';
import { SavedViewsToolbar } from './saved-views-toolbar';
import { useSavedViews } from './use-saved-views';
import { TagChip } from '../tags/tag-chip';
import { useTags } from '../tags/tags.api';

/*
 * SCR-004 — Processos (`/processos` · US-002): tabela paginada no servidor (modo manual: a API
 * filtra, ordena e pagina), busca com debounce, atalhos, painel de filtros, chips e escolha de
 * colunas. A URL é o estado da consulta (link compartilhável); abaixo de 768 px cada linha vira um
 * cartão (FA-09). A API decide visibilidade e sigilo; a tela só apresenta.
 */

export const PROCESS_LIST_PATH = '/processos';
const SEARCH_DEBOUNCE_MS = 300;

export type ColumnId =
  | 'code'
  | 'title'
  | 'status'
  | 'stage'
  | 'currentDepartment'
  | 'responsible'
  | 'deadline'
  | 'priority'
  | 'requestingSecretariat'
  | 'requestingDepartment'
  | 'contractingType'
  | 'modality'
  | 'origin'
  | 'estimatedValue'
  | 'targetDate'
  | 'tags'
  | 'internalCode'
  | 'organization'
  | 'createdAt'
  | 'updatedAt';

interface ColumnDef {
  readonly id: ColumnId;
  readonly sort?: ProcessListSortField;
  readonly fixed?: boolean;
  readonly visibleByDefault?: boolean;
  /** Só com mais de um órgão no tenant (RN-PROC-32 · FA-08). */
  readonly multiOrganization?: boolean;
  /** Mostrada também no cartão do mobile (FA-09). */
  readonly card?: boolean;
}

/** Colunas da tabela "Colunas" da US-002 ("Etiquetas" — US-007 — fica fora do padrão). */
export const PROCESS_COLUMNS: readonly ColumnDef[] = [
  { id: 'code', sort: 'code', fixed: true, card: true },
  { id: 'title', sort: 'title', fixed: true, card: true },
  { id: 'status', sort: 'status', visibleByDefault: true, card: true },
  { id: 'stage', visibleByDefault: true, card: true },
  { id: 'currentDepartment', visibleByDefault: true },
  { id: 'responsible', visibleByDefault: true, card: true },
  { id: 'deadline', sort: 'currentStageDueAt', visibleByDefault: true, card: true },
  { id: 'priority', sort: 'priority', visibleByDefault: true },
  { id: 'requestingSecretariat' },
  { id: 'requestingDepartment' },
  { id: 'contractingType' },
  { id: 'modality' },
  { id: 'origin' },
  { id: 'estimatedValue', sort: 'estimatedValue' },
  { id: 'targetDate', sort: 'targetDate' },
  { id: 'tags' },
  { id: 'internalCode' },
  { id: 'organization', multiOrganization: true },
  { id: 'createdAt', sort: 'createdAt' },
  { id: 'updatedAt', sort: 'updatedAt' },
];

const DEFAULT_COLUMNS: readonly ColumnId[] = PROCESS_COLUMNS.filter(
  (column) => column.visibleByDefault,
).map((column) => column.id);

const QUICK_ORDER: readonly QuickFilter[] = ['mine', 'myUnit', 'overdue', 'returned'];

/** Rótulo do chip de cada filtro (namespace `processList.filters`). */
const CHIP_LABELS: Partial<Record<ProcessListParamKey, keyof Messages['processList']['filters']>> =
  {
    q: 'search',
    status: 'status',
    stageKey: 'stage',
    currentWorkflowStageId: 'stage',
    currentDepartmentId: 'currentDepartment',
    requestingSecretariatId: 'requestingSecretariat',
    requestingDepartmentId: 'requestingDepartment',
    organizationId: 'organization',
    currentResponsibleId: 'responsible',
    priority: 'priority',
    contractingTypeId: 'contractingType',
    modalityId: 'modality',
    originId: 'origin',
    year: 'year',
    overdue: 'overdue',
    targetDateOverdue: 'targetDateOverdue',
    createdFrom: 'createdFrom',
    createdTo: 'createdTo',
    targetDateFrom: 'targetDateFrom',
    targetDateTo: 'targetDateTo',
    estimatedValueMin: 'estimatedValueMin',
    estimatedValueMax: 'estimatedValueMax',
  };

export function ProcessListPage() {
  const t = useTranslations('processList');
  const tErrors = useTranslations('errors');
  const tStatus = useTranslations('processes.statuses');
  const tPriority = useTranslations('processes.priorities');
  const format = useFormatter();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tenantId = useTenantId();
  const session = useShellSession();
  const canCreate = usePermission('PROCESS_CREATE').allowed;

  const state = useMemo(
    () => resolveListState(new URLSearchParams(searchParams.toString())),
    [searchParams],
  );
  const params = state.params;
  const apiQuery = useMemo(() => toApiQuery(params), [params]);

  // FA-03: parâmetros inválidos saem da URL com aviso.
  const [invalidLink] = useState(state.hadInvalid);
  useEffect(() => {
    if (state.hadInvalid) {
      router.replace(`${pathname}?${toSearchString(params)}`, { scroll: false });
    }
  }, [state.hadInvalid, params, pathname, router]);

  const navigate = (next: ListParams, mode: 'push' | 'replace' = 'push') => {
    const href = `${pathname}?${toSearchString(next)}`;
    if (mode === 'replace') router.replace(href, { scroll: false });
    else router.push(href, { scroll: false });
  };

  // Busca: 300 ms sem digitação e ≥ 2 caracteres (V-03); a URL troca por `replace`.
  const [searchText, setSearchText] = useState(params.q ?? '');
  const lastQ = useRef(params.q);
  useEffect(() => {
    if (params.q !== lastQ.current) {
      lastQ.current = params.q;
      setSearchText(params.q ?? '');
    }
  }, [params.q]);
  useEffect(() => {
    const { value, tooShort } = searchValue(searchText);
    if (tooShort || value === params.q) return undefined;
    const timer = setTimeout(() => {
      lastQ.current = value;
      navigate(withParam(params, 'q', value), 'replace');
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reage só ao texto digitado
  }, [searchText]);

  const searchTooShort = searchValue(searchText).tooShort;

  // Opções de etapa: só na primeira consulta (`includeStageOptions` — lacuna 1).
  const [stageOptions, setStageOptions] = useState<readonly ProcessStageOptionDto[] | null>(null);
  const wantsStageOptions = useRef(true);

  const optionQuery = <T,>(key: readonly unknown[], fn: (signal: AbortSignal) => Promise<T>) => ({
    queryKey: key,
    queryFn: ({ signal }: { signal: AbortSignal }) => fn(signal),
    staleTime: FILTER_OPTIONS_STALE_TIME_MS,
    throwOnError: false,
    retry: false,
  });
  const organizations = useQuery(
    optionQuery(processListKeys.organizations(tenantId), fetchOrganizations),
  );
  const units = useQuery(optionQuery(processListKeys.departments(tenantId), fetchUnitOptions));
  const contractingTypes = useQuery(
    optionQuery(processListKeys.catalog(tenantId, 'CONTRACTING_TYPE'), (signal) =>
      fetchCatalogOptions('CONTRACTING_TYPE', signal),
    ),
  );
  const modalities = useQuery(
    optionQuery(processListKeys.catalog(tenantId, 'MODALITY'), (signal) =>
      fetchCatalogOptions('MODALITY', signal),
    ),
  );
  const origins = useQuery(
    optionQuery(processListKeys.catalog(tenantId, 'PROCESS_ORIGIN'), (signal) =>
      fetchCatalogOptions('PROCESS_ORIGIN', signal),
    ),
  );
  // Etiquetas (US-007): o filtro oferece as ativas; quem tem `TAG_MANAGE` vê também as inativas.
  const canManageTags = usePermission('TAG_MANAGE').allowed;
  const tags = useTags(canManageTags);
  const multiOrganization = (organizations.data?.length ?? 0) > 1;
  const filterOptions: FilterOptions = {
    tags: tags.data ?? [],
    stages: stageOptions ?? [],
    units: units.data ?? [],
    organizations: (organizations.data ?? []).map((org) => ({ id: org.id, name: org.shortName })),
    contractingTypes: contractingTypes.data ?? [],
    modalities: modalities.data ?? [],
    origins: origins.data ?? [],
  };

  // Colunas (RN-PROC-32): aplicadas na hora; persistidas com contingência local.
  // A tabela só aparece depois da consulta (no cliente): ler o `localStorage` aqui não diverge do SSR.
  const [columns, setColumns] = useState<readonly ColumnId[]>(
    () => readStoredColumns(tenantId)?.filter(isColumnId) ?? DEFAULT_COLUMNS,
  );
  const [columnsWarning, setColumnsWarning] = useState(false);
  const [chooserOpen, setChooserOpen] = useState(false);
  const toggleColumn = (id: ColumnId) => {
    const next = columns.includes(id)
      ? columns.filter((column) => column !== id)
      : [...columns, id];
    setColumns(next);
    void saveColumnsPreference(tenantId, next).then((saved) => {
      setColumnsWarning(!saved);
    });
  };
  const offered = PROCESS_COLUMNS.filter(
    (column) => !column.multiOrganization || multiOrganization,
  );
  const visible = offered.filter((column) => column.fixed === true || columns.includes(column.id));

  // --- Visões salvas (US-003) ---------------------------------------------------------------
  const canExport = usePermission('PROCESS_EXPORT').allowed;
  const visibleIds = visible.map((column) => column.id);
  const availableColumnKeys = new Set(
    offered.map((column) => columnKeyOf(column.id)).filter((key) => key !== null),
  );
  const availability = buildAvailability({
    units: units.data,
    organizations: organizations.data,
    contractingTypes: contractingTypes.data,
    modalities: modalities.data,
    origins: origins.data,
  });
  const optionsSettled = [organizations, units, contractingTypes, modalities, origins].every(
    (option) => !option.isPending,
  );
  const views = useSavedViews({
    tenantId,
    usedDefaults: state.usedDefaults,
    params,
    visibleColumnIds: visibleIds,
    availableColumnKeys,
    availability,
    optionsSettled,
    navigate,
    applyColumns: (ids) => {
      setColumns(ids.filter(isColumnId));
    },
    resetColumns: () => {
      setColumns(readStoredColumns(tenantId)?.filter(isColumnId) ?? DEFAULT_COLUMNS);
    },
  });

  // Opções de etapa: só na primeira consulta (`includeStageOptions` — lacuna 1).
  const list = useQuery({
    queryKey: processListKeys.list(tenantId, apiQuery),
    queryFn: async ({ signal }) => {
      const include = wantsStageOptions.current;
      const page = await fetchProcessList(
        include ? { ...apiQuery, includeStageOptions: 'true' } : apiQuery,
        signal,
      );
      if (include && page.meta.stageOptions) {
        wantsStageOptions.current = false;
        setStageOptions(page.meta.stageOptions);
      }
      return page;
    },
    enabled: !views.awaitingDefault,
    placeholderData: keepPreviousData,
    staleTime: PROCESS_LIST_STALE_TIME_MS,
    refetchOnWindowFocus: true,
    throwOnError: false,
    retry: false,
  });

  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filtersKey, setFiltersKey] = useState(0);

  // --- Estados de erro ---------------------------------------------------------------------
  const error = list.error;
  if (error && isApiError(error) && error.status === 403) {
    return (
      <ErrorView
        title={tErrors('pages.403.title')}
        description={t('errors.forbidden')}
        actions={
          <Link href={HOME_PATH} className={buttonClassName({ variant: 'secondary' })}>
            {tErrors('actions.home')}
          </Link>
        }
      />
    );
  }

  const page = list.data;
  const items = page?.items ?? [];
  const total = page?.meta.totalItems ?? 0;
  const totalPages = page?.meta.totalPages ?? 0;
  const currentPage = Number(params.page ?? '1');
  const activeKeys = activeFilterKeys(params);
  const sort = primarySort(params);
  const membershipType = session.memberships.find(
    (membership) => membership.tenant.id === session.activeTenant.id,
  )?.type;

  // --- Chips ------------------------------------------------------------------------------
  const nameOf = (id: string) =>
    units.data?.find((unit) => unit.id === id)?.name ??
    organizations.data?.find((org) => org.id === id)?.shortName ??
    tags.data?.find((tag) => tag.id === id)?.name ??
    [...(contractingTypes.data ?? []), ...(modalities.data ?? []), ...(origins.data ?? [])].find(
      (item) => item.id === id,
    )?.label ??
    null;
  const chipValue = (key: ProcessListParamKey, raw: string): string => {
    const values = valuesOf(raw);
    const one = (value: string): string | null => {
      if (key === 'status') return tStatus(value as ProcessStatus);
      if (key === 'priority') return tPriority(value as ProcessListItemDto['priority']);
      if (key === 'stageKey')
        return stageOptions?.find((stage) => stage.key === value)?.name ?? value;
      if (value === 'me') return t('filters.responsibleMe');
      if (value === 'none') {
        return key === 'modalityId' ? t('filters.modalityNone') : t('filters.responsibleNone');
      }
      if (value === 'mine') return t('filters.mine');
      if (value === 'true') return t('filters.yes');
      if (value === 'false') return t('filters.no');
      if (key === 'estimatedValueMin' || key === 'estimatedValueMax') return formatBrl(value);
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return format.dateTime(new Date(`${value}T12:00:00Z`), {
          dateStyle: 'short',
          timeZone: 'UTC',
        });
      }
      if (key === 'q' || key === 'year') return value;
      return nameOf(value);
    };
    const labels = values.map(one);
    if (labels.length > 1 && labels.some((label) => label === null)) return String(values.length);
    return labels.map((label) => label ?? '…').join(', ');
  };
  const chipLabel = (key: ProcessListParamKey) =>
    key === 'tagId' ? t('columns.tags') : t(`filters.${CHIP_LABELS[key] ?? 'search'}`);

  const criteriaLabels: CriteriaLabels = {
    filter: chipLabel,
    value: chipValue,
    flag: (key) => (key === 'overdue' ? t('quick.overdue') : t('filters.targetDateOverdue')),
    sortTerm: (field, direction) => {
      const column = PROCESS_COLUMNS.find((candidate) => candidate.sort === field);
      const label = column ? t(`columns.${column.id}`) : field;
      return t(direction === 'desc' ? 'views.criteria.desc' : 'views.criteria.asc', { label });
    },
    sortPrefix: t('views.criteria.sortPrefix'),
    empty: t('views.criteria.empty'),
  };
  const exportColumns = visible.map((column) => ({
    id: column.id,
    label: t(`columns.${column.id}`),
  }));
  // O arquivo só cita a visão de origem quando a lista ainda é exatamente a visão (auditoria).
  const exportViewId = views.applied !== null && !views.unsaved ? views.applied.id : undefined;

  const showNoProcesses =
    page !== undefined && total === 0 && (activeKeys.length === 0 || state.usedDefaults);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('description')}</p>
        </div>
        <p className="text-sm font-medium" aria-hidden="true">
          {page ? t('total', { count: total }) : null}
        </p>
      </div>

      <div role="status" aria-live="polite" className="sr-only">
        {page ? t('announce', { count: total }) : ''}
      </div>

      {invalidLink ? (
        <Alert tone="warning" title={PROCESS_LIST_MESSAGES.invalidLink} live={false} />
      ) : null}

      <SavedViewsToolbar
        controller={views}
        canExport={canExport}
        exportTotal={page && !list.isFetching ? total : undefined}
        exportColumns={exportColumns}
        buildExportQuery={() =>
          exportQuery(params, columnKeysFromVisible(visibleIds), exportViewId)
        }
        summarize={() => summarizeCriteria(params, criteriaLabels)}
      />

      <div className="flex flex-col gap-3 md:flex-row md:items-start">
        <div className="flex flex-1 flex-col gap-1">
          <label className="relative block">
            <span className="sr-only">{t('search.label')}</span>
            <input
              type="search"
              value={searchText}
              placeholder={t('search.placeholder')}
              aria-describedby={searchTooShort ? 'process-search-hint' : undefined}
              onChange={(event) => {
                setSearchText(event.target.value);
              }}
              className="h-11 w-full rounded-control border border-border bg-surface px-3 text-sm md:h-9"
            />
          </label>
          {searchTooShort ? (
            <p id="process-search-hint" className="text-xs text-muted-foreground">
              {t('search.tooShort')}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              setFiltersKey((key) => key + 1);
              setFiltersOpen(true);
            }}
          >
            {t('filters.open')}
          </Button>
          <div className="relative hidden md:block">
            <Button
              variant="secondary"
              aria-expanded={chooserOpen}
              aria-controls="process-column-chooser"
              onClick={() => {
                setChooserOpen((open) => !open);
              }}
            >
              {t('columns.choose')}
            </Button>
            {chooserOpen ? (
              <fieldset
                id="process-column-chooser"
                className="absolute right-0 z-20 mt-1 flex w-64 flex-col gap-1 rounded-card border border-border bg-surface p-3 shadow-card"
              >
                <legend className="sr-only">{t('columns.chooserTitle')}</legend>
                {offered.map((column) => (
                  <label key={column.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={column.fixed === true || columns.includes(column.id)}
                      disabled={column.fixed}
                      onChange={() => {
                        toggleColumn(column.id);
                      }}
                    />
                    {column.fixed
                      ? t('columns.fixed', { label: t(`columns.${column.id}`) })
                      : t(`columns.${column.id}`)}
                  </label>
                ))}
              </fieldset>
            ) : null}
          </div>
        </div>
      </div>

      <div role="group" aria-label={t('quick.label')} className="flex flex-wrap gap-2">
        {QUICK_ORDER.map((filter) => {
          const active = isQuickFilterActive(params, filter);
          return (
            <button
              key={filter}
              type="button"
              aria-pressed={active}
              onClick={() => {
                navigate(toggleQuickFilter(params, filter));
              }}
              className={`min-h-11 rounded-full border px-3 text-sm font-medium md:min-h-8 ${
                active
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-surface text-foreground'
              }`}
            >
              {t(`quick.${filter}`)}
            </button>
          );
        })}
        {isQuickFilterActive(params, 'mine') ? (
          <Link href="/aprovacoes" className="self-center text-sm text-primary underline">
            {t('quick.pendingApprovals')}
          </Link>
        ) : null}
      </div>

      {activeKeys.length > 0 ? (
        <ul aria-label={t('filters.active')} className="flex flex-wrap gap-2">
          {activeKeys.map((key) => {
            const label = chipLabel(key);
            const value = chipValue(key, params[key] ?? '');
            return (
              <li key={key}>
                <button
                  type="button"
                  aria-label={t('filters.remove', { label: `${label}: ${value}` })}
                  onClick={() => {
                    navigate(withParam(params, key, undefined));
                  }}
                  className="inline-flex min-h-11 items-center gap-1 rounded-full bg-muted px-3 text-xs md:min-h-7"
                >
                  {t('filters.chip', { label, value })}
                  <span aria-hidden="true">×</span>
                </button>
              </li>
            );
          })}
          <li>
            <button
              type="button"
              className="min-h-11 px-2 text-xs text-primary underline md:min-h-7"
              onClick={() => {
                navigate(clearFilters(params));
              }}
            >
              {t('filters.clear')}
            </button>
          </li>
        </ul>
      ) : null}

      {hasValueFilter(params) && page?.meta.valueFilterExcludesConfidential ? (
        <Alert tone="info" title={t('notes.valueFilter')} live={false} />
      ) : null}
      {page?.meta.confidentialStepUpAvailable ? (
        <Alert tone="info" title={t('notes.stepUp')} live={false}>
          <a
            href={`/api/auth/step-up?returnTo=${encodeURIComponent(`${pathname}?${toSearchString(params)}`)}`}
            className={buttonClassName({ variant: 'secondary', size: 'sm' })}
          >
            {t('notes.stepUpAction')}
          </a>
        </Alert>
      ) : null}
      {columnsWarning ? (
        <p role="status" className="text-xs text-muted-foreground">
          {t('notes.columnsNotSaved')}
        </p>
      ) : null}

      {list.isError && !page ? (
        <ListError error={error} onRetry={() => void list.refetch()} />
      ) : null}
      {list.isError && page ? (
        <ListError error={error} onRetry={() => void list.refetch()} compact />
      ) : null}

      {list.isPending ? (
        <div role="status" className="flex flex-col gap-2">
          <span className="sr-only">{t('loading')}</span>
          {Array.from({ length: 10 }, (_, index) => (
            <Skeleton key={index} className="h-10 w-full" />
          ))}
        </div>
      ) : null}

      {list.isFetching && page ? (
        <div
          role="progressbar"
          aria-label={t('refreshing')}
          className="h-1 w-full animate-pulse rounded bg-primary/40"
        />
      ) : null}

      {page && items.length === 0 ? (
        <div className="rounded-card border border-dashed border-border p-6 text-center">
          {showNoProcesses ? (
            <>
              <p className="font-medium">
                {membershipType === 'EXTERNAL' ? t('empty.external') : t('empty.none')}
              </p>
              {canCreate && membershipType !== 'EXTERNAL' ? (
                <Link href="/processos/novo" className={`${buttonClassName({})} mt-3`}>
                  {t('empty.newProcess')}
                </Link>
              ) : null}
            </>
          ) : (
            <>
              <p className="font-medium">{t('empty.filtered')}</p>
              <div className="mt-3 flex flex-wrap justify-center gap-2">
                <Button
                  variant="secondary"
                  onClick={() => {
                    navigate(clearFilters(params));
                  }}
                >
                  {t('filters.clear')}
                </Button>
                {params.q && params.status ? (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      navigate(withParam(params, 'status', undefined));
                    }}
                  >
                    {t('filters.searchAllStatuses')}
                  </Button>
                ) : null}
              </div>
            </>
          )}
        </div>
      ) : null}

      {items.length > 0 ? (
        <div className="rounded-card border border-border bg-surface shadow-card md:overflow-x-auto">
          <table className="w-full text-left text-sm md:min-w-[56rem]">
            <caption className="sr-only">{t('table.caption')}</caption>
            <thead className="bg-muted text-xs text-muted-foreground uppercase max-md:sr-only">
              <tr>
                {visible.map((column) => {
                  const label = t(`columns.${column.id}`);
                  const sorted = sort?.field === column.sort ? sort : null;
                  return (
                    <th
                      key={column.id}
                      scope="col"
                      className="px-3 py-2"
                      aria-sort={
                        sorted
                          ? sorted.direction === 'asc'
                            ? 'ascending'
                            : 'descending'
                          : undefined
                      }
                    >
                      {column.sort ? (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 uppercase"
                          aria-label={t('table.sortBy', { label })}
                          onClick={() => {
                            if (column.sort) navigate(toggleSort(params, column.sort));
                          }}
                        >
                          {label}
                          <span aria-hidden="true">
                            {sorted ? (sorted.direction === 'asc' ? '▲' : '▼') : '↕'}
                          </span>
                        </button>
                      ) : (
                        label
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr
                  key={item.id}
                  className="border-t border-border max-md:flex max-md:flex-col max-md:gap-1 max-md:p-3"
                >
                  {visible.map((column) => (
                    <td
                      key={column.id}
                      className={`px-3 py-2 align-top max-md:p-0 ${column.card ? '' : 'max-md:hidden'}`}
                    >
                      <Cell column={column.id} item={item} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {page && totalPages > 1 ? (
        <nav aria-label={t('pagination.label')} className="flex items-center justify-between gap-2">
          <Button
            variant="secondary"
            disabled={currentPage <= 1}
            onClick={() => {
              navigate(withParam(params, 'page', String(currentPage - 1)));
            }}
          >
            {t('pagination.previous')}
          </Button>
          <span className="text-sm">
            {t('pagination.page', { page: currentPage, total: totalPages })}
          </span>
          <Button
            variant="secondary"
            disabled={currentPage >= totalPages}
            onClick={() => {
              navigate(withParam(params, 'page', String(currentPage + 1)));
            }}
          >
            {t('pagination.next')}
          </Button>
        </nav>
      ) : null}

      <ProcessFiltersPanel
        key={filtersKey}
        open={filtersOpen}
        onOpenChange={setFiltersOpen}
        params={params}
        options={filterOptions}
        onApply={(changes) => {
          let next: ListParams = params;
          for (const [key, value] of Object.entries(changes) as [
            ProcessListParamKey,
            string | undefined,
          ][]) {
            next = withParam(next, key, value);
          }
          navigate(next);
        }}
      />
    </div>
  );
}

function isColumnId(value: string): value is ColumnId {
  return PROCESS_COLUMNS.some((column) => column.id === value);
}

function ListError({
  error,
  onRetry,
  compact = false,
}: {
  readonly error: unknown;
  readonly onRetry: () => void;
  readonly compact?: boolean;
}) {
  const t = useTranslations('processList.errors');
  const correlationId = isApiError(error) ? error.correlationId : null;
  const status = isApiError(error) ? error.status : 0;
  const message =
    status === 429
      ? t('rateLimited')
      : status === 422
        ? t('invalidFilters')
        : status >= 500 && status !== 503
          ? t('unexpected', { correlationId: correlationId ?? '—' })
          : t('unavailable');
  return (
    <Alert tone="error" title={message} live={!compact}>
      <div className="flex flex-col gap-2">
        {correlationId ? (
          <CorrelationCode
            correlationId={correlationId}
            labels={{ code: t('code', { correlationId }), copy: t('copy'), copied: t('copied') }}
          />
        ) : null}
        <div>
          <Button variant="secondary" size="sm" onClick={onRetry}>
            {t('retry')}
          </Button>
        </div>
      </div>
    </Alert>
  );
}

function Cell({ column, item }: { readonly column: ColumnId; readonly item: ProcessListItemDto }) {
  const t = useTranslations('processList');
  const format = useFormatter();
  const date = (iso: string | null, withTime = false) =>
    iso === null
      ? t('table.none')
      : withTime
        ? format.dateTime(new Date(iso), { dateStyle: 'short', timeStyle: 'short' })
        : format.dateTime(new Date(`${iso}T12:00:00Z`), { dateStyle: 'short', timeZone: 'UTC' });
  switch (column) {
    case 'code':
      return (
        <Link
          href={`/processos/${item.id}`}
          className="font-medium text-primary underline-offset-2 hover:underline"
        >
          {item.code ?? t('table.draftCode')}
        </Link>
      );
    case 'title':
      return (
        <div className="flex flex-col gap-1">
          <Link href={`/processos/${item.id}`} className="font-medium hover:underline">
            {item.title}
          </Link>
          {item.isBudgetConfidential ? <ConfidentialBadge /> : null}
        </div>
      );
    case 'status':
      return <ProcessStatusBadge status={item.status} />;
    case 'stage':
      return <>{item.currentStage?.name ?? t('table.none')}</>;
    case 'currentDepartment':
      return <>{item.currentDepartment.name}</>;
    case 'responsible':
      return (
        <>
          {item.currentResponsible?.name ?? t('table.queue', { unit: item.currentDepartment.name })}
        </>
      );
    case 'deadline':
      return <DueDateBadge deadline={item.deadline} />;
    case 'priority':
      return <PriorityBadge priority={item.priority} />;
    case 'requestingSecretariat':
      return <>{item.requestingSecretariat.name}</>;
    case 'requestingDepartment':
      return <>{item.requestingDepartment.name}</>;
    case 'contractingType':
      return <>{item.contractingType.label}</>;
    case 'modality':
      return <>{item.modality?.label ?? t('table.modalityNone')}</>;
    case 'origin':
      return <>{item.origin.label}</>;
    case 'estimatedValue':
      return <ConfidentialValue value={item.estimatedValue} masked={item.estimatedValueMasked} />;
    case 'targetDate':
      return <>{date(item.targetDate)}</>;
    case 'tags':
      return item.tags.length === 0 ? (
        <>{t('table.none')}</>
      ) : (
        <ul className="flex flex-wrap gap-1">
          {item.tags.map((tag) => (
            <li key={tag.id}>
              <TagChip name={tag.name} color={tag.color} isActive={tag.isActive} />
            </li>
          ))}
        </ul>
      );
    case 'internalCode':
      return <>{item.internalCode ?? t('table.none')}</>;
    case 'organization':
      return <>{item.organization.shortName}</>;
    case 'createdAt':
      return <>{date(item.createdAt, true)}</>;
    case 'updatedAt':
      return <>{date(item.updatedAt, true)}</>;
  }
}
