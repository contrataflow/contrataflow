'use client';

import { Button, Dialog, DialogContent, DialogTitle, DialogTrigger } from '@contrataflow/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Icon } from './icons';
import { MainNav } from './main-nav';

/** Menu em gaveta abaixo de 768 px (shell responsivo — o menu lateral colapsa). */
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
        closeLabel={t('nav.close')}
        className="top-0 left-0 h-dvh max-w-72 translate-x-0 translate-y-0 content-start rounded-none p-0"
        aria-describedby={undefined}
      >
        <DialogTitle className="border-b border-border px-4 py-4">{t('appName')}</DialogTitle>
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
