'use client';

import {
  Alert,
  Avatar,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  FilterChip,
  Skeleton,
  Table,
  TableBody,
  TableContainer,
  TableFooter,
  TableHead,
  Td,
  Th,
  Tr,
  ViewTabs,
  buttonClassName,
} from '@contrataflow/ui';
import type { LinkComponent } from '@contrataflow/ui';
import { PROCESS_LIST_DEFAULT_PAGE_SIZE, PROCESS_LIST_MESSAGES } from '@contrataflow/validation';
import type {
  ProcessListItemDto,
  ProcessListParamKey,
  ProcessListSortField,
  ProcessStageOptionDto,
  ProcessStatus,
} from '@contrataflow/validation';
import { keepPreviousData, useQueries, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentProps, MouseEvent } from 'react';

import { CorrelationCode } from '@/components/errors/correlation-code';
import { ErrorView } from '@/components/errors/error-view';
import { Icon } from '@/components/shell/icons';
import { AppPageHeader } from '@/components/shell/page-header';
import { NEW_PROCESS_PATH } from '@/features/processes/new-process-button';
import { ProcessStatusBadge } from '@/features/processes/process-status-badge';
import type { Messages } from '@/i18n/messages';
import { isApiError } from '@/lib/api/api-error';
import { usePermission } from '@/lib/permissions/use-permission';
import { HOME_PATH } from '@/lib/routes';
import { useShellSession, useTenantId } from '@/lib/session/session-context';

import { ExportCsvDialog } from './export-csv-dialog';
import { ProcessFiltersPanel } from './process-filters-panel';
import type { FilterOptions } from './process-filters-panel';
import {
  ConfidentialBadge,
  ConfidentialValue,
  DueDateText,
  PriorityBadge,
  formatBrl,
} from './process-list-badges';
import {
  LIST_TABS,
  activeFilterKeys,
  activeTabOf,
  clearFilters,
  hasValueFilter,
  isQuickFilterActive,
  primarySort,
  resolveListState,
  searchValue,
  tabCountQuery,
  toApiQuery,
  toSearchString,
  toggleSort,
  valuesOf,
  withParam,
  withTab,
} from './process-list-state';
import type { ListParams, ListTab, SortState } from './process-list-state';
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
 * filtra, ordena e pagina), busca com debounce, atalhos em abas com contador, painel de filtros,
 * chips, menu de ordenação e escolha de colunas (repaginação — prd-4). A URL é o estado da consulta
 * (link compartilhável); abaixo de 768 px cada linha vira um cartão (FA-09). A API decide
 * visibilidade e sigilo; a tela só apresenta.
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

/**
 * Colunas da tabela "Colunas" da US-002, na ordem da repaginação (prd-4): o padrão segue o mockup
 * (Número, Objeto, Secretaria, Etapa atual, Responsável, Prazo da etapa, Situação); "Etiquetas"
 * (US-007), unidade atual e prioridade ficam no seletor de colunas.
 */
