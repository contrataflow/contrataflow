'use client';

import { Alert, Button } from '@contrataflow/ui';
import { RENDITION_MESSAGES } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';

import { CorrelationCode } from '@/components/errors/correlation-code';

import type { RenditionOutcome } from './rendition-errors';

export interface RenditionErrorAlertProps {
  readonly outcome: RenditionOutcome;
  /** "Tentar novamente" (503): repete o pedido ou a consulta que falhou. */
  readonly onRetry?: (() => void) | undefined;
}

/**
 * Falha de DOC-20..23 em linha (US-067 · "Casos de erro"): 404, 409, 403, 429, 503 e inesperado.
 * Redirecionamentos e sessão expirada não chegam aqui — quem usa o componente os trata antes.
 */
export function RenditionErrorAlert({ outcome, onRetry }: RenditionErrorAlertProps) {
  const t = useTranslations('documents.renditions');
  const tErrors = useTranslations('errors');

  switch (outcome.kind) {
    case 'notFound':
      return <Alert tone="error" title={RENDITION_MESSAGES.notFound} />;
    case 'rateLimited':
      return <Alert tone="warning" title={RENDITION_MESSAGES.rateLimited} />;
    case 'notReady':
      return <Alert tone="warning" title={outcome.detail ?? RENDITION_MESSAGES.notReady} />;
    case 'forbidden':
      return <Alert tone="error" title={outcome.detail ?? t('errors.forbidden')} />;
    case 'unavailable':
      return (
        <Alert tone="error" title={RENDITION_MESSAGES.unavailable}>
          {onRetry ? (
            <Button size="sm" variant="secondary" className="mt-3" onClick={onRetry}>
              {t('retry')}
            </Button>
          ) : null}
        </Alert>
      );
    case 'redirect':
    case 'silent':
      return null;
    case 'unexpected': {
      const correlationId = outcome.correlationId;
      return (
        <Alert tone="error" title={t('errors.unexpected')}>
          {correlationId ? (
            <div className="mt-2">
              <CorrelationCode
                correlationId={correlationId}
                labels={{
                  code: tErrors('correlation.label', { correlationId }),
                  copy: tErrors('correlation.copy'),
                  copied: tErrors('correlation.copied'),
                }}
              />
            </div>
          ) : null}
          {onRetry ? (
            <Button size="sm" variant="secondary" className="mt-3" onClick={onRetry}>
              {t('retry')}
            </Button>
          ) : null}
        </Alert>
      );
    }
  }
}
