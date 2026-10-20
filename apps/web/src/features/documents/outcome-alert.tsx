'use client';

import { Alert, Button } from '@contrataflow/ui';
import { useTranslations } from 'next-intl';

import { CorrelationCode } from '@/components/errors/correlation-code';

import type { DocumentOutcome } from './document-errors';

export interface OutcomeAlertProps {
  readonly outcome: DocumentOutcome;
  /** "Tentar novamente" (503): reenvia a mesma intenção, com a mesma `Idempotency-Key`. */
  readonly onRetry?: (() => void) | undefined;
}

/**
 * Falha que o painel ou o diálogo mostra em linha (503 com "Tentar novamente", erro inesperado com
 * o `correlationId` copiável, mensagem de campo); os demais desfechos viram toast e fecham o fluxo.
 */
export function OutcomeAlert({ outcome, onRetry }: OutcomeAlertProps) {
  const t = useTranslations('documents.errors');
  const tErrors = useTranslations('errors');

  if (outcome.kind === 'unavailable') {
    return (
      <Alert tone="error" title={t('unavailable')}>
        {onRetry ? (
          <Button size="sm" variant="secondary" className="mt-3" onClick={onRetry}>
            {t('retry')}
          </Button>
        ) : null}
      </Alert>
    );
  }
  if (outcome.kind === 'field') return <Alert tone="error" title={outcome.message} />;

  const correlationId = outcome.kind === 'unexpected' ? outcome.correlationId : null;
  return (
    <Alert tone="error" title={t('unexpected')}>
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
    </Alert>
  );
}
