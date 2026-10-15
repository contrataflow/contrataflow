import { CATALOG_TYPES } from '@contrataflow/types';
import { describe, expect, it } from 'vitest';

import {
  catalogCodeSchema,
  catalogItemListQuerySchema,
  catalogItemSchema,
  catalogTypeSchema,
  createCatalogItemSchema,
  reorderCatalogItemsSchema,
  updateCatalogItemSchema,
} from './catalog-item.js';
import { CatalogItemChanged } from './events.js';
import { CATALOG_METADATA_TYPES, catalogMetadataSchema } from './metadata.js';

const ID = '0192c000-0000-7000-8000-0000000104a1';
const ID2 = '0192c000-0000-7000-8000-0000000104a2';

describe('catalogCodeSchema (RN-TEN-59)', () => {
  it.each(['PREGAO', 'AQUISICAO_BENS', 'M2', 'SERVICO_CONTINUO_SEM_DEDICACAO', 'A1_B2'])(
    'aceita %s',
    (code) => {
      expect(catalogCodeSchema.safeParse(code).success).toBe(true);
    },
  );

  it.each([
    'servico novo',
    'pregao',
    'Pregao',
    '_INICIO',
    'FIM_',
    'DUPLO__SUBLINHADO',
    '1_NUMERO_PRIMEIRO',
    'COM-HIFEN',
    'ACENTUAÇÃO',
    '',
    'A'.repeat(61),
  ])('rejeita "%s"', (code) => {
    expect(catalogCodeSchema.safeParse(code).success).toBe(false);
  });
});

describe('catalogTypeSchema / metadata por tipo', () => {
  it('os 8 tipos do CatalogType e um schema de metadata para cada', () => {
    expect(CATALOG_TYPES).toHaveLength(8);
    expect(CATALOG_METADATA_TYPES).toEqual(CATALOG_TYPES);
    for (const type of CATALOG_TYPES) {
      expect(catalogTypeSchema.safeParse(type).success).toBe(true);
      expect(catalogMetadataSchema(type).safeParse({ chaveForaDoSchema: 1 }).success).toBe(false);
    }
    expect(catalogTypeSchema.safeParse('OUTRO').success).toBe(false);
  });

  it('ATTACHMENT_CATEGORY só aceita {}', () => {
    expect(catalogMetadataSchema('ATTACHMENT_CATEGORY').safeParse({}).success).toBe(true);
  });

  it('PRICE_SOURCE_TYPE limita campos exigidos e referência de idade', () => {
    const schema = catalogMetadataSchema('PRICE_SOURCE_TYPE');
    expect(
      schema.safeParse({
        legalBasis: 'art. 23',
        requiredFields: ['supplierId', 'quoteDate'],
        maxAgeDays: 180,
        ageReference: 'quoteDate',
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ legalBasis: 'art. 23', requiredFields: [], ageReference: 'hoje' }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ legalBasis: 'art. 23', requiredFields: [], maxAgeDays: 0 }).success,
    ).toBe(false);
  });
});

describe('createCatalogItemSchema (CAT-02)', () => {
  it('aceita o corpo mínimo e normaliza textos', () => {
    const parsed = createCatalogItemSchema.parse({
      code: 'OUTRO_SERVICO',
      label: '  Outro  ',
      description: '  texto  ',
    });
    expect(parsed).toMatchObject({ code: 'OUTRO_SERVICO', label: 'Outro', description: 'texto' });
  });

  it('descarta isSystem/isActive/sortOrder do cliente (não são aceitos na criação)', () => {
    const parsed = createCatalogItemSchema.parse({
      code: 'X',
      label: 'X',
      isSystem: true,
      isActive: false,
      sortOrder: 99,
    });
    expect(parsed).not.toHaveProperty('isSystem');
    expect(parsed).not.toHaveProperty('isActive');
    expect(parsed).not.toHaveProperty('sortOrder');
  });

  it('exige code e label; limita rótulo (150), descrição (1.000) e valida parentId', () => {
    expect(createCatalogItemSchema.safeParse({}).success).toBe(false);
    expect(createCatalogItemSchema.safeParse({ code: 'X', label: 'x'.repeat(151) }).success).toBe(
      false,
    );
    expect(
      createCatalogItemSchema.safeParse({ code: 'X', label: 'X', description: 'y'.repeat(1001) })
        .success,
    ).toBe(false);
    expect(
      createCatalogItemSchema.safeParse({ code: 'X', label: 'X', parentId: 'nao-e-uuid' }).success,
    ).toBe(false);
    expect(createCatalogItemSchema.safeParse({ code: 'X', label: 'X', parentId: ID }).success).toBe(
      true,
    );
  });
});

