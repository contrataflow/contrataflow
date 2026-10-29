'use client';

import {
  Alert,
  Avatar,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Ellipsis,
  EmptyState,
  Inbox,
  ListPage,
  Plus,
  Skeleton,
  Table,
  TableBody,
  TableContainer,
  TableFooter,
  TableHead,
  Td,
  Th,
  Tr,
  toast,
} from '@contrataflow/ui';
import type { TenantMembershipDto } from '@contrataflow/validation';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';

import { AppPageHeader } from '@/components/shell/page-header';
import { isApiError } from '@/lib/api/api-error';
import { Can } from '@/lib/permissions/can';
import { usePermission } from '@/lib/permissions/use-permission';
import { useTenantId } from '@/lib/session/session-context';

import { CancelInvitationDialog } from './cancel-invitation-dialog';
import { InviteUserForm } from './invite-user-form';
import { UserList } from './user-list';
import {
  INVITATIONS_STALE_TIME_MS,
  fetchPendingInvitations,
  resendInvitation,
  userKeys,
} from './users.api';

export const USERS_PATH = '/admin/usuarios';

/**
 * SCR-029 (`/admin/usuarios` · US-091/US-092) no modelo `ListPage` (prd-5): "Convidar usuário"
 * (USR-03, só com `USER_INVITE`) é a ação primária do cabeçalho; a lista de usuários (USR-01 —
 * `UserList`, com busca, filtros e link para o detalhe) e, abaixo, os convites pendentes (USR-01
 * `status=INVITED`) com "Reenviar" (USR-04) e "Cancelar" (USR-05) no menu ⋯ da linha. Sem
 * `USER_VIEW` a API responde 403 e a tela mostra o aviso de acesso (RN-FND-92).
 */
