'use client';

import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from '@contrataflow/ui';
import { useTranslations } from 'next-intl';

import { AuthIcon } from './auth-icons';

/** Documentos citados no aviso de privacidade; as páginas chegam com o conteúdo jurídico. */
export const PRIVACY_POLICY_HREF = '/privacidade';
export const TERMS_OF_USE_HREF = '/termos';

const LINK_CLASS = 'font-medium text-primary underline underline-offset-2 hover:opacity-80';

/**
 * Aviso de privacidade no rodapé da entrada (LGPD, DEC-140): uma linha na moldura e o aviso
 * completo no "Saiba mais". A instituição contratante é a controladora dos dados de acesso
 * (art. 7º, II e III, e art. 23).
 */
export function PrivacyNotice() {
  const t = useTranslations('auth.login.privacy');
  return (
    <div className="mx-auto flex w-full max-w-[420px] items-start gap-2 text-xs leading-normal text-muted-foreground">
      <AuthIcon name="shieldCheck" className="mt-px size-4 flex-none text-success" />
      <p className="min-w-0">
        {t('summary')}{' '}
        <Dialog>
          <DialogTrigger asChild>
            <button type="button" className={LINK_CLASS}>
              {t('more')}
            </button>
          </DialogTrigger>
          <DialogContent closeLabel={null}>
            <DialogTitle>{t('title')}</DialogTitle>
            <DialogDescription className="leading-relaxed">{t('description')}</DialogDescription>
            <p className="text-sm text-muted-foreground">
              {t.rich('references', {
                privacy: (chunks) => (
                  <a href={PRIVACY_POLICY_HREF} className={LINK_CLASS}>
                    {chunks}
                  </a>
                ),
                terms: (chunks) => (
                  <a href={TERMS_OF_USE_HREF} className={LINK_CLASS}>
                    {chunks}
                  </a>
                ),
              })}
            </p>
            <DialogFooter>
              <DialogClose asChild>
                <Button>{t('close')}</Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </p>
    </div>
  );
}
