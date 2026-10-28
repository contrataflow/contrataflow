'use client';

import { Kbd } from '@contrataflow/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';

import { Icon } from './icons';

/** Ctrl K (⌘ K no Mac) leva à busca de qualquer ponto do app. */
export function isSearchShortcut(event: KeyboardEvent): boolean {
  return (
    (event.ctrlKey || event.metaKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === 'k'
  );
}

/**
 * Busca global da barra superior (prd-4 · padrão 2): envia `q` para a lista de processos, que
 * busca por número, título e objeto. O atalho Ctrl K foca o campo (sem paleta de comandos). No
 * celular o campo ocupa a segunda linha da barra.
 */
export function GlobalSearch() {
  const t = useTranslations('shell.search');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isSearchShortcut(event) || !input.current) return;
      event.preventDefault();
      input.current.focus();
      input.current.select();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);
  return (
    <form
      role="search"
      action="/processos"
      className="order-last w-full md:order-none md:w-auto md:max-w-xl md:flex-1"
    >
      <div className="relative flex items-center">
        <label htmlFor="busca-global" className="sr-only">
          {t('label')}
        </label>
        <Icon
          name="search"
          className="pointer-events-none absolute left-3.5 size-[1.125rem] text-muted-foreground"
        />
        <input
          ref={input}
          id="busca-global"
          type="search"
          name="q"
          placeholder={t('placeholder')}
          aria-keyshortcuts="Control+K"
          className="h-11 w-full rounded-control border border-border-strong bg-background pr-3 pl-10 text-sm text-foreground placeholder:text-muted-foreground sm:pr-18"
        />
        <Kbd
          aria-hidden="true"
          className="pointer-events-none absolute right-3 hidden sm:inline-flex"
        >
          {t('shortcut')}
        </Kbd>
      </div>
    </form>
  );
}
