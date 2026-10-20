'use client';

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  toast,
} from '@contrataflow/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { ApiError } from '@/lib/api/api-error';
import { HOME_PATH } from '@/lib/routes';
import { switchTenant } from '@/lib/session/session-actions';
import { useShellSession } from '@/lib/session/session-context';
import type { ShellMembership } from '@/lib/session/types';

import { Icon } from './icons';

/** SCR-101 completa (lista com "Usar como padrão"). */
export const SELECT_TENANT_PATH = '/selecionar-orgao';

/** Mensagem do toast de erro por código do problem+json (Casos de erro da US-093). */
export type TenantSwitchFailure =
  'invalid' | 'membershipInactive' | 'tenantSuspended' | 'unavailable' | 'failed';

export function tenantSwitchFailure(error: unknown): TenantSwitchFailure {
  if (!(error instanceof ApiError)) return 'failed';
  switch (error.code) {
    case 'VALIDATION_ERROR':
      return 'invalid';
    case 'MEMBERSHIP_INACTIVE':
      return 'membershipInactive';
    case 'TENANT_SUSPENDED':
      return 'tenantSuspended';
    case 'DEPENDENCY_UNAVAILABLE':
      return 'unavailable';
    default:
      return 'failed';
  }
}

/**
 * Seletor de instituição contratante no cabeçalho (`TenantSwitcherMenu` de SCR-101 · DEC-012 ·
 * US-093): troca a instituição ativa na mesma sessão, apaga o cache do tenant anterior antes de
 * buscar qualquer dado do novo (RN-IAM-72) e segue ao início com o toast "Agora você está em …".
 * Com um único vínculo, mostra a instituição atual sem opção de troca (FA-03); o destino que
 * exige MFA leva ao *step-up* (FA-01).
 */
export function TenantSwitcher() {
  const t = useTranslations('shell.tenant');
  const session = useShellSession();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  /** Vínculos recusados pela API nesta tela ("Remove da lista" — V-02). */
  const [revoked, setRevoked] = useState<ReadonlySet<string>>(new Set());
  const active = session.activeTenant;
  const memberships = session.memberships.filter(
    (membership) => !revoked.has(membership.membershipId),
  );
  const switchable = memberships.some(
    (membership) => membership.usable && membership.tenant.id !== active.id,
  );

  const select = (membership: ShellMembership) => {
    if (membership.tenant.id === active.id || !membership.usable || pending) return;
    setPending(membership.membershipId);
    switchTenant(membership.membershipId, {
      queryClient,
      currentTenantId: active.id,
      refresh: () => {
        router.push(HOME_PATH);
        router.refresh();
      },
    })
      .then((outcome) => {
        if (outcome.kind === 'step-up') {
          window.location.assign(outcome.href);
          return;
        }
        if (outcome.kind === 'switched') {
          const name = outcome.session.activeTenant?.name ?? membership.tenant.name;
          toast({ title: t('switched', { name }), tone: 'success' });
        }
      })
      .catch((error: unknown) => {
        const failure = tenantSwitchFailure(error);
        if (failure === 'membershipInactive') {
          setRevoked((current) => new Set(current).add(membership.membershipId));
        }
        // Vínculo que não é mais do usuário: a lista é recarregada do servidor.
        if (failure === 'invalid') router.refresh();
        toast({ title: t(`errors.${failure}`), tone: 'error' });
      })
      .finally(() => {
        setPending(null);
      });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="secondary"
          size="sm"
          aria-label={t('label', { name: active.name })}
          aria-busy={pending !== null}
        >
          <Icon name="building" className="size-4 text-muted-foreground" />
          <span className="hidden max-w-48 truncate sm:inline">
            {pending ? t('switching') : active.name}
          </span>
          <Icon name="chevronDown" className="size-4 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-72">
        <DropdownMenuLabel>{t('heading')}</DropdownMenuLabel>
        {memberships.map((membership) => {
          const current = membership.tenant.id === active.id;
          return (
            <DropdownMenuItem
              key={membership.membershipId}
              disabled={current || !membership.usable || pending !== null}
              aria-current={current ? 'true' : undefined}
              onSelect={() => {
                select(membership);
              }}
              className="justify-between"
            >
              <span>
                {membership.tenant.name}
                {current ? <span className="sr-only"> {t('current')}</span> : null}
              </span>
              {current ? <Icon name="check" className="size-4 text-primary" /> : null}
            </DropdownMenuItem>
          );
        })}
        {switchable ? null : (
          <p className="px-3 py-2 text-xs text-muted-foreground">{t('single')}</p>
        )}
        <DropdownMenuItem
          onSelect={() => {
            router.push(SELECT_TENANT_PATH);
          }}
        >
          {t('manage')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
