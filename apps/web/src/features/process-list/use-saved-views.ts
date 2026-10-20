'use client';

import { toast } from '@contrataflow/ui';
import type { ProcessColumnKey, SavedViewDto } from '@contrataflow/validation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { DEFAULT_LIST_PARAMS } from './process-list-state';
import type { ListParams } from './process-list-state';
import {
  applyView,
  classifyViewError,
  currentDefinition,
  findDefaultView,
  groupViews,
  hasUnsavedChanges,
  upsertView,
} from './saved-views-model';
import type { FilterAvailability, ViewFailure } from './saved-views-model';
import {
  SAVED_VIEWS_STALE_TIME_MS,
  SAVED_VIEW_SCOPE,
  createSavedView,
  deleteSavedView,
  fetchSavedViews,
  savedViewKeys,
  updateSavedView,
} from './saved-views.api';
import type { SavedViewPatch } from './saved-views.api';

/*
 * Estado das visões salvas de SCR-004 (US-003): lista (PRC-35), visão aplicada, "Alterações não
 * salvas", filtros desatualizados (FA-05), visão padrão ao abrir sem parâmetros (FA-01) e as
 * mutações (PRC-36..38). A consulta da lista continua na URL: aplicar = escrever filtros e
 * ordenação na URL e as colunas no estado da tela. A visão aplicada vive só neste estado.
 */

export interface SavedViewsArgs {
  readonly tenantId: string;
  /** A URL não tinha parâmetros (RN-PROC-30): candidata a receber a visão padrão. */
  readonly usedDefaults: boolean;
  readonly params: ListParams;
  /** Ids das colunas visíveis, na ordem da tela. */
  readonly visibleColumnIds: readonly string[];
  /** Colunas que a tela oferece hoje (a de órgão só com mais de um órgão; sem etiquetas). */
  readonly availableColumnKeys: ReadonlySet<ProcessColumnKey>;
  readonly availability: FilterAvailability;
  /** As opções de filtro terminaram de carregar (com ou sem erro). */
  readonly optionsSettled: boolean;
  readonly navigate: (next: ListParams, mode?: 'push' | 'replace') => void;
  /** Mostra exatamente estas colunas (sem gravar a preferência do usuário). */
  readonly applyColumns: (ids: string[]) => void;
  /** Volta às colunas da preferência do usuário. */
  readonly resetColumns: () => void;
}

export interface NewViewInput {
  readonly name: string;
  readonly isShared: boolean;
  readonly isDefault: boolean;
}

