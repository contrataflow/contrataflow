'use client';

import { cx } from '@contrataflow/ui';
import { RISK_LEVEL_LABELS } from '@contrataflow/validation';
import type { RiskMatrixCellDto, RiskMatrixDto } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';

import { LEVEL_CLASSES } from './level-badge';
import { heatmapCellLabelOf } from './risk-matrix-model';

export interface RiskHeatmapGridProps {
  readonly matrix: RiskMatrixDto;
  /** Abre o risco na lista (o código de cada risco da célula vira um botão). */
  readonly onSelectRisk?: ((riskId: string) => void) | undefined;
}

/**
 * `RiskHeatmapGrid` (US-035 · SCR-011, aba "Matriz"): grade de calor somente leitura da escala
 * VIGENTE (RN-RISK-18) — probabilidade nas linhas (maior no topo), impacto nas colunas, cada célula
 * com a quantidade e a lista de riscos (código e título) e a cor do nível sempre acompanhada do
 * texto. Tabela com cabeçalhos de linha e coluna e `aria-label` por célula (probabilidade, impacto,
 * quantidade e nível); em telas estreitas a grade rola na horizontal com a coluna de probabilidade
 * fixa.
 */
export function RiskHeatmapGrid({ matrix, onSelectRisk }: RiskHeatmapGridProps) {
  const t = useTranslations('risks.matrix');
  const { scale } = matrix;
  const impacts = Array.from({ length: scale.max }, (_, index) => index + 1);
  const rows = new Map<number, RiskMatrixCellDto[]>();
  for (const cell of matrix.cells) {
    rows.set(cell.probability, [...(rows.get(cell.probability) ?? []), cell]);
  }
  const probabilities = [...rows.keys()].sort((a, b) => b - a);

  return (
    <div className="relative overflow-x-auto rounded-card border border-border">
      <table className="w-full min-w-[36rem] border-separate border-spacing-1 text-sm">
        <caption className="sr-only">{t('caption')}</caption>
        <thead>
          <tr>
            <th
              scope="col"
              className="sticky left-0 z-10 bg-surface p-1 text-left text-xs text-muted-foreground"
            >
              {t('axes')}
            </th>
            {impacts.map((impact) => (
              <th
                key={impact}
                scope="col"
                className="p-1 text-center text-xs font-medium break-words text-muted-foreground"
              >
                <span className="sr-only">{t('impact')} </span>
                {scale.impactLabels[impact - 1] ?? ''} ({impact})
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {probabilities.map((probability) => (
            <tr key={probability}>
              <th
                scope="row"
                className="sticky left-0 z-10 bg-surface p-1 text-left text-xs font-medium break-words text-muted-foreground"
              >
                <span className="sr-only">{t('probability')} </span>
                {scale.probabilityLabels[probability - 1] ?? ''} ({probability})
              </th>
              {(rows.get(probability) ?? [])
                .sort((a, b) => a.impact - b.impact)
                .map((cell) => (
                  <td
                    key={cell.impact}
                    className={cx(
                      'h-20 min-w-24 rounded-control border-2 p-1 align-top',
                      LEVEL_CLASSES[cell.level],
                    )}
                  >
                    <div
                      role="group"
                      aria-label={heatmapCellLabelOf(cell, scale)}
                      className="flex h-full flex-col gap-1"
                    >
                      <span
                        aria-hidden="true"
                        className="flex items-baseline justify-between gap-1 text-[0.7rem]"
                      >
                        <span>{RISK_LEVEL_LABELS[cell.level]}</span>
                        <span className="text-base font-semibold">{cell.risks.length}</span>
                      </span>
                      {cell.risks.length > 0 ? (
                        <ul className="flex flex-col gap-0.5">
                          {cell.risks.map((risk) => (
                            <li key={risk.id} className="min-w-0 text-xs break-words">
                              {onSelectRisk ? (
                                <button
                                  type="button"
                                  className="text-left underline"
                                  title={risk.title}
                                  aria-label={t('openRisk', { code: risk.code, title: risk.title })}
                                  onClick={() => {
                                    onSelectRisk(risk.id);
                                  }}
                                >
                                  <span className="font-semibold">{risk.code}</span> {risk.title}
                                </button>
                              ) : (
                                <>
                                  <span className="font-semibold">{risk.code}</span> {risk.title}
                                </>
                              )}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  </td>
                ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
