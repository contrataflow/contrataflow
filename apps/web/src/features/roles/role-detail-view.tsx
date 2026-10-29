'use client';

import {
  Alert,
  Button,
  ChevronDown,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  DetailPage,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Skeleton,
  toast,
} from '@contrataflow/ui';
import type { PermissionDto, RoleWithPermissionsDto } from '@contrataflow/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { stepUpHref } from '@/lib/api/error-policy';
import { formatDate } from '@/lib/i18n/format';
import { useEffectivePermissions, usePermission } from '@/lib/permissions/use-permission';
import { permissionKeys } from '@/lib/query/keys';
import { shouldThrowToBoundary } from '@/lib/query/query-client';
import { useShellSession, useTenantId } from '@/lib/session/session-context';

import { DeactivateRoleDialog } from './deactivate-role-dialog';
import { PermissionMatrix } from './permission-matrix';
import { actorReach, matrixDiff } from './permission-matrix-model';
import type { ActorReach } from './permission-matrix-model';
import { ROLES_PATH, RoleBadges, canDeactivate } from './role-chips';
import { RoleFormDialog } from './role-form-dialog';
import {
  ROLES_STALE_TIME_MS,
  duplicateRole,
  fetchRole,
  roleKeys,
  updateRolePermissions,
} from './roles.api';
import { PermissionCatalogPanel } from '../permissions/permission-catalog-panel';
import {
  PERMISSION_CATALOG_STALE_TIME_MS,
  fetchPermissionCatalog,
  permissionCatalogKeys,
} from '../permissions/permissions.api';

/**
 * SCR-031 (`/admin/perfis/[roleId]` · US-095) no modelo `DetailPage` (prd-5): faixa com trilha,
 * nome, chips de situação e fatos-chave (chave, vínculos ativos, permissões, atualização). "Salvar
 * matriz" (ROL-06, `If-Match`) é a ação primária; "Editar perfil" (ROL-05), "Duplicar" (ROL-07) e
 * "Desativar" (ROL-08 — nunca no `ADMIN_ORGAO`) ficam no menu "Mais". O conteúdo é a matriz de
 * permissões por módulo; o catálogo completo (US-094) fica atrás de "Ver catálogo de permissões".
 * Sem `ROLE_MANAGE` a tela é só leitura.
 */
export function RoleDetailView({ roleId }: { readonly roleId: string }) {
  const t = useTranslations('roles');
  const tenantId = useTenantId();
  const returnTo = `${ROLES_PATH}/${roleId}`;

  const role = useQuery({
    queryKey: roleKeys.detail(tenantId, roleId),
    queryFn: async ({ signal }) => (await fetchRole(roleId, signal)).data,
    staleTime: ROLES_STALE_TIME_MS,
    // 404 (inexistente ou de outro tenant) é tratado na própria tela, com o caminho de volta.
    throwOnError: (error) =>
      !(isApiError(error) && error.status === 404) && shouldThrowToBoundary(error),
  });
  const catalog = useQuery({
    queryKey: permissionCatalogKeys.all(tenantId),
    queryFn: async ({ signal }) => (await fetchPermissionCatalog(signal)).data,
    staleTime: PERMISSION_CATALOG_STALE_TIME_MS,
  });
  const effective = useEffectivePermissions();
  const canManage = usePermission('ROLE_MANAGE').allowed;
  const actor = useMemo(
    () => actorReach(effective.data?.permissions.map((permission) => permission.code) ?? []),
    [effective.data],
  );

  if (role.error && isApiError(role.error) && role.error.status === 403) {
    return (
      <Alert tone="error" title={t('forbidden.title')}>
        {t('forbidden.description')}
      </Alert>
    );
  }
  if (role.error && isApiError(role.error) && role.error.status === 404) {
    return (
      <Alert tone="error" title={t('detail.notFound')}>
        <Link href={ROLES_PATH} className="font-medium underline">
          {t('actions.back')}
        </Link>
      </Alert>
    );
  }

  if (role.isPending || catalog.isPending) {
    return (
      <div role="status" className="flex w-full flex-col gap-5">
        <span className="sr-only">{t('detail.loading')}</span>
        <Skeleton className="h-4 w-48 max-w-full" />
        <Skeleton className="h-8 w-96 max-w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-56 w-full" />
      </div>
    );
  }

  if (role.isError || catalog.isError) {
    return (
      <Alert tone="error" title={t('detail.loadFailed')}>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            void role.refetch();
            void catalog.refetch();
          }}
        >
          {t('list.retry')}
        </Button>
      </Alert>
    );
  }

  return (
    <RoleDetailBody
      key={`${role.data.id}:${String(role.data.version)}`}
      role={role.data}
      catalog={catalog.data}
      canManage={canManage}
      actor={actor}
      returnTo={returnTo}
      onReload={() => {
        void role.refetch();
      }}
    />
  );
}

