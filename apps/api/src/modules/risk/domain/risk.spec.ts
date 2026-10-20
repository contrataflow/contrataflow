import type { CreateRisk, RiskScaleSnapshot } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import {
  createRisk,
  diffRisk,
  gradeIssues,
  nextRiskCode,
  patchRisk,
  residualIssues,
  riskCode,
  touchRisk,
} from './risk.js';
import type { Risk } from './risk.js';

const NOW = new Date('2026-10-17T12:00:00.000Z');

const DEFAULT_SNAPSHOT: RiskScaleSnapshot = {
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

const SMALL_SNAPSHOT: RiskScaleSnapshot = {
  scale: { max: 3, probabilityLabels: ['B', 'M', 'A'], impactLabels: ['B', 'M', 'A'] },
  levelThresholds: [
    { level: 'LOW', minScore: 1, maxScore: 2 },
    { level: 'MEDIUM', minScore: 3, maxScore: 4 },
    { level: 'HIGH', minScore: 5, maxScore: 9 },
  ],
};

const body: CreateRisk = {
  title: 'Atraso na entrega',
  description: null,
  categoryId: '0192d033-0000-7000-8000-0000000000d1',
  phase: 'PLANNING',
  cause: 'Fornecedor com baixa capacidade produtiva',
  consequence: 'Paralisação da obra',
  probability: 4,
  impact: 4,
  ownerId: null,
  ownerDepartmentId: null,
};

function risk(overrides: Partial<CreateRisk> = {}, snapshot = DEFAULT_SNAPSHOT): Risk {
  return createRisk(
    { ...body, ...overrides },
    {
      id: '0192d033-0000-7000-8000-0000000000c1',
      tenantId: '0192d033-0000-7000-8000-00000000000a',
      processId: '0192d033-0000-7000-8000-0000000000b1',
      code: 'R01',
      snapshot,
      now: NOW,
      userId: '0192d033-0000-7000-8000-0000000000e1',
    },
  );
}

describe('código sequencial (RN-RISK-02)', () => {
  it('R + 2 dígitos, depois 3', () => {
    expect(riskCode(1)).toBe('R01');
    expect(riskCode(42)).toBe('R42');
    expect(riskCode(100)).toBe('R100');
  });

  it('maior código já usado + 1 — excluídos contam, nunca reaproveitado', () => {
    expect(nextRiskCode([])).toBe('R01');
    expect(nextRiskCode(['R01', 'R03'])).toBe('R04');
    expect(nextRiskCode(['R09', 'R10', 'X'])).toBe('R11');
  });
});

describe('Risk.create (RN-RISK-01..07)', () => {
  it('status OPEN, score = P × I, nível pela faixa e snapshot da escala vigente', () => {
    const created = risk();
    expect(created).toMatchObject({
      code: 'R01',
      status: 'OPEN',
      score: 16,
      level: 'HIGH',
      scaleSnapshot: DEFAULT_SNAPSHOT,
      residualScore: null,
      residualLevel: null,
      version: 1,
      deletedAt: null,
    });
  });

  it('responsáveis opcionais e não exclusivos (RN-RISK-06)', () => {
    const created = risk({
      ownerId: '0192d033-0000-7000-8000-0000000000e2',
      ownerDepartmentId: '0192d033-0000-7000-8000-0000000000f1',
    });
    expect(created).toMatchObject({
      ownerId: '0192d033-0000-7000-8000-0000000000e2',
      ownerDepartmentId: '0192d033-0000-7000-8000-0000000000f1',
    });
  });
});

describe('gradeIssues (V-03) e residualIssues (FA-05)', () => {
  it('fora de [1, max] do tenant → OUT_OF_RANGE com o máximo vigente', () => {
    expect(gradeIssues({ probability: 5, impact: 1 }, DEFAULT_SNAPSHOT)).toEqual([]);
    expect(gradeIssues({ probability: 4, impact: 3 }, SMALL_SNAPSHOT)).toEqual([
      { field: 'probability', code: 'OUT_OF_RANGE', message: 'Selecione um valor entre 1 e 3.' },
    ]);
    expect(
      gradeIssues({ residualProbability: 4, residualImpact: null }, SMALL_SNAPSHOT).map(
        (issue) => issue.field,
      ),
    ).toEqual(['residualProbability']);
  });

  it('residuais em par', () => {
    expect(residualIssues({ residualProbability: null, residualImpact: null })).toEqual([]);
    expect(residualIssues({ residualProbability: 2, residualImpact: 3 })).toEqual([]);
    expect(residualIssues({ residualProbability: 2, residualImpact: null })).toEqual([
      expect.objectContaining({ field: 'residualImpact', code: 'CONDITIONAL_REQUIRED' }),
    ]);
    expect(residualIssues({ residualProbability: null, residualImpact: 2 })).toEqual([
      expect.objectContaining({ field: 'residualProbability' }),
    ]);
  });
});

describe('Risk.assess (RSK-04 · RN-RISK-03/04 · FA-01/02)', () => {
  it('reavaliação muda score/nível e registra a transição', () => {
    const { next, reassessment } = patchRisk(risk(), { probability: 2 }, DEFAULT_SNAPSHOT);
    expect(next).toMatchObject({ probability: 2, impact: 4, score: 8, level: 'MEDIUM' });
    expect(reassessment).toEqual({
      fromScore: 16,
      toScore: 8,
      fromLevel: 'HIGH',
      toLevel: 'MEDIUM',
    });
  });

  it('reavaliação sem mudança de nível ainda é reavaliação (FA-01)', () => {
    const { reassessment } = patchRisk(risk(), { impact: 3 }, DEFAULT_SNAPSHOT);
    expect(reassessment).toEqual({
      fromScore: 16,
      toScore: 12,
      fromLevel: 'HIGH',
      toLevel: 'HIGH',
    });
  });

  it('FA-02: snapshot antigo preservado sem reavaliação; reavaliação grava a escala vigente', () => {
    const original = risk();
    const edited = patchRisk(original, { title: 'Atraso grave' }, SMALL_SNAPSHOT);
    expect(edited.reassessment).toBeNull();
    expect(edited.next.scaleSnapshot).toEqual(DEFAULT_SNAPSHOT);
    expect(edited.next).toMatchObject({ score: 16, level: 'HIGH' });

    const reassessed = patchRisk(original, { probability: 1, impact: 3 }, SMALL_SNAPSHOT);
    expect(reassessed.next).toMatchObject({ score: 3, level: 'MEDIUM' });
    expect(reassessed.next.scaleSnapshot).toEqual(SMALL_SNAPSHOT);
  });

  it('mesmo valor enviado não é reavaliação; null limpa opcionais; status manual', () => {
    const original = risk({
      description: 'Contexto',
      ownerId: '0192d033-0000-7000-8000-0000000000e2',
    });
    const { next, reassessment } = patchRisk(
      original,
      { probability: 4, description: null, ownerId: null, status: 'MITIGATED' },
      DEFAULT_SNAPSHOT,
    );
    expect(reassessment).toBeNull();
    expect(next).toMatchObject({ description: null, ownerId: null, status: 'MITIGATED' });
  });

  it('residual pela mesma regra (RN-RISK-08) e limpo com null', () => {
    const withResidual = patchRisk(
      risk(),
      { residualProbability: 2, residualImpact: 2 },
      DEFAULT_SNAPSHOT,
    ).next;
    expect(withResidual).toMatchObject({ residualScore: 4, residualLevel: 'LOW' });
    const kept = patchRisk(withResidual, { title: 'Outro título' }, SMALL_SNAPSHOT).next;
    expect(kept).toMatchObject({ residualScore: 4, residualLevel: 'LOW' });
    const cleared = patchRisk(
      withResidual,
      { residualProbability: null, residualImpact: null },
      DEFAULT_SNAPSHOT,
    ).next;
    expect(cleared).toMatchObject({
      residualProbability: null,
      residualImpact: null,
      residualScore: null,
      residualLevel: null,
    });
  });
});

describe('diffRisk e touchRisk', () => {
  it('criação lista os campos preenchidos; edição só os alterados, em ordem canônica', () => {
    const created = risk();
    expect(diffRisk(null, created).map((change) => change.field)).toEqual([
      'title',
      'categoryId',
      'phase',
      'cause',
      'consequence',
      'probability',
      'impact',
      'status',
    ]);
    const { next } = patchRisk(created, { impact: 2, title: 'Novo título' }, DEFAULT_SNAPSHOT);
    expect(diffRisk(created, next)).toEqual([
      { field: 'title', old: 'Atraso na entrega', new: 'Novo título' },
      { field: 'impact', old: 4, new: 2 },
    ]);
    expect(diffRisk(created, created)).toEqual([]);
  });

  it('touchRisk grava autoria e data', () => {
    const later = new Date('2026-10-18T00:00:00.000Z');
    expect(touchRisk(risk(), later, 'u-2')).toMatchObject({ updatedAt: later, updatedById: 'u-2' });
  });
});
