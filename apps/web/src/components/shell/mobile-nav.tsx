'use client';

import {
  BrandLogo,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from '@contrataflow/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Icon } from './icons';
import { MainNav } from './main-nav';
import { SidebarHelp } from './sidebar-help';

/**
 * Menu em gaveta abaixo de 1024 px (shell responsivo — a barra lateral colapsa), com a mesma
 * estrutura dela: marca, grupos e ajuda.
 */
export function MobileNav({ showExample = false }: { readonly showExample?: boolean }) {
  const t = useTranslations('shell');
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t('nav.open')} className="lg:hidden">
          <Icon name="menu" className="size-5" />
        </Button>
      </DialogTrigger>
      <DialogContent
        closeLabel={null}
        className="top-0! left-0! flex! h-dvh max-w-72! translate-x-0! translate-y-0! flex-col gap-6! rounded-none! border-y-0! border-l-0! border-r-border! bg-sidebar! p-0! pb-4! text-sidebar-foreground!"
        aria-describedby={undefined}
      >
        <div className="flex flex-none items-center justify-between gap-2 px-4 pt-4">
          <DialogTitle className="pr-0!">
            <BrandLogo size="sm" name={t('appName')} />
          </DialogTitle>
          <DialogClose
            aria-label={t('nav.close')}
            className="grid size-11 place-items-center rounded-control text-sidebar-muted hover:bg-muted hover:text-sidebar-foreground focus-visible:outline-sidebar-accent"
          >
            <Icon name="close" className="size-5" />
          </DialogClose>
        </div>
        <MainNav
          showExample={showExample}
          onNavigate={() => {
            setOpen(false);
          }}
        />
        <SidebarHelp />
      </DialogContent>
    </Dialog>
  );
}
