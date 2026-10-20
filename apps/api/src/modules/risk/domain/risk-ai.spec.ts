import type { AiProposedRisk, RiskScaleSnapshot } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { selectAiRisks } from './risk-ai-proposal.js';
import { createRiskTreatment } from './risk-treatment.js';
import { createRiskFromAiProposal, markRiskAiReviewed } from './risk.js';

/*
 * US-119 — riscos propostos pela IA no domínio do `risk`: `Risk.createFromAiProposal` (RN-AI-40),
 * `Risk.markAiReviewed` (RN-AI-42), o tratamento proposto e a seleção contra a proposta (V-07).
 */

const NOW = new Date('2026-10-18T12:00:00.000Z');
const GENERATION = '0192d119-0000-7000-8000-0000000000a1';
const USER = '0192d119-0000-7000-8000-0000000000b1';

const SNAPSHOT: RiskScaleSnapshot = {
  scale: {
    max: 5,
    probabilityLabels: ['Muito baixa', 'Baixa', 'Média', 'Alta', 'Muito alta'],
    impactLabels: ['Muito baixo', 'Baixo', 'Médio', 'Alto', 'Muito alto'],
  },
  levelThresholds: [
    { level: 'LOW', minScore: 1, maxScore: 4 },
    { level: 'MEDIUM', minScore: 5, maxScore: 9 },
    { level: 'HIGH', minScore: 10, maxScore: 16 },
    { level: 'EXTREME', minScore: 17, maxScore: 25 },
  ],
};

function proposed(key: string, treatments = 2): AiProposedRisk {
  return {
    proposalKey: key,
    title: `Risco ${key}`,
    description: '',
    categoryCode: 'PRAZO',
    phase: 'PLANNING',
    cause: 'Causa do risco proposto.',
    consequence: 'Consequência do risco proposto.',
    probability: 3,
    impact: 4,
    rationale: 'Motivo.',
    treatments: Array.from({ length: treatments }, (_, index) => ({
      proposalKey: `${key}.T${String(index + 1)}`,
      type: index === 0 ? 'PREVENTIVE' : 'CONTINGENCY',
      description: `Tratamento ${String(index + 1)} do risco ${key}.`,
    })),
  };
}

const context = {
  id: '0192d119-0000-7000-8000-0000000000c1',
  tenantId: '0192d119-0000-7000-8000-00000000000a',
  processId: '0192d119-0000-7000-8000-0000000000d1',
  code: 'R03',
  snapshot: SNAPSHOT,
  now: NOW,
  userId: USER,
  generationId: GENERATION,
};

describe('Risk.createFromAiProposal (RN-AI-40)', () => {
  it('escore e nível pelas faixas vigentes, snapshot, origem na IA, sem responsável e pendente de revisão', () => {
    const risk = createRiskFromAiProposal({ ...proposed('R1'), categoryId: context.id }, context);
    expect(risk).toMatchObject({
      code: 'R03',
      score: 12,
      level: 'HIGH',
      scaleSnapshot: SNAPSHOT,
      aiGenerationId: GENERATION,
      aiReviewedAt: null,
      aiReviewedById: null,
      ownerId: null,
      ownerDepartmentId: null,
      description: null,
      status: 'OPEN',
    });
  });

  it('o tratamento proposto nasce PLANNED, sem responsável nem prazo, com a geração de origem', () => {
    const risk = createRiskFromAiProposal({ ...proposed('R1'), categoryId: context.id }, context);
    const treatment = createRiskTreatment(
      { type: 'PREVENTIVE', description: 'Validar a especificação.' },
      { id: context.id, risk, sortOrder: 0, now: NOW, userId: USER, generationId: GENERATION },
    );
    expect(treatment).toMatchObject({
      status: 'PLANNED',
      responsibleId: null,
      responsibleDepartmentId: null,
      dueDate: null,
      aiGenerationId: GENERATION,
    });
  });
});

describe('Risk.markAiReviewed (RN-AI-42)', () => {
  it('grava quem e quando revisou; risco sem IA ou já revisado não muda (idempotente)', () => {
    const risk = createRiskFromAiProposal({ ...proposed('R1'), categoryId: context.id }, context);
    const later = new Date('2026-10-19T09:00:00.000Z');
    const reviewed = markRiskAiReviewed(risk, USER, later);
    expect(reviewed).toMatchObject({ aiReviewedAt: later, aiReviewedById: USER, updatedAt: later });
    expect(reviewed && markRiskAiReviewed(reviewed, USER, later)).toBeNull();
    expect(markRiskAiReviewed({ ...risk, aiGenerationId: null }, USER, later)).toBeNull();
  });
});

describe('selectAiRisks (V-07)', () => {
  const proposal = [proposed('R1'), proposed('R2'), proposed('R3', 1)];

  it('na ordem da proposta, só os tratamentos escolhidos de cada risco', () => {
    const result = selectAiRisks(proposal, [
      { proposalKey: 'R3', treatments: [] },
      { proposalKey: 'R1', treatments: ['R1.T2'] },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.selected.map((item) => [
        item.risk.proposalKey,
        item.treatments.map((treatment) => treatment.proposalKey),
      ]),
    ).toEqual([
      ['R1', ['R1.T2']],
      ['R3', []],
    ]);
  });

  it('chave fora da proposta e tratamento de outro risco = NOT_ALLOWED', () => {
    const result = selectAiRisks(proposal, [
      { proposalKey: 'R9', treatments: [] },
      { proposalKey: 'R1', treatments: ['R2.T1'] },
    ]);
    expect(result).toEqual({
      ok: false,
      issues: [
        expect.objectContaining({ field: 'risks.0.proposalKey', code: 'NOT_ALLOWED' }),
        expect.objectContaining({ field: 'risks.1.treatments.0', code: 'NOT_ALLOWED' }),
      ],
    });
  });
});
