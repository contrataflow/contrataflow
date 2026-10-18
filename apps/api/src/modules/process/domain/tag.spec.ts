import { describe, expect, it } from 'vitest';

import {
  applyTagPatch,
  diffTagSets,
  isTagNameTaken,
  newTag,
  tagSetErrors,
  tagUpdateAction,
} from './tag.js';
import type { Tag } from './tag.js';

const AT = new Date('2026-10-05T12:00:00.000Z');
const LATER = new Date('2026-10-06T12:00:00.000Z');
const USER = '0192d007-0000-7000-8000-0000000000c1';
const TENANT = '0192d007-0000-7000-8000-0000000000e1';

const id = (n: number) => `0192d007-0000-7000-8000-${String(n).padStart(12, '0')}`;

const tag = (overrides: Partial<Tag> = {}): Tag => ({
  id: id(1),
  tenantId: TENANT,
  name: 'Obras emergenciais',
  color: '#B45309',
  isActive: true,
  createdAt: AT,
  updatedAt: AT,
  createdById: USER,
  updatedById: USER,
  version: 2,
  ...overrides,
});

describe('newTag (RN-PROC-85)', () => {
  it('nasce ativa, na versão 1, com a cor padrão quando não informada', () => {
    expect(
      newTag({ id: id(1), tenantId: TENANT, name: 'Gabinete', now: AT, userId: USER }),
    ).toEqual({
      id: id(1),
      tenantId: TENANT,
      name: 'Gabinete',
      color: '#64748B',
      isActive: true,
      createdAt: AT,
      updatedAt: AT,
      createdById: USER,
      updatedById: USER,
      version: 1,
    });
  });

  it('usa a cor informada', () => {
    const created = newTag({
      id: id(1),
      tenantId: TENANT,
      name: 'Gabinete',
      color: '#0F766E',
      now: AT,
      userId: null,
    });
    expect(created.color).toBe('#0F766E');
    expect(created.createdById).toBeNull();
  });
});

describe('applyTagPatch (RN-PROC-90 · TAG-03)', () => {
  const context = { now: LATER, userId: USER };

  it('PATCH sem diferença devolve a etiqueta atual, sem alterações', () => {
    const current = tag();
    const result = applyTagPatch(current, { name: current.name, isActive: true }, context);
    expect(result.changes).toEqual([]);
    expect(result.tag).toBe(current);
  });

  it('registra só os campos que mudaram, na ordem canônica', () => {
    const result = applyTagPatch(
      tag(),
      { isActive: false, name: 'Obras', color: '#B45309' },
      context,
    );
    expect(result.changes).toEqual([
      { path: 'name', old: 'Obras emergenciais', new: 'Obras' },
      { path: 'isActive', old: true, new: false },
    ]);
    expect(result.tag).toMatchObject({
      name: 'Obras',
      isActive: false,
      color: '#B45309',
      updatedAt: LATER,
      updatedById: USER,
      version: 2,
    });
  });

  it('trocar só a caixa do nome é uma alteração', () => {
    expect(applyTagPatch(tag(), { name: 'obras emergenciais' }, context).changes).toHaveLength(1);
  });

  it('desativar audita tag.deactivate; recolorir e reativar, tag.update', () => {
    const off = applyTagPatch(tag(), { isActive: false }, context).changes;
    expect(tagUpdateAction(off)).toBe('tag.deactivate');
    const on = applyTagPatch(tag({ isActive: false }), { isActive: true }, context).changes;
    expect(tagUpdateAction(on)).toBe('tag.update');
    expect(tagUpdateAction(applyTagPatch(tag(), { color: '#0F766E' }, context).changes)).toBe(
      'tag.update',
    );
  });
});

describe('isTagNameTaken (RN-PROC-85)', () => {
  it('compara sem diferenciar maiúsculas e ignora a própria etiqueta', () => {
    const tags = [tag()];
    expect(isTagNameTaken(tags, 'obras EMERGENCIAIS')).toBe(true);
    expect(isTagNameTaken(tags, ' Obras emergenciais ', id(1))).toBe(false);
    expect(isTagNameTaken(tags, 'Recurso federal')).toBe(false);
  });
});

describe('diffTagSets (RN-PROC-89)', () => {
  it('devolve as inserções e as remoções', () => {
    expect(diffTagSets([id(1), id(2)], [id(2), id(3)])).toEqual({
      added: [id(3)],
      removed: [id(1)],
    });
  });

  it('conjunto idêntico (mesmo em outra ordem) não tem diferença', () => {
    expect(diffTagSets([id(1), id(2)], [id(2), id(1)])).toEqual({ added: [], removed: [] });
  });
});

describe('tagSetErrors (RN-PROC-88)', () => {
  const active = tag({ id: id(1) });
  const inactive = tag({ id: id(2), name: 'Antiga', isActive: false });

  it('conjunto válido, inclusive vazio', () => {
    expect(tagSetErrors([], [], new Set())).toEqual([]);
    expect(tagSetErrors([id(1)], [active], new Set())).toEqual([]);
  });

  it('inativa já aplicada é aceita; inativa nova é REFERENCE_INACTIVE', () => {
    expect(tagSetErrors([id(2)], [inactive], new Set([id(2)]))).toEqual([]);
    expect(tagSetErrors([id(2)], [inactive], new Set()).map((error) => error.code)).toEqual([
      'REFERENCE_INACTIVE',
    ]);
  });

  it('id desconhecido (inexistente ou de outro tenant) é REFERENCE_NOT_FOUND em tagIds', () => {
    expect(tagSetErrors([id(1), id(9)], [active], new Set())).toEqual([
      expect.objectContaining({ field: 'tagIds', code: 'REFERENCE_NOT_FOUND' }),
    ]);
  });

  it('mais de 10 e repetidas', () => {
    const many = Array.from({ length: 11 }, (_, index) => id(index + 1));
    expect(tagSetErrors(many, [], new Set()).map((error) => error.code)).toEqual([
      'OUT_OF_RANGE',
      'REFERENCE_NOT_FOUND',
    ]);
    expect(tagSetErrors([id(1), id(1)], [active], new Set()).map((error) => error.code)).toEqual([
      'DUPLICATE_IN_LIST',
    ]);
  });
});
