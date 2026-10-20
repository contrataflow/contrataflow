'use client';

import { Alert, Button, Skeleton, toast } from '@contrataflow/ui';
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
 * Detalhe do vínculo (SCR-029 `/admin/usuarios/[userId]` · US-092): dados globais somente leitura,
 * `UserDetailForm` (USR-08), lotações com principal explícita (USR-09) e as ações de acesso
 * (suspender, reativar, revogar — USR-10..12) conforme `meta.allowedActions` e a aba "Perfis e
 * acessos" (US-096 · ROL-10..12), e a redefinição da autenticação em duas etapas (US-090 · USR-13,
 * oculta para o próprio vínculo — RN-IAM-43). Toda mutação de vínculo envia
 * `If-Match`; a resposta (mesmo formato do detalhe, novo `ETag`) substitui o detalhe em cache e
 * invalida a lista, sem recarregar a página. 412/409 recarregam o detalhe antes de nova tentativa;
 * 404 devolve à lista.
 */
export function UserDetailView({ userId }: { readonly userId: string }) {
  const t = useTranslations('users');
  const tErrors = useTranslations('users.detail.errors');
  const format = useFormatter();
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const selfNoteId = useId();
  const [dialog, setDialog] = useState<MembershipDialogAction | null>(null);
  const [mfaResetOpen, setMfaResetOpen] = useState(false);
  const [state, setState] = useState<FeedbackState | null>(null);
  const [gone, setGone] = useState(false);
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

  // POL-16 (FA-03): o próprio ator vê os botões desabilitados, com a explicação.
  const selfBlocked = canManage && meta.isSelf;
  const showSuspend = allowed.has('SUSPEND') || (selfBlocked && membership.status === 'ACTIVE');
  const showRevoke =
    allowed.has('REVOKE') ||
    (selfBlocked && (membership.status === 'ACTIVE' || membership.status === 'SUSPENDED'));
  const showReactivate = allowed.has('REACTIVATE');
  const hasActions = showSuspend || showRevoke || showReactivate;

  return (
    <div className="flex flex-col gap-8">
      {backLink}

      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{membership.name}</h1>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <StatusBadge membership={membership} />
          <span>{t(`types.${membership.type}`)}</span>
        </div>
      </header>

      <div aria-live="assertive">
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

      <section aria-labelledby={`${selfNoteId}-identity`} className="flex flex-col gap-3">
        <h2 id={`${selfNoteId}-identity`} className="text-lg font-semibold">
          {t('detail.identityTitle')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('detail.identityHint')}</p>
        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="font-medium">{t('detail.name')}</dt>
            <dd className="text-muted-foreground">{membership.name}</dd>
          </div>
          <div>
            <dt className="font-medium">{t('detail.socialName')}</dt>
            <dd className="text-muted-foreground">{membership.socialName ?? t('detail.none')}</dd>
          </div>
          <div>
            <dt className="font-medium">{t('detail.email')}</dt>
            <dd className="break-all text-muted-foreground">{membership.email}</dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby={`${selfNoteId}-membership`} className="flex flex-col gap-3">
        <h2 id={`${selfNoteId}-membership`} className="text-lg font-semibold">
          {t('detail.membershipTitle')}
        </h2>
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
      </section>

      <section aria-labelledby={`${selfNoteId}-departments`} className="flex flex-col gap-3">
        <h2 id={`${selfNoteId}-departments`} className="text-lg font-semibold">
          {t('detail.departmentsTitle')}
        </h2>
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
      </section>

      <RoleAssignmentsSection
        key={`roles:${membership.id}`}
        membership={membership}
        returnTo={detailPath}
      />

      {hasActions ? (
        <section aria-labelledby={`${selfNoteId}-access`} className="flex flex-col gap-3">
          <h2 id={`${selfNoteId}-access`} className="text-lg font-semibold">
            {t('detail.statusTitle')}
          </h2>
          <div className="flex flex-wrap gap-2">
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
            {showSuspend ? (
              <Button
                variant="secondary"
                disabled={meta.isSelf || locked || pending}
                aria-describedby={meta.isSelf ? selfNoteId : undefined}
                title={meta.isSelf ? t('detail.actions.selfProtected') : undefined}
                onClick={() => {
                  setState(null);
                  setDialog('SUSPEND');
                }}
              >
                {t('detail.actions.suspend')}
              </Button>
            ) : null}
            {showRevoke ? (
              <Button
                variant="destructive"
                disabled={meta.isSelf || locked || pending}
                aria-describedby={meta.isSelf ? selfNoteId : undefined}
                title={meta.isSelf ? t('detail.actions.selfProtected') : undefined}
                onClick={() => {
                  setState(null);
                  setDialog('REVOKE');
                }}
              >
                {t('detail.actions.revoke')}
              </Button>
            ) : null}
          </div>
          {selfBlocked && (showSuspend || showRevoke) ? (
            <p id={selfNoteId} className="text-sm text-muted-foreground">
              {t('detail.actions.selfProtected')}
            </p>
          ) : null}
        </section>
      ) : null}

      {allowed.has('MFA_RESET') ? (
        <section aria-labelledby={`${selfNoteId}-mfa`} className="flex flex-col gap-3">
          <h2 id={`${selfNoteId}-mfa`} className="text-lg font-semibold">
            {t('detail.mfa.title')}
          </h2>
          <p className="text-sm text-muted-foreground">{t('detail.mfa.hint')}</p>
          <div>
            <Button
              variant="secondary"
              disabled={locked || pending}
              onClick={() => {
                setState(null);
                setMfaResetOpen(true);
              }}
            >
              {t('detail.mfa.action')}
            </Button>
          </div>
        </section>
      ) : null}

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
    </div>
  );
}
