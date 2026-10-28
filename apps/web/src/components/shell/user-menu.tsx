'use client';

import {
  Avatar,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@contrataflow/ui';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { useLogout } from '@/components/session/logout-guard';
import { useShellSession } from '@/lib/session/session-context';

import { Icon } from './icons';

/**
 * Menu do usuário (avatar de iniciais e nome — prd-4 · padrão 2): perfil e "Sair" — logout por POST com CSRF (DEC-131 · security.md §7), com
 * confirmação quando há rascunho local não sincronizado (`LogoutGuard` — US-088).
 */
export function UserMenu() {
  const t = useTranslations('shell.user');
  const { user } = useShellSession();
  const { requestLogout } = useLogout();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="secondary"
          aria-label={t('menu', { name: user.displayName })}
          className="gap-2.5 pr-3 pl-1.5 font-medium"
        >
          <Avatar name={user.displayName} />
          <span className="hidden max-w-40 truncate md:inline">{user.displayName}</span>
          <Icon name="chevronDown" className="size-4 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel className="normal-case">{user.displayName}</DropdownMenuLabel>
        <DropdownMenuItem asChild>
          <Link href="/perfil">
            <Icon name="user" />
            {t('profile')}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            requestLogout();
          }}
        >
          <Icon name="logout" />
          {t('logout')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
