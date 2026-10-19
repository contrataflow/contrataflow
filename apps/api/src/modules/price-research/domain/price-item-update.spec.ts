import type { PriceResearchParameters } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { calculationParameterChanges, planPriceItemUpdate } from './price-research.js';
import type { PriceItemEditable } from './price-research.js';

/*
 * US-029 — `PriceItem.setMethodOverride` (RN-PRICE-42/43 · V-01/V-02/V-05 · FA-01/FA-02) e os
 * parâmetros de cálculo do PRS-04 (RN-PRICE-47).
 */

const ITEM: PriceItemEditable = {
  quantity: '50.0000',
  methodOverride: null,
  manualUnitPrice: null,
  manualJustification: null,
};
const RULES = { allowsDecimal: true, unitPriceDecimals: 2 as const };
const JUSTIFICATION = 'Valor de ata vigente do consórcio regional';
const codes = (plan: ReturnType<typeof planPriceItemUpdate>) =>
  plan.errors.map((error) => [error.field, error.code]);

describe('planPriceItemUpdate', () => {
  it('FA-01: MANUAL com valor e justificativa normaliza e marca a troca de método', () => {
    const plan = planPriceItemUpdate(
      ITEM,
      {
        methodOverride: 'MANUAL',
        manualUnitPrice: '99.9',
        manualJustification: `  ${JUSTIFICATION} `,
      },
      RULES,
    );
    expect(plan).toMatchObject({
      next: {
        methodOverride: 'MANUAL',
        manualUnitPrice: '99.9000',
        manualJustification: JUSTIFICATION,
      },
      changed: true,
      methodChanged: true,
      errors: [],
    });
  });

  it('V-01: MANUAL sem justificativa (ou curta) e sem valor → CONDITIONAL_REQUIRED', () => {
    expect(codes(planPriceItemUpdate(ITEM, { methodOverride: 'MANUAL' }, RULES))).toEqual([
      ['manualUnitPrice', 'CONDITIONAL_REQUIRED'],
      ['manualJustification', 'CONDITIONAL_REQUIRED'],
    ]);
    const short = planPriceItemUpdate(
      ITEM,
      { methodOverride: 'MANUAL', manualUnitPrice: '10', manualJustification: 'curta' },
      RULES,
    );
    expect(codes(short)).toEqual([['manualJustification', 'CONDITIONAL_REQUIRED']]);
    expect(short).toMatchObject({ next: null, changed: false, methodChanged: false });
  });

  it('V-02: valor ≤ 0 ou com mais casas que unitPriceDecimals → INVALID_DECIMAL com {N}', () => {
    for (const manualUnitPrice of ['0', '0.00', '-1', '10.123', 'abc']) {
      const plan = planPriceItemUpdate(
        ITEM,
        { methodOverride: 'MANUAL', manualUnitPrice, manualJustification: JUSTIFICATION },
        RULES,
      );
      expect(plan.errors).toMatchObject([
        {
          field: 'manualUnitPrice',
          code: 'INVALID_DECIMAL',
          message: 'Informe um valor válido, com até 2 casas decimais.',
        },
      ]);
    }
    expect(
      planPriceItemUpdate(
        ITEM,
        {
          methodOverride: 'MANUAL',
          manualUnitPrice: '10.1234',
          manualJustification: JUSTIFICATION,
        },
        { ...RULES, unitPriceDecimals: 4 },
      ).errors,
    ).toEqual([]);
  });

  it('MANUAL já gravado: campos ausentes no corpo vêm do item (só a justificativa muda)', () => {
    const manual: PriceItemEditable = {
      ...ITEM,
      methodOverride: 'MANUAL',
      manualUnitPrice: '10.0000',
      manualJustification: JUSTIFICATION,
    };
    const plan = planPriceItemUpdate(
      manual,
      { manualJustification: `${JUSTIFICATION} (revisada)` },
      RULES,
    );
    expect(plan).toMatchObject({ changed: true, methodChanged: false });
    expect(plan.next?.manualUnitPrice).toBe('10.0000');
  });

  it('FA-02: limpar o método apaga valor e justificativa manuais', () => {
    const manual: PriceItemEditable = {
      ...ITEM,
      methodOverride: 'MANUAL',
      manualUnitPrice: '10.0000',
      manualJustification: JUSTIFICATION,
    };
    expect(planPriceItemUpdate(manual, { methodOverride: null }, RULES)).toMatchObject({
      next: { methodOverride: null, manualUnitPrice: null, manualJustification: null },
      changed: true,
      methodChanged: true,
    });
  });

  it('[Duplicidade]: reenviar o mesmo método não muda nada', () => {
    const mean: PriceItemEditable = { ...ITEM, methodOverride: 'MEAN' };
    expect(planPriceItemUpdate(mean, { methodOverride: 'MEAN' }, RULES)).toMatchObject({
      changed: false,
      methodChanged: false,
      errors: [],
    });
    expect(planPriceItemUpdate(mean, { quantity: '50' }, RULES).changed).toBe(false);
  });

  it('V-05: quantidade ≤ 0 → OUT_OF_RANGE; fracionária em unidade inteira → INVALID_DECIMAL', () => {
    expect(planPriceItemUpdate(ITEM, { quantity: '0' }, RULES).errors).toMatchObject([
      {
        field: 'quantity',
        code: 'OUT_OF_RANGE',
        message: 'Informe uma quantidade maior que zero.',
      },
    ]);
    expect(
      codes(planPriceItemUpdate(ITEM, { quantity: '1.5' }, { ...RULES, allowsDecimal: false })),
    ).toEqual([['quantity', 'INVALID_DECIMAL']]);
    expect(planPriceItemUpdate(ITEM, { quantity: '75.5' }, RULES)).toMatchObject({
      next: { quantity: '75.5000' },
      changed: true,
      methodChanged: false,
    });
  });
});

describe('calculationParameterChanges (RN-PRICE-47)', () => {
  const current: PriceResearchParameters = {
    defaultMethod: 'AUTO_CV',
    cvThresholdPercent: '25.0000',
    minQuotations: 3,
    directQuoteMaxAgeDays: 180,
    similarContractMaxAgeDays: 365,
    outlierLowerPercent: '70.0000',
    outlierUpperPercent: '130.0000',
    unitPriceDecimals: 2,
    roundingMode: 'HALF_UP',
  };

  it('só os alterados de fato; percentuais normalizados a 4 casas', () => {
    const result = calculationParameterChanges(current, {
      cvThresholdPercent: '25',
      defaultMethod: 'MEDIAN',
      outlierLowerPercent: '60.5',
      outlierUpperPercent: '130',
      unitPriceDecimals: 4,
    });
    expect(result.changed).toEqual(['defaultMethod', 'outlierLowerPercent', 'unitPriceDecimals']);
    expect(result.parameters).toEqual({
      ...current,
      defaultMethod: 'MEDIAN',
      outlierLowerPercent: '60.5000',
      unitPriceDecimals: 4,
    });
  });

  it('sem parâmetros no corpo: nada muda', () => {
    expect(calculationParameterChanges(current, {})).toEqual({ parameters: current, changed: [] });
  });
});
