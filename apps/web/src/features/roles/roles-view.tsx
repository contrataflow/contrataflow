'use client';

import { Alert, Button, Skeleton, toast } from '@contrataflow/ui';
import { PROTECTED_ROLE_KEY } from '@contrataflow/validation';
import type { RoleDto } from '@contrataflow/validation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { Can } from '@/lib/permissions/can';
import { useTenantId } from '@/lib/session/session-context';

import { DeactivateRoleDialog } from './deactivate-role-dialog';
import { RoleFormDialog } from './role-form-dialog';
import { ROLES_STALE_TIME_MS, duplicateRole, fetchRoles, roleKeys } from './roles.api';

export const ROLES_PATH = '/admin/perfis';

/** O perfil `ADMIN_ORGAO` nunca pode ser desativado (POL-12 · FA-05): o botão nem aparece. */
export function canDeactivate(role: RoleDto): boolean {
  return role.isActive && !role.isProtected && role.key !== PROTECTED_ROLE_KEY;
}

export function RoleBadges({ role }: { readonly role: RoleDto }) {
  const t = useTranslations('roles.badges');
  const badge = (label: string, tone: 'muted' | 'ok' | 'warn') => (
    <span
      key={label}
      className={`inline-flex rounded-control px-2 py-0.5 text-xs font-medium ${
        tone === 'ok'
          ? 'bg-success-soft text-foreground'
          : tone === 'warn'
            ? 'bg-warning-soft text-foreground'
            : 'bg-muted text-muted-foreground'
      }`}
    >
      {label}
    </span>
  );
  return (
    <div className="flex flex-wrap gap-1">
      {badge(role.isActive ? t('active') : t('inactive'), role.isActive ? 'ok' : 'warn')}
      {badge(role.isSystem ? t('system') : t('custom'), 'muted')}
      {role.isProtected ? badge(t('protected'), 'muted') : null}
      {role.allowExternalAssignment ? badge(t('external'), 'muted') : null}
    </div>
  );
}

/**
 * SCR-030 (`/admin/perfis` · US-095): os 15 perfis padrão e os personalizados (ROL-02) com a
 * contagem de vínculos ativos; "Novo perfil" (ROL-03) leva ao detalhe (SCR-031); "Duplicar"
 * (ROL-07) e "Desativar" (ROL-08) por linha, só com `ROLE_MANAGE`. Abaixo de 768 px cada linha
 * vira um cartão (mesma tabela, cabeçalho só para leitores de tela).
 */
export function RolesView() {
  const t = useTranslations('roles');
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [deactivating, setDeactivating] = useState<RoleDto | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const roles = useQuery({
    queryKey: roleKeys.all(tenantId),
    queryFn: async ({ signal }) => (await fetchRoles(signal)).data,
    staleTime: ROLES_STALE_TIME_MS,
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

  if (roles.error && isApiError(roles.error) && roles.error.status === 403) {
    return (
      <Alert tone="error" title={t('forbidden.title')}>
        {t('forbidden.description')}
      </Alert>
    );
  }

  const custom = roles.data?.filter((role) => !role.isSystem) ?? [];

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h2 className="text-lg font-semibold">{t('list.title')}</h2>
        {roles.data ? (
          <Can permission="ROLE_MANAGE">
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

      {roles.isPending ? (
        <div role="status" className="flex flex-col gap-2">
          <span className="sr-only">{t('list.loading')}</span>
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : null}

      {roles.isError ? (
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
      ) : null}

      <div aria-live="polite">
        {actionError ? <Alert tone="error" title={actionError} /> : null}
      </div>

      {roles.data ? (
        <>
          <div className="relative rounded-card border border-border bg-surface shadow-card md:overflow-x-auto">
            <table className="w-full text-left text-sm md:min-w-[48rem]">
              <caption className="sr-only">{t('list.caption')}</caption>
              <thead className="bg-muted text-xs text-muted-foreground uppercase max-md:sr-only">
                <tr>
                  <th scope="col" className="px-3 py-2">
                    {t('list.name')}
                  </th>
                  <th scope="col" className="px-3 py-2">
                    {t('list.key')}
                  </th>
                  <th scope="col" className="px-3 py-2">
                    {t('list.status')}
                  </th>
                  <th scope="col" className="px-3 py-2">
                    {t('list.assignments')}
                  </th>
                  <Can permission="ROLE_MANAGE">
                    <th scope="col" className="px-3 py-2">
                      {t('list.actions')}
                    </th>
                  </Can>
                </tr>
              </thead>
              <tbody>
                {roles.data.map((role) => (
                  <tr
                    key={role.id}
                    className="border-t border-border align-top max-md:block max-md:py-2"
                  >
                    <th scope="row" className="px-3 py-2 font-medium max-md:block">
                      <Link
                        href={`${ROLES_PATH}/${role.id}`}
                        aria-label={t('actions.open', { name: role.name })}
                        className="underline-offset-2 hover:underline"
                      >
                        {role.name}
                      </Link>
                    </th>
                    <td className="px-3 py-2 font-mono text-xs max-md:block max-md:py-1">
                      {role.key}
                    </td>
                    <td className="px-3 py-2 max-md:block max-md:py-1">
                      <RoleBadges role={role} />
                    </td>
                    <td className="px-3 py-2 max-md:block max-md:py-1">
                      {t('list.assignmentsCount', { count: role.activeAssignmentsCount })}
                    </td>
                    <Can permission="ROLE_MANAGE">
                      <td className="px-3 py-2 max-md:block">
                        <RoleActions
                          role={role}
                          onDuplicate={(item) => {
                            duplicate.mutate(item);
                          }}
                          onDeactivate={setDeactivating}
                        />
                      </td>
                    </Can>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {custom.length === 0 ? (
            <div className="rounded-card border border-dashed border-border p-6 text-center">
              <p className="font-medium">{t('list.emptyCustom')}</p>
              <p className="mt-1 text-sm text-muted-foreground">{t('list.emptyCustomHint')}</p>
            </div>
          ) : null}
        </>
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
    </div>
  );
}

interface RowProps {
  readonly role: RoleDto;
  readonly onDuplicate: (role: RoleDto) => void;
  readonly onDeactivate: (role: RoleDto) => void;
}

function RoleActions({ role, onDuplicate, onDeactivate }: RowProps) {
  const t = useTranslations('roles');
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        variant="secondary"
        size="sm"
        aria-label={t('actions.duplicate', { name: role.name })}
        onClick={() => {
          onDuplicate(role);
        }}
      >
        {t('actions.duplicateLabel')}
      </Button>
      {canDeactivate(role) ? (
        <Button
          variant="ghost"
          size="sm"
          aria-label={t('actions.deactivate', { name: role.name })}
          onClick={() => {
            onDeactivate(role);
          }}
        >
          {t('actions.deactivateLabel')}
        </Button>
      ) : null}
    </div>
  );
}
