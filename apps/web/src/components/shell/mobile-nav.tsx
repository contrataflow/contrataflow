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

/** Menu em gaveta abaixo de 768 px (shell responsivo — o menu lateral colapsa), em navy como ele. */
export function MobileNav({ showExample = false }: { readonly showExample?: boolean }) {
  const t = useTranslations('shell');
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t('nav.open')} className="md:hidden">
          <Icon name="menu" className="size-5" />
        </Button>
      </DialogTrigger>
      <DialogContent
        closeLabel={null}
        className="top-0! left-0! h-dvh max-w-72! translate-x-0! translate-y-0! content-start rounded-none! border-sidebar! bg-sidebar! p-0! text-sidebar-foreground!"
        aria-describedby={undefined}
      >
        <div className="flex h-14 items-center justify-between gap-2 border-b border-sidebar-foreground/10 px-4">
          <DialogTitle className="pr-0!">
            <BrandLogo tone="onDark" size="sm" name={t('appName')} />
          </DialogTitle>
          <DialogClose
            aria-label={t('nav.close')}
            className="grid size-8 place-items-center rounded-control text-sidebar-muted hover:bg-sidebar-foreground/10 hover:text-sidebar-foreground focus-visible:outline-sidebar-accent"
          >
            <Icon name="close" className="size-4" />
          </DialogClose>
        </div>
        <MainNav
          showExample={showExample}
          onNavigate={() => {
            setOpen(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
