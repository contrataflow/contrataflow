import { describe, expect, it } from 'vitest';

import {
  RISK_AI_MESSAGES,
  applyAiRisksSchema,
  hasToConfirmMarker,
  isAiReviewPending,
  reviewAiRisksSchema,
} from './ai.js';
import { evaluateRiskMapCompleteness } from './matrix.js';
import { aiGenerationOutputSchema } from '../ai/ai.js';

/*
 * US-119 — contratos dos riscos propostos pela IA: RSK-11 (seleção — V-07), RSK-12 (revisão —
 * V-08), a proposta tipada em `AiGenerationOutput.risks` e as pendências RN-AI-42 do `RISK_MAP`.
 */

const id = (n: number) => `0192d119-0000-7000-8000-${String(n).padStart(12, '0')}`;

describe('RSK-11 — applyAiRisksSchema (V-07)', () => {
  it('aceita a seleção de riscos com os tratamentos escolhidos (podem ser vazios)', () => {
    const body = {
      generationId: id(1),
      risks: [
        { proposalKey: 'R1', treatments: ['R1.T1', 'R1.T2'] },
        { proposalKey: 'R2', treatments: [] },
      ],
    };
    expect(applyAiRisksSchema.parse(body)).toEqual(body);
  });

  it('seleção vazia, chave repetida e campo extra são recusados', () => {
    const empty = applyAiRisksSchema.safeParse({ generationId: id(1), risks: [] });
    expect(empty.success).toBe(false);
    expect(empty.error?.issues[0]?.message).toBe(RISK_AI_MESSAGES.selectionRequired);
    const repeated = applyAiRisksSchema.safeParse({
      generationId: id(1),
      risks: [
        { proposalKey: 'R1', treatments: [] },
        { proposalKey: 'R1', treatments: [] },
      ],
    });
    expect(repeated.error?.issues[0]?.message).toBe(RISK_AI_MESSAGES.duplicated);
    expect(
      applyAiRisksSchema.safeParse({
        generationId: id(1),
        risks: [{ proposalKey: 'R1', treatments: [], ownerId: id(2) }],
      }).success,
    ).toBe(false);
  });
});

describe('RSK-12 — reviewAiRisksSchema (V-08)', () => {
  it('exige ao menos um risco e a versão de cada um', () => {
    expect(
      reviewAiRisksSchema.parse({ riskIds: [id(1)], expectedVersions: { [id(1)]: 2 } }),
    ).toEqual({ riskIds: [id(1)], expectedVersions: { [id(1)]: 2 } });
    expect(reviewAiRisksSchema.safeParse({ riskIds: [], expectedVersions: {} }).success).toBe(
      false,
    );
    expect(
      reviewAiRisksSchema.safeParse({ riskIds: [id(1)], expectedVersions: {} }).error?.issues[0]
        ?.message,
    ).toBe(RISK_AI_MESSAGES.versionsRequired);
  });
});

describe('AiGenerationOutput.risks — proposta tipada (RN-AI-39)', () => {
  const risk = {
    proposalKey: 'R1',
    title: 'Atraso na entrega',
    description: '',
    categoryCode: 'PRAZO',
    phase: 'CONTRACT_MANAGEMENT',
    cause: 'Dificuldade logística do fornecedor.',
    consequence: 'Interrupção do serviço público.',
    probability: 3,
    impact: 4,
    rationale: 'Mercado restrito.',
    treatments: [{ proposalKey: 'R1.T1', type: 'PREVENTIVE', description: 'Definir marcos.' }],
  };

  it('até 15 riscos, de 1 a 3 tratamentos, sem responsável nem prazo', () => {
    expect(
      aiGenerationOutputSchema.safeParse({ sections: [], risks: [risk], warnings: [] }).success,
    ).toBe(true);
    expect(
      aiGenerationOutputSchema.safeParse({
        sections: [],
        risks: Array.from({ length: 16 }, () => risk),
        warnings: [],
      }).success,
    ).toBe(false);
    expect(
      aiGenerationOutputSchema.safeParse({
        sections: [],
        risks: [{ ...risk, treatments: [] }],
        warnings: [],
      }).success,
    ).toBe(false);
    expect(
      aiGenerationOutputSchema.safeParse({
        sections: [],
        risks: [{ ...risk, dueDate: '2026-12-01' }],
        warnings: [],
      }).success,
    ).toBe(false);
  });
});

describe('RN-AI-42 — pendências do RISK_MAP', () => {
  it('marcador "[a confirmar" e revisão pendente', () => {
    expect(hasToConfirmMarker('Prazo de [a confirmar: prazo].')).toBe(true);
    expect(hasToConfirmMarker('[A CONFIRMAR]')).toBe(true);
    expect(hasToConfirmMarker('Sem marcador')).toBe(false);
    expect(hasToConfirmMarker(null)).toBe(false);
    expect(isAiReviewPending({ aiGenerationId: id(1), aiReviewedAt: null })).toBe(true);
    expect(isAiReviewPending({ aiGenerationId: id(1), aiReviewedAt: '2026-10-18T12:00:00Z' })).toBe(
      false,
    );
    expect(isAiReviewPending({ aiGenerationId: null, aiReviewedAt: null })).toBe(false);
  });

  it('[Validação] risco gerado por IA sem revisão e com "[a confirmar" na causa ou em tratamento ativo', () => {
    const violations = evaluateRiskMapCompleteness([
      {
        id: id(2),
        code: 'R02',
        level: 'LOW',
        aiGenerationId: id(9),
        aiReviewedAt: '2026-10-18T12:00:00Z',
        title: 'Atraso',
        cause: 'Prazo de [a confirmar: prazo].',
        consequence: 'Interrupção do serviço.',
        treatments: [],
      },
      {
        id: id(1),
        code: 'R01',
        level: 'LOW',
        aiGenerationId: id(9),
        aiReviewedAt: null,
        title: 'Especificação',
        cause: 'Levantamento incompleto.',
        consequence: 'Itens inadequados.',
        treatments: [{ status: 'CANCELED', description: 'Valor de [a confirmar: valor].' }],
      },
      {
        id: id(3),
        code: 'R03',
        level: 'LOW',
        aiGenerationId: null,
        aiReviewedAt: null,
        title: 'Manual',
        cause: 'Causa registrada por pessoa.',
        consequence: 'Consequência.',
        treatments: [{ status: 'PLANNED', description: 'Ação com [a confirmar: responsável].' }],
      },
    ]);
    expect(violations.map((item) => [item.code, item.params.code, item.ruleId])).toEqual([
      ['RISK_AI_REVIEW_PENDING', 'R01', 'RN-AI-42'],
      ['RISK_PLACEHOLDER_PENDING', 'R02', 'RN-AI-42'],
      ['RISK_PLACEHOLDER_PENDING', 'R03', 'RN-AI-42'],
    ]);
    expect(violations.every((item) => item.severity === 'BLOCKING')).toBe(true);
  });
});
