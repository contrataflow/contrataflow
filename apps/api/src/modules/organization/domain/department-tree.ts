/*
 * `DepartmentTree` (US-102 · RN-TEN-45/46): caminho materializado das unidades. Funções puras sobre
 * `path` (`/<idRaiz>/…/<id>/`) e `depth` (0 na raiz) — a subárvore de uma unidade são as linhas
 * cujo `path` começa pelo dela (`WHERE path LIKE '<path>%'`, índice `text_pattern_ops`).
 */

/** Posição de uma unidade na árvore. */
export interface TreePosition {
  readonly id: string;
  readonly path: string;
  readonly depth: number;
}

/** Caminho e profundidade de uma unidade nova (ou movida) sob `parent` (`null` = raiz do órgão). */
export function positionUnder(
  id: string,
  parent: Pick<TreePosition, 'path' | 'depth'> | null,
): Pick<TreePosition, 'path' | 'depth'> {
  return parent === null
    ? { path: `/${id}/`, depth: 0 }
    : { path: `${parent.path}${id}/`, depth: parent.depth + 1 };
}

/** `candidate` é a própria unidade ou está na subárvore dela. */
export function isSelfOrDescendant(
  candidate: Pick<TreePosition, 'path'>,
  unit: TreePosition,
): boolean {
  return candidate.path.startsWith(unit.path);
}

/**
 * RN-TEN-46: mover `unit` para baixo de `target` criaria ciclo quando o destino é a própria unidade
 * ou um descendente dela. `null` (raiz) nunca cria ciclo.
 */
export function movingCreatesCycle(unit: TreePosition, target: TreePosition | null): boolean {
  return target !== null && (target.id === unit.id || isSelfOrDescendant(target, unit));
}

/** Ids da raiz até a unidade, na ordem do caminho. */
export function pathIds(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

/**
 * Nova posição de um descendente quando a raiz da subárvore muda de `from` para `to`: troca o
 * prefixo do caminho e soma a diferença de profundidade.
 */
export function rebase(
  descendant: Pick<TreePosition, 'path' | 'depth'>,
  from: Pick<TreePosition, 'path' | 'depth'>,
  to: Pick<TreePosition, 'path' | 'depth'>,
): Pick<TreePosition, 'path' | 'depth'> {
  if (!descendant.path.startsWith(from.path)) {
    throw new Error('rebase: a unidade não pertence à subárvore movida.');
  }
  return {
    path: `${to.path}${descendant.path.slice(from.path.length)}`,
    depth: descendant.depth + (to.depth - from.depth),
  };
}

/**
 * Ordena as unidades na ordem da árvore (pais antes dos filhos; irmãos por `sortOrder`, nome e id)
 * — a ordem da lista do DEP-01 e da árvore do SCR-032. Unidade cujo pai não está na lista (filtro
 * por busca ou situação) entra como raiz local.
 */
export function treeOrder<
  T extends {
    readonly id: string;
    readonly parentId: string | null;
    readonly sortOrder: number;
    readonly name: string;
  },
>(units: readonly T[]): T[] {
  const ids = new Set(units.map((unit) => unit.id));
  const children = new Map<string | null, T[]>();
  for (const unit of units) {
    const key = unit.parentId !== null && ids.has(unit.parentId) ? unit.parentId : null;
    const list = children.get(key) ?? [];
    list.push(unit);
    children.set(key, list);
  }
  const compare = (a: T, b: T) =>
    a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'pt-BR') || a.id.localeCompare(b.id);
  const ordered: T[] = [];
  const visit = (parentId: string | null) => {
    for (const unit of (children.get(parentId) ?? []).sort(compare)) {
      ordered.push(unit);
      visit(unit.id);
    }
  };
  visit(null);
  return ordered;
}
