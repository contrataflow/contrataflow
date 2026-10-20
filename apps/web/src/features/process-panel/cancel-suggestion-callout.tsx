'use client';

import { Alert } from '@contrataflow/ui';
import type { ProcessSummaryDto } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';

/**
 * RN-DFD-68 (US-017 · PEND-02): DFD indeferido devolve o processo (`RETURNED`) — a tela sugere o
 * cancelamento, sem cancelar sozinha. Some quando o DFD é reaberto ou o processo segue.
 */
export function suggestsCancellation(summary: ProcessSummaryDto): boolean {
  return (
    summary.where.status === 'RETURNED' &&
    summary.documents.some(
      (document) => document.typeCode === 'DFD' && document.status === 'REJECTED',
    )
  );
}

/** `CancelSuggestionCallout` (SCR-006): "Considere cancelar este processo", anunciado (`aria-live`). */
export function CancelSuggestionCallout({ summary }: { readonly summary: ProcessSummaryDto }) {
  const t = useTranslations('processes.panel.cancelSuggestion');
  if (!suggestsCancellation(summary)) return null;
  return (
    <div aria-live="polite">
      <Alert tone="warning" title={t('title')} live={false}>
        <p>{t('body')}</p>
      </Alert>
    </div>
  );
}
