'use client';

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
import type { SupplierDto } from '@contrataflow/validation';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useId, useMemo, useState } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { Can } from '@/lib/permissions/can';
import { useTenantId } from '@/lib/session/session-context';

import { SupplierFormDialog } from './supplier-form-dialog';
import { SupplierList } from './supplier-list';
import {
  EMPTY_SUPPLIER_FILTERS,
  SUPPLIERS_STALE_TIME_MS,
  deleteSupplier,
  fetchSuppliers,
  supplierKeys,
  updateSupplier,
} from './suppliers.api';
import type { SupplierListFilters } from './suppliers.api';

const DEBOUNCE_MS = 300;
const CONTROL = 'h-10 rounded-control border border-border bg-surface px-3 text-sm';

/**
 * SCR-107 (`/fornecedores` · US-025): lista de fornecedores do tenant (SUP-01) com busca (≥ 2
 * caracteres, com debounce), filtro Ativos/Inativos e paginação; "Novo fornecedor" (SUP-02),
 * edição, inativação/reativação (SUP-04, com `If-Match`) e exclusão (SUP-05) só com
 * `SUPPLIER_MANAGE`. Sem `SUPPLIER_VIEW` a API responde 403 e a tela mostra o aviso de acesso
 * (RN-FND-92). Excluir fornecedor em uso (409 `SUPPLIER_IN_USE`) oferece "Inativar" no lugar.
 */
