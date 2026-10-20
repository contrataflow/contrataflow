import { describe, expect, it } from 'vitest';

import {
  applyTermHeader,
  createTermOfReference,
  estimatedFromResearch,
  estimatedValueIntent,
  headerDefaults,
  initialObjectDefinition,
  isConditionField,
  manualEstimated,
  mergeTermConditions,
  normalizeMoney,
  normalizePercent,
} from './term-of-reference.js';
import type { TermOfReference } from './term-of-reference.js';

const NOW = new Date('2026-10-19T12:00:00.000Z');
const LATER = new Date('2026-10-19T13:00:00.000Z');

function term(overrides: Partial<TermOfReference> = {}): TermOfReference {
  return {
    ...createTermOfReference({
      documentId: 'd-1',
      tenantId: 't-1',
      processId: 'p-1',
      processObject: 'Aquisição de notebooks para as escolas',
      fieldConfig: {},
      completedResearch: null,
      creatorId: 'u-1',
      now: NOW,
    }),
    ...overrides,
  };
}

describe('createTermOfReference (RN-TR-06/07)', () => {
  it('objeto do processo, sem valor, versão 1 e o id do documento', () => {
    expect(term()).toMatchObject({
      id: 'd-1',
      documentId: 'd-1',
      objectDefinition: 'Aquisição de notebooks para as escolas',
      estimatedTotalValue: null,
      estimatedValueSource: null,
      priceResearchId: null,
      importedFromEtpId: null,
      version: 1,
      createdById: 'u-1',
      updatedById: 'u-1',
    });
  });

  it('com pesquisa concluída: priceResearchId, total e origem PRICE_RESEARCH', () => {
    const created = createTermOfReference({
      documentId: 'd-1',
      tenantId: 't-1',
      processId: 'p-1',
      processObject: 'Objeto',
      fieldConfig: { paymentTermDays: { defaultValue: 30 } },
      completedResearch: { id: 'pr-1', totalEstimatedValue: '98000' },
      creatorId: null,
      now: NOW,
    });
    expect(created).toMatchObject({
      priceResearchId: 'pr-1',
      estimatedTotalValue: '98000.00',
      estimatedValueSource: 'PRICE_RESEARCH',
      paymentTermDays: 30,
    });
  });

  it('objeto cortado em 2.000 caracteres e sem espaços nas pontas', () => {
    expect(initialObjectDefinition(`  ${'x'.repeat(2100)}  `)).toHaveLength(2000);
  });
});

describe('headerDefaults (RN-TR-06)', () => {
  it('aplica só os padrões válidos', () => {
    expect(
      headerDefaults({
        contractDurationMonths: { defaultValue: 12 },
        paymentTermDays: { defaultValue: 120 },
        contractGuaranteePercent: { defaultValue: '5.00' },
        awardType: { defaultValue: 'GLOBAL' },
        allowsSubcontracting: { defaultValue: 'sim' },
        deliveryLocation: { defaultValue: null },
        objectDefinition: { defaultValue: 'ignorado' },
      }),
    ).toEqual({
      contractDurationMonths: 12,
      contractGuaranteePercent: '5.00',
      awardType: 'GLOBAL',
    });
  });

  it('garantia acima de 10% é ignorada; prazo sem tipo de contagem não é aplicado', () => {
    expect(headerDefaults({ contractGuaranteePercent: { defaultValue: '10.5' } })).toEqual({});
    expect(headerDefaults({ executionDeadline: { defaultValue: 30 } })).toEqual({});
    expect(
      headerDefaults({
        executionDeadline: { defaultValue: 30 },
        executionDeadlineType: { defaultValue: 'BUSINESS' },
      }),
    ).toEqual({ executionDeadline: 30, executionDeadlineType: 'BUSINESS' });
  });
});

describe('EstimatedValue (RN-TR-08)', () => {
  it('normaliza para 2 casas', () => {
    expect(normalizeMoney('100000')).toBe('100000.00');
    expect(normalizeMoney('0.5')).toBe('0.50');
    expect(normalizeMoney(' 12.34 ')).toBe('12.34');
  });

  it('pesquisa e manual', () => {
    expect(estimatedFromResearch({ id: 'pr-1', totalEstimatedValue: '1.5' })).toEqual({
      value: '1.50',
      source: 'PRICE_RESEARCH',
      priceResearchId: 'pr-1',
    });
    expect(manualEstimated('7')).toEqual({
      value: '7.00',
      source: 'MANUAL',
      priceResearchId: null,
    });
  });
});

