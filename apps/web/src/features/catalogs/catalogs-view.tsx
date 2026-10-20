'use client';

import { CATALOG_TYPES } from '@contrataflow/types';
import type { CatalogType } from '@contrataflow/types';
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
import type { CatalogItemDto } from '@contrataflow/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { KeyboardEvent } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { Can } from '@/lib/permissions/can';
import { usePermission } from '@/lib/permissions/use-permission';
import { useTenantId } from '@/lib/session/session-context';

import { CatalogFormDialog } from './catalog-form-dialog';
import { CatalogItemTable } from './catalog-item-table';
import { hasNoActiveItems, moveId } from './catalog-model';
import {
  CATALOGS_STALE_TIME_MS,
  catalogKeys,
  fetchCatalogItems,
  reorderCatalogItems,
  setCatalogItemActive,
} from './catalogs.api';
import { TagsAdminPanel } from '../tags/tags-admin-panel';

/** Aba extra da SCR-109 (não é um catálogo): o cadastro de etiquetas (US-007). */
const TAGS_TAB = 'TAGS';

/**
 * SCR-109 — Administração › Catálogos (`/admin/catalogos` · US-104): abas por `catalogType`, cada
 * uma com a tabela reordenável dos itens (CAT-01), criação e edição (CAT-02/03), ativação e
 * desativação com `If-Match` (CAT-04/05) e reordenação (CAT-06). Leitura é capacidade implícita do
 * vínculo ativo; as ações de escrita só aparecem com `CATALOG_MANAGE` (a API decide cada
 * requisição). Estados: skeleton, vazio, "nenhum item ativo", erro com "Tentar novamente",
 * conflito de versão e indicador de salvamento. Com `TAG_MANAGE`, a aba "Etiquetas" (US-007) traz o
 * cadastro das etiquetas do órgão (`TagsAdminPanel`).
 */
