'use client';

import { Alert, Button } from '@contrataflow/ui';
import { useTranslations } from 'next-intl';

/*
 * Avisos não bloqueantes da sessão (US-088): fim absoluto em 5 min (RN-IAM-23) e
 * indisponibilidade do serviço (503 — RN-IAM-33: nunca "sessão expirada"; a tela e o que foi
 * digitado continuam). Fixos no rodapé, legíveis em 360 px.
 */

export function AbsoluteEndNotice({ endsAt }: { readonly endsAt: string }) {
  const t = useTranslations('shell.session');
  return (
    <div className="fixed inset-x-4 bottom-4 z-40 mx-auto max-w-lg">
      <Alert tone="warning" title={t('absolute', { time: endsAt })} />
    </div>
  );
}

export function UnavailableBanner({
  onRetry,
  pending,
}: {
  readonly onRetry: () => void;
  readonly pending: boolean;
}) {
  const t = useTranslations('shell.session.unavailable');
  return (
    <div className="fixed inset-x-4 bottom-4 z-40 mx-auto max-w-lg">
      <Alert tone="error" title={t('title')}>
        <p>{t('description')}</p>
        <Button
          variant="secondary"
          size="sm"
          className="mt-3"
          aria-busy={pending}
          onClick={onRetry}
        >
          {t('retry')}
        </Button>
      </Alert>
    </div>
  );
}
