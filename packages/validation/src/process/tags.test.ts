import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TAG_COLOR,
  TAG_PALETTE,
  createTagSchema,
  setProcessTagsSchema,
  tagNameKey,
  tagSetIssues,
  updateTagSchema,
} from './tags.js';

const ID_A = '0192f000-0000-7000-8000-0000000000a1';
const ID_B = '0192f000-0000-7000-8000-0000000000a2';

const issuesOf = (result: {
  success: boolean;
  error?: { issues: readonly { path: PropertyKey[]; message: string; params?: unknown }[] };
}) => (result.error?.issues ?? []).map((issue) => issue.path.join('.'));

/** Luminância relativa (WCAG 2.x) de `#RRGGBB`. */
function luminance(hex: string): number {
  const channel = (offset: number) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

describe('paleta de etiquetas (RN-PROC-85)', () => {
  it('toda cor tem contraste AA (≥ 4,5:1) com o texto branco do chip', () => {
    for (const color of TAG_PALETTE) {
      expect(1.05 / (luminance(color) + 0.05), color).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('inclui a cor padrão e não repete cores', () => {
    expect(TAG_PALETTE).toContain(DEFAULT_TAG_COLOR);
    expect(new Set(TAG_PALETTE).size).toBe(TAG_PALETTE.length);
  });
});

describe('createTagSchema (TAG-02)', () => {
  it('apara o nome e normaliza a cor para maiúsculas', () => {
    expect(createTagSchema.parse({ name: '  Obras emergenciais ', color: '#b45309' })).toEqual({
      name: 'Obras emergenciais',
      color: '#B45309',
    });
  });

  it('a cor é opcional (o padrão é da API)', () => {
    expect(createTagSchema.parse({ name: 'Gabinete' })).toEqual({ name: 'Gabinete' });
  });

  it('V-01: nome curto, longo ou ausente', () => {
    expect(issuesOf(createTagSchema.safeParse({ name: ' a ' }))).toEqual(['name']);
    expect(issuesOf(createTagSchema.safeParse({ name: 'x'.repeat(41) }))).toEqual(['name']);
    expect(issuesOf(createTagSchema.safeParse({}))).toEqual(['name']);
    expect(createTagSchema.safeParse({ name: 'x'.repeat(40) }).success).toBe(true);
  });

  it('V-02: cor fora do formato ou da paleta', () => {
    const outside = createTagSchema.safeParse({ name: 'Gabinete', color: '#FFFF00' });
    expect(outside.error?.issues[0]).toMatchObject({
      path: ['color'],
      params: { code: 'INVALID_ENUM' },
    });
    const format = createTagSchema.safeParse({ name: 'Gabinete', color: 'azul' });
    expect(format.error?.issues[0]).toMatchObject({
      path: ['color'],
      params: { code: 'INVALID_FORMAT' },
    });
  });

  it('é estrito: campo desconhecido é rejeitado', () => {
    expect(createTagSchema.safeParse({ name: 'Gabinete', isActive: false }).success).toBe(false);
  });
});

describe('updateTagSchema (TAG-03)', () => {
  it('aceita qualquer subconjunto e o corpo vazio', () => {
    expect(updateTagSchema.parse({})).toEqual({});
    expect(updateTagSchema.parse({ isActive: false, color: '#0f766e' })).toEqual({
      isActive: false,
      color: '#0F766E',
    });
  });

  it('valida nome e cor quando informados', () => {
    expect(issuesOf(updateTagSchema.safeParse({ name: 'a', color: '#123456' }))).toEqual([
      'name',
      'color',
    ]);
  });
});

describe('tagSetIssues / setProcessTagsSchema (RN-PROC-88 · PRC-18)', () => {
  const ids = (count: number) =>
    Array.from(
      { length: count },
      (_, index) => `0192f000-0000-7000-8000-${String(index).padStart(12, '0')}`,
    );

  it('aceita o conjunto vazio e até 10 etiquetas distintas', () => {
    expect(setProcessTagsSchema.parse({ tagIds: [] })).toEqual({ tagIds: [] });
    expect(setProcessTagsSchema.safeParse({ tagIds: ids(10) }).success).toBe(true);
  });

  it('V-04: 11 etiquetas = OUT_OF_RANGE em tagIds', () => {
    const result = setProcessTagsSchema.safeParse({ tagIds: ids(11) });
    expect(result.error?.issues[0]).toMatchObject({
      path: ['tagIds'],
      params: { code: 'OUT_OF_RANGE' },
    });
  });

  it('V-05: repetida = DUPLICATE_IN_LIST', () => {
    const result = setProcessTagsSchema.safeParse({ tagIds: [ID_A, ID_B, ID_A] });
    expect(result.error?.issues[0]).toMatchObject({ params: { code: 'DUPLICATE_IN_LIST' } });
    expect(tagSetIssues([ID_A, ID_A]).map((issue) => issue.code)).toEqual(['DUPLICATE_IN_LIST']);
  });

  it('rejeita id malformado e campo desconhecido', () => {
    expect(setProcessTagsSchema.safeParse({ tagIds: ['x'] }).success).toBe(false);
    expect(setProcessTagsSchema.safeParse({ tagIds: [], extra: 1 }).success).toBe(false);
  });
});

describe('tagNameKey', () => {
  it('ignora maiúsculas e espaços nas pontas (lower(name))', () => {
    expect(tagNameKey(' obras EMERGENCIAIS ')).toBe(tagNameKey('Obras emergenciais'));
  });
});
