import { CATALOG_TYPES } from '@contrataflow/types';
import { catalogMetadataSchema } from '@contrataflow/validation';
import type { CatalogItemDto } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import {
  METADATA_FIELDS,
  buildCreateBody,
  buildMetadata,
  buildPatch,
  hasNoActiveItems,
  initialValues,
  moveId,
  validateForm,
} from './catalog-model';

const MESSAGES = {
  required: (field: 'code' | 'label') => `Informe o ${field}.`,
  invalidCode: 'Código inválido.',
  tooLong: (_field: 'label' | 'description', max: number) => `Máximo ${String(max)}.`,
  metadata: 'Revise este campo.',
};

function item(overrides: Partial<CatalogItemDto> = {}): CatalogItemDto {
  return {
    id: '0192a000-0000-7000-8000-000000000001',
    catalogType: 'MODALITY',
    code: 'PREGAO',
    label: 'Pregão',
    description: null,
    isSystem: true,
    isActive: true,
    sortOrder: 1,
    parentId: null,
    metadata: { legalBasis: 'Lei 14.133/2021, art. 28, I', isDirectContracting: false },
    createdAt: '2026-10-15T12:00:00.000Z',
    updatedAt: '2026-10-15T12:00:00.000Z',
    version: 3,
    ...overrides,
  };
}

describe('descritores de metadata (entities.md §5.9)', () => {
  it('cada catálogo tem descritores coerentes com o schema Zod do tipo', () => {
    for (const type of CATALOG_TYPES) {
      const schemaKeys = Object.keys(catalogMetadataSchema(type).shape);
      for (const field of METADATA_FIELDS[type]) expect(schemaKeys).toContain(field.name);
    }
  });
});

describe('initialValues / buildMetadata', () => {
  it('item existente: preenche código, rótulo e metadata do tipo', () => {
    const values = initialValues('MODALITY', item());
    expect(values).toMatchObject({ code: 'PREGAO', label: 'Pregão', description: '' });
    expect(values.metadata).toEqual({
      legalBasis: 'Lei 14.133/2021, art. 28, I',
      isDirectContracting: false,
    });
  });

  it('booleano obrigatório vai sempre; opcional só quando marcado; texto vazio some', () => {
    expect(
      buildMetadata('MODALITY', { legalBasis: '  art. 75  ', isDirectContracting: true }),
    ).toEqual({ legalBasis: 'art. 75', isDirectContracting: true });
    expect(buildMetadata('MODALITY', { legalBasis: 'x', isDirectContracting: false })).toEqual({
      legalBasis: 'x',
      isDirectContracting: false,
    });
    expect(buildMetadata('CONTRACTING_TYPE', { itemKinds: ['GOOD'], isContinuous: false })).toEqual(
      {
        itemKinds: ['GOOD'],
      },
    );
    expect(buildMetadata('RISK_CATEGORY', { color: '  ' })).toEqual({});
    expect(buildMetadata('ATTACHMENT_CATEGORY', {})).toEqual({});
  });

  it('número vazio é omitido; preenchido vira número', () => {
    const base = { legalBasis: 'art. 23', requiredFields: [], maxAgeDays: '', ageReference: '' };
    expect(buildMetadata('PRICE_SOURCE_TYPE', base)).toEqual({ legalBasis: 'art. 23' });
    expect(buildMetadata('PRICE_SOURCE_TYPE', { ...base, maxAgeDays: '180' })).toMatchObject({
      maxAgeDays: 180,
    });
  });
});