describe('estimatedValueIntent (TRM-04)', () => {
  const linked = term({
    estimatedTotalValue: '98000.00',
    estimatedValueSource: 'PRICE_RESEARCH',
    priceResearchId: 'pr-1',
  });
  const manual = term({ estimatedTotalValue: '5.00', estimatedValueSource: 'MANUAL' });

  it('sem campos de valor: nada a fazer', () => {
    expect(estimatedValueIntent(linked, {})).toEqual({ ok: true, intent: { kind: 'NONE' } });
  });

  it('origem ETP só pela importação', () => {
    expect(estimatedValueIntent(linked, { estimatedValueSource: 'ETP' })).toMatchObject({
      ok: false,
      error: { field: 'estimatedValueSource', code: 'NOT_ALLOWED' },
    });
  });

  it('pesquisa: indicada, a vinculada ou a do processo; sem valor no corpo', () => {
    expect(estimatedValueIntent(manual, { priceResearchId: 'pr-2' })).toEqual({
      ok: true,
      intent: { kind: 'LINK_RESEARCH', priceResearchId: 'pr-2' },
    });
    expect(estimatedValueIntent(linked, { estimatedValueSource: 'PRICE_RESEARCH' })).toEqual({
      ok: true,
      intent: { kind: 'LINK_RESEARCH', priceResearchId: 'pr-1' },
    });
    expect(estimatedValueIntent(manual, { estimatedValueSource: 'PRICE_RESEARCH' })).toEqual({
      ok: true,
      intent: { kind: 'LINK_RESEARCH', priceResearchId: null },
    });
    expect(
      estimatedValueIntent(manual, { priceResearchId: 'pr-2', estimatedTotalValue: '1.00' }),
    ).toMatchObject({ ok: false, error: { field: 'estimatedTotalValue', code: 'NOT_ALLOWED' } });
    expect(
      estimatedValueIntent(manual, { priceResearchId: 'pr-2', estimatedValueSource: 'MANUAL' }),
    ).toMatchObject({ ok: false, error: { field: 'priceResearchId', code: 'NOT_ALLOWED' } });
  });

  it('manual: o valor enviado ou o manual atual; sem nenhum = CONDITIONAL_REQUIRED', () => {
    expect(
      estimatedValueIntent(linked, { estimatedValueSource: 'MANUAL', estimatedTotalValue: '1' }),
    ).toEqual({ ok: true, intent: { kind: 'MANUAL', value: '1' } });
    expect(estimatedValueIntent(manual, { estimatedValueSource: 'MANUAL' })).toEqual({
      ok: true,
      intent: { kind: 'MANUAL', value: '5.00' },
    });
    expect(estimatedValueIntent(linked, { estimatedValueSource: 'MANUAL' })).toMatchObject({
      ok: false,
      error: { field: 'estimatedTotalValue', code: 'CONDITIONAL_REQUIRED' },
    });
  });

  it('valor sem origem: manual quando não há valor vinculado; somente leitura sobre a pesquisa/ETP', () => {
    expect(estimatedValueIntent(term(), { estimatedTotalValue: '9' })).toEqual({
      ok: true,
      intent: { kind: 'MANUAL', value: '9' },
    });
    expect(estimatedValueIntent(manual, { estimatedTotalValue: '9' })).toEqual({
      ok: true,
      intent: { kind: 'MANUAL', value: '9' },
    });
    for (const current of [
      linked,
      term({ estimatedValueSource: 'ETP', estimatedTotalValue: '1.00' }),
    ]) {
      expect(estimatedValueIntent(current, { estimatedTotalValue: '9' })).toMatchObject({
        ok: false,
        error: { field: 'estimatedTotalValue', code: 'NOT_ALLOWED' },
      });
    }
  });
});

describe('applyTermHeader (TRM-04)', () => {
  const stamp = { actorId: 'u-2', now: LATER };

  it('só os campos que mudaram, com quem e quando', () => {
    const current = term();
    const { term: next, changes } = applyTermHeader(
      current,
      { objectDefinition: 'Novo objeto do TR', estimated: manualEstimated('10') },
      stamp,
    );
    expect(changes).toEqual([
      { field: 'objectDefinition', old: current.objectDefinition, new: 'Novo objeto do TR' },
      { field: 'estimatedTotalValue', old: null, new: '10.00' },
      { field: 'estimatedValueSource', old: null, new: 'MANUAL' },
    ]);
    expect(next).toMatchObject({ updatedAt: LATER, updatedById: 'u-2', version: 1 });
  });

  it('sem mudança devolve o mesmo TR', () => {
    const current = term();
    const result = applyTermHeader(current, { objectDefinition: current.objectDefinition }, stamp);
    expect(result).toEqual({ term: current, changes: [] });
    expect(applyTermHeader(current, {}, stamp).changes).toEqual([]);
  });

  it('trocar a pesquisa pelo manual desvincula a pesquisa', () => {
    const current = term({
      estimatedTotalValue: '98000.00',
      estimatedValueSource: 'PRICE_RESEARCH',
      priceResearchId: 'pr-1',
    });
    const { term: next, changes } = applyTermHeader(
      current,
      { estimated: manualEstimated('100000') },
      stamp,
    );
    expect(next).toMatchObject({ priceResearchId: null, estimatedValueSource: 'MANUAL' });
    expect(changes.map((change) => change.field)).toEqual([
      'estimatedTotalValue',
      'estimatedValueSource',
      'priceResearchId',
    ]);
  });
});