interface RoleDetailBodyProps {
  readonly role: RoleWithPermissionsDto;
  readonly catalog: readonly PermissionDto[];
  readonly canManage: boolean;
  readonly actor: ActorReach;
  readonly returnTo: string;
  readonly onReload: () => void;
}

function RoleDetailBody({
  role,
  catalog,
  canManage,
  actor,
  returnTo,
  onReload,
}: RoleDetailBodyProps) {
  const t = useTranslations('roles');
  const tShell = useTranslations('shell');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const router = useRouter();
  const timeZone = useShellSession().activeTenant.timezone;
  const [editing, setEditing] = useState(false);
  const [deactivating, setDeactivating] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const granted = useMemo(() => new Set(role.permissions), [role.permissions]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(granted);
  const [error, setError] = useState<{
    message: string;
    kind: 'conflict' | 'mfa' | 'plain';
  } | null>(null);
  const diff = matrixDiff(granted, selected);
  const dirty = diff.added.length + diff.removed.length > 0;

  const duplicate = useMutation({
    mutationFn: () => duplicateRole(role.id),
    onSuccess: (result) => {
      toast({ title: t('toast.duplicated', { name: result.data.name }), tone: 'success' });
      void queryClient.invalidateQueries({ queryKey: roleKeys.all(tenantId) });
      router.push(`${ROLES_PATH}/${result.data.id}`);
    },
    onError: (failure) => {
      setActionError(
        isApiError(failure) && failure.code === 'PRIVILEGE_ESCALATION_FORBIDDEN'
          ? t('errors.escalation')
          : isApiError(failure)
            ? failure.message
            : t('errors.generic'),
      );
    },
  });

  const save = useMutation({
    mutationFn: () => updateRolePermissions(role.id, [...selected], role.version),
    onSuccess: (result) => {
      toast({ title: t('toast.matrixUpdated'), tone: 'success' });
      queryClient.setQueryData(roleKeys.detail(tenantId, role.id), result.data);
      // Só a lista: o detalhe já veio na resposta (com a nova versão).
      void queryClient.invalidateQueries({ queryKey: roleKeys.all(tenantId), exact: true });
      // A matriz pode ser a do próprio ator: as permissões efetivas exibidas são relidas.
      void queryClient.invalidateQueries({ queryKey: permissionKeys.all(tenantId) });
    },
    onError: (failure) => {
      if (!isApiError(failure)) {
        setError({ message: t('errors.generic'), kind: 'plain' });
      } else if (failure.code === 'PRIVILEGE_ESCALATION_FORBIDDEN') {
        // A caixa volta a desmarcada (Casos de erro).
        setSelected(new Set([...selected].filter((code) => granted.has(code))));
        setError({ message: t('errors.escalation'), kind: 'plain' });
      } else if (failure.code === 'BUSINESS_RULE_VIOLATION') {
        // A caixa protegida volta a marcada.
        setSelected(new Set([...selected, ...diff.removed]));
        setError({ message: t('errors.protected'), kind: 'plain' });
      } else if (failure.code === 'MFA_REQUIRED') {
        setError({ message: t('errors.mfa'), kind: 'mfa' });
      } else if (failure.status === 412) {
        setError({ message: t('errors.conflict'), kind: 'conflict' });
      } else if (failure.status === 422) {
        setError({ message: t('errors.invalidPermissions'), kind: 'plain' });
        void queryClient.invalidateQueries({ queryKey: permissionCatalogKeys.all(tenantId) });
      } else if (failure.status === 403) {
        setError({ message: t('errors.permission'), kind: 'plain' });
      } else if (failure.status === 503) {
        setError({ message: t('errors.unavailable'), kind: 'plain' });
      } else {
        setError({ message: failure.message || t('errors.generic'), kind: 'plain' });
      }
    },
  });

  return (
    <DetailPage
      breadcrumbs={[
        { label: tShell('admin.title'), href: '/admin' },
        { label: t('title'), href: ROLES_PATH },
        { label: role.name },
      ]}
      breadcrumbLabel={t('detail.breadcrumbLabel')}
      linkComponent={Link}
      title={role.name}
      status={<RoleBadges role={role} />}
      subtitle={role.description}
      actions={
        canManage ? (
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="secondary" iconRight={<ChevronDown />}>
                  {t('actions.more')}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onSelect={() => {
                    setEditing(true);
                  }}
                >
                  {t('actions.edit')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={duplicate.isPending}
                  onSelect={() => {
                    setActionError(null);
                    duplicate.mutate();
                  }}
                >
                  {t('actions.duplicateLabel')}
                </DropdownMenuItem>
                {canDeactivate(role) ? (
                  <DropdownMenuItem
                    onSelect={() => {
                      setDeactivating(true);
                    }}
                  >
                    {t('actions.deactivateLabel')}
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              disabled={!dirty || save.isPending}
              aria-busy={save.isPending}
              onClick={() => {
                setError(null);
                save.mutate();
              }}
            >
              {save.isPending ? t('matrix.saving') : t('matrix.save')}
            </Button>
          </>
        ) : null
      }
      facts={[
        {
          id: 'key',
          label: t('detail.facts.key'),
          value: <code className="font-mono">{role.key}</code>,
        },
        {
          id: 'assignments',
          label: t('detail.facts.assignments'),
          value: t('list.assignmentsCount', { count: role.activeAssignmentsCount }),
        },
        {
          id: 'permissions',
          label: t('detail.facts.permissions'),
          value: t('detail.permissionsCount', { selected: granted.size, total: catalog.length }),
        },
        {
          id: 'updated',
          label: t('detail.facts.updated'),
          value: formatDate(role.updatedAt, timeZone),
        },
      ]}
      notices={
        <div aria-live="polite" className="flex flex-col gap-2 empty:hidden">
          {actionError ? <Alert tone="error" title={actionError} /> : null}
          {role.isActive ? null : (
            <Alert tone="warning" live={false} title={t('detail.inactiveNotice')} />
          )}
        </div>
      }
    >
      <section aria-labelledby="role-matrix-title" className="flex flex-col gap-4">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 id="role-matrix-title" className="text-lg font-bold text-brand-ink">
              {t('matrix.title')}
            </h2>
            <p className="max-w-3xl text-sm text-muted-foreground">
              {canManage ? t('matrix.description') : t('matrix.readonlyNotice')}
            </p>
          </div>
          {canManage ? (
            <div className="flex flex-wrap items-center gap-3">
              <p role="status" className="text-sm text-muted-foreground">
                {dirty
                  ? t('matrix.pending', {
                      added: diff.added.length,
                      removed: diff.removed.length,
                      separator: diff.added.length > 0 && diff.removed.length > 0 ? ' · ' : '',
                    })
                  : t('matrix.noChanges')}
              </p>
              <Button
                variant="secondary"
                disabled={!dirty || save.isPending}
                onClick={() => {
                  setSelected(granted);
                  setError(null);
                }}
              >
                {t('matrix.discard')}
              </Button>
            </div>
          ) : null}
        </header>

        <div aria-live="assertive" className="empty:hidden">
          {error ? (
            <Alert tone="error" title={error.message}>
              {error.kind === 'conflict' ? (
                <Button variant="secondary" size="sm" onClick={onReload}>
                  {t('errors.reload')}
                </Button>
              ) : null}
              {error.kind === 'mfa' ? (
                <a className="font-medium underline" href={stepUpHref(returnTo)}>
                  {t('errors.stepUp')}
                </a>
              ) : null}
            </Alert>
          ) : null}
        </div>

        <PermissionMatrix
          catalog={catalog}
          granted={granted}
          selected={selected}
          isProtectedRole={role.isProtected}
          canManage={canManage}
          actor={actor}
          onToggle={(code, checked) => {
            const next = new Set(selected);
            if (checked) next.add(code);
            else next.delete(code);
            setSelected(next);
          }}
        />
      </section>

      <Collapsible open={catalogOpen} onOpenChange={setCatalogOpen} className="flex flex-col gap-4">
        <CollapsibleTrigger className="self-start">
          {catalogOpen ? t('detail.catalog.hide') : t('detail.catalog.show')}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <PermissionCatalogPanel />
        </CollapsibleContent>
      </Collapsible>

      <RoleFormDialog open={editing} onOpenChange={setEditing} role={role} returnTo={returnTo} />
      <DeactivateRoleDialog
        role={deactivating ? role : null}
        onClose={() => {
          setDeactivating(false);
        }}
      />
    </DetailPage>
  );
}
