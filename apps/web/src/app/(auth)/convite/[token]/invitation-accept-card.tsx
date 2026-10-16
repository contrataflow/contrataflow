'use client';

import { Alert, Button, Skeleton } from '@contrataflow/ui';
import { INVITATION_TOKEN_PATTERN } from '@contrataflow/validation';
import type { InvitationPreviewDto } from '@contrataflow/validation';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { acceptInvitation, previewInvitation } from '@/features/users/users.api';
import { isApiError } from '@/lib/api/api-error';
import { loginHref } from '@/lib/api/error-policy';
import { HOME_PATH } from '@/lib/routes';
import { switchTenant } from '@/lib/session/session-actions';

/** Página de entrada (SCR-001), para quem abriu um convite inválido. */
export const SIGN_IN_PATH = '/entrar';
/** SCR-101: escolha manual da instituição, se a troca automática falhar depois do aceite. */
const SELECT_TENANT_PATH = '/selecionar-orgao';

type CardState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly preview: InvitationPreviewDto }
  | { readonly kind: 'expired' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'error'; readonly message: 'generic' | 'unavailable' | 'tenantSuspended' };

function failureState(error: unknown): CardState {
  if (!isApiError(error)) return { kind: 'error', message: 'generic' };
  if (error.code === 'INVITATION_EXPIRED' || error.status === 410) return { kind: 'expired' };
  if (error.code === 'INVITATION_INVALID' || error.status === 404) return { kind: 'invalid' };
  if (error.code === 'TENANT_SUSPENDED') return { kind: 'error', message: 'tenantSuspended' };
  if (error.status === 503) return { kind: 'error', message: 'unavailable' };
  return { kind: 'error', message: 'generic' };
}

export interface InvitationAcceptCardProps {
  readonly token: string;
  /** Instituição ativa da sessão (`null` quando ainda não há nenhuma). */
  readonly currentTenantId: string | null;
  /** Navegação com recarga completa (o *step-up* e o login são rotas do BFF, não páginas). */
  readonly navigate?: (href: string) => void;
}

function hardNavigate(href: string): void {
  window.location.assign(href);
}

/**
 * `InvitationAcceptCard` (SCR-102 · US-091 · USR-14/USR-06): mostra o que o convite concede
 * (instituição, tipo, cargo, lotação e validade) e aceita com "Aceitar convite". Token malformado
 * é inválido sem chamar a API. Depois do aceite a instituição passa a ser a ativa (troca de tenant
 * da mesma sessão) e a pessoa segue para o início; se a troca exigir MFA, vai ao *step-up*.
 */
export function InvitationAcceptCard({
  token,
  currentTenantId,
  navigate = hardNavigate,
}: InvitationAcceptCardProps) {
  const t = useTranslations('auth.invite');
  const format = useFormatter();
  const router = useRouter();
  const wellFormed = INVITATION_TOKEN_PATTERN.test(token);
  const [state, setState] = useState<CardState>(
    wellFormed ? { kind: 'loading' } : { kind: 'invalid' },
  );
  const [attempt, setAttempt] = useState(0);
  const [accepting, setAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [switchFailed, setSwitchFailed] = useState(false);

  useEffect(() => {
    if (!wellFormed) return;
    const controller = new AbortController();
    void previewInvitation(token, controller.signal).then(
      (result) => {
        setState({ kind: 'ready', preview: result.data });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        if (isApiError(error) && error.status === 401) {
          navigate(loginHref(`/convite/${token}`));
          return;
        }
        setState(failureState(error));
      },
    );
    return () => {
      controller.abort();
    };
    // `navigate` é estável por contrato (função de módulo ou do chamador).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, wellFormed, attempt]);

  const accept = async () => {
    setAccepting(true);
    setAcceptError(null);
    setSwitchFailed(false);
    let membershipId: string;
    try {
      membershipId = (await acceptInvitation(token)).data.id;
    } catch (error: unknown) {
      setAccepting(false);
      if (isApiError(error) && error.status === 401) {
        navigate(loginHref(`/convite/${token}`));
        return;
      }
      const next = failureState(error);
      if (next.kind === 'error') setAcceptError(t(`errors.${next.message}`));
      else setState(next);
      return;
    }
    try {
      const outcome = await switchTenant(membershipId, {
        currentTenantId,
        refresh: () => {
          router.refresh();
        },
      });
      if (outcome.kind === 'step-up') {
        navigate(outcome.href);
        return;
      }
      router.replace(HOME_PATH);
    } catch {
      // O vínculo já foi ativado: a pessoa escolhe a instituição manualmente.
      setSwitchFailed(true);
      setAccepting(false);
    }
  };

  const dateTime = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: 'short', timeStyle: 'short' });
  const none = t('noValue');

  return (
    <section className="mx-auto flex w-full max-w-md flex-col gap-4 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>

      {state.kind === 'loading' ? (
        <div role="status" className="flex flex-col gap-2">
          <span className="sr-only">{t('loading')}</span>
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-2/3" />
        </div>
      ) : null}

      {state.kind === 'ready' ? (
        <>
          <p className="text-muted-foreground">{t('description')}</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-card border border-border bg-surface p-4 text-sm">
            <dt className="text-muted-foreground">{t('tenant')}</dt>
            <dd className="font-medium">{state.preview.tenant.name}</dd>
            <dt className="text-muted-foreground">{t('type')}</dt>
            <dd>{t(`types.${state.preview.type}`)}</dd>
            <dt className="text-muted-foreground">{t('jobTitle')}</dt>
            <dd>{state.preview.jobTitle ?? none}</dd>
            <dt className="text-muted-foreground">{t('departments')}</dt>
            <dd>
              {state.preview.departments.length === 0
                ? none
                : state.preview.departments.map((department) => department.name).join(', ')}
            </dd>
            {state.preview.expiresAt ? (
              <>
                <dt className="text-muted-foreground">{t('expiresAt')}</dt>
                <dd>{dateTime(state.preview.expiresAt)}</dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">{t('inviteExpiresAt')}</dt>
            <dd>{dateTime(state.preview.inviteExpiresAt)}</dd>
          </dl>

          <div aria-live="polite">
            {acceptError ? <Alert tone="error" title={acceptError} /> : null}
            {switchFailed ? (
              <Alert tone="warning" title={t('errors.switchFailed')}>
                <Link className="font-medium underline" href={SELECT_TENANT_PATH}>
                  {t('selectTenant')}
                </Link>
              </Alert>
            ) : null}
          </div>

          <div className="bg-background max-md:sticky max-md:bottom-0 max-md:-mx-4 max-md:border-t max-md:border-border max-md:px-4 max-md:py-3">
            <Button
              className="w-full"
              disabled={accepting}
              aria-busy={accepting}
              onClick={() => {
                void accept();
              }}
            >
              {accepting ? t('accepting') : t('accept')}
            </Button>
          </div>
        </>
      ) : null}

      {state.kind === 'expired' ? (
        <Alert tone="warning" title={t('expired.title')}>
          {t('expired.description')}
        </Alert>
      ) : null}

      {state.kind === 'invalid' ? (
        <>
          <Alert tone="error" title={t('invalid.title')}>
            {t('invalid.description')}
          </Alert>
          <Link className="font-medium underline" href={SIGN_IN_PATH}>
            {t('invalid.signIn')}
          </Link>
        </>
      ) : null}

      {state.kind === 'error' ? (
        <Alert tone="error" title={t(`errors.${state.message}`)}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setState({ kind: 'loading' });
              setAttempt((current) => current + 1);
            }}
          >
            {t('retry')}
          </Button>
        </Alert>
      ) : null}
    </section>
  );
}
