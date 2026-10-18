'use client';

import { Skeleton } from '@contrataflow/ui';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useId } from 'react';

import { useTenantId } from '@/lib/session/session-context';

import { riskViolationsOf } from './risk-matrix-model';
import { riskKeys } from './risks.api';
import { fetchDocumentValidation } from '../documents/documents.api';

export interface RiskMapCompletenessPanelProps {
  readonly processId: string;
  readonly documentId: string;
  /** Leva à lista com o risco aberto (onde se cria o tratamento — US-034). */
  readonly onGoToRisk: (riskId: string) => void;
}

/**
 * `RiskMapCompletenessPanel` (US-035 · fluxo principal 5 · FA-03): as pendências de risco do DOC-08
 * do Mapa de Riscos em rascunho — `RISK_LIST_EMPTY` e um `RISK_TREATMENT_REQUIRED_FOR_LEVEL` por
 * risco Alto/Extremo sem tratamento ativo, com o atalho para o risco. A completude é a do servidor
 * (a mesma regra da finalização); a chave fica sob a dos riscos, então toda mudança a recalcula.
 */
export function RiskMapCompletenessPanel({
  processId,
  documentId,
  onGoToRisk,
}: RiskMapCompletenessPanelProps) {
  const t = useTranslations('risks.riskMap.completeness');
  const tenantId = useTenantId();
  const headingId = useId();
  const validation = useQuery({
    queryKey: riskKeys.mapValidation(tenantId, processId, documentId),
    queryFn: ({ signal }) => fetchDocumentValidation(documentId, signal),
    throwOnError: false,
  });

  if (validation.data === undefined) {
    if (validation.isPending) {
      return (
        <div role="status">
          <span className="sr-only">{t('loading')}</span>
          <Skeleton className="h-10 w-full" />
        </div>
      );
    }
    return null;
  }
  const pending = riskViolationsOf(validation.data.violations);
  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-2 rounded-card border border-border p-3"
    >
      <h3 id={headingId} className="text-sm font-semibold">
        {t('title')}
      </h3>
      {pending.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('none')}</p>
      ) : (
        <ul aria-label={t('listLabel')} className="flex flex-col gap-2">
          {pending.map((violation) => (
            <li
              key={`${violation.code}:${violation.itemId ?? ''}`}
              className="flex min-w-0 flex-col gap-1 rounded-control border-l-4 border-destructive bg-destructive-soft p-2 text-sm"
            >
              <span className="text-xs font-semibold tracking-wide uppercase">
                {violation.severity === 'BLOCKING' ? t('blocking') : t('warning')}
              </span>
              <span className="break-words">{violation.message}</span>
              {violation.itemId === null ? null : (
                <button
                  type="button"
                  className="self-start text-xs text-primary underline"
                  onClick={() => {
                    if (violation.itemId !== null) onGoToRisk(violation.itemId);
                  }}
                >
                  {typeof violation.params.code === 'string'
                    ? t('goToRiskNamed', { code: violation.params.code })
                    : t('goToRisk')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
