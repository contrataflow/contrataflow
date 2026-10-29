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
import { ORGANIZATION_TYPES } from '@contrataflow/validation';
import type { OrganizationDto, OrganizationType } from '@contrataflow/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { Can } from '@/lib/permissions/can';
import { useTenantId } from '@/lib/session/session-context';

import { OrganizationFormDialog } from './organization-form-dialog';
import { OrganizationList } from './organization-list';
import {
  ORGANIZATIONS_STALE_TIME_MS,
  fetchOrganizations,
  organizationKeys,
  updateOrganization,
} from './organizations.api';
import { PrimaryAction } from './primary-action-slot';
import type { PrimaryActionSlot } from './primary-action-slot';

/** O `Select` do kit não aceita valor vazio: "Todos" usa este marcador. */
const ALL = 'all';
type StatusFilter = typeof ALL | 'active' | 'inactive';

const normalize = (value: string): string =>
  value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export interface OrganizationsViewProps {
  /** Lugar da ação "Novo órgão" no cabeçalho da página (ver `PrimaryAction`). */
  readonly actionsSlot?: PrimaryActionSlot;
}

/**
 * Aba "Órgãos" do SCR-032 (`/admin/estrutura` — US-101): lista os órgãos do tenant (ORG-01),
 * cria (ORG-02) e edita/inativa/reativa (ORG-04, com `If-Match`). Leitura é capacidade implícita;
 * as ações de escrita só aparecem com `ORGANIZATION_MANAGE`. Modelo `ListPage` (prd-5): "Novo
 * órgão" no cabeçalho, busca inline (no navegador — a API devolve todos os órgãos), situação e
 * tipo no popover "Filtros" com chips, ações da linha no menu ⋯ e formulário no painel lateral.
 * Estados: esqueleto, vazio, erro com "Tentar novamente" e conflito de versão.
 */