export function UsersView() {
  const t = useTranslations('users');
  const format = useFormatter();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const canInvite = usePermission('USER_INVITE').allowed;
  const [inviting, setInviting] = useState(false);
  const [cancelling, setCancelling] = useState<TenantMembershipDto | null>(null);
  const [page, setPage] = useState(1);
  const [actionError, setActionError] = useState<string | null>(null);

  const invitations = useQuery({
    queryKey: userKeys.invitationsPage(tenantId, page),
    queryFn: ({ signal }) => fetchPendingInvitations(page, signal),
    staleTime: INVITATIONS_STALE_TIME_MS,
    placeholderData: keepPreviousData,
    // Erros (403, 5xx) são tratados na própria tela, com "Tentar novamente".
    throwOnError: false,
  });

  const resend = useMutation({
    mutationFn: (invitation: TenantMembershipDto) => resendInvitation(invitation.userId),
    onSuccess: (_result, invitation) => {
      setActionError(null);
      toast({ title: t('toast.resent', { email: invitation.email }), tone: 'success' });
      void queryClient.invalidateQueries({ queryKey: userKeys.invitations(tenantId) });
    },
    onError: (error) => {
      if (!isApiError(error)) setActionError(t('errors.generic'));
      else if (error.status === 429) setActionError(error.message || t('errors.rateLimited'));
      else if (error.status === 404) {
        setActionError(t('errors.notFound'));
        void queryClient.invalidateQueries({ queryKey: userKeys.invitations(tenantId) });
      } else if (error.status === 403) setActionError(t('errors.permission'));
      else if (error.status === 503) setActionError(t('errors.actionUnavailable'));
      else setActionError(error.message || t('errors.generic'));
    },
  });

  const header = (
    <AppPageHeader
      section="admin"
      title={t('title')}
      description={t('description')}
      actions={
        <Can permission="USER_INVITE">
          <Button
            iconLeft={<Plus />}
            onClick={() => {
              setInviting(true);
            }}
          >
            {t('list.invite')}
          </Button>
        </Can>
      }
    />
  );

  if (invitations.error && isApiError(invitations.error) && invitations.error.status === 403) {
    return (
      <ListPage
        header={<AppPageHeader section="admin" title={t('title')} description={t('description')} />}
        error={
          <Alert tone="error" title={t('forbidden.title')}>
            {t('forbidden.description')}
          </Alert>
        }
      />
    );
  }

  const items = invitations.data?.items ?? [];
  const totalPages = invitations.data?.totalPages ?? 1;
  const dateTime = (iso: string | null) =>
    iso ? format.dateTime(new Date(iso), { dateStyle: 'short', timeStyle: 'short' }) : '—';

  return (
    <>
      <UserList header={header}>
        <section aria-labelledby="pending-invitations-title" className="flex flex-col gap-3">
          <h2 id="pending-invitations-title" className="text-section-title text-brand-ink">
            {t('list.title')}
          </h2>

          {invitations.isPending ? (
            <div role="status" className="flex flex-col gap-2">
              <span className="sr-only">{t('list.loading')}</span>
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : null}

          {invitations.isError ? (
            <Alert tone="error" title={t('list.loadFailed')}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  void invitations.refetch();
                }}
              >
                {t('list.retry')}
              </Button>
            </Alert>
          ) : null}

          <div aria-live="polite" className="empty:hidden">
            {actionError ? <Alert tone="error" title={actionError} /> : null}
          </div>

          {invitations.data && items.length === 0 ? (
            <EmptyState
              icon={<Inbox />}
              title={t('list.empty')}
              description={t('list.emptyHint')}
            />
          ) : null}

          {items.length > 0 ? (
            <TableContainer
              label={t('list.caption')}
              footer={
                totalPages > 1 ? (
                  <TableFooter summary={t('list.count', { count: items.length })}>
                    <nav aria-label={t('list.pager')} className="flex items-center gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={page <= 1}
                        onClick={() => {
                          setPage((current) => Math.max(1, current - 1));
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
                          setPage((current) => current + 1);
                        }}
                      >
                        {t('list.next')}
                      </Button>
                    </nav>
                  </TableFooter>
                ) : undefined
              }
            >
              <Table>
                <caption className="sr-only">{t('list.caption')}</caption>
                <TableHead>
                  <Tr>
                    <Th>{t('list.invitee')}</Th>
                    <Th className="hidden md:table-cell">{t('list.type')}</Th>
                    <Th className="hidden sm:table-cell">{t('list.inviteExpiresAt')}</Th>
                    {canInvite ? (
                      <Th className="w-12">
                        <span className="sr-only">{t('list.actions')}</span>
                      </Th>
                    ) : null}
                  </Tr>
                </TableHead>
                <TableBody>
                  {items.map((invitation) => (
                    <Tr key={invitation.id}>
                      <th scope="row" className="px-3.5 py-3 text-left font-normal">
                        <span className="flex items-center gap-3">
                          <Avatar name={invitation.name} />
                          <span className="flex min-w-0 flex-col">
                            <span className="font-bold text-foreground">{invitation.name}</span>
                            <span className="text-xs break-all text-muted-foreground">
                              {invitation.email}
                            </span>
                          </span>
                        </span>
                      </th>
                      <Td className="hidden md:table-cell">{t(`types.${invitation.type}`)}</Td>
                      <Td className="hidden whitespace-nowrap sm:table-cell">
                        {dateTime(invitation.inviteExpiresAt)}
                      </Td>
                      {canInvite ? (
                        <Td className="w-12 py-1.5 text-right">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <button
                                type="button"
                                aria-label={t('actions.menu', { name: invitation.name })}
                                className="inline-grid size-11 place-items-center rounded-control text-muted-foreground hover:bg-muted hover:text-foreground md:size-9"
                              >
                                <Ellipsis aria-hidden="true" className="size-[1.125rem]" />
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                disabled={resend.isPending && resend.variables.id === invitation.id}
                                onSelect={() => {
                                  setActionError(null);
                                  resend.mutate(invitation);
                                }}
                              >
                                {t('actions.resendLabel', { name: invitation.name })}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onSelect={() => {
                                  setCancelling(invitation);
                                }}
                              >
                                {t('actions.cancelLabel', { name: invitation.name })}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </Td>
                      ) : null}
                    </Tr>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          ) : null}
        </section>
      </UserList>

      <InviteUserForm open={inviting} onOpenChange={setInviting} returnTo={USERS_PATH} />
      <CancelInvitationDialog
        invitation={cancelling}
        onClose={() => {
          setCancelling(null);
        }}
      />
    </>
  );
}