export function SuppliersView() {
  const t = useTranslations('suppliers');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const ids = useId();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<SupplierDto | null>(null);
  const [deactivating, setDeactivating] = useState<SupplierDto | null>(null);
  const [deleting, setDeleting] = useState<SupplierDto | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [inUse, setInUse] = useState(false);

  const [search, setSearch] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [isActive, setIsActive] = useState<SupplierListFilters['isActive']>(
    EMPTY_SUPPLIER_FILTERS.isActive,
  );
  const filters = useMemo<SupplierListFilters>(
    () => ({ q: debouncedQ, isActive }),
    [debouncedQ, isActive],
  );
  // Qualquer mudança de filtro volta à página 1 (a página guarda os filtros em que foi escolhida).
  const filterKey = JSON.stringify(filters);
  const [pageState, setPageState] = useState({ key: filterKey, page: 1 });
  const page = pageState.key === filterKey ? pageState.page : 1;
  const goToPage = (next: number) => {
    setPageState({ key: filterKey, page: next });
  };

  // A busca só entra nos filtros depois do debounce e com ao menos 2 caracteres.
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQ(search.trim().length >= 2 ? search.trim() : '');
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [search]);

  const suppliers = useQuery({
    queryKey: supplierKeys.list(tenantId, filters, page),
    queryFn: ({ signal }) => fetchSuppliers(filters, page, signal),
    staleTime: SUPPLIERS_STALE_TIME_MS,
    placeholderData: keepPreviousData,
    // Erros (403, 5xx) são tratados na própria tela, com "Tentar novamente".
    throwOnError: false,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: supplierKeys.all(tenantId) });
  };

  const failure = (error: unknown): string => {
    if (!isApiError(error)) return t('errors.generic');
    if (error.status === 412) return t('errors.stale');
    if (error.status === 404) return t('errors.notFound');
    if (error.status === 403) return t('errors.permission');
    if (error.status === 503) return t('errors.unavailable');
    return error.message || t('errors.generic');
  };

  const setActive = useMutation({
    mutationFn: ({ supplier, active }: { supplier: SupplierDto; active: boolean }) =>
      updateSupplier(supplier.id, { isActive: active }, supplier.version),
    onSuccess: (result, { active }) => {
      toast({
        title: t(active ? 'toast.reactivated' : 'toast.deactivated', {
          name: result.data.legalName,
        }),
        tone: 'success',
      });
      setDeactivating(null);
      setDeleting(null);
      setInUse(false);
      setActionError(null);
      refresh();
    },
    onError: (error) => {
      setActionError(failure(error));
      // Versão desatualizada: a lista é relida e a pessoa tenta de novo.
      refresh();
    },
  });

  const remove = useMutation({
    mutationFn: (supplier: SupplierDto) => deleteSupplier(supplier.id, supplier.version),
    onSuccess: (_result, supplier) => {
      toast({ title: t('toast.deleted', { name: supplier.legalName }), tone: 'success' });
      setDeleting(null);
      setActionError(null);
      refresh();
    },
    onError: (error) => {
      if (isApiError(error) && error.code === 'SUPPLIER_IN_USE') {
        setInUse(true);
        setActionError(null);
        return;
      }
      setActionError(failure(error));
      refresh();
    },
  });

  if (suppliers.error && isApiError(suppliers.error) && suppliers.error.status === 403) {
    return (
      <Alert tone="error" title={t('forbidden.title')}>
        {t('forbidden.description')}
      </Alert>
    );
  }

  const items = suppliers.data?.items ?? [];
  const totalPages = suppliers.data?.totalPages ?? 1;
  const filtered = filters.q !== '' || filters.isActive !== '';

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h2 className="text-lg font-semibold">{t('list.title')}</h2>
        {suppliers.data ? (
          <Can permission="SUPPLIER_MANAGE">
            <Button
              onClick={() => {
                setCreating(true);
              }}
            >
              {t('list.new')}
            </Button>
          </Can>
        ) : null}
      </header>

      <form
        role="search"
        aria-label={t('list.title')}
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
        }}
      >
        <div className="flex flex-col gap-1">
          <label htmlFor={`${ids}-q`} className="text-sm font-medium">
            {t('filters.search')}
          </label>
          <input
            id={`${ids}-q`}
            type="search"
            autoComplete="off"
            className={CONTROL}
            value={search}
            aria-describedby={`${ids}-q-hint`}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
          <p id={`${ids}-q-hint`} className="text-xs text-muted-foreground">
            {t('filters.searchHint')}
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${ids}-status`} className="text-sm font-medium">
            {t('filters.status')}
          </label>
          <select
            id={`${ids}-status`}
            className={CONTROL}
            value={isActive}
            onChange={(event) => {
              const value = event.target.value;
              setIsActive(value === 'true' || value === 'false' ? value : '');
            }}
          >
            <option value="">{t('filters.all')}</option>
            <option value="true">{t('filters.active')}</option>
            <option value="false">{t('filters.inactive')}</option>
          </select>
        </div>
      </form>

      <div aria-live="polite">
        {actionError && deactivating === null && deleting === null ? (
          <Alert tone="error" title={actionError} />
        ) : null}
      </div>

      {suppliers.isPending ? (
        <div role="status" className="flex flex-col gap-2">
          <span className="sr-only">{t('list.loading')}</span>
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : null}

      {suppliers.isError ? (
        <Alert tone="error" title={t('list.loadFailed')}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void suppliers.refetch();
            }}
          >
            {t('list.retry')}
          </Button>
        </Alert>
      ) : null}

      {suppliers.data && items.length === 0 ? (
        <div className="rounded-card border border-dashed border-border p-6 text-center">
          <p className="font-medium">{filtered ? t('list.noResults') : t('list.empty')}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {filtered ? t('list.noResultsHint') : t('list.emptyHint')}
          </p>
        </div>
      ) : null}

      {items.length > 0 ? (
        <SupplierList
          suppliers={items}
          onEdit={setEditing}
          onDeactivate={(supplier) => {
            setActionError(null);
            setDeactivating(supplier);
          }}
          onReactivate={(supplier) => {
            setActionError(null);
            setActive.mutate({ supplier, active: true });
          }}
          onDelete={(supplier) => {
            setActionError(null);
            setInUse(false);
            setDeleting(supplier);
          }}
        />
      ) : null}

      {totalPages > 1 ? (
        <nav aria-label={t('list.pager')} className="flex items-center justify-between gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={page <= 1}
            onClick={() => {
              goToPage(Math.max(1, page - 1));
            }}
          >
            {t('list.previous')}
          </Button>
          <span className="text-sm text-muted-foreground">
            {t('list.pageOf', { page, total: totalPages })}
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => {
              goToPage(page + 1);
            }}
          >
            {t('list.next')}
          </Button>
        </nav>
      ) : null}

      <SupplierFormDialog open={creating} onOpenChange={setCreating} />
      <SupplierFormDialog
        open={editing !== null}
        supplier={editing ?? undefined}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      />

      <Dialog
        open={deactivating !== null}
        onOpenChange={(open) => {
          if (!open) setDeactivating(null);
        }}
      >
        <DialogContent>
          <DialogTitle>
            {t('deactivate.title', { name: deactivating?.legalName ?? '' })}
          </DialogTitle>
          <DialogDescription>{t('deactivate.description')}</DialogDescription>
          {actionError ? <Alert tone="error" title={actionError} /> : null}
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
                if (deactivating) setActive.mutate({ supplier: deactivating, active: false });
              }}
            >
              {t('deactivate.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <DialogContent>
          <DialogTitle>{t('delete.title', { name: deleting?.legalName ?? '' })}</DialogTitle>
          <DialogDescription>{t('delete.description')}</DialogDescription>
          {inUse ? (
            <Alert tone="warning" title={t('delete.inUse')}>
              {t('delete.inUseHint')}
            </Alert>
          ) : null}
          {actionError ? <Alert tone="error" title={actionError} /> : null}
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => {
                setDeleting(null);
              }}
            >
              {t('delete.cancel')}
            </Button>
            {inUse ? (
              <Button
                disabled={setActive.isPending}
                aria-busy={setActive.isPending}
                onClick={() => {
                  if (deleting) setActive.mutate({ supplier: deleting, active: false });
                }}
              >
                {t('delete.deactivateInstead')}
              </Button>
            ) : (
              <Button
                variant="destructive"
                disabled={remove.isPending}
                aria-busy={remove.isPending}
                onClick={() => {
                  if (deleting) remove.mutate(deleting);
                }}
              >
                {t('delete.confirm')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
