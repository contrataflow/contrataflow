import { describe, expect, it } from 'vitest';

import {
  ALTERNATIVE_DECISIONS,
  alternativeNameKey,
  alternativesComparison,
  createEtpAlternativeSchema,
  decideEtpAlternativeSchema,
  decisionJustificationProblem,
  decisionRequiresJustification,
  ETP_ALTERNATIVE_MESSAGES,
  etpAlternativeListMetaSchema,
  nextAlternativeSortOrder,
  updateEtpAlternativeSchema,
} from './etp-alternatives.js';
import { EtpAlternativeRecommended } from './events.js';

const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const issues = (result: { success: boolean; error?: { issues: readonly unknown[] } }) =>
  (result.error?.issues ?? []).map((issue) => {
    const { path, message, params } = issue as {
      path: PropertyKey[];
      message: string;
      params?: { code?: string };
    };
    return { field: path.join('.'), message, code: params?.code ?? null };
  });

const VALID = {
  name: 'Locação de equipamentos',
  description: doc('Locação mensal com manutenção inclusa.'),
};

describe('createEtpAlternativeSchema (ETP-06 · RN-ETP-18)', () => {
  it('aceita o mínimo e normaliza observações vazias', () => {
    expect(createEtpAlternativeSchema.parse({ ...VALID, observations: '  ' })).toEqual({
      ...VALID,
      observations: null,
    });
  });

  it('aceita todos os campos opcionais', () => {
    const parsed = createEtpAlternativeSchema.parse({
      ...VALID,
      name: '  Locação de equipamentos  ',
      advantages: doc('Sem investimento inicial.'),
      disadvantages: null,
      estimatedCost: '15000.00',
      riskLevel: 'LOW',
      observations: 'Cotação informal.',
    });
    expect(parsed).toMatchObject({ name: 'Locação de equipamentos', estimatedCost: '15000.00' });
  });

  it('V-01: nome ausente, vazio ou acima de 150 caracteres', () => {
    for (const name of [undefined, '   ', 'x'.repeat(151)]) {
      const result = createEtpAlternativeSchema.safeParse({ ...VALID, name });
      expect(issues(result)).toEqual([
        expect.objectContaining({ field: 'name', message: ETP_ALTERNATIVE_MESSAGES.nameInvalid }),
      ]);
    }
    expect(createEtpAlternativeSchema.safeParse({ ...VALID, name: 'x'.repeat(150) }).success).toBe(
      true,
    );
  });

  it('V-02: descrição ausente ou sem texto → "Descreva a alternativa."', () => {
    const missing = createEtpAlternativeSchema.safeParse({ name: VALID.name });
    expect(issues(missing)).toEqual([
      expect.objectContaining({
        field: 'description',
        message: ETP_ALTERNATIVE_MESSAGES.descriptionRequired,
      }),
    ]);
    const empty = createEtpAlternativeSchema.safeParse({
      ...VALID,
      description: { type: 'doc', content: [] },
    });
    expect(issues(empty)).toEqual([
      {
        field: 'description',
        message: ETP_ALTERNATIVE_MESSAGES.descriptionRequired,
        code: 'REQUIRED',
      },
    ]);
  });

  it('rich text com nó não permitido é recusado (INVALID_FORMAT)', () => {
    const result = createEtpAlternativeSchema.safeParse({
      ...VALID,
      advantages: { type: 'doc', content: [{ type: 'iframe' }] },
    });
    expect(issues(result)).toEqual([
      expect.objectContaining({ field: 'advantages', code: 'INVALID_FORMAT' }),
    ]);
    expect(createEtpAlternativeSchema.safeParse({ ...VALID, description: 'texto' }).success).toBe(
      false,
    );
  });

  it('V-07: custo negativo, com 3 casas ou número → INVALID_DECIMAL', () => {
    for (const estimatedCost of ['-1.00', '10.123', '1,50', 'abc']) {
      const result = createEtpAlternativeSchema.safeParse({ ...VALID, estimatedCost });
      expect(issues(result)).toEqual([
        {
          field: 'estimatedCost',
          message: ETP_ALTERNATIVE_MESSAGES.costInvalid,
          code: 'INVALID_DECIMAL',
        },
      ]);
    }
    expect(createEtpAlternativeSchema.safeParse({ ...VALID, estimatedCost: 15000 }).success).toBe(
      false,
    );
    expect(createEtpAlternativeSchema.safeParse({ ...VALID, estimatedCost: '0' }).success).toBe(
      true,
    );
  });

  it('nível de risco fora do enum e campos técnicos (decisão, ordem) são recusados', () => {
    expect(createEtpAlternativeSchema.safeParse({ ...VALID, riskLevel: 'CRITICAL' }).success).toBe(
      false,
    );
    expect(
      createEtpAlternativeSchema.safeParse({ ...VALID, decision: 'RECOMMENDED' }).success,
    ).toBe(false);
    expect(createEtpAlternativeSchema.safeParse({ ...VALID, sortOrder: 1 }).success).toBe(false);
  });
});

