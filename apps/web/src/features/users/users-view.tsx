'use client';

import { Alert, Button, Skeleton, toast } from '@contrataflow/ui';
import type { TenantMembershipDto } from '@contrataflow/validation';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { Can } from '@/lib/permissions/can';
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
 * SCR-029 (`/admin/usuarios` · US-091/US-092): a lista de usuários (USR-01 — `UserList`, com busca,
 * filtros e link para o detalhe), "Convidar usuário" (USR-03, só com `USER_INVITE`) e os convites
 * pendentes (USR-01 `status=INVITED`) com "Reenviar" (USR-04) e "Cancelar" (USR-05). Sem
 * `USER_VIEW` a API responde 403 e a tela mostra o aviso de acesso (RN-FND-92). Abaixo de 768 px
 * cada linha vira um cartão (mesma tabela, cabeçalho só para leitores de tela).
 */
export function UsersView() {
  const t = useTranslations('users');
  const format = useFormatter();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
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

  if (invitations.error && isApiError(invitations.error) && invitations.error.status === 403) {
    return (
      <Alert tone="error" title={t('forbidden.title')}>
        {t('forbidden.description')}
      </Alert>
    );
  }

  const items = invitations.data?.items ?? [];
  const totalPages = invitations.data?.totalPages ?? 1;
  const dateTime = (iso: string | null) =>
    iso ? format.dateTime(new Date(iso), { dateStyle: 'short', timeStyle: 'short' }) : '—';

  return (
    <div className="flex flex-col gap-8">
      <Can permission="USER_INVITE">
        <div className="flex justify-end">
          <Button
            onClick={() => {
              setInviting(true);
            }}
          >
            {t('list.invite')}
          </Button>
        </div>
      </Can>

      <UserList />

      <section aria-labelledby="pending-invitations-title" className="flex flex-col gap-4">
        <h2 id="pending-invitations-title" className="text-lg font-semibold">
          {t('list.title')}
        </h2>

        {invitations.isPending ? (
          <div role="status" className="flex flex-col gap-2">
            <span className="sr-only">{t('list.loading')}</span>
            <Skeleton className="h-10 w-full" />
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

        <div aria-live="polite">
          {actionError ? <Alert tone="error" title={actionError} /> : null}
        </div>

        {invitations.data && items.length === 0 ? (
          <div className="rounded-card border border-dashed border-border p-6 text-center">
            <p className="font-medium">{t('list.empty')}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t('list.emptyHint')}</p>
          </div>
        ) : null}

        {items.length > 0 ? (
          <div className="relative rounded-card border border-border bg-surface shadow-card md:overflow-x-auto">
            <table className="w-full text-left text-sm md:min-w-[48rem]">
              <caption className="sr-only">{t('list.caption')}</caption>
              <thead className="bg-muted text-xs text-muted-foreground uppercase max-md:sr-only">
                <tr>
                  <th scope="col" className="px-3 py-2">
                    {t('list.name')}
                  </th>
                  <th scope="col" className="px-3 py-2">
                    {t('list.email')}
                  </th>
                  <th scope="col" className="px-3 py-2">
                    {t('list.type')}
                  </th>
                  <th scope="col" className="px-3 py-2">
                    {t('list.inviteExpiresAt')}
                  </th>
                  <Can permission="USER_INVITE">
                    <th scope="col" className="px-3 py-2">
                      {t('list.actions')}
                    </th>
                  </Can>
                </tr>
              </thead>
              <tbody>
                {items.map((invitation) => (
                  <tr
                    key={invitation.id}
                    className="border-t border-border align-top max-md:block max-md:py-2"
                  >
                    <th scope="row" className="px-3 py-2 font-medium max-md:block">
                      {invitation.name}
                    </th>
                    <td className="px-3 py-2 break-all max-md:block max-md:py-1">
                      {invitation.email}
                    </td>
                    <td className="px-3 py-2 max-md:block max-md:py-1">
                      {t(`types.${invitation.type}`)}
                    </td>
                    <td className="px-3 py-2 max-md:block max-md:py-1">
                      {dateTime(invitation.inviteExpiresAt)}
                    </td>
                    <Can permission="USER_INVITE">
                      <td className="px-3 py-2 max-md:block">
                        <div className="flex flex-wrap gap-2">
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={resend.isPending && resend.variables.id === invitation.id}
                            aria-label={t('actions.resendLabel', { name: invitation.name })}
                            onClick={() => {
                              setActionError(null);
                              resend.mutate(invitation);
                            }}
                          >
                            {t('actions.resend')}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={t('actions.cancelLabel', { name: invitation.name })}
                            onClick={() => {
                              setCancelling(invitation);
                            }}
                          >
                            {t('actions.cancel')}
                          </Button>
                        </div>
                      </td>
                    </Can>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {totalPages > 1 ? (
          <nav aria-label={t('list.pager')} className="flex items-center justify-between gap-2">
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
            <span className="text-sm text-muted-foreground">
              {t('list.pageOf', { page, total: totalPages })}
            </span>
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
        ) : null}
      </section>

      <InviteUserForm open={inviting} onOpenChange={setInviting} returnTo={USERS_PATH} />
      <CancelInvitationDialog
        invitation={cancelling}
        onClose={() => {
          setCancelling(null);
        }}
      />
    </div>
  );
}