describe('Condições contratuais (US-038 · RN-TR-28..32)', () => {
  it('normalizePercent devolve a forma do numeric(9,4) lido do banco', () => {
    expect(normalizePercent('5')).toBe('5');
    expect(normalizePercent('05.50')).toBe('5.5');
    expect(normalizePercent('10.0000')).toBe('10');
    expect(normalizePercent('0.0001')).toBe('0.0001');
    expect(normalizePercent('0')).toBe('0');
  });

  it('isConditionField separa as condições dos campos do painel "Dados do TR"', () => {
    expect(isConditionField('awardType')).toBe(true);
    expect(isConditionField('contractGuaranteePercent')).toBe(true);
    expect(isConditionField('objectDefinition')).toBe(false);
    expect(isConditionField('estimatedTotalValue')).toBe(false);
  });

  it('mescla o corpo sobre as atuais: ausente mantém, null limpa, texto aparado', () => {
    const current = term({ contractDurationMonths: 12, paymentTermDays: 30 });
    const merged = mergeTermConditions(current, {
      contractDurationMonths: null,
      deliveryLocation: '  Almoxarifado  ',
      contractGuaranteePercent: '5.00',
    });
    expect(merged).toEqual({
      ok: true,
      conditions: expect.objectContaining({
        contractDurationMonths: null,
        paymentTermDays: 30,
        deliveryLocation: 'Almoxarifado',
        contractGuaranteePercent: '5',
      }) as unknown,
    });
    const blank = mergeTermConditions(current, { deliveryLocation: '   ' });
    expect(blank.ok && blank.conditions.deliveryLocation).toBeNull();
  });

  it('RN-TR-29: prazo e tipo de contagem, um exige o outro, sobre o estado resultante', () => {
    expect(mergeTermConditions(term(), { executionDeadline: 30 })).toEqual({
      ok: false,
      error: expect.objectContaining({
        field: 'executionDeadlineType',
        code: 'CONDITIONAL_REQUIRED',
      }) as unknown,
    });
    expect(mergeTermConditions(term(), { executionDeadlineType: 'BUSINESS' })).toEqual({
      ok: false,
      error: expect.objectContaining({ field: 'executionDeadline' }) as unknown,
    });
    const typed = term({ executionDeadline: 10, executionDeadlineType: 'CALENDAR' });
    expect(mergeTermConditions(typed, { executionDeadline: 30 }).ok).toBe(true);
    expect(mergeTermConditions(typed, { executionDeadline: null }).ok).toBe(false);
    expect(
      mergeTermConditions(typed, { executionDeadline: null, executionDeadlineType: null }).ok,
    ).toBe(true);
  });

  it('applyTermHeader devolve só as condições alteradas e carimba o autor', () => {
    const current = term({ awardType: 'GLOBAL' });
    const merged = mergeTermConditions(current, { awardType: 'BY_ITEM', paymentTermDays: 30 });
    if (!merged.ok) throw new Error('esperava ok');
    const result = applyTermHeader(
      current,
      { conditions: merged.conditions },
      { actorId: 'u-2', now: LATER },
    );
    expect(result.changes).toEqual([
      { field: 'paymentTermDays', old: null, new: 30 },
      { field: 'awardType', old: 'GLOBAL', new: 'BY_ITEM' },
    ]);
    expect(result.term).toMatchObject({
      awardType: 'BY_ITEM',
      updatedById: 'u-2',
      updatedAt: LATER,
    });

    const same = applyTermHeader(
      current,
      { conditions: { ...merged.conditions, awardType: 'GLOBAL', paymentTermDays: null } },
      { actorId: 'u-2', now: LATER },
    );
    expect(same.changes).toEqual([]);
    expect(same.term).toBe(current);
  });
});