describe('updateCatalogItemSchema (CAT-03)', () => {
  it('todos os campos são opcionais e description/parentId aceitam null', () => {
    expect(updateCatalogItemSchema.parse({})).toEqual({});
    expect(updateCatalogItemSchema.parse({ description: null, parentId: null })).toEqual({
      description: null,
      parentId: null,
    });
  });

  it('aceita code só para o caso de uso recusá-lo (CATALOG_ITEM_SYSTEM)', () => {
    expect(updateCatalogItemSchema.parse({ code: 'NOVO' })).toEqual({ code: 'NOVO' });
  });

  it('sortOrder inteiro e não negativo', () => {
    expect(updateCatalogItemSchema.safeParse({ sortOrder: -1 }).success).toBe(false);
    expect(updateCatalogItemSchema.safeParse({ sortOrder: 1.5 }).success).toBe(false);
    expect(updateCatalogItemSchema.safeParse({ sortOrder: 3 }).success).toBe(true);
  });
});

describe('reorderCatalogItemsSchema (CAT-06 · RN-TEN-65)', () => {
  it('aceita a lista de IDs sem repetição', () => {
    expect(reorderCatalogItemsSchema.safeParse({ orderedIds: [ID, ID2] }).success).toBe(true);
  });

  it('rejeita lista vazia, repetida ou com ID inválido', () => {
    expect(reorderCatalogItemsSchema.safeParse({ orderedIds: [] }).success).toBe(false);
    const repeated = reorderCatalogItemsSchema.safeParse({ orderedIds: [ID, ID] });
    expect(repeated.success).toBe(false);
    expect(reorderCatalogItemsSchema.safeParse({ orderedIds: ['x'] }).success).toBe(false);
    expect(reorderCatalogItemsSchema.safeParse({}).success).toBe(false);
  });
});

describe('catalogItemListQuerySchema (CAT-01)', () => {
  it('converte isActive e usa página única de até 100 itens por padrão', () => {
    expect(catalogItemListQuerySchema.parse({ isActive: 'true', q: ' pre ' })).toEqual({
      page: 1,
      pageSize: 100,
      isActive: true,
      q: 'pre',
    });
    expect(catalogItemListQuerySchema.safeParse({ isActive: 'talvez' }).success).toBe(false);
    expect(catalogItemListQuerySchema.safeParse({ pageSize: '101' }).success).toBe(false);
  });
});

describe('catalogItemSchema e CatalogItemChanged', () => {
  it('valida o item da resposta', () => {
    const item = {
      id: ID,
      catalogType: 'MODALITY',
      code: 'PREGAO',
      label: 'Pregão',
      description: null,
      isSystem: true,
      isActive: true,
      sortOrder: 1,
      parentId: null,
      metadata: { legalBasis: 'x', isDirectContracting: false },
      createdAt: '2026-10-15T12:00:00.000Z',
      updatedAt: '2026-10-15T12:00:00.000Z',
      version: 1,
    };
    expect(catalogItemSchema.safeParse(item).success).toBe(true);
  });

  it('o evento usa a routing key catalog.item_changed e o payload do events.md §4.5', () => {
    const payload = {
      catalogType: 'MODALITY',
      catalogItemId: ID,
      code: 'PREGAO',
      change: 'CREATED',
    };
    const resolved = CatalogItemChanged.resolve(payload);
    expect(resolved).toMatchObject({
      eventType: 'CatalogItemChanged',
      aggregateType: 'CatalogItem',
      routingKey: 'catalog.item_changed',
      payload,
    });
    expect(() => CatalogItemChanged.resolve({ ...payload, change: 'DELETED' })).toThrow();
    expect(() => CatalogItemChanged.resolve({ ...payload, extra: 1 })).toThrow();
  });
});
