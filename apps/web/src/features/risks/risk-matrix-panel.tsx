'use client';

import { Alert, Button, Skeleton } from '@contrataflow/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { EmitRiskMapButton } from './emit-risk-map-button';
import { RiskFilterBar } from './risk-filter-bar';
import { RiskHeatmapGrid } from './risk-heatmap-grid';
import { RiskMapCompletenessPanel } from './risk-map-completeness-panel';
import { riskMapActionOf } from './risk-matrix-model';
import { useRiskMatrix, useRisks } from './risks.api';
import type { RiskFilters } from './risks.api';

export interface RiskMatrixPanelProps {
  readonly processId: string;
  /** Vai para a aba "Lista de riscos" com o risco aberto. */
  readonly onGoToRisk: (riskId: string) => void;
}

/**
 * Aba "Matriz" do SCR-011 (US-035): a grade de calor (RSK-09) com os filtros, sempre disponível em
 * leitura (RN-RISK-24 — mesmo com o Mapa de Riscos concluído); o "Emitir Mapa de Riscos" ou o
 * acesso ao mapa já emitido (a partir do `meta` de RSK-01) e, com o mapa em rascunho, as pendências
 * de risco do DOC-08. Estados: skeleton, vazio (FA-02), erro com "Tentar novamente".
 */
export function RiskMatrixPanel({ processId, onGoToRisk }: RiskMatrixPanelProps) {
  const t = useTranslations('risks.matrix');
  const [filters, setFilters] = useState<RiskFilters>({});
  const list = useRisks(processId);
  const matrix = useRiskMatrix(processId, filters);

  const action =
    list.data === undefined ? null : riskMapActionOf(list.data.meta, list.data.risks.length);
  const empty = list.data?.risks.length === 0;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-prose text-sm text-muted-foreground">{t('intro')}</p>
        {action === null ? null : <EmitRiskMapButton processId={processId} action={action} />}
      </div>
      {action?.kind === 'open' ? (
        <RiskMapCompletenessPanel
          processId={processId}
          documentId={action.documentId}
          onGoToRisk={onGoToRisk}
        />
      ) : null}
      {empty ? (
        <p className="rounded-card border border-dashed border-border p-4 text-sm text-muted-foreground">
          {t('empty')}
        </p>
      ) : (
        <>
          <RiskFilterBar filters={filters} onChange={setFilters} />
          {matrix.data === undefined ? (
            matrix.isPending ? (
              <div role="status" className="flex flex-col gap-2">
                <span className="sr-only">{t('loading')}</span>
                <Skeleton className="h-64 w-full" />
              </div>
            ) : (
              <Alert tone="error" title={t('errors.load')}>
                <Button
                  size="sm"
                  variant="secondary"
                  className="mt-2"
                  onClick={() => {
                    void matrix.refetch();
                  }}
                >
                  {t('errors.retry')}
                </Button>
              </Alert>
            )
          ) : (
            <div aria-busy={matrix.isFetching} className="min-w-0">
              <RiskHeatmapGrid matrix={matrix.data} onSelectRisk={onGoToRisk} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
