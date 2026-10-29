'use client';

import { ErrorView } from '@/components/errors/error-view';
import { isApiError } from '@/lib/api/api-error';

import errors from '../../messages/pt-BR/errors.json';

import './globals.css';

/**
 * Última barreira (architecture.md §8.12): substitui o layout raiz quando ele próprio falha, por
 * isso define `<html>` e usa as mensagens pt-BR sem o provider do next-intl.
 */
export default function GlobalError({
  error,
  retry,
}: {
  readonly error: Error & { digest?: string };
  readonly retry: () => void;
}) {
  const correlationId = isApiError(error) ? error.correlationId : null;
  return (
    <html lang="pt-BR">
      <body className="bg-background px-4 font-sans text-foreground antialiased">
        <main>
          <ErrorView
            illustration="failure"
            title={errors.pages['500'].title}
            description={errors.pages['500'].description}
            correlationId={correlationId}
            correlationLabels={
              correlationId
                ? {
                    code: errors.correlation.label.replace('{correlationId}', correlationId),
                    copy: errors.correlation.copy,
                    copied: errors.correlation.copied,
                  }
                : undefined
            }
            retryLabel={errors.actions.retry}
            onRetry={retry}
          />
        </main>
      </body>
    </html>
  );
}
