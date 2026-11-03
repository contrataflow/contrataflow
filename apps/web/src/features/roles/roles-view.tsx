'use client';

import {
  Alert,
  Button,
  EmptyState,
  Field,
  FilterPanel,
  ListPage,
  Plus,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  ShieldCheck,
  TableContainer,
  TableFooter,
  toast,
} from '@contrataflow/ui';
import type { RoleDto } from '@contrataflow/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import { ListSearchField } from '@/components/lists/list-search-field';
import { useFilterPanelLabels } from '@/components/lists/use-filter-panel-labels';
import { AppPageHeader } from '@/components/shell/page-header';
import { isApiError } from '@/lib/api/api-error';
import { Can } from '@/lib/permissions/can';
import { useTenantId } from '@/lib/session/session-context';

import { DeactivateRoleDialog } from './deactivate-role-dialog';
import { foldText } from './permission-matrix-model';
import { ROLES_PATH } from './role-chips';
import { RoleFormDialog } from './role-form-dialog';
import { RoleList } from './role-list';
import { ROLES_STALE_TIME_MS, duplicateRole, fetchRoles, roleKeys } from './roles.api';

/** O `Select` do kit não aceita valor vazio: "Todos" usa este marcador. */
const ALL = 'all';

type StatusFilter = typeof ALL | 'active' | 'inactive';
type KindFilter = typeof ALL | 'system' | 'custom';

/** Busca local (sem acento nem maiúsculas) em nome, chave e descrição. */
function matchesSearch(role: RoleDto, search: string): boolean {
  const term = foldText(search.trim());
  if (term === '') return true;
  return [role.name, role.key, role.description ?? ''].some((value) =>
    foldText(value).includes(term),
  );
}

/**
 * SCR-030 (`/admin/perfis` · US-095): os 15 perfis padrão e os personalizados (ROL-02) com a
 * contagem de vínculos ativos; "Novo perfil" (ROL-03) no cabeçalho abre o painel lateral e leva ao
 * detalhe (SCR-031); "Duplicar" (ROL-07) e "Desativar" (ROL-08) no menu ⋯ da linha, só com
 * `ROLE_MANAGE`. Modelo `ListPage` (prd-5): cartão `FilterPanel` com busca sobre os perfis
 * já carregados, situação e tipo.
 */
