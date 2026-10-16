'use client';

import { Alert, Button } from '@contrataflow/ui';
import { useTranslations } from 'next-intl';

import { ApiError } from '@/lib/api/api-error';

/** Mensagem do painel por falha (US-041 · "Casos de erro"): 404, 503 e erro inesperado com código. */
function messageKey(error: unknown): 'notFound' | 'unavailable' | 'unexpected' {
  if (error instanceof ApiError && error.status === 404) return 'notFound';
  if (error instanceof ApiError && (error.status === 503 || error.status === 429)) {
    return 'unavailable';
  }
  return 'unexpected';
}

export interface PanelErrorProps {
  readonly error: unknown;
  readonly onRetry: () => void;
}

/** Erro do painel com "Tentar novamente" (404 não oferece nova tentativa). */
export function PanelError({ error, onRetry }: PanelErrorProps) {
  const t = useTranslations('processActions.errors');
  const key = messageKey(error);
  const correlationId = error instanceof ApiError ? (error.correlationId ?? '—') : '—';
  return (
    <Alert tone="error" title={t(key, { correlationId })}>
      {key === 'notFound' ? null : (
        <Button size="sm" variant="secondary" className="mt-3" onClick={onRetry}>
          {t('retry')}
        </Button>
      )}
    </Alert>
  );
}