export function OrganizationsView({ actionsSlot }: OrganizationsViewProps = {}) {
  const t = useTranslations('organizations');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<OrganizationDto | null>(null);
  const [deactivating, setDeactivating] = useState<OrganizationDto | null>(null);
  const [deactivationError, setDeactivationError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>(ALL);
  const [type, setType] = useState<OrganizationType | typeof ALL>(ALL);

  const organizations = useQuery({
    queryKey: organizationKeys.list(tenantId),
    queryFn: async ({ signal }) => (await fetchOrganizations(signal)).data,
    staleTime: ORGANIZATIONS_STALE_TIME_MS,
  });

  const setActive = useMutation({
    mutationFn: ({
      organization,
      isActive,
    }: {
      organization: OrganizationDto;
      isActive: boolean;
    }) => updateOrganization(organization.id, { isActive }, organization.version),
    onSuccess: (result, { isActive }) => {
      toast({
        title: t(isActive ? 'toast.reactivated' : 'toast.deactivated', { name: result.data.name }),
        tone: 'success',
      });
      setDeactivating(null);
      setDeactivationError(null);
      void queryClient.invalidateQueries({ queryKey: organizationKeys.all(tenantId) });
    },
    onError: (error) => {
      setDeactivationError(isApiError(error) ? error.message : t('errors.generic'));
      // Versão desatualizada ou regra do órgão principal: a lista é relida (FA-04/FA-05).
      void queryClient.invalidateQueries({ queryKey: organizationKeys.all(tenantId) });
    },
  });

  const filtered = useMemo(() => {
    const term = normalize(search.trim());
    const digits = search.replace(/[^0-9A-Za-z]/g, '').toLowerCase();
    return (organizations.data ?? []).filter((organization) => {
      if (status === 'active' && !organization.isActive) return false;
      if (status === 'inactive' && organization.isActive) return false;
      if (type !== ALL && organization.type !== type) return false;
      if (term === '') return true;
      return (
        normalize(organization.name).includes(term) ||
        normalize(organization.shortName).includes(term) ||
        (digits.length >= 2 && organization.cnpj.toLowerCase().includes(digits))
      );
    });
  }, [organizations.data, search, status, type]);

  if (
    organizations.error &&
    isApiError(organizations.error) &&
    organizations.error.status === 403
  ) {
    return (
      <ListPage
        header={null}
        error={
          <Alert tone="error" title={t('forbidden.title')}>
            {t('forbidden.description')}
          </Alert>
        }
      />
    );
  }

  const total = organizations.data?.length ?? 0;
  const hasFilters = search.trim() !== '' || status !== ALL || type !== ALL;
  const statusLabel = (value: StatusFilter) =>
    value === 'active' ? t('filters.active') : t('filters.inactive');
  const chips = [
    ...(status === ALL
      ? []
      : [
          {
            id: 'status',
            label: t('filters.statusChip', { value: statusLabel(status) }),
            removeLabel: t('filters.removeStatusChip', { value: statusLabel(status) }),
            onRemove: () => {
              setStatus(ALL);
            },
          },
        ]),
    ...(type === ALL
      ? []
      : [
          {
            id: 'type',
            label: t('filters.typeChip', { value: t(`types.${type}`) }),
            removeLabel: t('filters.removeTypeChip', { value: t(`types.${type}`) }),
            onRemove: () => {
              setType(ALL);
            },
          },
        ]),
  ];
  const clear = () => {
    setSearch('');
    setStatus(ALL);
    setType(ALL);
  };

  return (
    <ListPage
      header={
        <PrimaryAction slot={actionsSlot}>
          {organizations.data ? (
            <Can permission="ORGANIZATION_MANAGE">
              <Button
                iconLeft={<Plus />}
                onClick={() => {
                  setCreating(true);
                }}
              >
                {t('organizations.new')}
              </Button>
            </Can>
          ) : null}
        </PrimaryAction>
      }
      toolbar={
        total > 0 ? (
          <FilterToolbar
            search={{
              value: search,
              onChange: setSearch,
              label: t('filters.search'),
              placeholder: t('filters.searchPlaceholder'),
              description: t('filters.searchHint'),
            }}
            activeCount={chips.length}
            filters={
              <>
                <Field label={t('filters.status')}>
                  <Select
                    value={status}
                    onValueChange={(value) => {
                      setStatus(value === 'active' || value === 'inactive' ? value : ALL);
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL}>{t('filters.all')}</SelectItem>
                      <SelectItem value="active">{t('filters.active')}</SelectItem>
                      <SelectItem value="inactive">{t('filters.inactive')}</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label={t('filters.type')}>
                  <Select
                    value={type}
                    onValueChange={(value) => {
                      setType(ORGANIZATION_TYPES.find((item) => item === value) ?? ALL);
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL}>{t('filters.allTypes')}</SelectItem>
                      {ORGANIZATION_TYPES.map((item) => (
                        <SelectItem key={item} value={item}>
                          {t(`types.${item}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </>
            }
            chips={chips}
            onClearAll={clear}
          />
        ) : null
      }
      loading={organizations.isPending}
      loadingLabel={t('organizations.loading')}
      error={
        organizations.isError ? (
          <Alert tone="error" title={t('organizations.loadFailed')}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void organizations.refetch();
              }}
            >
              {t('organizations.retry')}
            </Button>
          </Alert>
        ) : null
      }
      empty={
        organizations.data && filtered.length === 0 ? (
          <EmptyState
            icon={<Building2 />}
            title={hasFilters ? t('organizations.noResults') : t('organizations.empty')}
            description={
              hasFilters ? t('organizations.noResultsHint') : t('organizations.emptyHint')
            }
            action={
              hasFilters ? (
                <Button variant="secondary" onClick={clear}>
                  {t('filters.clear')}
                </Button>
              ) : undefined
            }
          />
        ) : null
      }
    >
      {filtered.length > 0 ? (
        <TableContainer
          label={t('table.caption')}
          footer={<TableFooter summary={t('organizations.count', { count: filtered.length })} />}
        >
          <OrganizationList
            organizations={filtered}
            onEdit={setEditing}
            onDeactivate={(organization) => {
              setDeactivationError(null);
              setDeactivating(organization);
            }}
            onReactivate={(organization) => {
              setActive.mutate({ organization, isActive: true });
            }}
          />
        </TableContainer>
      ) : null}

      <OrganizationFormDialog open={creating} onOpenChange={setCreating} />
      <OrganizationFormDialog
        open={editing !== null}
        organization={editing ?? undefined}
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
          <DialogTitle>{t('deactivate.title', { name: deactivating?.name ?? '' })}</DialogTitle>
          <DialogDescription>{t('deactivate.description')}</DialogDescription>
          {deactivationError ? (
            <Alert tone="error" title={deactivationError}>
              {t('deactivate.blockedHint')}
            </Alert>
          ) : null}
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
                if (deactivating) setActive.mutate({ organization: deactivating, isActive: false });
              }}
            >
              {t('deactivate.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ListPage>
  );
}
