import type { CatalogType } from '@contrataflow/types';
import { describe, expect, it } from 'vitest';

import {
  CatalogCodeImmutableError,
  CatalogItemSystemError,
  CatalogMetadataInvalidError,
  CatalogOrderInvalidError,
  createCatalogItem,
  createsParentCycle,
  parseCatalogMetadata,
  planReorder,
  setCatalogItemActive,
  updateCatalogItem,
} from './catalog-item.js';
import type { CatalogItem } from './catalog-item.js';

const TENANT = '0192c000-0000-7000-8000-0000000104a1';
const NOW = new Date('2026-10-15T12:00:00.000Z');
const LATER = new Date('2026-10-15T13:00:00.000Z');
const USER = '0192c000-0000-7000-8000-0000000104b1';

function item(overrides: Partial<CatalogItem> = {}): CatalogItem {
  return {
    id: '0192c000-0000-7000-8000-000000010401',
    tenantId: TENANT,
    catalogType: 'MODALITY',
    code: 'PREGAO',
    label: 'Pregão',
    description: null,
    isSystem: true,
    isActive: true,
    sortOrder: 1,
    parentId: null,
    metadata: { legalBasis: 'Lei 14.133/2021, art. 28, I', isDirectContracting: false },
    createdAt: NOW,
    updatedAt: NOW,
    createdById: null,
    updatedById: null,
    version: 3,
    ...overrides,
  };
}

const ctx = { now: LATER, userId: USER };

describe('parseCatalogMetadata (RN-TEN-62 — entities.md §5.9)', () => {
  const valid: readonly (readonly [CatalogType, unknown])[] = [
    ['MODALITY', { legalBasis: 'art. 28, I', isDirectContracting: false }],
    ['CONTRACTING_TYPE', { itemKinds: ['GOOD', 'SERVICE'], isContinuous: true }],
    [
      'PRICE_SOURCE_TYPE',
      {
        legalBasis: 'art. 23',
        requiredFields: ['url'],
        maxAgeDays: 180,
        ageReference: 'quoteDate',
      },
    ],
    ['UNIT_OF_MEASURE', { abbreviation: 'kg', allowsDecimal: true }],
    ['RISK_CATEGORY', { color: '#AA00FF' }],
    ['RISK_CATEGORY', {}],
    ['JUDGMENT_CRITERION', { legalBasis: 'art. 33, I' }],
    ['PROCESS_ORIGIN', { requiresPcaStatus: 'PLANNED' }],
    ['PROCESS_ORIGIN', {}],
    ['ATTACHMENT_CATEGORY', {}],
  ];

  it.each(valid)('%s aceita %j', (type, metadata) => {
    expect(parseCatalogMetadata(type, metadata)).toEqual(metadata);
  });

  it('omitida vira {} (válida só nos tipos sem campo obrigatório)', () => {
    expect(parseCatalogMetadata('ATTACHMENT_CATEGORY', undefined)).toEqual({});
    expect(() => parseCatalogMetadata('MODALITY', undefined)).toThrow(CatalogMetadataInvalidError);
  });

  it('rejeita chave fora do schema do tipo com NOT_ALLOWED em metadata.<chave>', () => {
    try {
      parseCatalogMetadata('ATTACHMENT_CATEGORY', { extra: 1 });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CatalogMetadataInvalidError);
      expect((error as CatalogMetadataInvalidError).errors).toEqual([
        expect.objectContaining({ field: 'metadata.extra', code: 'NOT_ALLOWED' }),
      ]);
    }
  });

  it.each<readonly [CatalogType, unknown]>([
    ['MODALITY', { legalBasis: 'x' }],
    ['MODALITY', { legalBasis: 'x', isDirectContracting: 'sim' }],
    ['CONTRACTING_TYPE', { itemKinds: [] }],
    ['CONTRACTING_TYPE', { itemKinds: ['SPACESHIP'] }],
    ['PRICE_SOURCE_TYPE', { legalBasis: 'x', requiredFields: ['nope'] }],
    ['UNIT_OF_MEASURE', { abbreviation: '', allowsDecimal: true }],
    ['RISK_CATEGORY', { color: 'vermelho' }],
    ['PROCESS_ORIGIN', { requiresPcaStatus: 'MAYBE' }],
  ])('%s rejeita %j', (type, metadata) => {
    expect(() => parseCatalogMetadata(type, metadata)).toThrow(CatalogMetadataInvalidError);
  });
});

describe('createCatalogItem (RN-TEN-59/60)', () => {
  it('cria item não-sistema, ativo, na versão 1 e no fim da lista', () => {
    const created = createCatalogItem(
      { code: 'OUTRO_SERVICO', label: 'Outro', description: '  texto  ', metadata: {} },
      {
        id: 'id-1',
        tenantId: TENANT,
        catalogType: 'ATTACHMENT_CATEGORY',
        now: NOW,
        userId: USER,
        sortOrder: 11,
      },
    );
    expect(created).toMatchObject({
      code: 'OUTRO_SERVICO',
      isSystem: false,
      isActive: true,
      sortOrder: 11,
      description: 'texto',
      parentId: null,
      version: 1,
      createdById: USER,
    });
  });

  it('valida a metadata pelo tipo do catálogo da rota', () => {
    expect(() =>
      createCatalogItem(
        { code: 'X', label: 'X' },
        {
          id: 'id',
          tenantId: TENANT,
          catalogType: 'MODALITY',
          now: NOW,
          userId: null,
          sortOrder: 1,
        },
      ),
    ).toThrow(CatalogMetadataInvalidError);
  });
});

