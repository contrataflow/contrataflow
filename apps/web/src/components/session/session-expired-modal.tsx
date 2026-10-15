'use client';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  buttonClassName,
} from '@contrataflow/ui';
import { useTranslations } from 'next-intl';

/**
 * `SessionExpiredModal` (US-088 · CA-T-09): bloqueante — sem fechar, sem `Esc`, sem clique fora.
 * A tela continua montada atrás (o que foi digitado fica no rascunho local); "Entrar novamente"
 * leva ao login com reautenticação e volta à página atual (RN-IAM-30/32).
 */
export function SessionExpiredModal({
  open,
  loginHref,
}: {
  readonly open: boolean;
  readonly loginHref: string;
}) {
  const t = useTranslations('shell.session.expired');
  return (
    <Dialog open={open}>
      <DialogContent
        closeLabel={null}
        className="max-w-md"
        onEscapeKeyDown={(event) => {
          event.preventDefault();
        }}
        onInteractOutside={(event) => {
          event.preventDefault();
        }}
      >
        <DialogTitle>{t('title')}</DialogTitle>
        <DialogDescription aria-live="assertive">{t('description')}</DialogDescription>
        <DialogFooter>
          <a href={loginHref} className={buttonClassName()}>
            {t('login')}
          </a>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