describe('updateEtpAlternativeSchema (ETP-07)', () => {
  it('aceita patch parcial e a reordenação', () => {
    expect(updateEtpAlternativeSchema.parse({})).toEqual({});
    expect(updateEtpAlternativeSchema.parse({ sortOrder: 2, estimatedCost: null })).toEqual({
      sortOrder: 2,
      estimatedCost: null,
    });
  });

  it('nome e descrição não podem ser limpos; ordem inválida é recusada', () => {
    expect(updateEtpAlternativeSchema.safeParse({ name: null }).success).toBe(false);
    expect(updateEtpAlternativeSchema.safeParse({ description: null }).success).toBe(false);
    expect(updateEtpAlternativeSchema.safeParse({ sortOrder: -1 }).success).toBe(false);
    expect(updateEtpAlternativeSchema.safeParse({ sortOrder: 1.5 }).success).toBe(false);
    expect(updateEtpAlternativeSchema.safeParse({ decision: 'DISCARDED' }).success).toBe(false);
  });
});

describe('decideEtpAlternativeSchema (ETP-09 · RN-ETP-19)', () => {
  const justification = 'A locação reduz o custo total em 30% no período.';

  it('RECOMMENDED/DISCARDED com justificativa ≥ 20 caracteres', () => {
    expect(
      decideEtpAlternativeSchema.parse({
        decision: 'RECOMMENDED',
        decisionJustification: justification,
      }),
    ).toEqual({ decision: 'RECOMMENDED', decisionJustification: justification });
    expect(
      decideEtpAlternativeSchema.parse({
        decision: 'RECOMMENDED',
        decisionJustification: justification,
        replaceRecommended: true,
      }).replaceRecommended,
    ).toBe(true);
  });

  it('V-04: sem justificativa → CONDITIONAL_REQUIRED; curta → TOO_SHORT', () => {
    expect(issues(decideEtpAlternativeSchema.safeParse({ decision: 'DISCARDED' }))).toEqual([
      {
        field: 'decisionJustification',
        message: ETP_ALTERNATIVE_MESSAGES.justificationRequired,
        code: 'CONDITIONAL_REQUIRED',
      },
    ]);
    expect(
      issues(
        decideEtpAlternativeSchema.safeParse({
          decision: 'RECOMMENDED',
          decisionJustification: '   curta demais   ',
        }),
      ),
    ).toEqual([
      {
        field: 'decisionJustification',
        message: ETP_ALTERNATIVE_MESSAGES.justificationRequired,
        code: 'TOO_SHORT',
      },
    ]);
  });

  it('UNDER_ANALYSIS dispensa a justificativa; decisão desconhecida é recusada', () => {
    expect(decideEtpAlternativeSchema.parse({ decision: 'UNDER_ANALYSIS' })).toEqual({
      decision: 'UNDER_ANALYSIS',
    });
    expect(decideEtpAlternativeSchema.safeParse({ decision: 'APPROVED' }).success).toBe(false);
    expect(
      decideEtpAlternativeSchema.safeParse({
        decision: 'DISCARDED',
        decisionJustification: 'x'.repeat(4001),
      }).success,
    ).toBe(false);
  });
});

