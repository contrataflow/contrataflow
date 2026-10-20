import type { PricingTable } from './ai-pricing.js';

/*
 * Tabela de preços da plataforma (RN-AI-09 · DEC-079, lacuna 4): arquivo versionado em código —
 * `version` é o `pricingVersion` gravado em cada geração. Mudou um preço ou entrou um modelo?
 * Nova `version`. Só os modelos do `FakeAiProvider` (custo zero) até a decisão da ADR-013
 * (PEND-21): os valores do provedor real entram junto com o adaptador.
 */
export const AI_PRICING_TABLE: PricingTable = {
  version: '2026-10-16.1',
  models: {
    'fake-draft-1': { inputPerMillionUsd: '0', outputPerMillionUsd: '0' },
    'fake-section-1': { inputPerMillionUsd: '0', outputPerMillionUsd: '0' },
  },
};
