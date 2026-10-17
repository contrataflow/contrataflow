import { RISK_MESSAGES } from '@contrataflow/validation';
import type { FieldError, RiskDto } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { ApiError } from '@/lib/api/api-error';

import {
  cellLabelOf,
  createBodyOf,
  divergentFieldsOf,
  levelTransitionOf,
  liveAssessment,
  lockStateOf,
  moveGridPosition,
  ownerLabelOf,
  patchOf,
  referenceFieldsOf,
  riskFormValuesOf,
  riskProblemOf,
  validateRisk,
} from './risks-model';

const THRESHOLDS = [
  { level: 'LOW', minScore: 1, maxScore: 4 },
  { level: 'MEDIUM', minScore: 5, maxScore: 9 },
  { level: 'HIGH', minScore: 10, maxScore: 16 },
  { level: 'EXTREME', minScore: 17, maxScore: 25 },
] as const;
const SCALE = {
  max: 5,
  probabilityLabels: ['Muito baixa', 'Baixa', 'Média', 'Alta', 'Muito alta'],
  impactLabels: ['Insignificante', 'Baixo', 'Médio', 'Alto', 'Crítico'],
};
const CATEGORY = '0192a000-0000-7000-8000-000000000241';
const OWNER = '0192a000-0000-7000-8000-000000000001';

function risk(extra: Partial<RiskDto> = {}): RiskDto {
  return {
    id: '0192a000-0000-7000-8000-000000000901',
    processId: '0192a000-0000-7000-8000-000000000400',
    code: 'R01',
    title: 'Atraso na entrega',
    description: null,
    categoryId: CATEGORY,
    category: { id: CATEGORY, code: 'MERCADO', label: 'Risco de mercado' },
    phase: 'PLANNING',
    cause: 'Fornecedor com pouca capacidade',
    consequence: 'Obra parada por semanas',
    probability: 4,
    impact: 4,
    score: 16,
    level: 'HIGH',
    scaleSnapshot: { scale: SCALE, levelThresholds: [...THRESHOLDS] },
    ownerId: null,
    owner: null,
    ownerDepartmentId: null,
    ownerDepartment: null,
    residualProbability: null,
    residualImpact: null,
    residualScore: null,
    residualLevel: null,
    status: 'OPEN',
    sortOrder: 1,
    treatments: [],
    version: 3,
    ...extra,
  };
}

const filled = {
  ...riskFormValuesOf(null),
  title: 'Atraso na entrega',
  categoryId: CATEGORY,
  cause: 'Fornecedor com pouca capacidade',
  consequence: 'Obra parada por semanas',
  probability: 4,
  impact: 4,
};

describe('formulário de riscos (US-033)', () => {
  it('risco novo começa em PLANNING/OPEN sem avaliação; o existente carrega seus valores', () => {
    const empty = riskFormValuesOf(null);
    expect(empty).toMatchObject({ phase: 'PLANNING', status: 'OPEN', probability: null });
    const existing = riskFormValuesOf(
      risk({ ownerId: OWNER, owner: { id: OWNER, name: 'Ana Souza' } }),
    );
    expect(existing).toMatchObject({ ownerId: OWNER, ownerName: 'Ana Souza', probability: 4 });
  });

  it('corpo do RSK-02 omite o que não foi informado (estrito: sem residuais nem status)', () => {
    expect(createBodyOf(filled)).toEqual({
      title: 'Atraso na entrega',
      categoryId: CATEGORY,
      phase: 'PLANNING',
      cause: 'Fornecedor com pouca capacidade',
      consequence: 'Obra parada por semanas',
      probability: 4,
      impact: 4,
    });
    expect(createBodyOf({ ...filled, ownerId: OWNER, description: ' Texto ' })).toMatchObject({
      ownerId: OWNER,
      description: ' Texto ',
    });
  });

  it('V-01/V-02: obrigatórios e limites com as mensagens da story', () => {
    const messages = validateRisk(riskFormValuesOf(null), 5);
    expect(messages).toMatchObject({
      title: RISK_MESSAGES.titleRequired,
      categoryId: RISK_MESSAGES.categoryRequired,
      cause: RISK_MESSAGES.causeRequired,
      consequence: RISK_MESSAGES.consequenceRequired,
      probability: RISK_MESSAGES.probabilityRequired,
      impact: RISK_MESSAGES.impactRequired,
    });
    expect(validateRisk({ ...filled, cause: 'curta' }, 5).cause).toBe(RISK_MESSAGES.causeLength);
    expect(validateRisk(filled, 5)).toEqual({});
  });

  it('V-03: grau acima da escala vigente (3×3) é recusado', () => {
    expect(validateRisk({ ...filled, probability: 4 }, 3).probability).toBe(
      RISK_MESSAGES.outOfRange(3),
    );
  });

  it('RN-RISK-08: residuais só em par e dentro da escala', () => {
    expect(validateRisk({ ...filled, residualProbability: 2 }, 5).residualImpact).toBe(
      RISK_MESSAGES.residualPair,
    );
    expect(validateRisk({ ...filled, residualProbability: 2, residualImpact: 2 }, 5)).toEqual({});
  });

  it('PATCH só com o que mudou; residuais sempre em par; null limpa', () => {
    const base = risk();
    const values = riskFormValuesOf(base);
    expect(patchOf(base, values)).toEqual({});
    expect(patchOf(base, { ...values, probability: 2, title: 'Novo título' })).toEqual({
      title: 'Novo título',
      probability: 2,
    });
    expect(patchOf(base, { ...values, residualProbability: 2, residualImpact: 3 })).toEqual({
      residualProbability: 2,
      residualImpact: 3,
    });
    const withResidual = risk({ residualProbability: 2, residualImpact: 3 });
    expect(
      patchOf(withResidual, {
        ...riskFormValuesOf(withResidual),
        residualProbability: null,
        residualImpact: null,
      }),
    ).toEqual({ residualProbability: null, residualImpact: null });
    expect(patchOf(base, { ...values, ownerId: OWNER })).toEqual({ ownerId: OWNER });
  });
});