export function RolesView() {
  const t = useTranslations('roles');
  const filterPanelLabels = useFilterPanelLabels();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [deactivating, setDeactivating] = useState<RoleDto | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>(ALL);
  const [kind, setKind] = useState<KindFilter>(ALL);

  const roles = useQuery({
    queryKey: roleKeys.all(tenantId),
    queryFn: async ({ signal }) => (await fetchRoles(signal)).data,
    staleTime: ROLES_STALE_TIME_MS,
    // Erros (403, 5xx) são tratados na própria tela, com "Tentar novamente".
    throwOnError: false,
  });

  const duplicate = useMutation({
    mutationFn: (role: RoleDto) => duplicateRole(role.id),
    onSuccess: (result) => {
      setActionError(null);
      toast({ title: t('toast.duplicated', { name: result.data.name }), tone: 'success' });
      void queryClient.invalidateQueries({ queryKey: roleKeys.all(tenantId) });
    },
    onError: (error) => {
      setActionError(
        isApiError(error) && error.code === 'PRIVILEGE_ESCALATION_FORBIDDEN'
          ? t('errors.escalation')
          : isApiError(error) && error.code === 'MFA_REQUIRED'
            ? t('errors.mfa')
            : isApiError(error)
              ? error.message
              : t('errors.generic'),
      );
    },
  });

  const items = useMemo(
    () =>
      (roles.data ?? []).filter(
        (role) =>
          matchesSearch(role, search) &&
          (status === ALL || role.isActive === (status === 'active')) &&
          (kind === ALL || role.isSystem === (kind === 'system')),
      ),
    [roles.data, search, status, kind],
  );

  const header = (
    <AppPageHeader section="admin" title={t('title')} description={t('description')} />
  );

  if (roles.error && isApiError(roles.error) && roles.error.status === 403) {
    return (
      <ListPage
        header={header}
        error={
          <Alert tone="error" title={t('forbidden.title')}>
            {t('forbidden.description')}
          </Alert>
        }
      />
    );
  }

  const custom = roles.data?.filter((role) => !role.isSystem) ?? [];
  const activeCount = (status === ALL ? 0 : 1) + (kind === ALL ? 0 : 1);
  const filtered = search.trim() !== '' || activeCount > 0;
  const clearAll = () => {
    setSearch('');
    setStatus(ALL);
    setKind(ALL);
  };
  const newRole = (
    <Can permission="ROLE_MANAGE">
      <Button
        iconLeft={<Plus />}
        onClick={() => {
          setCreating(true);
        }}
      >
        {t('list.new')}
      </Button>
    </Can>
  );

  return (
    <ListPage
      header={
        <AppPageHeader
          section="admin"
          title={t('title')}
          description={t('description')}
          actions={roles.data ? newRole : null}
        />
      }
      toolbar={
        <FilterPanel
          labels={filterPanelLabels}
          activeCount={activeCount + (search.trim() === '' ? 0 : 1)}
          onClear={clearAll}
        >
          <ListSearchField
            value={search}
            onChange={setSearch}
            ariaLabel={t('filters.search')}
            placeholder={t('filters.searchPlaceholder')}
            description={t('filters.searchHint')}
          />
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
          <Field label={t('filters.kind')}>
            <Select
              value={kind}
              onValueChange={(value) => {
                setKind(value === 'system' || value === 'custom' ? value : ALL);
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t('filters.all')}</SelectItem>
                <SelectItem value="system">{t('filters.system')}</SelectItem>
                <SelectItem value="custom">{t('filters.custom')}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </FilterPanel>
      }
      summary={roles.data ? { text: t('list.summary', { count: items.length }) } : undefined}
      notices={
        <div aria-live="polite" className="flex flex-col gap-2 empty:hidden">
          {actionError ? <Alert tone="error" title={actionError} /> : null}
          {roles.data && custom.length === 0 ? (
            <Alert tone="info" live={false} title={t('list.emptyCustom')}>
              {t('list.emptyCustomHint')}
            </Alert>
          ) : null}
        </div>
      }
      loading={roles.isPending}
      loadingLabel={t('list.loading')}
      error={
        roles.isError ? (
          <Alert tone="error" title={t('list.loadFailed')}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void roles.refetch();
              }}
            >
              {t('list.retry')}
            </Button>
          </Alert>
        ) : null
      }
      empty={
        roles.data && items.length === 0 ? (
          <EmptyState
            icon={<ShieldCheck />}
            title={filtered ? t('list.noResults') : t('list.emptyCustom')}
            description={filtered ? t('list.noResultsHint') : t('list.emptyCustomHint')}
            action={
              filtered ? (
                <Button variant="secondary" onClick={clearAll}>
                  {t('filters.clear')}
                </Button>
              ) : (
                newRole
              )
            }
          />
        ) : null
      }
    >
      {items.length > 0 ? (
        <TableContainer
          label={t('list.caption')}
          footer={<TableFooter summary={t('list.count', { count: items.length })} />}
        >
          <RoleList
            roles={items}
            onDuplicate={(role) => {
              duplicate.mutate(role);
            }}
            onDeactivate={setDeactivating}
          />
        </TableContainer>
      ) : null}

      <RoleFormDialog
        open={creating}
        onOpenChange={setCreating}
        returnTo={ROLES_PATH}
        onCreated={(role) => {
          router.push(`${ROLES_PATH}/${role.id}`);
        }}
      />
      <DeactivateRoleDialog
        role={deactivating}
        onClose={() => {
          setDeactivating(null);
        }}
      />
    </ListPage>
  );
}
