'use client';

import { Avatar, Tooltip, TooltipContent, TooltipTrigger } from '@contrataflow/ui';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { useLogout } from '@/components/session/logout-guard';
import { useShellSession } from '@/lib/session/session-context';

import { Icon } from './icons';

/** SCR-039 — Meu perfil (US-098). */
export const PROFILE_PATH = '/perfil';

/**
 * Cartão do usuário no rodapé da barra lateral (prd-6 · §2.2, padrão do Microlegis): avatar de
 * iniciais, nome, "Minha conta" e "Sair" — logout por POST com CSRF (DEC-131 · security.md §7),
 * com confirmação quando há rascunho local não sincronizado (`LogoutGuard` — US-088).
 */
export function UserCard({ onNavigate }: { readonly onNavigate?: (() => void) | undefined }) {
  const t = useTranslations('shell.user');
  const { user } = useShellSession();
  const { requestLogout } = useLogout();
  return (
    <div className="mx-3 flex flex-none items-center gap-2.5 rounded-[0.625rem] border border-border px-3 py-2">
      <Avatar name={user.displayName} />
      <div className="flex min-w-0 flex-1 flex-col">
        <p className="truncate text-sm leading-tight font-bold text-brand-ink">
          {user.displayName}
        </p>
        <Link
          href={PROFILE_PATH}
          onClick={() => onNavigate?.()}
          className="inline-flex min-h-6 items-center self-start text-xs text-primary-hover underline underline-offset-2 hover:text-brand-ink focus-visible:outline-sidebar-accent"
        >
          {t('account')}
        </Link>
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={t('logout')}
            onClick={() => {
              requestLogout();
            }}
            className="grid size-9 flex-none place-items-center rounded-control text-sidebar-muted hover:bg-muted hover:text-sidebar-foreground focus-visible:outline-sidebar-accent"
          >
            <Icon name="logout" className="size-[1.125rem]" />
          </button>
        </TooltipTrigger>
        <TooltipContent>{t('logout')}</TooltipContent>
      </Tooltip>
    </div>
  );
}
