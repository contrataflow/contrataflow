'use client';

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@contrataflow/ui';
import { useTranslations } from 'next-intl';

import { formatCountdown } from '@/lib/session/watcher';

/**
 * `IdleWarningDialog` (US-088 · RN-IAM-23): "Você continua aí?" 2 min antes do fim por
 * ociosidade. O aviso é anunciado uma vez (`aria-live="assertive"`); a contagem regressiva é só
 * visual (`role="timer"`, sem anunciar a cada segundo). Foco preso e devolvido pelo `Dialog`;
 * `Esc` equivale a "Continuar conectado" (o usuário está presente). Foco ou clique fora NÃO fecham:
 * a sessão só é renovada por uma ação explícita do usuário.
 */
export function IdleWarningDialog({
  open,
  secondsLeft,
  pending,
  onStay,
  onLogout,
}: {
  readonly open: boolean;
  readonly secondsLeft: number;
  readonly pending: boolean;
  readonly onStay: () => void;
  readonly onLogout: () => void;
}) {
  const t = useTranslations('shell.session.idle');
  return (
    <Dialog open={open}>
      <DialogContent
        closeLabel={null}
        className="max-w-md"
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          onStay();
        }}
        onInteractOutside={(event) => {
          event.preventDefault();
        }}
      >
        <DialogTitle>{t('title')}</DialogTitle>
        <DialogDescription aria-live="assertive">{t('description')}</DialogDescription>
        <p
          role="timer"
          aria-label={t('countdown', { time: formatCountdown(secondsLeft) })}
          className="text-2xl font-semibold tabular-nums"
        >
          {formatCountdown(secondsLeft)}
        </p>
        {/* "Continuar conectado" primeiro: recebe o foco ao abrir (primeiro elemento focável). */}
        <DialogFooter>
          <Button onClick={onStay} aria-busy={pending}>
            {t('stay')}
          </Button>
          <Button variant="secondary" onClick={onLogout}>
            {t('logout')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
