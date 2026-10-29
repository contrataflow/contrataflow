'use client';

import {
  Alert,
  Building2,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  EmptyState,
  Field,
  FilterToolbar,
  ListPage,
  Plus,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  TableContainer,
  TableFooter,
  toast,
} from '@contrataflow/ui';
import type { SupplierDto } from '@contrataflow/validation';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';

import { AppPageHeader } from '@/components/shell/page-header';
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
/** O `Select` do kit não aceita valor vazio: "Todos" usa este marcador. */
const ALL = 'all';

/**
 * SCR-107 (`/fornecedores` · US-025): lista de fornecedores do tenant (SUP-01) com busca (≥ 2
 * caracteres, com debounce), filtro Ativos/Inativos e paginação; "Novo fornecedor" (SUP-02),
 * edição, inativação/reativação (SUP-04, com `If-Match`) e exclusão (SUP-05) só com
 * `SUPPLIER_MANAGE`. Sem `SUPPLIER_VIEW` a API responde 403 e a tela mostra o aviso de acesso
 * (RN-FND-92). Excluir fornecedor em uso (409 `SUPPLIER_IN_USE`) oferece "Inativar" no lugar.
 * Modelo `ListPage` (prd-5): "Novo fornecedor" no cabeçalho, busca inline e situação no popover
 * "Filtros" com chip, ações da linha no menu ⋯ e formulário no painel lateral.
 */
export function SuppliersView() {
  const t = useTranslations('suppliers');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
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
      <ListPage
        header={<AppPageHeader title={t('title')} description={t('description')} />}
        error={
          <Alert tone="error" title={t('forbidden.title')}>
            {t('forbidden.description')}
          </Alert>
        }
      />
    );
  }

  const items = suppliers.data?.items ?? [];
  const totalPages = suppliers.data?.totalPages ?? 1;
  const filtered = filters.q !== '' || filters.isActive !== '';
  const statusLabel = (value: SupplierListFilters['isActive']) =>
    value === 'true' ? t('filters.active') : t('filters.inactive');

  return (
    <ListPage
      header={
        <AppPageHeader
          title={t('title')}
          description={t('description')}
          actions={
            suppliers.data ? (
              <Can permission="SUPPLIER_MANAGE">
                <Button
                  iconLeft={<Plus />}
                  onClick={() => {
                    setCreating(true);
                  }}
                >
                  {t('list.new')}
                </Button>
              </Can>
            ) : null
          }
        />
      }
      toolbar={
        <FilterToolbar
          search={{
            value: search,
            onChange: setSearch,
            label: t('filters.search'),
            placeholder: t('filters.searchPlaceholder'),
            description: t('filters.searchHint'),
          }}
          activeCount={isActive === '' ? 0 : 1}
          filters={
            <Field label={t('filters.status')}>
              <Select
                value={isActive === '' ? ALL : isActive}
                onValueChange={(value) => {
                  setIsActive(value === 'true' || value === 'false' ? value : '');
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>{t('filters.all')}</SelectItem>
                  <SelectItem value="true">{t('filters.active')}</SelectItem>
                  <SelectItem value="false">{t('filters.inactive')}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          }
          chips={
            isActive === ''
              ? []
              : [
                  {
                    id: 'status',
                    label: t('filters.chip', { value: statusLabel(isActive) }),
                    removeLabel: t('filters.removeChip', { value: statusLabel(isActive) }),
                    onRemove: () => {
                      setIsActive('');
                    },
                  },
                ]
          }
        />
      }
      notices={
        <div aria-live="polite" className="empty:hidden">
          {actionError && deactivating === null && deleting === null ? (
            <Alert tone="error" title={actionError} />
          ) : null}
        </div>
      }
      loading={suppliers.isPending}
      loadingLabel={t('list.loading')}
      error={
        suppliers.isError ? (
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
        ) : null
      }
      empty={
        suppliers.data && items.length === 0 ? (
          <EmptyState
            icon={<Building2 />}
            title={filtered ? t('list.noResults') : t('list.empty')}
            description={filtered ? t('list.noResultsHint') : t('list.emptyHint')}
            action={
              filtered ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setSearch('');
                    setDebouncedQ('');
                    setIsActive('');
                  }}
                >
                  {t('filters.clear')}
                </Button>
              ) : (
                <Can permission="SUPPLIER_MANAGE">
                  <Button
                    iconLeft={<Plus />}
                    onClick={() => {
                      setCreating(true);
                    }}
                  >
                    {t('list.new')}
                  </Button>
                </Can>
              )
            }
          />
        ) : null
      }
    >
      {items.length > 0 && suppliers.data ? (
        <TableContainer
          label={t('table.caption')}
          footer={
            <TableFooter summary={t('list.count', { count: suppliers.data.totalItems })}>
              {totalPages > 1 ? (
                <nav aria-label={t('list.pager')} className="flex items-center gap-2">
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
                  <span>{t('list.pageOf', { page, total: totalPages })}</span>
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
            </TableFooter>
          }
        >
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
        </TableContainer>
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
    </ListPage>
  );
}