export function CatalogsView() {
  const t = useTranslations('catalogs');
  const tTags = useTranslations('tags.admin');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const [catalogType, setCatalogType] = useState<CatalogType>(CATALOG_TYPES[0]);
  const canManageTags = usePermission('TAG_MANAGE').allowed;
  const [tagsSelected, setTagsSelected] = useState(false);
  const tagsActive = tagsSelected && canManageTags;
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<CatalogItemDto | null>(null);
  const [deactivating, setDeactivating] = useState<CatalogItemDto | null>(null);
  const [banner, setBanner] = useState<'conflict' | 'unavailable' | 'generic' | null>(null);

  const itemsKey = catalogKeys.items(tenantId, catalogType);
  const items = useQuery({
    queryKey: itemsKey,
    queryFn: async ({ signal }) => (await fetchCatalogItems(catalogType, signal)).data,
    staleTime: CATALOGS_STALE_TIME_MS,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: catalogKeys.all(tenantId) });
  };
  const reload = () => {
    setBanner(null);
    refresh();
  };
  /** 412 vindo do diálogo: avisa e relê a lista (a versão do item mudou). */
  const onConflict = () => {
    setBanner('conflict');
    refresh();
  };

  const failure = (error: unknown): void => {
    if (isApiError(error) && (error.status === 412 || error.status === 404)) {
      setBanner('conflict');
    } else {
      setBanner(isApiError(error) && error.status === 503 ? 'unavailable' : 'generic');
    }
    void queryClient.invalidateQueries({ queryKey: catalogKeys.all(tenantId) });
  };

  const setActive = useMutation({
    mutationFn: ({ item, isActive }: { item: CatalogItemDto; isActive: boolean }) =>
      setCatalogItemActive(item.id, isActive, item.version),
    onSuccess: (result, { isActive }) => {
      setBanner(null);
      setDeactivating(null);
      toast({
        title: t(isActive ? 'toast.activated' : 'toast.deactivated', { name: result.data.label }),
        tone: 'success',
      });
      void queryClient.invalidateQueries({ queryKey: catalogKeys.all(tenantId) });
    },
    onError: (error) => {
      setDeactivating(null);
      failure(error);
    },
  });

  const reorder = useMutation({
    mutationFn: (orderedIds: readonly string[]) => reorderCatalogItems(catalogType, orderedIds),
    onMutate: async (orderedIds) => {
      await queryClient.cancelQueries({ queryKey: itemsKey });
      const previous = queryClient.getQueryData<CatalogItemDto[]>(itemsKey);
      if (previous) {
        const byId = new Map(previous.map((item) => [item.id, item]));
        queryClient.setQueryData<CatalogItemDto[]>(
          itemsKey,
          orderedIds.flatMap((id) => {
            const found = byId.get(id);
            return found ? [found] : [];
          }),
        );
      }
      return { previous };
    },
    onSuccess: (result) => {
      setBanner(null);
      queryClient.setQueryData<CatalogItemDto[]>(itemsKey, result.data);
    },
    onError: (error, _ids, context) => {
      if (context?.previous) queryClient.setQueryData(itemsKey, context.previous);
      failure(error);
    },
  });

  const move = (from: number, to: number): void => {
    const current = items.data;
    if (!current || reorder.isPending) return;
    const next = moveId(
      current.map((item) => item.id),
      from,
      to,
    );
    if (next.every((id, index) => id === current[index]?.id)) return;
    reorder.mutate(next);
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const tabs: readonly (CatalogType | typeof TAGS_TAB)[] = canManageTags
      ? [...CATALOG_TYPES, TAGS_TAB]
      : CATALOG_TYPES;
    const last = tabs.length - 1;
    const target =
      event.key === 'ArrowRight'
        ? (index + 1) % tabs.length
        : event.key === 'ArrowLeft'
          ? (index - 1 + tabs.length) % tabs.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null;
    if (target === null) return;
    event.preventDefault();
    const next = tabs[target];
    if (next === TAGS_TAB) {
      setTagsSelected(true);
      setBanner(null);
      document.getElementById(`catalog-tab-${TAGS_TAB}`)?.focus();
    } else if (next) {
      setTagsSelected(false);
      setCatalogType(next);
      setBanner(null);
      document.getElementById(`catalog-tab-${next}`)?.focus();
    }
  };

  const saving = setActive.isPending || reorder.isPending;
  const catalogLabel = t(`types.${catalogType}`);

  return (
    <section className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="mt-1 max-w-3xl text-muted-foreground">{t('description')}</p>
      </header>

      <div
        role="tablist"
        aria-label={t('tabs.label')}
        className="flex flex-wrap gap-2 border-b border-border"
      >
        {CATALOG_TYPES.map((type, index) => (
          <button
            key={type}
            type="button"
            role="tab"
            id={`catalog-tab-${type}`}
            aria-selected={!tagsActive && type === catalogType}
            aria-controls="catalog-panel"
            tabIndex={!tagsActive && type === catalogType ? 0 : -1}
            className={`border-b-2 px-3 py-2 text-sm font-medium ${
              !tagsActive && type === catalogType
                ? 'border-primary'
                : 'border-transparent text-muted-foreground'
            }`}
            onClick={() => {
              setTagsSelected(false);
              setCatalogType(type);
              setBanner(null);
            }}
            onKeyDown={(event) => {
              onTabKeyDown(event, index);
            }}
          >
            {t(`types.${type}`)}
          </button>
        ))}
        {canManageTags ? (
          <button
            type="button"
            role="tab"
            id={`catalog-tab-${TAGS_TAB}`}
            aria-selected={tagsActive}
            aria-controls="catalog-panel"
            tabIndex={tagsActive ? 0 : -1}
            className={`border-b-2 px-3 py-2 text-sm font-medium ${
              tagsActive ? 'border-primary' : 'border-transparent text-muted-foreground'
            }`}
            onClick={() => {
              setTagsSelected(true);
              setBanner(null);
            }}
            onKeyDown={(event) => {
              onTabKeyDown(event, CATALOG_TYPES.length);
            }}
          >
            {tTags('tab')}
          </button>
        ) : null}
      </div>

      <div
        role="tabpanel"
        id="catalog-panel"
        aria-labelledby={`catalog-tab-${tagsActive ? TAGS_TAB : catalogType}`}
        className="flex flex-col gap-4"
      >
        {tagsActive ? (
          <TagsAdminPanel />
        ) : items.error && isApiError(items.error) && items.error.status === 403 ? (
          <Alert tone="error" title={t('errors.permission')} />
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <h2 className="text-lg font-semibold">{catalogLabel}</h2>
              <div className="flex items-center gap-3">
                <p role="status" className="text-sm text-muted-foreground">
                  {saving ? t('list.saving') : ''}
                </p>
                {items.data ? (
                  <Can permission="CATALOG_MANAGE">
                    <Button
                      onClick={() => {
                        setCreating(true);
                      }}
                    >
                      {t('list.new')}
                    </Button>
                  </Can>
                ) : null}
              </div>
            </div>

            {banner ? (
              <Alert
                tone={banner === 'conflict' ? 'warning' : 'error'}
                title={
                  banner === 'conflict'
                    ? t('conflict.title')
                    : banner === 'unavailable'
                      ? t('errors.unavailable')
                      : t('errors.generic')
                }
              >
                <Button variant="secondary" size="sm" onClick={reload}>
                  {banner === 'conflict' ? t('conflict.reload') : t('list.retry')}
                </Button>
              </Alert>
            ) : null}

            {items.isPending ? (
              <div role="status" className="flex flex-col gap-2">
                <span className="sr-only">{t('list.loading')}</span>
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : null}

            {items.isError ? (
              <Alert tone="error" title={t('list.loadFailed')}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    void items.refetch();
                  }}
                >
                  {t('list.retry')}
                </Button>
              </Alert>
            ) : null}

            {items.data?.length === 0 ? (
              <div className="rounded-card border border-dashed border-border p-6 text-center">
                <p className="font-medium">{t('list.empty')}</p>
                <p className="mt-1 text-sm text-muted-foreground">{t('list.emptyHint')}</p>
              </div>
            ) : null}

            {items.data && hasNoActiveItems(items.data) ? (
              <Alert tone="warning" title={t('list.noActive')}>
                {t('list.noActiveHint')}
              </Alert>
            ) : null}

            {items.data && items.data.length > 0 ? (
              <>
                <Can permission="CATALOG_MANAGE">
                  <p className="text-sm text-muted-foreground">{t('list.dragHint')}</p>
                </Can>
                <CatalogItemTable
                  caption={t('table.caption', { catalog: catalogLabel })}
                  items={items.data}
                  busy={saving}
                  onEdit={setEditing}
                  onDeactivate={setDeactivating}
                  onActivate={(item) => {
                    setActive.mutate({ item, isActive: true });
                  }}
                  onMove={move}
                />
              </>
            ) : null}
          </>
        )}
      </div>

      <CatalogFormDialog
        open={creating}
        onOpenChange={setCreating}
        catalogType={catalogType}
        onConflict={onConflict}
      />
      <CatalogFormDialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        catalogType={catalogType}
        item={editing ?? undefined}
        onConflict={onConflict}
      />

      <Dialog
        open={deactivating !== null}
        onOpenChange={(open) => {
          if (!open) setDeactivating(null);
        }}
      >
        <DialogContent>
          <DialogTitle>{t('deactivate.title', { name: deactivating?.label ?? '' })}</DialogTitle>
          <DialogDescription>{t('deactivate.description')}</DialogDescription>
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => {
                setDeactivating(null);
              }}
            >
              {t('deactivate.cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={setActive.isPending}
              aria-busy={setActive.isPending}
              onClick={() => {
                if (deactivating) setActive.mutate({ item: deactivating, isActive: false });
              }}
            >
              {t('deactivate.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
