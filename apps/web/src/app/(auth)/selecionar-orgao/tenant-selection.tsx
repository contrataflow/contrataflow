'use client';

import { Alert, Button } from '@contrataflow/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { HOME_PATH } from '@/lib/routes';
import { publishSessionEvent } from '@/lib/session/session-channel';
import type { ShellMembership } from '@/lib/session/types';

/** Lista de instituições usáveis; a escolha troca a instituição ativa da sessão (RN-IAM-66). */
export function TenantSelection({
  memberships,
  activeTenantId,
}: {
  readonly memberships: readonly ShellMembership[];
  readonly activeTenantId: string | null;
}) {
  const t = useTranslations('auth.selectTenant');
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState<string | null>(null);

  const select = async (tenantId: string) => {
    setPending(tenantId);
    setFailed(false);
    const response = await fetch('/api/auth/switch-tenant', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CF-Request': '1' },
      body: JSON.stringify({ tenantId }),
    }).catch(() => null);
    if (!response?.ok) {
      setPending(null);
      setFailed(true);
      return;
    }
    if (tenantId !== activeTenantId) publishSessionEvent({ type: 'tenant-switched', tenantId });
    window.location.assign(HOME_PATH);
  };

  return (
    <>
      {failed ? <Alert tone="error" title={t('failed')} /> : null}
      <ul className="flex flex-col gap-2">
        {memberships.map((membership) => (
          <li key={membership.membershipId}>
            <Button
              variant="secondary"
              className="w-full justify-start"
              aria-busy={pending === membership.tenant.id}
              onClick={() => {
                void select(membership.tenant.id);
              }}
            >
              {membership.tenant.name}
            </Button>
          </li>
        ))}
      </ul>
    </>
  );
}