describe('buildCreateBody / buildPatch', () => {
  it('criação envia code, rótulo aparado, descrição só se informada e a metadata', () => {
    const values = {
      ...initialValues('ATTACHMENT_CATEGORY'),
      code: ' OUTRO_SERVICO ',
      label: ' Outro ',
    };
    expect(buildCreateBody('ATTACHMENT_CATEGORY', values)).toEqual({
      code: 'OUTRO_SERVICO',
      label: 'Outro',
      metadata: {},
    });
  });

  it('edição envia só o que mudou e nunca o code (RN-TEN-59/60)', () => {
    const base = item();
    const unchanged = initialValues('MODALITY', base);
    expect(buildPatch('MODALITY', unchanged, base)).toEqual({});

    const patch = buildPatch(
      'MODALITY',
      { ...unchanged, code: 'OUTRO', label: 'Pregão eletrônico', description: ' Menor preço ' },
      base,
    );
    expect(patch).toEqual({ label: 'Pregão eletrônico', description: 'Menor preço' });
  });

  it('descrição apagada vira null; metadata alterada vai completa', () => {
    const base = item({ description: 'antiga' });
    const values = {
      ...initialValues('MODALITY', base),
      description: '',
      metadata: { legalBasis: 'Nova base', isDirectContracting: true },
    };
    expect(buildPatch('MODALITY', values, base)).toEqual({
      description: null,
      metadata: { legalBasis: 'Nova base', isDirectContracting: true },
    });
  });
});

describe('validateForm (mesmas regras da API)', () => {
  it('criação: código obrigatório, em SCREAMING_SNAKE_CASE, e rótulo obrigatório', () => {
    const empty = validateForm(
      'ATTACHMENT_CATEGORY',
      initialValues('ATTACHMENT_CATEGORY'),
      'create',
      MESSAGES,
    );
    expect(empty).toEqual({ code: 'Informe o code.', label: 'Informe o label.' });

    const invalid = validateForm(
      'ATTACHMENT_CATEGORY',
      { ...initialValues('ATTACHMENT_CATEGORY'), code: 'servico novo', label: 'Novo' },
      'create',
      MESSAGES,
    );
    expect(invalid).toEqual({ code: 'Código inválido.' });
  });

  it('edição não valida o código (somente leitura)', () => {
    expect(
      validateForm(
        'MODALITY',
        initialValues('MODALITY', item({ code: 'qualquer coisa' })),
        'edit',
        MESSAGES,
      ),
    ).toEqual({});
  });

  it('limites de rótulo (150) e descrição (1.000)', () => {
    const errors = validateForm(
      'ATTACHMENT_CATEGORY',
      {
        ...initialValues('ATTACHMENT_CATEGORY'),
        code: 'X',
        label: 'a'.repeat(151),
        description: 'b'.repeat(1001),
      },
      'create',
      MESSAGES,
    );
    expect(errors).toEqual({ label: 'Máximo 150.', description: 'Máximo 1000.' });
  });

  it('metadata pelo schema do tipo: campos obrigatórios e valores inválidos', () => {
    const modality = validateForm(
      'MODALITY',
      { ...initialValues('MODALITY'), code: 'X', label: 'X' },
      'create',
      MESSAGES,
    );
    expect(modality).toEqual({ 'metadata.legalBasis': 'Revise este campo.' });

    const contracting = validateForm(
      'CONTRACTING_TYPE',
      { ...initialValues('CONTRACTING_TYPE'), code: 'X', label: 'X' },
      'create',
      MESSAGES,
    );
    expect(contracting).toEqual({ 'metadata.itemKinds': 'Revise este campo.' });

    const risk = validateForm(
      'RISK_CATEGORY',
      { ...initialValues('RISK_CATEGORY'), code: 'X', label: 'X', metadata: { color: 'vermelho' } },
      'create',
      MESSAGES,
    );
    expect(risk).toEqual({ 'metadata.color': 'Revise este campo.' });

    const valid = validateForm(
      'UNIT_OF_MEASURE',
      {
        ...initialValues('UNIT_OF_MEASURE'),
        code: 'X',
        label: 'X',
        metadata: { abbreviation: 'kg', allowsDecimal: true },
      },
      'create',
      MESSAGES,
    );
    expect(valid).toEqual({});
  });
});

describe('moveId / hasNoActiveItems', () => {
  it('move o item entre posições e ignora índices inválidos', () => {
    expect(moveId(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveId(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'c', 'b']);
    expect(moveId(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'b', 'c']);
    expect(moveId(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(moveId(['a', 'b', 'c'], 0, 3)).toEqual(['a', 'b', 'c']);
  });

  it('FA-04: lista não vazia sem nenhum item ativo', () => {
    expect(hasNoActiveItems([])).toBe(false);
    expect(hasNoActiveItems([item({ isActive: false })])).toBe(true);
    expect(hasNoActiveItems([item({ isActive: false }), item()])).toBe(false);
  });
});
