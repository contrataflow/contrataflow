'use client';

import { Kbd } from '@contrataflow/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { CommandPalette } from './command-palette';
import { Icon } from './icons';

/** Ctrl K (⌘ K no Mac) abre a paleta de comandos de qualquer ponto do app. */
export function isSearchShortcut(event: KeyboardEvent): boolean {
  return (
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === 'k'
  );
}

/**
 * Busca global da barra superior (prd-5 · §4 card 2): parece um campo, mas abre a paleta de
 * comandos (`CommandPalette`) — busca de processos, "Novo processo" e "Ir para" as áreas do menu.
 * O atalho Ctrl K abre a mesma paleta. No celular ocupa a segunda linha da barra.
 */
export function GlobalSearch({ showExample = false }: { readonly showExample?: boolean }) {
  const t = useTranslations('shell.search');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isSearchShortcut(event)) return;
      event.preventDefault();
      setOpen(true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);
  return (
    <div className="order-last w-full md:order-none md:w-auto md:max-w-xl md:flex-1">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-keyshortcuts="Control+K"
        aria-label={t('label')}
        onClick={() => {
          setOpen(true);
        }}
        className="flex h-11 w-full items-center gap-2.5 rounded-control border border-border-strong bg-background px-3.5 text-left text-sm text-muted-foreground hover:border-primary"
      >
        <Icon name="search" className="size-[1.125rem] flex-none" />
        <span className="min-w-0 flex-1 truncate">{t('placeholder')}</span>
        <Kbd aria-hidden="true" className="max-sm:hidden">
          {t('shortcut')}
        </Kbd>
      </button>
      <CommandPalette open={open} onOpenChange={setOpen} showExample={showExample} />
    </div>
  );
}
