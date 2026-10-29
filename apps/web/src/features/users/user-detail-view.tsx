'use client';

import {
  Alert,
  Button,
  Card,
  DetailPage,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Ellipsis,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  buttonClassName,
  toast,
} from '@contrataflow/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { isApiError } from '@/lib/api/api-error';
import { stepUpHref } from '@/lib/api/error-policy';
import { shouldRetryQuery } from '@/lib/query/query-client';
import { useTenantId } from '@/lib/session/session-context';

import { MembershipActionDialog } from './membership-action-dialog';
import type { MembershipDialogAction } from './membership-action-dialog';
import { MfaResetDialog } from './mfa-reset-dialog';
import { RoleAssignmentsSection } from './role-assignments-section';
import { StatusBadge } from './status-badge';
import { UserDepartmentsForm } from './user-departments-form';
import { UserDetailForm } from './user-detail-form';
import { describeUserError } from './user-errors';
import type { UserFeedback } from './user-errors';
import { USERS_PATH } from './users-view';
import { USER_DETAIL_STALE_TIME_MS, fetchUser, reactivateUser, userKeys } from './users.api';
import type { UserDetailResult } from './users.api';

type ToastKey = 'saved' | 'departmentsSaved' | 'suspended' | 'reactivated' | 'revoked';

interface FeedbackState {
  readonly feedback: UserFeedback;
  /** Repete a ação que falhou (503). */
  readonly retry?: (() => void) | undefined;
}

/**
 * Detalhe do vínculo (SCR-029 `/admin/usuarios/[userId]` · US-092) no modelo `DetailPage` (prd-5):
 * faixa com trilha, nome, situação, fatos-chave em linha, "Reativar" como ação primária quando o
 * vínculo está suspenso e as demais ações de acesso (suspender, revogar — USR-10..12, conforme
 * `meta.allowedActions` — e a redefinição da autenticação em duas etapas, US-090 · USR-13, oculta
 * para o próprio vínculo — RN-IAM-43) no menu "Mais". Abas "Dados" (dados da pessoa, `UserDetailForm`
 * USR-08 e lotações com principal explícita USR-09) e "Atribuições" (US-096 · ROL-10..12). A API não
 * expõe sessões do usuário: não há aba "Sessões". Toda mutação de vínculo envia `If-Match`; a
 * resposta (mesmo formato do detalhe, novo `ETag`) substitui o detalhe em cache e invalida a lista,
 * sem recarregar a página. 412/409 recarregam o detalhe antes de nova tentativa; 404 devolve à
 * lista.
 */
