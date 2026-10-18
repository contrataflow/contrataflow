import { RISK_AI_MESSAGES } from '@contrataflow/validation';
import type { AiProposedRisk, AiProposedTreatment, ApplyAiRisks } from '@contrataflow/validation';

import type { RiskIssue } from './risk.js';

/*
 * Aplicação seletiva da proposta de riscos da IA (US-119 · RN-AI-40 · V-07): cada risco escolhido
 * existe na proposta e cada tratamento escolhido é do próprio risco. Puro: a proposta chega pela
 * porta `AiSuggestionSource` e a seleção pelo corpo do RSK-11 (já validado pelo Zod).
 */

export interface SelectedAiRisk {
  readonly risk: AiProposedRisk;
  readonly treatments: readonly AiProposedTreatment[];
}

export type AiRiskSelection =
  | { readonly ok: true; readonly selected: readonly SelectedAiRisk[] }
  | { readonly ok: false; readonly issues: readonly RiskIssue[] };

/** V-07: a seleção contra a proposta, na ordem da proposta (os códigos seguem essa ordem). */
export function selectAiRisks(
  proposal: readonly AiProposedRisk[],
  selection: ApplyAiRisks['risks'],
): AiRiskSelection {
  const byKey = new Map(proposal.map((risk) => [risk.proposalKey, risk]));
  const issues: RiskIssue[] = [];
  const chosen = new Map<string, readonly string[]>();
  selection.forEach((item, index) => {
    const risk = byKey.get(item.proposalKey);
    if (risk === undefined) {
      issues.push({
        field: `risks.${String(index)}.proposalKey`,
        code: 'NOT_ALLOWED',
        message: RISK_AI_MESSAGES.proposalKeyUnknown,
      });
      return;
    }
    const own = new Set(risk.treatments.map((treatment) => treatment.proposalKey));
    item.treatments.forEach((key, position) => {
      if (!own.has(key)) {
        issues.push({
          field: `risks.${String(index)}.treatments.${String(position)}`,
          code: 'NOT_ALLOWED',
          message: RISK_AI_MESSAGES.treatmentOfOtherRisk,
        });
      }
    });
    chosen.set(item.proposalKey, item.treatments);
  });
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    selected: proposal.flatMap((risk) => {
      const treatments = chosen.get(risk.proposalKey);
      if (treatments === undefined) return [];
      const keys = new Set(treatments);
      return [
        {
          risk,
          treatments: risk.treatments.filter((treatment) => keys.has(treatment.proposalKey)),
        },
      ];
    }),
  };
}
