import type { DepartmentDto, DepartmentType } from '@contrataflow/validation';

/*
 * Modelo da árvore de unidades do SCR-032 (US-102): funções puras sobre a lista plana do DEP-01
 * (já na ordem da árvore). Montagem, nós visíveis para a navegação por teclado, destinos válidos
 * do "Mover para…" (RN-TEN-46) e rótulos configuráveis (FA-06 · `labels.*`).
 */

export interface DepartmentNode {
  readonly department: DepartmentDto;
  readonly children: readonly DepartmentNode[];
}

/** Monta a árvore preservando a ordem recebida; pai fora da lista → raiz local. */
export function buildTree(departments: readonly DepartmentDto[]): DepartmentNode[] {
  const ids = new Set(departments.map((department) => department.id));
  const children = new Map<string | null, DepartmentDto[]>();
  for (const department of departments) {
    const key =
      department.parentId !== null && ids.has(department.parentId) ? department.parentId : null;
    const list = children.get(key) ?? [];
    list.push(department);
    children.set(key, list);
  }
  const build = (parentId: string | null): DepartmentNode[] =>
    (children.get(parentId) ?? []).map((department) => ({
      department,
      children: build(department.id),
    }));
  return build(null);
}

export interface VisibleNode {
  readonly department: DepartmentDto;
  readonly level: number;
  readonly hasChildren: boolean;
  readonly expanded: boolean;
  readonly parentId: string | null;
  /** Posição entre os irmãos (1-based) e tamanho do grupo, para `aria-posinset`/`aria-setsize`. */
  readonly position: number;
  readonly setSize: number;
}

/** Nós visíveis (pais expandidos), na ordem de leitura — base da navegação por setas. */
export function visibleNodes(
  tree: readonly DepartmentNode[],
  expanded: ReadonlySet<string>,
): VisibleNode[] {
  const out: VisibleNode[] = [];
  const walk = (nodes: readonly DepartmentNode[], level: number, parentId: string | null) => {
    nodes.forEach((node, index) => {
      const isExpanded = expanded.has(node.department.id);
      out.push({
        department: node.department,
        level,
        hasChildren: node.children.length > 0,
        expanded: isExpanded,
        parentId,
        position: index + 1,
        setSize: nodes.length,
      });
      if (isExpanded) walk(node.children, level + 1, node.department.id);
    });
  };
  walk(tree, 1, null);
  return out;
}

/** Ids com filhos (para "expandir tudo" na primeira carga). */
export function idsWithChildren(departments: readonly DepartmentDto[]): Set<string> {
  return new Set(
    departments.map((department) => department.parentId).filter((id): id is string => id !== null),
  );
}

/** A unidade `candidate` é `unit` ou está na subárvore dela (prefixo do caminho). */
export function isSelfOrDescendant(candidate: DepartmentDto, unit: DepartmentDto): boolean {
  return candidate.path.startsWith(unit.path);
}

/**
 * Destinos válidos do "Mover para…" (RN-TEN-46): unidades ATIVAS do mesmo órgão que não são a
 * própria unidade, um descendente dela nem o pai atual. A raiz é oferecida à parte.
 */
export function moveTargets(
  departments: readonly DepartmentDto[],
  unit: DepartmentDto,
): DepartmentDto[] {
  return departments.filter(
    (candidate) =>
      candidate.organizationId === unit.organizationId &&
      candidate.isActive &&
      candidate.id !== unit.parentId &&
      !isSelfOrDescendant(candidate, unit),
  );
}

/** Soltar `dragged` sobre `target` é permitido (mesma regra do diálogo; `null` = raiz). */
export function canDropOn(dragged: DepartmentDto, target: DepartmentDto | null): boolean {
  if (target === null) return dragged.parentId !== null;
  return (
    target.organizationId === dragged.organizationId &&
    target.isActive &&
    target.id !== dragged.parentId &&
    !isSelfOrDescendant(target, dragged)
  );
}

/** Rótulos configuráveis da instituição (US-103 · `labels.secretariat`/`labels.department`). */
export interface StructureLabels {
  readonly secretariat: string;
  readonly department: string;
}

export const DEFAULT_LABELS: StructureLabels = { secretariat: 'Secretaria', department: 'Setor' };

/** SET-03 → rótulos (valores ausentes ou vazios caem no padrão). */
export function labelsFrom(publicSettings: Readonly<Record<string, unknown>> | undefined) {
  const read = (key: string, fallback: string) => {
    const value = publicSettings?.[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback;
  };
  return {
    secretariat: read('labels.secretariat', DEFAULT_LABELS.secretariat),
    department: read('labels.department', DEFAULT_LABELS.department),
  } satisfies StructureLabels;
}

/**
 * Nome exibido do tipo: `SECRETARIAT` usa `labels.secretariat` e `SECTOR`, `labels.department`
 * (FA-06); os demais vêm das mensagens.
 */
export function typeLabel(
  type: DepartmentType,
  labels: StructureLabels,
  messageFor: (type: DepartmentType) => string,
): string {
  if (type === 'SECRETARIAT') return labels.secretariat;
  if (type === 'SECTOR') return labels.department;
  return messageFor(type);
}