export function UserDetailView({ userId }: { readonly userId: string }) {
  const t = useTranslations('users');
  const tShell = useTranslations('shell');
  const tErrors = useTranslations('users.detail.errors');
  const format = useFormatter();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const selfNoteId = useId();
  const [dialog, setDialog] = useState<MembershipDialogAction | null>(null);
  const [mfaResetOpen, setMfaResetOpen] = useState(false);
  const [state, setState] = useState<FeedbackState | null>(null);
  const [gone, setGone] = useState(false);
  const [tab, setTab] = useState('data');
  /** Incrementa depois de recarregar o detalhe por conflito: os formulários recomeçam dele. */
  const [resetToken, setResetToken] = useState(0);
  const detailPath = `${USERS_PATH}/${userId}`;
  const detailKey = userKeys.detail(tenantId, userId);

  const detail = useQuery({
    queryKey: detailKey,
    queryFn: ({ signal }) => fetchUser(userId, signal),
    staleTime: USER_DETAIL_STALE_TIME_MS,
    retry: shouldRetryQuery,
    // 403, 404 e 5xx são tratados na própria tela.
    throwOnError: false,
  });

  const applied = (result: UserDetailResult, toastKey: ToastKey) => {
    queryClient.setQueryData(detailKey, result);
    void queryClient.invalidateQueries({ queryKey: userKeys.lists(tenantId) });
    setState(null);
    toast({
      title: t(`detail.toast.${toastKey}`, { name: result.membership.name }),
      tone: 'success',
    });
  };

  const showFeedback = (feedback: UserFeedback, retry?: () => void) => {
    if (feedback.kind === 'notFound') {
      setGone(true);
      void queryClient.invalidateQueries({ queryKey: userKeys.lists(tenantId) });
      return;
    }
    setState({ feedback, retry });
    if (feedback.kind === 'stale') {
      // Recarrega o vínculo atual antes de permitir nova tentativa (RN-IAM-63).
      void detail.refetch().then(() => {
        setResetToken((current) => current + 1);
      });
      void queryClient.invalidateQueries({ queryKey: userKeys.lists(tenantId) });
    }
  };

  const failed = (error: unknown, retry?: () => void) => {
    showFeedback(describeUserError(error, tErrors), retry);
  };

  const reactivate = useMutation({
    mutationFn: (version: number) => reactivateUser(userId, version),
    onSuccess: (result) => {
      applied(result, 'reactivated');
    },
  });
  const runReactivate = (version: number) => {
    setState(null);
    reactivate.mutate(version, {
      onError: (error) => {
        failed(error, () => {
          runReactivate(version);
        });
      },
    });
  };

  const backLink = (
    <Link href={USERS_PATH} className="text-sm underline-offset-2 hover:underline">
      {t('detail.back')}
    </Link>
  );

  const loadError = detail.error;
  if (gone || (loadError && isApiError(loadError) && loadError.status === 404)) {
    return (
      <Alert tone="error" title={t('detail.notFound')}>
        <Link href={USERS_PATH} className="font-medium underline">
          {t('detail.back')}
        </Link>
      </Alert>
    );
  }
  if (loadError && isApiError(loadError) && loadError.status === 403) {
    return (
      <Alert tone="error" title={t('forbidden.title')}>
        {t('forbidden.description')}
      </Alert>
    );
  }

  if (detail.isPending) {
    return (
      <div role="status" className="flex flex-col gap-2">
        <span className="sr-only">{t('detail.loading')}</span>
        <Skeleton className="h-10 w-1/2" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  if (detail.isError) {
    return (
      <div className="flex flex-col gap-4">
        {backLink}
        <Alert tone="error" title={t('detail.loadFailed')}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              void detail.refetch();
            }}
          >
            {t('detail.retry')}
          </Button>
        </Alert>
      </div>
    );
  }

  const { membership, meta } = detail.data;
  const allowed = new Set<string>(meta.allowedActions);
  const canManage = allowed.has('UPDATE');
  // Recarregando por conflito: sem enviar nada até chegar a versão atual.
  const locked = detail.isFetching;
  const pending = reactivate.isPending;

  const dateTime = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: 'short', timeStyle: 'short' });

  // POL-16 (FA-03): o próprio ator vê os itens desabilitados, com a explicação.
  const selfBlocked = canManage && meta.isSelf;
  const showSuspend = allowed.has('SUSPEND') || (selfBlocked && membership.status === 'ACTIVE');
  const showRevoke =
    allowed.has('REVOKE') ||
    (selfBlocked && (membership.status === 'ACTIVE' || membership.status === 'SUSPENDED'));
  const showReactivate = allowed.has('REACTIVATE');
  const showMfaReset = allowed.has('MFA_RESET');
  const hasMore = showSuspend || showRevoke || showMfaReset;

  const primaryDepartment = membership.departments.find((department) => department.isPrimary);
  const external = membership.type === 'EXTERNAL';
  const facts = [
    { id: 'type', label: t('detail.type'), value: t(`types.${membership.type}`) },
    {
      id: 'department',
      label: t('directory.primaryDepartment'),
      value: primaryDepartment?.name ?? t('detail.none'),
    },
    ...(external
      ? [
          {
            id: 'expiresAt',
            label: t('detail.expiresAt'),
            value: membership.expiresAt
              ? format.dateTime(new Date(membership.expiresAt), { dateStyle: 'short' })
              : t('detail.none'),
          },
        ]
      : []),
  ];

  const actions = (
    <>
      {hasMore ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            className={buttonClassName({ variant: 'secondary', size: 'md' })}
            aria-label={t('detail.moreLabel')}
          >
            <Ellipsis aria-hidden="true" className="size-4" />
            {t('detail.more')}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {showSuspend ? (
              <DropdownMenuItem
                disabled={meta.isSelf || locked || pending}
                aria-describedby={meta.isSelf ? selfNoteId : undefined}
                onSelect={() => {
                  setState(null);
                  setDialog('SUSPEND');
                }}
              >
                {t('detail.actions.suspend')}
              </DropdownMenuItem>
            ) : null}
            {showRevoke ? (
              <DropdownMenuItem
                disabled={meta.isSelf || locked || pending}
                aria-describedby={meta.isSelf ? selfNoteId : undefined}
                onSelect={() => {
                  setState(null);
                  setDialog('REVOKE');
                }}
              >
                {t('detail.actions.revoke')}
              </DropdownMenuItem>
            ) : null}
            {showMfaReset ? (
              <>
                {showSuspend || showRevoke ? <DropdownMenuSeparator /> : null}
                <DropdownMenuItem
                  disabled={locked || pending}
                  onSelect={() => {
                    setState(null);
                    setMfaResetOpen(true);
                  }}
                >
                  {t('detail.mfa.action')}
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {showReactivate ? (
        <Button
          disabled={locked || pending}
          aria-busy={pending}
          onClick={() => {
            runReactivate(membership.version);
          }}
        >
          {t('detail.actions.reactivate')}
        </Button>
      ) : null}
    </>
  );

  return (
    <Tabs value={tab} onValueChange={setTab}>
      <DetailPage
        breadcrumbs={[
          { label: tShell('admin.title'), href: '/admin' },
          { label: t('title'), href: USERS_PATH },
          { label: membership.name },
        ]}
        breadcrumbLabel={tShell('pageHeader.breadcrumb')}
        linkComponent={Link}
        title={membership.name}
        status={<StatusBadge membership={membership} />}
        actions={actions}
        facts={facts}
        notices={
          <div className="flex flex-col gap-3 empty:hidden">
            <div aria-live="assertive" className="empty:hidden">
              {state ? (
                <Alert tone="error" title={state.feedback.message}>
                  {state.feedback.hint ? <p>{state.feedback.hint}</p> : null}
                  {state.feedback.kind === 'mfa' ? (
                    <a className="font-medium underline" href={stepUpHref(detailPath)}>
                      {tErrors('stepUp')}
                    </a>
                  ) : null}
                  {state.feedback.kind === 'unavailable' && state.retry ? (
                    <Button variant="secondary" size="sm" onClick={state.retry}>
                      {tErrors('retry')}
                    </Button>
                  ) : null}
                  {state.feedback.kind === 'stale' && locked ? <p>{tErrors('reloading')}</p> : null}
                </Alert>
              ) : null}
            </div>

            {membership.status === 'SUSPENDED' && membership.suspendedAt ? (
              <Alert
                tone="warning"
                live={false}
                title={t('detail.since.suspended', { date: dateTime(membership.suspendedAt) })}
              >
                {membership.suspensionReason
                  ? t('detail.reason', { reason: membership.suspensionReason })
                  : null}
              </Alert>
            ) : null}
            {membership.status === 'REVOKED' && membership.revokedAt ? (
              <Alert
                tone="warning"
                live={false}
                title={t('detail.since.revoked', { date: dateTime(membership.revokedAt) })}
              >
                {membership.revocationReason
                  ? t('detail.reason', { reason: membership.revocationReason })
                  : null}
              </Alert>
            ) : null}
            {selfBlocked && (showSuspend || showRevoke) ? (
              <div id={selfNoteId}>
                <Alert tone="info" live={false} title={t('detail.actions.selfProtected')} />
              </div>
            ) : null}
          </div>
        }
        tabs={
          <TabsList aria-label={t('detail.tabsLabel')}>
            <TabsTrigger value="data">{t('detail.tabs.data')}</TabsTrigger>
            <TabsTrigger value="roles">{t('detail.tabs.roles')}</TabsTrigger>
          </TabsList>
        }
      >
        <TabsContent value="data" className="flex flex-col gap-5 pt-0">
          <Card title={t('detail.identityTitle')} description={t('detail.identityHint')}>
            <dl className="grid gap-4 text-sm sm:grid-cols-3">
              <div>
                <dt className="font-semibold">{t('detail.name')}</dt>
                <dd className="text-muted-foreground">{membership.name}</dd>
              </div>
              <div>
                <dt className="font-semibold">{t('detail.socialName')}</dt>
                <dd className="text-muted-foreground">
                  {membership.socialName ?? t('detail.none')}
                </dd>
              </div>
              <div>
                <dt className="font-semibold">{t('detail.email')}</dt>
                <dd className="break-all text-muted-foreground">{membership.email}</dd>
              </div>
            </dl>
          </Card>

          <Card title={t('detail.membershipTitle')}>
            <UserDetailForm
              key={`profile:${membership.id}:${String(resetToken)}`}
              membership={membership}
              canEdit={canManage}
              locked={locked || pending}
              onSaved={(result) => {
                applied(result, 'saved');
              }}
              onFailed={failed}
            />
          </Card>

          <Card title={t('detail.departmentsTitle')}>
            <UserDepartmentsForm
              key={`departments:${membership.id}:${String(resetToken)}`}
              membership={membership}
              canEdit={allowed.has('UPDATE_DEPARTMENTS')}
              locked={locked || pending}
              onSaved={(result) => {
                applied(result, 'departmentsSaved');
              }}
              onFailed={failed}
            />
          </Card>
        </TabsContent>

        <TabsContent value="roles" className="pt-0">
          <RoleAssignmentsSection
            key={`roles:${membership.id}`}
            membership={membership}
            returnTo={detailPath}
          />
        </TabsContent>
      </DetailPage>

      <MfaResetDialog
        open={mfaResetOpen}
        membership={membership}
        returnTo={detailPath}
        onClose={() => {
          setMfaResetOpen(false);
        }}
        onDone={() => {
          setMfaResetOpen(false);
          toast({ title: t('detail.mfa.toast', { name: membership.name }), tone: 'success' });
        }}
        onStale={(feedback) => {
          showFeedback(feedback);
        }}
      />

      <MembershipActionDialog
        action={dialog}
        membership={membership}
        returnTo={detailPath}
        onClose={() => {
          setDialog(null);
        }}
        onDone={(action, result) => {
          setDialog(null);
          applied(result, action === 'SUSPEND' ? 'suspended' : 'revoked');
        }}
        onStale={(feedback) => {
          showFeedback(feedback);
        }}
      />
    </Tabs>
  );
}
