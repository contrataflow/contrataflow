import type { RiskDto, RiskScaleSnapshot, RiskTreatmentDto } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { riskMapSnapshot, riskMapSummary, riskMapViolations, riskMatrixOf } from './risk-map.js';

const CURRENT: RiskScaleSnapshot = {
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

function treatment(overrides: Partial<RiskTreatmentDto> = {}): RiskTreatmentDto {
  return {
    id: id(90),
    riskId: id(1),
    processId: id(50),
    type: 'CONTINGENCY',
    description: 'Plano de contingência com fornecedor alternativo',
    responsibleId: null,
    responsible: null,
    responsibleDepartmentId: id(70),
    responsibleDepartment: { id: id(70), name: 'Setor de Compras' },
    dueDate: '2026-11-30',
    status: 'IN_PROGRESS',
    completedAt: null,
    notes: null,
    sortOrder: 0,
    version: 1,
    ...overrides,
  };
}

function risk(overrides: Partial<RiskDto> = {}): RiskDto {
  return {
    id: id(1),
    processId: id(50),
    code: 'R01',
    title: 'Fornecedores insuficientes',
    description: null,
    categoryId: id(60),
    category: { id: id(60), code: 'MERCADO_FORNECEDOR', label: 'Mercado fornecedor' },
    phase: 'PLANNING',
    cause: 'Mercado local restrito',
    consequence: 'Licitação deserta',
    probability: 3,
    impact: 2,
    score: 6,
    level: 'HIGH',
    scaleSnapshot: CURRENT,
    ownerId: id(80),
    owner: { id: id(80), name: 'Ana Souza' },
    ownerDepartmentId: null,
    ownerDepartment: null,
    residualProbability: 1,
    residualImpact: 2,
    residualScore: 2,
    residualLevel: 'LOW',
    status: 'IN_TREATMENT',
    sortOrder: 0,
    treatments: [treatment()],
    version: 3,
    ...overrides,
  } as RiskDto;
}

describe('RiskMapSnapshotBuilder (RN-RISK-20)', () => {
  it('congela riscos, tratamentos e as células ocupadas da matriz vigente, com rótulos legíveis', () => {
    const r02 = risk({
      id: id(2),
      code: 'R02',
      title: 'Atraso na entrega',
      probability: 1,
      impact: 1,
      score: 1,
      level: 'LOW',
      owner: null,
      ownerId: null,
      ownerDepartmentId: id(71),
      ownerDepartment: { id: id(71), name: 'Almoxarifado' },
      residualProbability: null,
      residualImpact: null,
      residualScore: null,
      residualLevel: null,
      status: 'OPEN',
      treatments: [],
    });
    const snapshot = riskMapSnapshot([risk(), r02], CURRENT);
    expect(snapshot.header).toEqual({
      riskCount: 2,
      treatmentCount: 1,
      scaleMax: 3,
      levelThresholds: CURRENT.levelThresholds,
      byLevel: { LOW: 1, MEDIUM: 0, HIGH: 1, EXTREME: 0 },
    });
    expect(snapshot.collections.risks).toEqual([
      {
        riskId: id(1),
        code: 'R01',
        title: 'Fornecedores insuficientes',
        description: null,
        category: 'Mercado fornecedor',
        phase: 'Planejamento da contratação',
        cause: 'Mercado local restrito',
        consequence: 'Licitação deserta',
        probability: 3,
        impact: 2,
        score: 6,
        level: 'Alto',
        residualScore: 2,
        residualLevel: 'Baixo',
        status: 'Em tratamento',
        owner: 'Ana Souza',
      },
      expect.objectContaining({
        code: 'R02',
        level: 'Baixo',
        residualLevel: null,
        status: 'Aberto',
        owner: 'Almoxarifado',
      }),
    ]);
    expect(snapshot.collections.treatments).toEqual([
      {
        treatmentId: id(90),
        riskCode: 'R01',
        type: 'Contingência',
        description: 'Plano de contingência com fornecedor alternativo',
        responsible: 'Setor de Compras',
        dueDate: '2026-11-30',
        status: 'Em andamento',
        completedAt: null,
        notes: null,
      },
    ]);
    expect(snapshot.collections.matrix).toEqual([
      { probability: 3, impact: 2, score: 6, level: 'Alto', risks: 'R01' },
      { probability: 1, impact: 1, score: 1, level: 'Baixo', risks: 'R02' },
    ]);
  });

  it('sem responsável nem unidade: `owner`/`responsible` nulos; sem riscos: coleções vazias', () => {
    const lonely = risk({
      owner: null,
      ownerId: null,
      treatments: [treatment({ responsibleDepartment: null, responsibleDepartmentId: null })],
    });
    const snapshot = riskMapSnapshot([lonely], CURRENT);
    expect(snapshot.collections.risks).toEqual([expect.objectContaining({ owner: null })]);
    expect(snapshot.collections.treatments).toEqual([
      expect.objectContaining({ responsible: null }),
    ]);
    expect(riskMapSnapshot([], CURRENT).collections).toEqual({
      risks: [],
      treatments: [],
      matrix: [],
    });
  });

  it('a matriz do snapshot é a mesma agregação de RSK-09 (RN-RISK-18)', () => {
    const grid = riskMatrixOf([risk()], CURRENT);
    expect(grid.cells.filter((cell) => cell.risks.length > 0)).toEqual([
      {
        probability: 3,
        impact: 2,
        score: 6,
        level: 'HIGH',
        risks: [{ id: id(1), code: 'R01', title: 'Fornecedores insuficientes' }],
      },
    ]);
  });
});

describe('riskMapSummary · riskMapViolations', () => {
  it('resumo de DocumentFinalized: contagens por nível e de tratamentos', () => {
    expect(riskMapSummary([risk(), risk({ id: id(2), level: 'EXTREME', treatments: [] })])).toEqual(
      {
        riskCount: 2,
        treatmentCount: 1,
        byLevel: { LOW: 0, MEDIUM: 0, HIGH: 1, EXTREME: 1 },
      },
    );
  });

  it('completude RN-RISK-21 sobre os DTOs: Extremo sem tratamento ativo bloqueia', () => {
    const r02 = risk({ id: id(2), code: 'R02', level: 'EXTREME', treatments: [] });
    expect(riskMapViolations([risk(), r02]).map((v) => [v.code, v.itemId])).toEqual([
      ['RISK_TREATMENT_REQUIRED_FOR_LEVEL', id(2)],
    ]);
  });
});