export function useSavedViews(args: SavedViewsArgs) {
  const t = useTranslations('processList.views');
  const queryClient = useQueryClient();
  const { tenantId, usedDefaults, params, visibleColumnIds } = args;
  const listKey = savedViewKeys.list(tenantId);

  const query = useQuery({
    queryKey: listKey,
    queryFn: ({ signal }) => fetchSavedViews(SAVED_VIEW_SCOPE, signal),
    staleTime: SAVED_VIEWS_STALE_TIME_MS,
    throwOnError: false,
    retry: false,
  });
  const views = useMemo(() => query.data ?? [], [query.data]);
  const grouped = useMemo(() => groupViews(views), [views]);

  const [appliedId, setAppliedId] = useState<string | null>(null);
  const [staleFilters, setStaleFilters] = useState(false);
  const [conflict, setConflict] = useState<ViewFailure | null>(null);
  const [updating, setUpdating] = useState(false);

  // Callbacks "ao vivo" sem entrar nas dependências dos efeitos.
  const live = useRef(args);
  useEffect(() => {
    live.current = args;
  });

  const applied = appliedId === null ? null : (views.find((view) => view.id === appliedId) ?? null);
  const current = useMemo(
    () => currentDefinition(params, visibleColumnIds),
    [params, visibleColumnIds],
  );
  const unsaved = applied !== null && hasUnsavedChanges(applied, current, args.availableColumnKeys);

  const apply = useCallback((view: SavedViewDto, mode: 'push' | 'replace' = 'push') => {
    const result = applyView(view, live.current.availability);
    live.current.navigate(result.params, mode);
    live.current.applyColumns(result.columnIds);
    setAppliedId(view.id);
    setStaleFilters(result.dropped);
    setConflict(null);
  }, []);

  // FA-01: sem parâmetros na URL, a visão padrão do usuário é aplicada (uma vez por chegada).
  const defaultView = findDefaultView(views);
  const defaultRequested = useRef(false);
  useEffect(() => {
    if (!usedDefaults) {
      defaultRequested.current = false;
      return;
    }
    if (query.isPending || defaultRequested.current) return;
    if (defaultView === undefined) {
      // Uma vez só: rodar de novo (ex.: as opções dos filtros chegando) apagaria a visão que a
      // pessoa acabou de escolher enquanto a URL ainda não mudou.
      defaultRequested.current = true;
      setAppliedId(null);
      return;
    }
    if (!args.optionsSettled) return;
    defaultRequested.current = true;
    apply(defaultView, 'replace');
  }, [usedDefaults, query.isPending, defaultView, args.optionsSettled, apply]);

  /** A lista espera a visão padrão para não consultar duas vezes (padrão da tela e depois a visão). */
  const awaitingDefault = usedDefaults && (query.isPending || defaultView !== undefined);

  const select = useCallback(
    (id: string) => {
      const view = views.find((item) => item.id === id);
      if (view !== undefined) apply(view);
    },
    [views, apply],
  );

  /** "Limpar": solta a visão e volta ao padrão da tela (RN-PROC-30) e às colunas do usuário. */
  const clear = useCallback(() => {
    setAppliedId(null);
    setStaleFilters(false);
    setConflict(null);
    live.current.navigate(DEFAULT_LIST_PARAMS);
    live.current.resetColumns();
  }, []);

  const store = useCallback(
    (saved: SavedViewDto) => {
      queryClient.setQueryData<SavedViewDto[]>(listKey, (old) => upsertView(old ?? [], saved));
    },
    [queryClient, tenantId],
  );

  const dropFromCache = useCallback(
    (id: string) => {
      queryClient.setQueryData<SavedViewDto[]>(listKey, (old) =>
        (old ?? []).filter((view) => view.id !== id),
      );
      setAppliedId((now) => (now === id ? null : now));
    },
    [queryClient, tenantId],
  );

  /** PRC-36 com os critérios atuais; a visão criada passa a ser a aplicada. */
  const create = async (input: NewViewInput, idempotencyKey: string): Promise<SavedViewDto> => {
    const saved = await createSavedView(
      {
        scope: SAVED_VIEW_SCOPE,
        name: input.name.trim(),
        filters: current.filters,
        sort: current.sort,
        columns: current.columns,
        isShared: input.isShared,
        isDefault: input.isDefault,
      },
      idempotencyKey,
    );
    store(saved);
    setAppliedId(saved.id);
    setStaleFilters(false);
    setConflict(null);
    toast({ title: t('created', { name: saved.name }), tone: 'success' });
    return saved;
  };

  /** FA-02: "Atualizar visão" (PRC-37 com `If-Match`); falhas viram `conflict` na tela. */
  const updateApplied = async (): Promise<void> => {
    if (!applied?.isOwner) return;
    setUpdating(true);
    setConflict(null);
    try {
      const saved = await updateSavedView(
        applied.id,
        { filters: current.filters, sort: current.sort, columns: current.columns },
        applied.version,
      );
      store(saved);
      setStaleFilters(false);
      toast({ title: t('updated', { name: saved.name }), tone: 'success' });
    } catch (error) {
      const failure = classifyViewError(error, 'change');
      if (failure.kind === 'notFound') {
        dropFromCache(applied.id);
        void query.refetch();
      }
      setConflict(failure);
    } finally {
      setUpdating(false);
    }
  };

  /** "Recarregar a visão": lê a versão atual no servidor e a reaplica (descarta as alterações). */
  const reloadApplied = async (): Promise<void> => {
    const id = appliedId;
    const result = await query.refetch();
    const fresh = result.data?.find((view) => view.id === id);
    if (fresh !== undefined) {
      apply(fresh);
      return;
    }
    setAppliedId(null);
    setConflict({ kind: 'notFound' });
  };

  /** Alteração de uma visão própria (renomear, padrão…) a partir de "Gerenciar visões". */
  const patch = async (view: SavedViewDto, changes: SavedViewPatch): Promise<SavedViewDto> => {
    const saved = await updateSavedView(view.id, changes, view.version);
    store(saved);
    return saved;
  };

  const remove = async (view: SavedViewDto): Promise<void> => {
    await deleteSavedView(view.id, view.version);
    dropFromCache(view.id);
  };

  return {
    views,
    grouped,
    isPending: query.isPending,
    isError: query.isError,
    refetch: query.refetch,
    applied,
    unsaved,
    staleFilters,
    conflict,
    dismissConflict: () => {
      setConflict(null);
    },
    updating,
    awaitingDefault,
    current,
    apply,
    select,
    clear,
    create,
    updateApplied,
    reloadApplied,
    patch,
    remove,
    dropFromCache,
  };
}

export type SavedViewsController = ReturnType<typeof useSavedViews>;
