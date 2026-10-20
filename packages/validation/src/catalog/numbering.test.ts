import { describe, expect, it } from 'vitest';

import { numberingPreviewSchema } from './numbering.js';
import {
  DOCUMENT_SETTING_MASK_RULES,
  maskHasOrganization,
  numberingMaskProblem,
  PROCESS_MASK_RULES,
  renderNumberingMask,
} from '../document/numbering-mask.js';
import {
  documentMaskSettingKey,
  SETTING_DOCUMENT_MASK_KEY,
  settingSchemaOf,
} from '../tenancy/settings.js';

describe('máscaras das chaves numbering.* (RN-TEN-67)', () => {
  it.each(['{seq:4}/{year}', '{org}-{seq:5}/{year}', 'P{seq:1}-{year}', '{seq:6}/{year}'])(
    'processo aceita %s',
    (mask) => {
      expect(numberingMaskProblem(mask, PROCESS_MASK_RULES)).toBeNull();
    },
  );

  it.each([
    ['{seq:4}', 'MISSING_YEAR'],
    ['{year}', 'MISSING_SEQ'],
    ['{seq}/{year}', 'UNKNOWN_TOKEN'],
    ['{seq:7}/{year}', 'UNKNOWN_TOKEN'],
    ['{seq:0}/{year}', 'UNKNOWN_TOKEN'],
    ['{seq:4}/{year}/{mes}', 'UNKNOWN_TOKEN'],
    ['{type} {seq:4}/{year}', 'TYPE_NOT_ALLOWED'],
    ['{seq:4}/{year', 'STRAY_BRACE'],
  ])('processo recusa %s (%s)', (mask, problem) => {
    expect(numberingMaskProblem(mask, PROCESS_MASK_RULES)).toBe(problem);
  });

  it('documento aceita {type} e recusa {seq:N} acima de 6', () => {
    expect(numberingMaskProblem('{type} {seq:4}/{year}', DOCUMENT_SETTING_MASK_RULES)).toBeNull();
    expect(numberingMaskProblem('MR {seq:4}/{year}', DOCUMENT_SETTING_MASK_RULES)).toBeNull();
    expect(numberingMaskProblem('{type} {seq:8}/{year}', DOCUMENT_SETTING_MASK_RULES)).toBe(
      'UNKNOWN_TOKEN',
    );
    // O tipo de documento (US-061) continua aceitando até 8 dígitos.
    expect(numberingMaskProblem('{type} {seq:8}/{year}')).toBeNull();
  });

  it('formata processo, órgão e documento', () => {
    expect(renderNumberingMask({ mask: '{seq:4}/{year}', sequence: 12, year: 2026 })).toBe(
      '0012/2026',
    );
    expect(
      renderNumberingMask({
        mask: '{org}-{seq:5}/{year}',
        sequence: 7,
        year: 2026,
        organization: 'SEMED',
      }),
    ).toBe('SEMED-00007/2026');
    expect(
      renderNumberingMask({
        mask: '{type} {seq:4}/{year}',
        typeCode: 'DFD',
        sequence: 5,
        year: 2026,
      }),
    ).toBe('DFD 0005/2026');
    // Número maior que a largura não é truncado.
    expect(renderNumberingMask({ mask: '{seq:2}/{year}', sequence: 123, year: 2026 })).toBe(
      '123/2026',
    );
    expect(maskHasOrganization('{org}-{seq:4}/{year}')).toBe(true);
    expect(maskHasOrganization('{seq:4}/{year}')).toBe(false);
  });

  it('schemas do registro: processo sem {type}, documento com {type}, chave dinâmica por tipo', () => {
    expect(settingSchemaOf('numbering.process.mask')?.safeParse('{seq:4}/{year}').success).toBe(
      true,
    );
    expect(
      settingSchemaOf('numbering.process.mask')?.safeParse('{type}-{seq:4}/{year}').success,
    ).toBe(false);
    expect(
      settingSchemaOf('numbering.document.defaultMask')?.safeParse('{type} {seq:4}/{year}').success,
    ).toBe(true);
    const key = documentMaskSettingKey('RISK_MAP');
    expect(key).toBe('numbering.document.RISK_MAP.mask');
    expect(SETTING_DOCUMENT_MASK_KEY.test(key)).toBe(true);
    expect(settingSchemaOf(key)?.safeParse('MR {seq:4}/{year}').success).toBe(true);
    expect(settingSchemaOf(key)?.safeParse('MR {seq:4}').success).toBe(false);
    expect(SETTING_DOCUMENT_MASK_KEY.test('numbering.document.risk.mask')).toBe(false);
    expect(SETTING_DOCUMENT_MASK_KEY.test('numberingXdocumentXRISK_MAPXmask')).toBe(false);
    expect(settingSchemaOf('numbering.document.X.mask')).toBeNull();
  });
});

describe('numberingPreviewSchema (SET-04)', () => {
  it('aceita máscara com escopo opcional e código de tipo', () => {
    expect(numberingPreviewSchema.parse({ mask: '{seq:4}/{year}' })).toEqual({
      mask: '{seq:4}/{year}',
    });
    expect(
      numberingPreviewSchema.safeParse({
        mask: '{type} {seq:4}/{year}',
        scope: 'ORGANIZATION',
        documentTypeCode: 'DFD',
      }).success,
    ).toBe(true);
  });

  it.each([
    { mask: 1 },
    { mask: '{seq:4}/{year}', scope: 'UNIDADE' },
    { mask: '{seq:4}/{year}', documentTypeCode: 'dfd' },
    { mask: '{seq:4}/{year}', extra: true },
    { mask: 'x'.repeat(201) },
  ])('recusa %j', (body) => {
    expect(numberingPreviewSchema.safeParse(body).success).toBe(false);
  });
});
