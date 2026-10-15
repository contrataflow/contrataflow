'use client';

import {
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

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
}

/**
 * Menu do usuário: perfil e "Sair" — logout por POST com CSRF (DEC-131 · security.md §7), com
 * confirmação quando há rascunho local não sincronizado (`LogoutGuard` — US-088).
 */
export function UserMenu() {
  const t = useTranslations('shell.user');
  const { user } = useShellSession();
  const { requestLogout } = useLogout();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={t('menu', { name: user.displayName })}>
          <span
            aria-hidden="true"
            className="grid size-8 place-items-center rounded-full bg-foreground text-xs font-semibold text-surface"
          >
            {initials(user.displayName)}
          </span>
          <span className="hidden max-w-40 truncate xl:inline">{user.displayName}</span>
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
