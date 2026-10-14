'use client';

import { Alert } from '@contrataflow/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { AuthIcon } from '@/features/auth/auth-icons';
import { InstitutionList } from '@/features/auth/institution-list';
import { SignOutButton } from '@/features/auth/sign-out-button';
import { apiErrorFromResponse } from '@/lib/api/api-error';
import { HOME_PATH } from '@/lib/routes';
import { publishSessionEvent } from '@/lib/session/session-channel';
import type { ShellMembership } from '@/lib/session/types';

/** Mensagem inline por código do problem+json de `POST /api/auth/switch-tenant`. */
type FailureKey = 'failed' | 'membershipInactive' | 'tenantSuspended' | 'forbidden' | 'unavailable';

function failureKey(code: string): FailureKey {
  switch (code) {
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
 * Seleção da instituição do login (SCR-101 · FA-01): a escolha troca a instituição ativa da
 * sessão no BFF e segue para `returnTo` (já validado no servidor) ou para o início (RN-IAM-66).
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
  const [failure, setFailure] = useState<FailureKey | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const select = async (tenantId: string) => {
    setPending(tenantId);
    setFailure(null);
    const response = await fetch('/api/auth/switch-tenant', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CF-Request': '1' },
      body: JSON.stringify({ tenantId }),
    }).catch(() => null);
    if (!response?.ok) {
      setPending(null);
      if (!response) {
        setFailure('failed');
        return;
      }
      const body: unknown = await response.json().catch(() => null);
      const error = apiErrorFromResponse(response.status, response.headers, body);
      if (error.code === 'SESSION_EXPIRED' || error.code === 'UNAUTHENTICATED') {
        const query = new URLSearchParams({ motivo: 'sessao-expirada' });
        if (returnTo) query.set('returnTo', returnTo);
        hardNavigate(`/entrar?${query.toString()}`);
        return;
      }
      setFailure(failureKey(error.code));
      return;
    }
    if (tenantId !== activeTenantId) publishSessionEvent({ type: 'tenant-switched', tenantId });
    hardNavigate(returnTo ?? HOME_PATH);
  };

  return (
    <>
      {failure ? <Alert tone="error" title={t(`errors.${failure}`)} className="mt-6" /> : null}
      <InstitutionList
        memberships={memberships}
        pendingTenantId={pending}
        onSelect={(tenantId) => {
          void select(tenantId);
        }}
      />
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