describe('regras puras', () => {
  it('decisionRequiresJustification / decisionJustificationProblem', () => {
    expect(ALTERNATIVE_DECISIONS.filter(decisionRequiresJustification)).toEqual([
      'RECOMMENDED',
      'DISCARDED',
    ]);
    expect(decisionJustificationProblem('UNDER_ANALYSIS', null)).toBeNull();
    expect(decisionJustificationProblem('DISCARDED', undefined)).toBe('CONDITIONAL_REQUIRED');
    expect(decisionJustificationProblem('DISCARDED', 'x'.repeat(19))).toBe('TOO_SHORT');
    expect(decisionJustificationProblem('DISCARDED', 'x'.repeat(20))).toBeNull();
  });

  it('alternativeNameKey ignora caixa e espaços nas pontas', () => {
    expect(alternativeNameKey('  Locação de Equipamentos ')).toBe(
      alternativeNameKey('locação de equipamentos'),
    );
  });

  it('nextAlternativeSortOrder: ao final da lista', () => {
    expect(nextAlternativeSortOrder([])).toBe(0);
    expect(nextAlternativeSortOrder([{ sortOrder: 0 }, { sortOrder: 4 }, { sortOrder: 2 }])).toBe(
      5,
    );
  });
});

describe('alternativesComparison (RN-ETP-23)', () => {
  const row = (
    id: string,
    overrides: Partial<Parameters<typeof alternativesComparison>[0][number]> = {},
  ) => ({
    id,
    name: `Alternativa ${id}`,
    decision: 'UNDER_ANALYSIS' as const,
    estimatedCost: null,
    estimatedCostMasked: false,
    riskLevel: null,
    sortOrder: 0,
    createdAt: '2026-10-18T10:00:00.000Z',
    ...overrides,
  });

  it('ordena por sortOrder (empate: criação, id) e destaca a recomendada e o menor custo', () => {
    const rows = alternativesComparison([
      row('c', { sortOrder: 2, estimatedCost: '900.00' }),
      row('a', { sortOrder: 0, estimatedCost: '15000.00', decision: 'RECOMMENDED' }),
      row('b', { sortOrder: 1, estimatedCost: '12000.5', riskLevel: 'HIGH' }),
      row('d', {
        sortOrder: 2,
        estimatedCost: '10.00',
        decision: 'DISCARDED',
        createdAt: '2026-10-18T11:00:00.000Z',
      }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(rows.find((r) => r.isRecommended)?.id).toBe('a');
    // A descartada (mais barata) não conta para o menor custo.
    expect(rows.filter((r) => r.isLowestCost).map((r) => r.id)).toEqual(['c']);
  });

  it('sem custo, com custo mascarado ou com uma única alternativa: nenhum "menor custo"', () => {
    expect(alternativesComparison([row('a', { estimatedCost: '10.00' })])[0]?.isLowestCost).toBe(
      false,
    );
    const masked = alternativesComparison([
      row('a', { estimatedCostMasked: true }),
      row('b', { estimatedCostMasked: true, sortOrder: 1 }),
    ]);
    expect(masked.some((r) => r.isLowestCost)).toBe(false);
    expect(masked[0]).toMatchObject({ estimatedCost: null, estimatedCostMasked: true });
    const tie = alternativesComparison([
      row('a', { estimatedCost: '10.00' }),
      row('b', { estimatedCost: '10', sortOrder: 1 }),
    ]);
    expect(tie.some((r) => r.isLowestCost)).toBe(false);
  });
});

describe('EtpAlternativeRecommended (events.md §4)', () => {
  it('payload só com ids e routing key fixa', () => {
    const draft = EtpAlternativeRecommended.of({
      aggregateId: '0192d021-0000-7000-8000-000000000001',
      processId: '0192d021-0000-7000-8000-000000000002',
      payload: {
        etpId: '0192d021-0000-7000-8000-000000000001',
        alternativeId: '0192d021-0000-7000-8000-000000000003',
      },
    });
    expect(draft.definition.eventType).toBe('EtpAlternativeRecommended');
    expect(
      EtpAlternativeRecommended.payloadSchema.safeParse({
        etpId: '0192d021-0000-7000-8000-000000000001',
        alternativeId: '0192d021-0000-7000-8000-000000000003',
        name: 'vazaria',
      }).success,
    ).toBe(false);
  });

  it('meta do ETP-05', () => {
    expect(
      etpAlternativeListMetaSchema.parse({
        canManage: false,
        recommendedAlternativeId: null,
        estimatedCostMasked: true,
      }),
    ).toEqual({ canManage: false, recommendedAlternativeId: null, estimatedCostMasked: true });
  });
});
