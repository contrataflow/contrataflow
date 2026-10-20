import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api/api-error';

import {
  emitOutcomeOf,
  heatmapCellLabelOf,
  riskMapActionOf,
  riskViolationsOf,
} from './risk-matrix-model';

const SCALE = {
  max: 5,
  probabilityLabels: ['Muito baixa', 'Baixa', 'Média', 'Alta', 'Muito alta'],
  impactLabels: ['Insignificante', 'Baixo', 'Médio', 'Alto', 'Crítico'],
};
const DOC = '0192d035-0000-7000-8000-000000000777';

const apiError = (status: number, code: string, meta?: Record<string, unknown>) =>
  new ApiError({
    status,
    code,
    correlationId: 'corr-1',
    problem: meta === undefined ? null : ({ meta } as never),
  });

describe('heatmapCellLabelOf (acessibilidade da grade)', () => {
  it('graus com rótulo, quantidade com os códigos e o nível', () => {
    expect(
      heatmapCellLabelOf(
        {
          probability: 4,
          impact: 4,
          score: 16,
          level: 'HIGH',
          risks: [
            { id: DOC, code: 'R01', title: 'Fornecedores insuficientes' },
            { id: DOC, code: 'R03', title: 'Impugnação' },
          ],
        },
        SCALE,
      ),
    ).toBe('Probabilidade Alta (4), impacto Alto (4): 2 riscos (R01, R03), nível Alto');
    expect(
      heatmapCellLabelOf({ probability: 1, impact: 2, score: 2, level: 'LOW', risks: [] }, SCALE),
    ).toBe('Probabilidade Muito baixa (1), impacto Baixo (2): nenhum risco, nível Baixo');
    expect(
      heatmapCellLabelOf(
        {
          probability: 1,
          impact: 1,
          score: 1,
          level: 'LOW',
          risks: [{ id: DOC, code: 'R02', title: 'x' }],
        },
        SCALE,
      ),
    ).toContain('1 risco (R02)');
  });
});

describe('riskMapActionOf (EmitRiskMapButton)', () => {
  it('sem mapa: emitir (desabilitado sem riscos — FA-02); sem permissão: nada', () => {
    expect(riskMapActionOf({ riskMap: null, canManage: true }, 2)).toEqual({
      kind: 'emit',
      disabled: false,
    });
    expect(riskMapActionOf({ riskMap: null, canManage: true }, 0)).toEqual({
      kind: 'emit',
      disabled: true,
    });
    expect(riskMapActionOf({ riskMap: null, canManage: false }, 3)).toEqual({ kind: 'none' });
  });

  it('com mapa: abrir em DRAFT/RETURNED; concluído em FINALIZED/APPROVED/IN_REVIEW; rejeitado', () => {
    const map = (status: string) => ({
      riskMap: { id: DOC, code: 'MR 0001/2026', status },
      canManage: false,
    });
    expect(riskMapActionOf(map('DRAFT'), 1)).toEqual({
      kind: 'open',
      documentId: DOC,
      code: 'MR 0001/2026',
    });
    expect(riskMapActionOf(map('RETURNED'), 1).kind).toBe('open');
    for (const status of ['FINALIZED', 'APPROVED', 'IN_REVIEW']) {
      expect(riskMapActionOf(map(status), 1)).toEqual({
        kind: 'completed',
        documentId: DOC,
        code: 'MR 0001/2026',
        rejected: false,
      });
    }
    expect(riskMapActionOf(map('REJECTED'), 1)).toMatchObject({
      kind: 'completed',
      rejected: true,
    });
  });
});

describe('emitOutcomeOf (RSK-10 recusado)', () => {
  it('mapeia cada recusa para a faixa da UI', () => {
    expect(
      emitOutcomeOf(apiError(409, 'DOCUMENT_ALREADY_EXISTS', { existingDocumentId: DOC })),
    ).toEqual({ kind: 'exists', documentId: DOC });
    expect(emitOutcomeOf(apiError(409, 'DOCUMENT_ALREADY_EXISTS'))).toEqual({
      kind: 'exists',
      documentId: null,
    });
    expect(emitOutcomeOf(apiError(422, 'BUSINESS_RULE_VIOLATION')).kind).toBe('empty');
    expect(emitOutcomeOf(apiError(403, 'PERMISSION_DENIED')).kind).toBe('forbidden');
    expect(emitOutcomeOf(apiError(409, 'INVALID_PROCESS_STATUS')).kind).toBe('notEditable');
    expect(emitOutcomeOf(apiError(409, 'DOCUMENT_NOT_EDITABLE')).kind).toBe('notEditable');
    expect(emitOutcomeOf(apiError(422, 'DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE')).kind).toBe(
      'typeNotAllowed',
    );
    expect(emitOutcomeOf(apiError(503, 'DEPENDENCY_UNAVAILABLE'))).toEqual({
      kind: 'unavailable',
      correlationId: 'corr-1',
    });
    expect(emitOutcomeOf(apiError(500, 'INTERNAL_ERROR'))).toEqual({
      kind: 'failed',
      correlationId: 'corr-1',
    });
    expect(emitOutcomeOf(new Error('rede'))).toEqual({ kind: 'failed', correlationId: null });
  });
});

describe('riskViolationsOf', () => {
  it('só as pendências RISK_* do DOC-08', () => {
    const base = {
      severity: 'BLOCKING' as const,
      message: 'm',
      ruleId: null,
      sectionKey: null,
      field: null,
      itemId: null,
      params: {},
    };
    expect(
      riskViolationsOf([
        { ...base, code: 'SECTION_REQUIRED' },
        { ...base, code: 'RISK_TREATMENT_REQUIRED_FOR_LEVEL' },
      ]).map((violation) => violation.code),
    ).toEqual(['RISK_TREATMENT_REQUIRED_FOR_LEVEL']);
  });
});