describe('updateCatalogItem (RN-TEN-59/60/62)', () => {
  it('item de sistema: edita rótulo, descrição, ordem e metadata (só o que mudou entra)', () => {
    const result = updateCatalogItem(
      item(),
      {
        label: 'Pregão eletrônico',
        description: 'Modalidade comum',
        sortOrder: 5,
        metadata: { legalBasis: 'Lei 14.133/2021, art. 28, I', isDirectContracting: false },
      },
      ctx,
    );
    expect(result.changes.map((change) => change.path)).toEqual([
      'label',
      'description',
      'sortOrder',
    ]);
    expect(result.next).toMatchObject({
      label: 'Pregão eletrônico',
      sortOrder: 5,
      updatedById: USER,
      code: 'PREGAO',
      isSystem: true,
    });
  });

  it('alterar o code de item de sistema → CatalogItemSystemError (FA-01)', () => {
    expect(() => updateCatalogItem(item(), { code: 'OUTRO' }, ctx)).toThrow(CatalogItemSystemError);
  });

  it('alterar o code de item comum → CatalogCodeImmutableError (RN-TEN-59)', () => {
    expect(() => updateCatalogItem(item({ isSystem: false }), { code: 'OUTRO' }, ctx)).toThrow(
      CatalogCodeImmutableError,
    );
  });

  it('code igual ao atual é ignorado', () => {
    expect(updateCatalogItem(item(), { code: 'PREGAO' }, ctx).changes).toEqual([]);
  });

  it('nada alterado → sem mudanças (sem nova versão)', () => {
    const current = item();
    const result = updateCatalogItem(current, { label: 'Pregão', sortOrder: 1 }, ctx);
    expect(result.changes).toEqual([]);
    expect(result.next).toBe(current);
  });

  it('metadata fora do schema → CatalogMetadataInvalidError', () => {
    expect(() => updateCatalogItem(item(), { metadata: { legalBasis: 'x' } }, ctx)).toThrow(
      CatalogMetadataInvalidError,
    );
  });

  it('descrição vazia limpa o campo; parentId novo é marcado para validar', () => {
    const result = updateCatalogItem(
      item({ description: 'antiga' }),
      { description: '   ', parentId: '0192c000-0000-7000-8000-000000010402' },
      ctx,
    );
    expect(result.next.description).toBeNull();
    expect(result.parentToValidate).toBe('0192c000-0000-7000-8000-000000010402');
  });
});

describe('setCatalogItemActive (RN-TEN-61)', () => {
  it('desativa e reativa; já no estado pedido → null', () => {
    const inactive = setCatalogItemActive(item(), false, ctx);
    expect(inactive).toMatchObject({ isActive: false, updatedById: USER, code: 'PREGAO' });
    expect(setCatalogItemActive(item({ isActive: false }), false, ctx)).toBeNull();
    expect(setCatalogItemActive(item(), true, ctx)).toBeNull();
    expect(setCatalogItemActive(item({ isActive: false }), true, ctx)).toMatchObject({
      isActive: true,
    });
  });
});

describe('createsParentCycle (RN-TEN-63)', () => {
  const parents: Record<string, string | null> = { a: null, b: 'a', c: 'b' };
  const parentOf = (id: string) => Promise.resolve(parents[id] ?? null);

  it('detecta o próprio item e ancestrais na cadeia do pai', async () => {
    expect(await createsParentCycle('a', 'a', parentOf)).toBe(true);
    expect(await createsParentCycle('a', 'c', parentOf)).toBe(true);
  });

  it('aceita pai que não descende do item', async () => {
    expect(await createsParentCycle('c', 'a', parentOf)).toBe(false);
    expect(await createsParentCycle('z', 'c', parentOf)).toBe(false);
  });
});

describe('planReorder (RN-TEN-65)', () => {
  const items = ['a', 'b', 'c'].map((code, index) =>
    item({ id: `id-${code}`, code: code.toUpperCase(), sortOrder: index + 1 }),
  );

  it('recalcula sortOrder sequencial e devolve só os itens que mudaram', () => {
    const plan = planReorder(items, ['id-c', 'id-a', 'id-b']);
    expect(plan.ordered.map((entry) => entry.id)).toEqual(['id-c', 'id-a', 'id-b']);
    expect(plan.moves.map((move) => [move.item.id, move.sortOrder])).toEqual([
      ['id-c', 1],
      ['id-a', 2],
      ['id-b', 3],
    ]);
  });

  it('mesma ordem → nenhuma mudança', () => {
    expect(planReorder(items, ['id-a', 'id-b', 'id-c']).moves).toEqual([]);
  });

  it('normaliza ordens esparsas (10, 20, 30 → 1, 2, 3)', () => {
    const sparse = items.map((entry, index) => ({ ...entry, sortOrder: (index + 1) * 10 }));
    expect(planReorder(sparse, ['id-a', 'id-b', 'id-c']).moves).toHaveLength(3);
  });

  it('ID de fora do catálogo bloqueia a operação inteira', () => {
    expect(() => planReorder(items, ['id-a', 'id-b', 'id-c', 'id-x'])).toThrow(
      CatalogOrderInvalidError,
    );
    try {
      planReorder(items, ['id-a', 'id-x', 'id-c']);
    } catch (error) {
      expect((error as CatalogOrderInvalidError).reason).toBe('UNKNOWN_ID');
    }
  });

  it('lista incompleta é recusada', () => {
    try {
      planReorder(items, ['id-a', 'id-b']);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CatalogOrderInvalidError);
      expect((error as CatalogOrderInvalidError).reason).toBe('INCOMPLETE');
      expect((error as CatalogOrderInvalidError).ids).toEqual(['id-c']);
    }
  });
});
