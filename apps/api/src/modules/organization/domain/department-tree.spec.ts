import { describe, expect, it } from 'vitest';

import {
  isSelfOrDescendant,
  movingCreatesCycle,
  pathIds,
  positionUnder,
  rebase,
  treeOrder,
} from './department-tree.js';

const S = '0192a000-0000-7000-8000-000000000001';
const A = '0192a000-0000-7000-8000-000000000002';
const B = '0192a000-0000-7000-8000-000000000003';
const X = '0192a000-0000-7000-8000-000000000004';

const sec = { id: S, ...positionUnder(S, null) };
const a = { id: A, ...positionUnder(A, sec) };
const b = { id: B, ...positionUnder(B, sec) };
const x = { id: X, ...positionUnder(X, a) };

describe('DepartmentTree (US-102 · RN-TEN-45/46)', () => {
  it('raiz tem depth 0 e caminho só com o próprio id; filho herda o caminho do pai', () => {
    expect(sec).toEqual({ id: S, path: `/${S}/`, depth: 0 });
    expect(a).toEqual({ id: A, path: `/${S}/${A}/`, depth: 1 });
    expect(x).toEqual({ id: X, path: `/${S}/${A}/${X}/`, depth: 2 });
    expect(pathIds(x.path)).toEqual([S, A, X]);
  });

  it('subárvore pelo prefixo do caminho', () => {
    expect(isSelfOrDescendant(x, a)).toBe(true);
    expect(isSelfOrDescendant(a, a)).toBe(true);
    expect(isSelfOrDescendant(b, a)).toBe(false);
    expect(isSelfOrDescendant(sec, a)).toBe(false);
  });

  it('ciclo: destino é a própria unidade ou um descendente; raiz e irmã não criam ciclo', () => {
    expect(movingCreatesCycle(a, a)).toBe(true);
    expect(movingCreatesCycle(a, x)).toBe(true);
    expect(movingCreatesCycle(sec, x)).toBe(true);
    expect(movingCreatesCycle(a, b)).toBe(false);
    expect(movingCreatesCycle(x, sec)).toBe(false);
    expect(movingCreatesCycle(a, null)).toBe(false);
  });

  it('rebase troca o prefixo e ajusta a profundidade do descendente', () => {
    const movedA = { id: A, ...positionUnder(A, b) };
    expect(rebase(x, a, movedA)).toEqual({ path: `/${S}/${B}/${A}/${X}/`, depth: 3 });
    const aAsRoot = { id: A, ...positionUnder(A, null) };
    expect(rebase(x, a, aAsRoot)).toEqual({ path: `/${A}/${X}/`, depth: 1 });
    expect(() => rebase(b, a, movedA)).toThrow(/subárvore/);
  });

  it('ordem da árvore: pais antes dos filhos, irmãos por sortOrder, nome e id', () => {
    const units = [
      { id: X, parentId: A, sortOrder: 0, name: 'Setor X' },
      { id: B, parentId: S, sortOrder: 0, name: 'Divisão B' },
      { id: A, parentId: S, sortOrder: 0, name: 'Divisão A' },
      { id: S, parentId: null, sortOrder: 0, name: 'Secretaria' },
      { id: '0192a000-0000-7000-8000-000000000005', parentId: null, sortOrder: -1, name: 'Zeta' },
    ];
    expect(treeOrder(units).map((unit) => unit.name)).toEqual([
      'Zeta',
      'Secretaria',
      'Divisão A',
      'Setor X',
      'Divisão B',
    ]);
  });

  it('ordem da árvore: unidade cujo pai está fora da lista vira raiz local', () => {
    const units = [{ id: X, parentId: A, sortOrder: 0, name: 'Setor X' }];
    expect(treeOrder(units)).toEqual(units);
  });
});
