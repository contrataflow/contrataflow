import { describe, expect, it } from 'vitest';

import {
  RISK_MAP_MESSAGES,
  buildRiskMatrix,
  evaluateRiskMapCompleteness,
  riskMatrixQuerySchema,
  riskMatrixSchema,
} from './matrix.js';
import type { RiskScaleSnapshot } from './risk.js';

const FIVE: RiskScaleSnapshot = {
  scale: {
    max: 5,
    probabilityLabels: ['Rara', 'Improvável', 'Possível', 'Provável', 'Quase certa'],
    impactLabels: ['Muito baixo', 'Baixo', 'Médio', 'Alto', 'Muito alto'],
  },
  levelThresholds: [
    { level: 'LOW', minScore: 1, maxScore: 4 },
    { level: 'MEDIUM', minScore: 5, maxScore: 9 },
    { level: 'HIGH', minScore: 10, maxScore: 16 },
    { level: 'EXTREME', minScore: 17, maxScore: 25 },
  ],
};

const THREE: RiskScaleSnapshot = {
  scale: {
    max: 3,
    probabilityLabels: ['Baixa', 'Média', 'Alta'],
    impactLabels: ['Baixo', 'Médio', 'Alto'],
  },
  levelThresholds: [
    { level: 'LOW', minScore: 1, maxScore: 2 },
    { level: 'MEDIUM', minScore: 3, maxScore: 4 },
    { level: 'HIGH', minScore: 5, maxScore: 6 },
    { level: 'EXTREME', minScore: 7, maxScore: 9 },
  ],
};

const id = (n: number) => `0192d035-0000-7000-8000-${String(n).padStart(12, '0')}`;
const risk = (n: number, probability: number, impact: number) => ({
  id: id(n),
  code: `R${String(n).padStart(2, '0')}`,
  title: `Risco ${String(n)}`,
  probability,
  impact,
});

describe('RN-RISK-18 — buildRiskMatrix', () => {
  it('[Sucesso] R01 (4×4) na célula HIGH e R02 (1×1) na LOW; demais células vazias', () => {
    const matrix = riskMatrixSchema.parse(buildRiskMatrix([risk(1, 4, 4), risk(2, 1, 1)], FIVE));
    expect(matrix.cells).toHaveLength(25);
    const cell = (p: number, i: number) =>
      matrix.cells.find((candidate) => candidate.probability === p && candidate.impact === i);
    expect(cell(4, 4)).toEqual({
      probability: 4,
      impact: 4,
      score: 16,
      level: 'HIGH',
      risks: [{ id: id(1), code: 'R01', title: 'Risco 1' }],
    });
    expect(cell(1, 1)).toMatchObject({ score: 1, level: 'LOW', risks: [{ code: 'R02' }] });
    expect(cell(5, 5)).toMatchObject({ score: 25, level: 'EXTREME', risks: [] });
    expect(matrix.cells.filter((candidate) => candidate.risks.length > 0)).toHaveLength(2);
  });

  it('ordem de exibição: probabilidade decrescente, impacto crescente; riscos da célula por código', () => {
    const matrix = buildRiskMatrix([risk(10, 2, 3), risk(2, 2, 3), risk(9, 2, 3)], THREE);
    expect(matrix.cells.map((cell) => [cell.probability, cell.impact])).toEqual([
      [3, 1],
      [3, 2],
      [3, 3],
      [2, 1],
      [2, 2],
      [2, 3],
      [1, 1],
      [1, 2],
      [1, 3],
    ]);
    const cell = matrix.cells.find((c) => c.probability === 2 && c.impact === 3);
    expect(cell?.risks.map((r) => r.code)).toEqual(['R02', 'R09', 'R10']);
  });

  it('usa a escala e as faixas VIGENTES: grau acima do máximo vai para a borda (nunca some)', () => {
    const matrix = buildRiskMatrix([risk(1, 5, 4), risk(2, 1, 5)], THREE);
    expect(matrix.scale).toEqual(THREE.scale);
    expect(matrix.levelThresholds).toEqual(THREE.levelThresholds);
    const withRisks = matrix.cells.filter((cell) => cell.risks.length > 0);
    expect(withRisks.map((cell) => [cell.probability, cell.impact, cell.level])).toEqual([
      [3, 3, 'EXTREME'],
      [1, 3, 'MEDIUM'],
    ]);
  });

  it('sem riscos: todas as células, todas vazias', () => {
    const matrix = buildRiskMatrix([], THREE);
    expect(matrix.cells).toHaveLength(9);
    expect(matrix.cells.every((cell) => cell.risks.length === 0)).toBe(true);
  });

  it('filtros de RSK-09: fase, categoria e status opcionais e estritos', () => {
    expect(riskMatrixQuerySchema.parse({})).toEqual({});
    expect(
      riskMatrixQuerySchema.parse({ phase: 'PLANNING', status: 'OPEN', categoryId: id(3) }),
    ).toEqual({ phase: 'PLANNING', status: 'OPEN', categoryId: id(3) });
    expect(riskMatrixQuerySchema.safeParse({ phase: 'OUTRA' }).success).toBe(false);
    expect(riskMatrixQuerySchema.safeParse({ sort: 'code' }).success).toBe(false);
  });
});

describe('RN-RISK-21 — evaluateRiskMapCompleteness', () => {
  it('[Validação] sem nenhum risco: RISK_LIST_EMPTY bloqueante', () => {
    expect(evaluateRiskMapCompleteness([])).toEqual([
      {
        code: 'RISK_LIST_EMPTY',
        severity: 'BLOCKING',
        message: RISK_MAP_MESSAGES.listEmpty,
        ruleId: 'RN-RISK-21',
        sectionKey: null,
        field: 'risks',
        itemId: null,
        params: {},
      },
    ]);
  });

  it('[Validação] HIGH/EXTREME sem tratamento ativo (cancelado não conta): uma pendência por risco', () => {
    const violations = evaluateRiskMapCompleteness([
      { id: id(4), code: 'R04', level: 'EXTREME', treatments: [{ status: 'CANCELED' }] },
      { id: id(3), code: 'R03', level: 'HIGH', treatments: [] },
      { id: id(1), code: 'R01', level: 'HIGH', treatments: [{ status: 'PLANNED' }] },
      { id: id(2), code: 'R02', level: 'MEDIUM', treatments: [] },
      { id: id(5), code: 'R05', level: 'LOW', treatments: [] },
      { id: id(6), code: 'R06', level: 'EXTREME', treatments: [{ status: 'DONE' }] },
    ]);
    expect(violations).toEqual([
      {
        code: 'RISK_TREATMENT_REQUIRED_FOR_LEVEL',
        severity: 'BLOCKING',
        message: 'O risco R03 precisa de ao menos uma ação de tratamento.',
        ruleId: 'RN-RISK-21',
        sectionKey: null,
        field: 'treatments',
        itemId: id(3),
        params: { code: 'R03', level: 'HIGH' },
      },
      expect.objectContaining({ itemId: id(4), params: { code: 'R04', level: 'EXTREME' } }),
    ]);
  });

  it('[Sucesso] todos os Altos/Extremos com tratamento ativo: sem pendências', () => {
    expect(
      evaluateRiskMapCompleteness([
        { id: id(1), code: 'R01', level: 'HIGH', treatments: [{ status: 'IN_PROGRESS' }] },
        { id: id(2), code: 'R02', level: 'LOW', treatments: [] },
      ]),
    ).toEqual([]);
  });
});
