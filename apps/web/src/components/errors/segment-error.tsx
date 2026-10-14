'use client';

import { useQueryErrorResetBoundary } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';

import { isApiError } from '@/lib/api/api-error';

import { ErrorView } from './error-view';

/**
 * Corpo do `error.tsx` dos segmentos (architecture.md §8.12 · FA-04): 404 com a mensagem única
 * (nunca distingue inexistente de sem acesso); 503/5xx com `correlationId` copiável e
 * "Tentar novamente", que limpa os erros do TanStack Query e refaz o segmento.
 */
export function SegmentError({
  error,
  retry,
}: {
  readonly error: Error & { digest?: string };
  readonly retry: () => void;
}) {
  const t = useTranslations('errors');
  const { reset } = useQueryErrorResetBoundary();
  const apiError = isApiError(error) ? error : null;
  const correlationId = apiError?.correlationId ?? null;
  const onRetry = () => {
    reset();
    retry();
  };

  if (apiError?.status === 404) {
    return (
      <ErrorView
        headingLevel={2}
        title={t('pages.404.title')}
        description={t('pages.404.description')}
      />
    );
  }
  const unavailable = apiError?.status === 503 || apiError?.code === 'DEPENDENCY_UNAVAILABLE';
  return (
    <ErrorView
      headingLevel={2}
      title={unavailable ? t('boundary.unavailableTitle') : t('boundary.title')}
      description={unavailable ? t('boundary.unavailableDescription') : t('boundary.description')}
      correlationId={correlationId}
      correlationLabels={
        correlationId
          ? {
              code: t('correlation.label', { correlationId }),
              copy: t('correlation.copy'),
              copied: t('correlation.copied'),
            }
          : undefined
      }
      retryLabel={t('actions.retry')}
      onRetry={onRetry}
    />
  );
}
