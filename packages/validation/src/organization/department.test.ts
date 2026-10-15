import { describe, expect, it } from 'vitest';

import {
  createDepartmentSchema,
  departmentListQuerySchema,
  departmentLookupQuerySchema,
  moveDepartmentSchema,
  updateDepartmentSchema,
} from './department.js';
import { DepartmentCreated, DepartmentMoved, DepartmentUpdated } from './events.js';

const ORG = '0192a000-0000-7000-8000-0000000100a1';
const HEAD = '0192a000-0000-7000-8000-0000000000a4';
const DEPUTY = '0192a000-0000-7000-8000-0000000000a5';

const valid = { organizationId: ORG, type: 'SECRETARIAT', name: 'Secretaria de Obras' };

function issuesOf(result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) {
  return (result.error?.issues ?? []).map((issue) => issue.path.join('.'));
}

describe('createDepartmentSchema (DEP-03 · RN-TEN-44..48)', () => {
  it('normaliza nome, sigla (maiúsculas) e e-mail; descarta path/depth/isActive do cliente', () => {
    const parsed = createDepartmentSchema.parse({
      ...valid,
      name: '  Secretaria de Obras  ',
      acronym: ' sob ',
      email: ' Obras@SJ.SC.gov.br ',
      path: '/x/',
      depth: 3,
      isActive: false,
    });
    expect(parsed).toEqual({
      organizationId: ORG,
      type: 'SECRETARIAT',
      name: 'Secretaria de Obras',
      acronym: 'SOB',
      email: 'obras@sj.sc.gov.br',
    });
  });

  it('obrigatórios, limites e enum', () => {
    expect(issuesOf(createDepartmentSchema.safeParse({}))).toEqual(
      expect.arrayContaining(['organizationId', 'type', 'name']),
    );
    expect(issuesOf(createDepartmentSchema.safeParse({ ...valid, name: 'AB' }))).toEqual(['name']);
    expect(issuesOf(createDepartmentSchema.safeParse({ ...valid, type: 'GABINETE' }))).toEqual([
      'type',
    ]);
    expect(
      issuesOf(
        createDepartmentSchema.safeParse({
          ...valid,
          acronym: 'A'.repeat(31),
          code: 'C'.repeat(41),
          phone: '9'.repeat(21),
          email: 'sem-arroba',
          sortOrder: -1,
          parentId: 'x',
        }),
      ).sort(),
    ).toEqual(['acronym', 'code', 'email', 'parentId', 'phone', 'sortOrder']);
  });

  it('V-07: titular e substituto iguais → erro em deputyUserId; diferentes, aceitos', () => {
    const same = createDepartmentSchema.safeParse({
      ...valid,
      headUserId: HEAD,
      deputyUserId: HEAD,
    });
    expect(issuesOf(same)).toEqual(['deputyUserId']);
    expect(
      createDepartmentSchema.safeParse({ ...valid, headUserId: HEAD, deputyUserId: DEPUTY })
        .success,
    ).toBe(true);
  });
});

describe('updateDepartmentSchema / moveDepartmentSchema (DEP-05/06)', () => {
  it('tudo opcional; null limpa os opcionais; titular = substituto barrado', () => {
    expect(updateDepartmentSchema.parse({})).toEqual({});
    expect(updateDepartmentSchema.parse({ acronym: null, headUserId: null })).toEqual({
      acronym: null,
      headUserId: null,
    });
    expect(
      issuesOf(updateDepartmentSchema.safeParse({ headUserId: HEAD, deputyUserId: HEAD })),
    ).toEqual(['deputyUserId']);
  });

  it('mover: parentId ausente ou nulo = raiz', () => {
    expect(moveDepartmentSchema.parse({})).toEqual({});
    expect(moveDepartmentSchema.parse({ parentId: null })).toEqual({ parentId: null });
    expect(moveDepartmentSchema.safeParse({ parentId: 'raiz' }).success).toBe(false);
  });
});

describe('consultas DEP-01/02', () => {
  it('lista: paginação padrão, isActive booleano e busca com 2+ caracteres', () => {
    expect(departmentListQuerySchema.parse({ isActive: 'false', q: ' ob ' })).toEqual({
      page: 1,
      pageSize: 20,
      isActive: false,
      q: 'ob',
    });
    expect(departmentListQuerySchema.safeParse({ q: 'o' }).success).toBe(false);
  });

  it('lookup: sem paginação; parâmetro desconhecido é recusado', () => {
    expect(departmentLookupQuerySchema.parse({ organizationId: ORG })).toEqual({
      organizationId: ORG,
    });
    expect(departmentLookupQuerySchema.safeParse({ page: '1' }).success).toBe(false);
  });
});

describe('eventos Department* (events.md §4)', () => {
  it('routing keys e payloads', () => {
    expect(DepartmentCreated.resolve({ departmentId: ORG }).routingKey).toBe('department.created');
    expect(
      DepartmentUpdated.resolve({ departmentId: ORG, changedFields: ['name'] }).routingKey,
    ).toBe('department.updated');
    expect(
      DepartmentMoved.resolve({ departmentId: ORG, fromParentId: null, toParentId: HEAD }).payload,
    ).toEqual({ departmentId: ORG, fromParentId: null, toParentId: HEAD });
    expect(() => DepartmentMoved.resolve({ departmentId: ORG })).toThrow(/DepartmentMoved/);
  });
});
