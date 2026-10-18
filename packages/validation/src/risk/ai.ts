import { z } from 'zod';

import { riskSchema } from './risk.js';
import { AI_RISK_PROPOSAL_LIMITS } from '../ai/ai.js';

/*
 * Riscos propostos pela IA (US-119 · RN-AI-40/42 · api/08-risks.md RSK-11/RSK-12): a aplicação
 * seletiva da proposta (riscos e, de cada um, os tratamentos escolhidos) e a revisão humana dos
 * riscos criados. Os MESMOS schemas validam o painel do SCR-011/SCR-117 e o corpo da API. O marcador
 * literal "[a confirmar: …]" nos textos do risco ou do tratamento bloqueia a conclusão do
 * `RISK_MAP` (`RISK_PLACEHOLDER_PENDING`), como o risco ainda não revisado (`RISK_AI_REVIEW_PENDING`).
 */

/** Mensagens da tabela de validações e dos casos de erro da US-119. */
export const RISK_AI_MESSAGES = Object.freeze({
  selectionRequired: 'Selecione ao menos um risco da proposta.',
  proposalKeyUnknown: 'Este item não faz parte da proposta.',
  treatmentOfOtherRisk: 'Este tratamento não pertence ao risco escolhido.',
  duplicated: 'Cada item da proposta só pode ser escolhido uma vez.',
  reviewRequired: 'Selecione ao menos um risco para revisar.',
  versionsRequired: 'Informe a versão de cada risco.',
  notApplicable: 'Esta proposta não pode mais ser aplicada. Gere outra.',
  versionConflict: 'O risco foi alterado por outra pessoa. Recarregue.',
  reviewPending: (code: string) => `O risco ${code} foi gerado por IA e ainda não foi revisado.`,
  placeholderPending: (code: string) => `O risco ${code} tem itens "a confirmar" sem resolver.`,
  incomplete: 'Revise os riscos gerados por IA e resolva os itens a confirmar.',
});

const proposalKeySchema = z
  .string({ error: RISK_AI_MESSAGES.proposalKeyUnknown })
  .min(1, { error: RISK_AI_MESSAGES.proposalKeyUnknown })
  .max(AI_RISK_PROPOSAL_LIMITS.proposalKeyMax, { error: RISK_AI_MESSAGES.proposalKeyUnknown });

/**
 * RSK-11 — corpo de `POST /processes/{id}/risks/ai-apply` (V-07): ao menos um risco, cada chave uma
 * vez; os tratamentos são do próprio risco (conferido contra a proposta na API).
 */
export const applyAiRisksSchema = z
  .strictObject({
    generationId: z.uuid({ error: RISK_AI_MESSAGES.notApplicable }),
    risks: z
      .array(
        z.strictObject({
          proposalKey: proposalKeySchema,
          treatments: z.array(proposalKeySchema).max(AI_RISK_PROPOSAL_LIMITS.maxTreatments, {
            error: RISK_AI_MESSAGES.treatmentOfOtherRisk,
          }),
        }),
        { error: RISK_AI_MESSAGES.selectionRequired },
      )
      .min(1, { error: RISK_AI_MESSAGES.selectionRequired })
      .max(AI_RISK_PROPOSAL_LIMITS.maxRisks, { error: RISK_AI_MESSAGES.proposalKeyUnknown }),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.risks.forEach((risk, index) => {
      for (const [key, path] of [
        [risk.proposalKey, ['risks', index, 'proposalKey']] as const,
        ...risk.treatments.map(
          (treatment, position) => [treatment, ['risks', index, 'treatments', position]] as const,
        ),
      ]) {
        if (seen.has(key)) {
          ctx.addIssue({
            code: 'custom',
            path: [...path],
            message: RISK_AI_MESSAGES.duplicated,
            params: { code: 'DUPLICATE' },
          });
        }
        seen.add(key);
      }
    });
  })
  .meta({ id: 'ApplyAiRisksRequest' });
export type ApplyAiRisks = z.output<typeof applyAiRisksSchema>;
export type ApplyAiRisksInput = z.input<typeof applyAiRisksSchema>;

/** RSK-11 — `201 { data: { risks: Risk[] } }` (riscos criados, com os tratamentos). */
export const applyAiRisksResultSchema = z
  .object({ risks: z.array(riskSchema) })
  .meta({ id: 'ApplyAiRisksResult' });
export type ApplyAiRisksResultDto = z.infer<typeof applyAiRisksResultSchema>;

/**
 * RSK-12 — corpo de `POST /processes/{id}/risks/ai-review` (V-08): os riscos e a versão que a
 * pessoa viu de cada um (concorrência por risco, no corpo — sem `If-Match`).
 */
export const reviewAiRisksSchema = z
  .strictObject({
    riskIds: z
      .array(z.uuid(), { error: RISK_AI_MESSAGES.reviewRequired })
      .min(1, { error: RISK_AI_MESSAGES.reviewRequired })
      .max(200),
    expectedVersions: z.record(z.uuid(), z.int().min(1), {
      error: RISK_AI_MESSAGES.versionsRequired,
    }),
  })
  .superRefine((value, ctx) => {
    value.riskIds.forEach((id, index) => {
      if (value.expectedVersions[id] === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['expectedVersions', index],
          message: RISK_AI_MESSAGES.versionsRequired,
          params: { code: 'CONDITIONAL_REQUIRED' },
        });
      }
    });
  })
  .meta({ id: 'ReviewAiRisksRequest' });
export type ReviewAiRisks = z.output<typeof reviewAiRisksSchema>;

/** RSK-12 — `200 { data: { risks, reviewedRiskIds } }` (já revisados/sem IA são ignorados). */
export const reviewAiRisksResultSchema = z
  .object({ risks: z.array(riskSchema), reviewedRiskIds: z.array(z.uuid()) })
  .meta({ id: 'ReviewAiRisksResult' });
export type ReviewAiRisksResultDto = z.infer<typeof reviewAiRisksResultSchema>;

const TO_CONFIRM_MARKER = /\[a confirmar/i;

/** Texto com o marcador literal "[a confirmar…" (entities.md §5.10 · RN-AI-42). */
export function hasToConfirmMarker(text: string | null | undefined): boolean {
  return typeof text === 'string' && TO_CONFIRM_MARKER.test(text);
}

/** O risco gerado por IA ainda não revisado (selo "Gerado por IA" — RN-AI-42). */
export function isAiReviewPending(risk: {
  readonly aiGenerationId?: string | null;
  readonly aiReviewedAt?: string | null;
}): boolean {
  return (risk.aiGenerationId ?? null) !== null && (risk.aiReviewedAt ?? null) === null;
}