export const PROCESS_COLUMNS: readonly ColumnDef[] = [
  { id: 'code', sort: 'code', fixed: true, card: true },
  { id: 'title', sort: 'title', fixed: true, card: true },
  { id: 'requestingSecretariat', visibleByDefault: true },
  { id: 'stage', visibleByDefault: true, card: true },
  { id: 'responsible', visibleByDefault: true, card: true },
  { id: 'deadline', sort: 'currentStageDueAt', visibleByDefault: true, card: true },
  { id: 'status', sort: 'status', visibleByDefault: true, card: true },
  { id: 'currentDepartment' },
  { id: 'priority', sort: 'priority' },
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

/** Atalhos do menu ⋯ da linha: abas do processo (`?aba=`) — as ações com diálogo ficam no processo. */
const ROW_LINKS = [
  { key: 'open', tab: null },
  { key: 'documents', tab: 'documentos' },
  { key: 'movements', tab: 'tramitacao' },
  { key: 'comments', tab: 'comentarios' },
] as const;

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
  const tExport = useTranslations('processList.export');
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

  // Contadores das abas: o total de cada aba com os demais filtros (`pageSize=1`); a aba ativa usa
  // o total da própria lista. Sem contrato novo na API (prd-4).
  const activeTab = activeTabOf(params);
  const countedTabs = LIST_TABS.filter((tab) => tab !== activeTab);
  const tabCounts = useQueries({
    queries: countedTabs.map((tab) => {
      const query = tabCountQuery(params, tab);
      return {
        queryKey: processListKeys.list(tenantId, query),
        queryFn: async ({ signal }: { signal: AbortSignal }) =>
          (await fetchProcessList(query, signal)).meta.totalItems,
        enabled: !views.awaitingDefault,
        staleTime: PROCESS_LIST_STALE_TIME_MS,
        throwOnError: false,
        retry: false,
      };
    }),
  });

  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filtersKey, setFiltersKey] = useState(0);
  const [exportOpen, setExportOpen] = useState(false);
  const exportReturnFocus = useRef<HTMLElement | null>(null);
  const openExport = (trigger: HTMLElement | null) => {
    exportReturnFocus.current = trigger;
    setExportOpen(true);
  };

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

  const isExternal = membershipType === 'EXTERNAL';
  const pageSize = page?.meta.pageSize ?? PROCESS_LIST_DEFAULT_PAGE_SIZE;
  const firstShown = items.length === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const lastShown = items.length === 0 ? 0 : firstShown + items.length - 1;
  const countOf = (tab: ListTab): number | undefined =>
    tab === activeTab ? page?.meta.totalItems : tabCounts[countedTabs.indexOf(tab)]?.data;

  return (
    <div className="flex flex-col gap-5">
      <AppPageHeader
        breadcrumbs={[{ label: t('breadcrumbHome'), href: HOME_PATH }, { label: t('title') }]}
        title={t('title')}
        description={t('description')}
        actions={
          <>
            {canExport ? (
              <Button
                variant="secondary"
                onClick={(event) => {
                  openExport(event.currentTarget);
                }}
              >
                <Icon name="download" />
                {tExport('button')}
              </Button>
            ) : null}
            {canCreate && !isExternal ? (
              <Link href={NEW_PROCESS_PATH} className={buttonClassName({})}>
                <Icon name="plus" />
                {t('newProcess')}
              </Link>
            ) : null}
          </>
        }
      />

      <div role="status" aria-live="polite" className="sr-only">
        {page ? t('announce', { count: total }) : ''}
      </div>

      {invalidLink ? (
        <Alert tone="warning" title={PROCESS_LIST_MESSAGES.invalidLink} live={false} />
      ) : null}

      <SavedViewsToolbar
        controller={views}
        canExport={canExport}
        onExport={openExport}
        summarize={() => summarizeCriteria(params, criteriaLabels)}
      />

      <ViewTabs
        label={t('tabs.label')}
        value={activeTab ?? ''}
        linkComponent={RouterLink}
        tabs={LIST_TABS.map((tab) => ({
          id: tab,
          label: t(`tabs.${tab}`),
          count: countOf(tab),
          href: `${pathname}?${toSearchString(withTab(params, tab))}`,
        }))}
      />

      <div className="flex flex-wrap items-center gap-2.5">
        <div className="flex min-w-0 flex-[1_1_16rem] flex-col gap-1 md:max-w-sm">
          <label className="relative flex items-center">
            <span className="sr-only">{t('search.label')}</span>
            <Icon
              name="search"
              className="pointer-events-none absolute left-3 size-4 text-muted-foreground"
            />
            <input
              type="search"
              value={searchText}
              placeholder={t('search.placeholder')}
              aria-describedby={searchTooShort ? 'process-search-hint' : undefined}
              onChange={(event) => {
                setSearchText(event.target.value);
              }}
              className="h-11 w-full rounded-control border border-border-strong bg-surface pr-3 pl-9 text-sm md:h-10"
            />
          </label>
          {searchTooShort ? (
            <p id="process-search-hint" className="text-xs text-muted-foreground">
              {t('search.tooShort')}
            </p>
          ) : null}
        </div>

        {activeKeys.length > 0 ? (
          <ul aria-label={t('filters.active')} className="flex flex-wrap items-center gap-2">
            {activeKeys.map((key) => {
              const label = chipLabel(key);
              const value = chipValue(key, params[key] ?? '');
              return (
                <li key={key}>
                  <FilterChip
                    removeLabel={t('filters.remove', { label: `${label}: ${value}` })}
                    onRemove={() => {
                      navigate(withParam(params, key, undefined));
                    }}
                  >
                    {t('filters.chip', { label, value })}
                  </FilterChip>
                </li>
              );
            })}
          </ul>
        ) : null}
        <button
          type="button"
          onClick={() => {
            setFiltersKey((key) => key + 1);
            setFiltersOpen(true);
          }}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-dashed border-border-strong bg-surface px-3 text-[0.8125rem] font-semibold text-foreground hover:border-primary hover:text-primary-soft-foreground md:min-h-9"
        >
          <Icon name="plus" className="size-3.5" />
          {t('filters.open')}
        </button>
        {activeKeys.length > 0 ? (
          <button
            type="button"
            className="min-h-11 px-1 text-[0.8125rem] font-semibold text-primary-soft-foreground underline-offset-2 hover:underline md:min-h-9"
            onClick={() => {
              navigate(clearFilters(params));
            }}
          >
            {t('filters.clear')}
          </button>
        ) : null}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <SortMenu
            sort={sort}
            onSelect={(value) => {
              navigate(withParam(params, 'sort', value));
            }}
          />
          <div className="relative hidden md:block">
            <Button
              variant="secondary"
              size="sm"
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
                className="absolute right-0 z-20 mt-1 flex w-64 flex-col gap-1 rounded-card border border-border bg-surface p-3 shadow-lg"
              >
                <legend className="sr-only">{t('columns.chooserTitle')}</legend>
                {offered.map((column) => (
                  <label key={column.id} className="flex min-h-8 items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={column.fixed === true || columns.includes(column.id)}
                      disabled={column.fixed}
                      onChange={() => {
                        toggleColumn(column.id);
                      }}
                      className="size-4 accent-primary"
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

      {isQuickFilterActive(params, 'mine') ? (
        <Link
          href="/aprovacoes"
          className="self-start text-sm font-semibold text-primary-soft-foreground underline-offset-2 hover:underline"
        >
          {t('quick.pendingApprovals')}
        </Link>
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

      {list.isPending ? <ListSkeleton label={t('loading')} /> : null}

      {list.isFetching && page ? (
        <div
          role="progressbar"
          aria-label={t('refreshing')}
          className="h-1 w-full animate-pulse rounded bg-primary/40"
        />
      ) : null}

      {page && items.length === 0 ? (
        <EmptyState
          icon={<Icon name="folder" />}
          title={t('empty.title')}
          description={
            showNoProcesses
              ? isExternal
                ? t('empty.external')
                : t('empty.none')
              : t('empty.filtered')
          }
          action={
            showNoProcesses ? (
              canCreate && !isExternal ? (
                <Link href={NEW_PROCESS_PATH} className={buttonClassName({})}>
                  <Icon name="plus" />
                  {t('empty.create')}
                </Link>
              ) : null
            ) : (
              <>
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
              </>
            )
          }
        />
      ) : null}

      {items.length > 0 ? (
        <TableContainer
          label={t('table.caption')}
          footer={
            <TableFooter
              summary={t('pagination.showing', {
                from: firstShown,
                to: lastShown,
                total,
              })}
            >
              {totalPages > 1 ? (
                <Pagination
                  page={currentPage}
                  totalPages={totalPages}
                  onChange={(next) => {
                    navigate(withParam(params, 'page', String(next)));
                  }}
                />
              ) : null}
            </TableFooter>
          }
        >
          <Table className="md:min-w-[64rem]">
            <caption className="sr-only">{t('table.caption')}</caption>
            <TableHead className="max-md:sr-only">
              <Tr>
                {visible.map((column) => {
                  const sorted = sort?.field === column.sort ? sort : null;
                  const field = column.sort;
                  return (
                    <Th
                      key={column.id}
                      sort={
                        sorted
                          ? sorted.direction === 'asc'
                            ? 'ascending'
                            : 'descending'
                          : undefined
                      }
                      onSort={
                        field
                          ? () => {
                              navigate(toggleSort(params, field));
                            }
                          : undefined
                      }
                    >
                      {t(`columns.${column.id}`)}
                    </Th>
                  );
                })}
                <Th className="w-14">
                  <span className="sr-only">{t('row.actionsColumn')}</span>
                </Th>
              </Tr>
            </TableHead>
            <TableBody>
              {items.map((item) => (
                <Tr
                  key={item.id}
                  className="max-md:relative max-md:flex max-md:flex-col max-md:gap-1.5 max-md:p-4 max-md:pr-14"
                >
                  {visible.map((column) => (
                    <Td key={column.id} className={column.card ? 'max-md:p-0' : 'max-md:hidden'}>
                      <Cell column={column.id} item={item} />
                    </Td>
                  ))}
                  <Td className="text-right max-md:absolute max-md:top-2 max-md:right-2 max-md:p-0">
                    <RowMenu item={item} />
                  </Td>
                </Tr>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
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
      {exportOpen ? (
        <ExportCsvDialog
          open
          onOpenChange={(isOpen) => {
            if (!isOpen) setExportOpen(false);
          }}
          total={page && !list.isFetching ? total : undefined}
          columns={exportColumns}
          buildQuery={() => exportQuery(params, columnKeysFromVisible(visibleIds), exportViewId)}
          returnFocusRef={exportReturnFocus}
        />
      ) : null}
    </div>
  );
}

/** Link das abas: navega pelo roteador sem rolar; o `href` real mantém "abrir em nova aba". */
function RouterLink({ href, className, children, ...rest }: ComponentProps<LinkComponent>) {
  const router = useRouter();
  return (
    <a
      href={href}
      className={className}
      aria-current={rest['aria-current']}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
          return;
        event.preventDefault();
        router.push(href, { scroll: false });
      }}
    >
      {children}
    </a>
  );
}

/** Campos do menu "Ordenar" (os mesmos do cabeçalho — RN-PROC-27). */
const SORTABLE_COLUMNS = PROCESS_COLUMNS.filter(
  (column): column is ColumnDef & { readonly sort: ProcessListSortField } =>
    column.sort !== undefined,
);

/** "Ordenar: Prazo da etapa": escolhe o campo e a direção; com busca e sem `sort`, relevância. */
function SortMenu({
  sort,
  onSelect,
}: {
  readonly sort: SortState | null;
  readonly onSelect: (sort: string) => void;
}) {
  const t = useTranslations('processList');
  const column = SORTABLE_COLUMNS.find((candidate) => candidate.sort === sort?.field);
  const current = sort ? (column ? t(`columns.${column.id}`) : sort.field) : t('sort.relevance');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex min-h-11 items-center gap-2 rounded-control border border-border-strong bg-surface px-3 text-[0.8125rem] font-medium text-foreground hover:bg-muted md:min-h-9"
        >
          {t('sort.trigger', { label: current })}
          {sort ? (
            <span className="sr-only">
              {`, ${t(sort.direction === 'asc' ? 'sort.ascShort' : 'sort.descShort')}`}
            </span>
          ) : null}
          <Icon name="chevronDown" className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel>{t('sort.menu')}</DropdownMenuLabel>
        <DropdownMenuGroup>
          {SORTABLE_COLUMNS.map((option) => {
            const active = sort !== null && sort.field === option.sort;
            return (
              <DropdownMenuItem
                key={option.id}
                onSelect={() => {
                  onSelect(active && sort.direction === 'desc' ? `-${option.sort}` : option.sort);
                }}
              >
                <span className="flex-1">{t(`columns.${option.id}`)}</span>
                {active ? (
                  <>
                    <Icon name="check" className="size-4 text-primary" />
                    <span className="sr-only">{t('sort.current')}</span>
                  </>
                ) : null}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>
        {sort ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t('sort.direction')}</DropdownMenuLabel>
            <DropdownMenuGroup>
              {(['asc', 'desc'] as const).map((direction) => (
                <DropdownMenuItem
                  key={direction}
                  onSelect={() => {
                    onSelect(`${direction === 'desc' ? '-' : ''}${sort.field}`);
                  }}
                >
                  <span className="flex-1">{t(`sort.${direction}`)}</span>
                  {sort.direction === direction ? (
                    <>
                      <Icon name="check" className="size-4 text-primary" />
                      <span className="sr-only">{t('sort.current')}</span>
                    </>
                  ) : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Até 5 páginas numeradas em volta da atual. */
function pageWindow(page: number, totalPages: number): number[] {
  const start = Math.max(1, Math.min(page - 2, totalPages - 4));
  const end = Math.min(totalPages, start + 4);
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function Pagination({
  page,
  totalPages,
  onChange,
}: {
  readonly page: number;
  readonly totalPages: number;
  readonly onChange: (page: number) => void;
}) {
  const t = useTranslations('processList.pagination');
  return (
    <nav aria-label={t('label')} className="flex flex-wrap items-center gap-1.5">
      <Button
        variant="secondary"
        size="sm"
        className="max-md:min-h-11"
        disabled={page <= 1}
        onClick={() => {
          onChange(page - 1);
        }}
      >
        {t('previous')}
      </Button>
      {pageWindow(page, totalPages).map((number) => (
        <button
          key={number}
          type="button"
          aria-label={t('goTo', { page: number })}
          aria-current={number === page ? 'page' : undefined}
          onClick={() => {
            onChange(number);
          }}
          className={
            number === page
              ? 'grid size-11 place-items-center rounded-control bg-primary text-[0.8125rem] font-bold text-primary-foreground md:size-9'
              : 'grid size-11 place-items-center rounded-control border border-border-strong bg-surface text-[0.8125rem] text-foreground hover:bg-muted md:size-9'
          }
        >
          {number}
        </button>
      ))}
      <Button
        variant="secondary"
        size="sm"
        className="max-md:min-h-11"
        disabled={page >= totalPages}
        onClick={() => {
          onChange(page + 1);
        }}
      >
        {t('next')}
      </Button>
    </nav>
  );
}

/** Esqueleto da tabela enquanto a primeira consulta não volta. */
function ListSkeleton({ label }: { readonly label: string }) {
  return (
    <div
      role="status"
      className="overflow-hidden rounded-card border border-border bg-surface shadow-card"
    >
      <span className="sr-only">{label}</span>
      <div className="h-11 border-b border-border bg-muted/60" />
      {Array.from({ length: 8 }, (_, index) => (
        <div
          key={index}
          className="flex items-center gap-4 border-b border-border px-3.5 py-3.5 last:border-b-0"
        >
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="hidden h-4 w-28 md:block" />
          <Skeleton className="size-7 flex-none rounded-full" />
          <Skeleton className="hidden h-4 w-28 md:block" />
          <Skeleton className="h-5 w-24 rounded-full" />
        </div>
      ))}
    </div>
  );
}

/** Menu ⋯ da linha: atalhos para o processo e suas abas (sem ação em lote nesta tela). */
function RowMenu({ item }: { readonly item: ProcessListItemDto }) {
  const t = useTranslations('processList');
  const code = item.code ?? t('table.draftCode');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('row.actions', { code })}
          className="inline-grid size-11 place-items-center rounded-control text-muted-foreground hover:bg-muted hover:text-foreground md:size-9"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" className="size-[1.125rem] fill-current">
            <circle cx="5" cy="12" r="2" />
            <circle cx="12" cy="12" r="2" />
            <circle cx="19" cy="12" r="2" />
          </svg>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {ROW_LINKS.map((link) => (
          <DropdownMenuItem key={link.key} asChild>
            <Link
              href={
                link.tab === null
                  ? `/processos/${item.id}`
                  : `/processos/${item.id}?aba=${link.tab}`
              }
            >
              {t(`row.${link.key}`)}
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
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
          className="font-bold whitespace-nowrap text-primary-soft-foreground underline-offset-2 hover:underline"
        >
          {item.code ?? t('table.draftCode')}
        </Link>
      );
    case 'title':
      return (
        <div className="flex min-w-48 flex-col items-start gap-0.5">
          <Link
            href={`/processos/${item.id}`}
            className="font-semibold text-brand-ink underline-offset-2 hover:underline"
          >
            {item.title}
          </Link>
          <span className="text-xs text-muted-foreground">
            {item.modality
              ? t('row.typeLine', {
                  modality: item.modality.label,
                  type: item.contractingType.label,
                })
              : item.contractingType.label}
          </span>
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
      return item.currentResponsible ? (
        <span className="inline-flex items-center gap-2 whitespace-nowrap">
          <Avatar name={item.currentResponsible.name} size="sm" />
          <span>{item.currentResponsible.name}</span>
        </span>
      ) : (
        <span className="text-muted-foreground">
          {t('table.queue', { unit: item.currentDepartment.name })}
        </span>
      );
    case 'deadline':
      return <DueDateText deadline={item.deadline} overdueSince={item.overdueSince} />;
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
