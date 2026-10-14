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

import { switchTenant } from '@/lib/session/session-actions';
import { useShellSession } from '@/lib/session/session-context';

import { Icon } from './icons';

/**
 * Seletor de instituição contratante (DEC-012): troca a instituição ativa na mesma sessão,
 * apagando o cache do tenant anterior antes de buscar qualquer dado do novo (RN-FND-90).
 */
export function TenantSwitcher() {
  const t = useTranslations('shell.tenant');
  const session = useShellSession();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const active = session.activeTenant;

  const select = (tenantId: string, name: string) => {
    if (tenantId === active.id || pending) return;
    setPending(true);
    switchTenant(tenantId, {
      queryClient,
      refresh: () => {
        router.refresh();
      },
    })
      .then(() => {
        toast({ title: t('switched', { name }), tone: 'success' });
      })
      .catch(() => {
        toast({ title: t('switchFailed'), tone: 'error' });
      })
      .finally(() => {
        setPending(false);
      });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="secondary"
          size="sm"
          aria-label={t('label', { name: active.name })}
          aria-busy={pending}
        >
          <Icon name="building" className="size-4 text-muted-foreground" />
          <span className="hidden max-w-48 truncate sm:inline">{active.name}</span>
          <Icon name="chevronDown" className="size-4 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-72">
        <DropdownMenuLabel>{t('heading')}</DropdownMenuLabel>
        {session.memberships.map((membership) => {
          const current = membership.tenant.id === active.id;
          return (
            <DropdownMenuItem
              key={membership.membershipId}
              disabled={!membership.usable}
              onSelect={() => {
                select(membership.tenant.id, membership.tenant.name);
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
