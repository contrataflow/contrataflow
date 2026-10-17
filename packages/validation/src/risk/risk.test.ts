import { describe, expect, it } from 'vitest';

import { RiskAssessed, RiskCreated, RiskDeleted } from './events.js';
import {
  assessRisk,
  createRiskSchema,
  isWithinScale,
  RISK_MESSAGES,
  riskLevelOf,
  updateRiskSchema,
} from './risk.js';
import { riskLevelThresholdsSettingSchema, SETTING_DEFINITIONS } from '../tenancy/settings.js';
import type { RiskLevelThreshold } from '../tenancy/settings.js';

const DEFAULT_THRESHOLDS = SETTING_DEFINITIONS.find((item) => item.key === 'risk.levelThresholds')
  ?.defaultValue as RiskLevelThreshold[];

const CATEGORY = '0192d033-0000-7000-8000-000000000001';

const valid = {
  title: 'Atraso na entrega',
  categoryId: CATEGORY,
  phase: 'PLANNING',
  cause: 'Fornecedor com baixa capacidade produtiva',
  consequence: 'Paralisação da obra por falta de material',
  probability: 4,
  impact: 4,
};

describe('assessRisk (RN-RISK-03)', () => {
  it.each([
    [1, 1, 1, 'LOW'],
    [2, 2, 4, 'LOW'],
    [1, 5, 5, 'MEDIUM'],
    [3, 3, 9, 'MEDIUM'],
    [2, 5, 10, 'HIGH'],
    [4, 4, 16, 'HIGH'],
    [3, 6, 18, 'EXTREME'],
    [5, 5, 25, 'EXTREME'],
  ])('%i × %i = %i → %s nas faixas padrão', (probability, impact, score, level) => {
    expect(assessRisk(probability, impact, DEFAULT_THRESHOLDS)).toEqual({ score, level });
  });

  it('faixas configuradas: escore acima da última faixa fica no nível dela', () => {
    const bands = riskLevelThresholdsSettingSchema.parse([
      { level: 'LOW', minScore: 1, maxScore: 3 },
      { level: 'HIGH', minScore: 4, maxScore: 9 },
    ]);
    expect(assessRisk(1, 3, bands)).toEqual({ score: 3, level: 'LOW' });
    expect(assessRisk(2, 2, bands)).toEqual({ score: 4, level: 'HIGH' });
    expect(assessRisk(4, 4, bands)).toEqual({ score: 16, level: 'HIGH' });
    expect(riskLevelOf(16, bands)).toBeNull();
    expect(() => assessRisk(1, 1, [])).toThrow();
  });

  it('isWithinScale confere [1, max]', () => {
    expect(isWithinScale(3, { max: 3 })).toBe(true);
    expect(isWithinScale(4, { max: 3 })).toBe(false);
    expect(isWithinScale(0, { max: 5 })).toBe(false);
    expect(isWithinScale(2.5, { max: 5 })).toBe(false);
  });
});

describe('createRiskSchema (RN-RISK-01 · V-01..V-03)', () => {
  const issues = (input: unknown) => {
    const parsed = createRiskSchema.safeParse(input);
    return parsed.success ? [] : parsed.error.issues.map((issue) => [issue.path[0], issue.message]);
  };

  it('aceita o risco válido, apara textos e normaliza opcionais vazios', () => {
    const parsed = createRiskSchema.parse({ ...valid, title: '  Atraso  ', description: '  ' });
    expect(parsed).toMatchObject({ title: 'Atraso', description: null });
  });

  it('obrigatórios ausentes com a mensagem "Informe …"', () => {
    const { cause: _cause, ...withoutCause } = valid;
    expect(issues(withoutCause)).toEqual([['cause', RISK_MESSAGES.causeRequired]]);
    expect(issues({ ...valid, title: '   ' })).toEqual([['title', RISK_MESSAGES.titleRequired]]);
    const { probability: _p, ...withoutProbability } = valid;
    expect(issues(withoutProbability)).toEqual([
      ['probability', RISK_MESSAGES.probabilityRequired],
    ]);
  });

  it('limites de tamanho e faixa da grade', () => {
    expect(issues({ ...valid, cause: 'curta' })).toEqual([['cause', RISK_MESSAGES.causeLength]]);
    expect(issues({ ...valid, title: 'x'.repeat(201) })).toEqual([
      ['title', RISK_MESSAGES.titleLength],
    ]);
    expect(issues({ ...valid, probability: 7 })).toEqual([
      ['probability', RISK_MESSAGES.outOfRange(5)],
    ]);
    expect(issues({ ...valid, impact: 0 })).toEqual([['impact', RISK_MESSAGES.outOfRange(5)]]);
  });

  it('é estrito: campos calculados e residuais não entram na criação', () => {
    expect(createRiskSchema.safeParse({ ...valid, code: 'R01' }).success).toBe(false);
    expect(createRiskSchema.safeParse({ ...valid, residualImpact: 2 }).success).toBe(false);
  });

  it('PATCH aceita parciais, residuais nulos e status', () => {
    expect(
      updateRiskSchema.parse({ probability: 2, residualImpact: null, status: 'MITIGATED' }),
    ).toEqual({ probability: 2, residualImpact: null, status: 'MITIGATED' });
    expect(updateRiskSchema.safeParse({ score: 3 }).success).toBe(false);
  });
});

describe('eventos Risk*', () => {
  it('payloads só com ids, código e níveis', () => {
    const riskId = '0192d033-0000-7000-8000-0000000000aa';
    expect(
      RiskCreated.resolve({
        riskId,
        code: 'R01',
        level: 'HIGH',
        phase: 'PLANNING',
        categoryCode: 'PRAZO',
      }).routingKey,
    ).toBe('risk.created');
    expect(
      RiskAssessed.resolve({ riskId, fromLevel: 'HIGH', toLevel: 'MEDIUM', score: 8 }).routingKey,
    ).toBe('risk.assessed');
    expect(RiskDeleted.resolve({ riskId, code: 'R01' }).routingKey).toBe('risk.deleted');
    expect(() => RiskDeleted.resolve({ riskId, code: 'R01', title: 'Atraso' })).toThrow();
  });
});