describe('avaliação em tempo real (US-033)', () => {
  it('escore e nível pelas faixas vigentes; incompleta ou fora da escala = null', () => {
    expect(liveAssessment(4, 4, 5, THRESHOLDS)).toEqual({ score: 16, level: 'HIGH' });
    expect(liveAssessment(2, 4, 5, THRESHOLDS)).toEqual({ score: 8, level: 'MEDIUM' });
    expect(liveAssessment(null, 4, 5, THRESHOLDS)).toBeNull();
    expect(liveAssessment(5, 4, 3, THRESHOLDS)).toBeNull();
  });

  it('FA-01: transição "Alto → Médio" só quando o nível muda', () => {
    expect(levelTransitionOf('HIGH', 'MEDIUM')).toBe('Alto → Médio');
    expect(levelTransitionOf('HIGH', 'HIGH')).toBeNull();
  });

  it('rótulo da célula com rótulos da escala, escore e nível', () => {
    expect(cellLabelOf(4, 3, SCALE, THRESHOLDS)).toBe(
      'Probabilidade Alta (4), impacto Médio (3): escore 12, nível Alto',
    );
    expect(cellLabelOf(1, 1, { ...SCALE, probabilityLabels: [] }, THRESHOLDS)).toContain(
      'Probabilidade 1,',
    );
  });

  it('FA-03: "Sem responsável" quando não há pessoa nem unidade', () => {
    expect(ownerLabelOf(risk())).toEqual({ text: 'Sem responsável', missing: true });
    expect(
      ownerLabelOf(
        risk({
          owner: { id: OWNER, name: 'Ana Souza' },
          ownerDepartment: { id: CATEGORY, name: 'Setor de Obras' },
        }),
      ),
    ).toEqual({ text: 'Ana Souza · Setor de Obras', missing: false });
  });
});

describe('navegação por setas da grade', () => {
  it('↑/↓ mudam a probabilidade, ←/→ o impacto, com limites; Home/End vão às pontas', () => {
    const at = { probability: 3, impact: 3 };
    expect(moveGridPosition(at, 'ArrowUp', 5)).toEqual({ probability: 4, impact: 3 });
    expect(moveGridPosition(at, 'ArrowDown', 5)).toEqual({ probability: 2, impact: 3 });
    expect(moveGridPosition(at, 'ArrowRight', 5)).toEqual({ probability: 3, impact: 4 });
    expect(moveGridPosition(at, 'ArrowLeft', 5)).toEqual({ probability: 3, impact: 2 });
    expect(moveGridPosition({ probability: 5, impact: 5 }, 'ArrowUp', 5)).toEqual({
      probability: 5,
      impact: 5,
    });
    expect(moveGridPosition({ probability: 1, impact: 1 }, 'ArrowLeft', 5)).toEqual({
      probability: 1,
      impact: 1,
    });
    expect(moveGridPosition(at, 'Home', 5)).toEqual({ probability: 3, impact: 1 });
    expect(moveGridPosition(at, 'End', 5)).toEqual({ probability: 3, impact: 5 });
    expect(moveGridPosition(at, 'a', 5)).toBeNull();
  });
});

