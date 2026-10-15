'use client';

import { Alert } from '@contrataflow/ui';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

import { AuthIcon } from '@/features/auth/auth-icons';
import { InstitutionList } from '@/features/auth/institution-list';
import { SignOutButton } from '@/features/auth/sign-out-button';
import { ApiError } from '@/lib/api/api-error';
import { HOME_PATH } from '@/lib/routes';
import { switchTenant } from '@/lib/session/session-actions';
import type { ShellMembership } from '@/lib/session/types';

/** Mensagem inline por código do problem+json de `POST /api/auth/switch-tenant`. */
type FailureKey =
  'failed' | 'invalid' | 'membershipInactive' | 'tenantSuspended' | 'forbidden' | 'unavailable';

function failureKey(code: string): FailureKey {
  switch (code) {
    case 'VALIDATION_ERROR':
      return 'invalid';
    case 'MEMBERSHIP_INACTIVE':
      return 'membershipInactive';
    case 'TENANT_SUSPENDED':
      return 'tenantSuspended';
    case 'PERMISSION_DENIED':
    case 'CSRF_REJECTED':
      return 'forbidden';
    case 'DEPENDENCY_UNAVAILABLE':
      return 'unavailable';
    default:
      return 'failed';
  }
}

/** Navegação com recarga completa: a sessão mudou e nada do estado do cliente pode sobreviver. */
function hardNavigate(href: string): void {
  window.location.assign(href);
}

/**
 * Seleção da instituição (SCR-101 · `TenantList`): no login (FA-01 da US-087) e a qualquer momento
 * pelo cabeçalho (US-093). A escolha troca a instituição ativa da MESMA sessão no BFF (RN-IAM-66) e
 * segue para `returnTo` (já validado no servidor) ou para o início; "Usar como padrão" pré-seleciona
 * a instituição nos próximos logins (FA-04). O destino que exige MFA leva ao *step-up* (FA-01).
 */
export function TenantSelection({
  memberships,
  activeTenantId,
  returnTo,
}: {
  /** Todos os vínculos; os não utilizáveis aparecem desabilitados (FA-08). */
  readonly memberships: readonly ShellMembership[];
  readonly activeTenantId: string | null;
  readonly returnTo: string | null;
}) {
  const t = useTranslations('auth.selectTenant');
  const defaultSwitchId = useId();
  const [failure, setFailure] = useState<FailureKey | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [setAsDefault, setSetAsDefault] = useState(false);
  /** Vínculos recusados pela API nesta tela (V-02: "Remove da lista"). */
  const [revoked, setRevoked] = useState<ReadonlySet<string>>(new Set());
  const listed = memberships.map((membership) =>
    revoked.has(membership.membershipId) ? { ...membership, usable: false } : membership,
  );

  const select = async (membership: ShellMembership) => {
    setPending(membership.membershipId);
    setFailure(null);
    try {
      const outcome = await switchTenant(membership.membershipId, {
        currentTenantId: activeTenantId,
        setAsDefault,
        refresh: () => undefined,
      });
      hardNavigate(outcome.kind === 'step-up' ? outcome.href : (returnTo ?? HOME_PATH));
    } catch (error: unknown) {
      setPending(null);
      if (!(error instanceof ApiError)) {
        setFailure('failed');
        return;
      }
      if (error.code === 'SESSION_EXPIRED' || error.code === 'UNAUTHENTICATED') {
        const query = new URLSearchParams({ motivo: 'sessao-expirada' });
        if (returnTo) query.set('returnTo', returnTo);
        hardNavigate(`/entrar?${query.toString()}`);
        return;
      }
      const key = failureKey(error.code);
      if (key === 'membershipInactive') {
        setRevoked((current) => new Set(current).add(membership.membershipId));
      }
      setFailure(key);
    }
  };

  return (
    <>
      {failure ? <Alert tone="error" title={t(`errors.${failure}`)} className="mt-6" /> : null}
      <InstitutionList
        memberships={listed}
        activeTenantId={activeTenantId}
        pendingMembershipId={pending}
        onSelect={(membership) => {
          void select(membership);
        }}
      />
      <div className="mt-6 flex items-start gap-3">
        <input
          id={defaultSwitchId}
          type="checkbox"
          role="switch"
          checked={setAsDefault}
          disabled={pending !== null}
          onChange={(event) => {
            setSetAsDefault(event.target.checked);
          }}
          className="mt-0.5 size-4 flex-none accent-primary"
        />
        <label htmlFor={defaultSwitchId} className="text-sm">
          <span className="font-medium text-foreground">{t('setAsDefault')}</span>
          <span className="block text-muted-foreground">{t('setAsDefaultHint')}</span>
        </label>
      </div>
      <div className="mt-8 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <p className="flex gap-2 text-sm text-muted-foreground">
          <AuthIcon name="info" className="mt-0.5 size-4 flex-none" />
          {t('help')}
        </p>
        <SignOutButton variant="ghost" withIcon className="flex-none" />
      </div>
    </>
  );
}