describe('bloqueio e permissão (FA-04 · [Permissão])', () => {
  it('canManage mostra as ações; sem permissão não mostra nada; demais motivos desabilitam', () => {
    expect(lockStateOf({ canManage: true, lockReason: null })).toEqual({
      showActions: true,
      disabled: false,
      reason: null,
    });
    expect(lockStateOf({ canManage: false, lockReason: 'PERMISSION_DENIED' }).showActions).toBe(
      false,
    );
    expect(lockStateOf({ canManage: false, lockReason: null }).showActions).toBe(false);
    expect(lockStateOf({ canManage: false, lockReason: 'DOCUMENT_NOT_EDITABLE' })).toEqual({
      showActions: true,
      disabled: true,
      reason: 'DOCUMENT_NOT_EDITABLE',
    });
  });
});

function apiError(
  status: number,
  code: string,
  extra: { errors?: FieldError[]; detail?: string } = {},
) {
  return new ApiError({ status, code, correlationId: 'c-1', ...extra });
}

describe('erros da API (casos de erro da story)', () => {
  it('422 vira mensagens por campo; REFERENCE_* e OUT_OF_RANGE usam o texto da story', () => {
    const problem = riskProblemOf(
      apiError(422, 'VALIDATION_ERROR', {
        errors: [
          { field: 'categoryId', code: 'REFERENCE_INACTIVE', message: 'inativo' },
          { field: 'ownerId', code: 'REFERENCE_NOT_FOUND', message: 'x' },
          { field: 'probability', code: 'OUT_OF_RANGE', message: 'y' },
          { field: 'cause', code: 'REQUIRED', message: 'Informe a causa.' },
        ],
      }),
      5,
    );
    expect(problem).toEqual({
      kind: 'fields',
      fields: {
        categoryId: RISK_MESSAGES.categoryInvalid,
        ownerId: RISK_MESSAGES.ownerInvalid,
        probability: RISK_MESSAGES.outOfRange(5),
        cause: 'Informe a causa.',
      },
    });
    expect(referenceFieldsOf({ categoryId: 'a', cause: 'b', ownerDepartmentId: 'c' })).toEqual([
      'categoryId',
      'ownerDepartmentId',
    ]);
  });

  it('classifica 412, 403, 409, 422 de etapa, chave reutilizada, 503 e 500', () => {
    expect(riskProblemOf(apiError(412, 'VERSION_CONFLICT'), 5)).toEqual({ kind: 'stale' });
    expect(riskProblemOf(apiError(403, 'PERMISSION_DENIED'), 5)).toEqual({ kind: 'permission' });
    expect(riskProblemOf(apiError(409, 'DOCUMENT_NOT_EDITABLE'), 5)).toEqual({
      kind: 'blocked',
      message: RISK_MESSAGES.locked,
    });
    expect(riskProblemOf(apiError(409, 'INVALID_PROCESS_STATUS'), 5)).toEqual({
      kind: 'blocked',
      message: RISK_MESSAGES.invalidProcessStatus,
    });
    expect(
      riskProblemOf(
        apiError(422, 'DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE', { detail: 'Etapa não permite.' }),
        5,
      ),
    ).toEqual({ kind: 'blocked', message: 'Etapa não permite.' });
    expect(riskProblemOf(apiError(422, 'IDEMPOTENCY_KEY_REUSED'), 5)).toEqual({
      kind: 'keyReused',
    });
    expect(riskProblemOf(apiError(503, 'DEPENDENCY_UNAVAILABLE'), 5)).toEqual({
      kind: 'unavailable',
    });
    expect(riskProblemOf(apiError(500, 'INTERNAL_ERROR'), 5)).toEqual({
      kind: 'unexpected',
      correlationId: 'c-1',
    });
    expect(riskProblemOf(new Error('x'), 5)).toEqual({ kind: 'unexpected', correlationId: '—' });
  });

  it('412: destaca os campos alterados por outra pessoa', () => {
    const base = risk();
    const latest = risk({ title: 'Outro título', probability: 2, version: 4 });
    expect(divergentFieldsOf(base, latest)).toEqual(['title', 'probability']);
  });
});
