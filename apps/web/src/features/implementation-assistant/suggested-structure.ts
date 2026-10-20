/*
 * Estrutura mínima sugerida no primeiro acesso (US-099 · FA-09 · entities.md §7): "Gabinete" e
 * "Secretaria de Administração" → "Setor de Compras". Tudo editável e descartável; nada é criado sem
 * confirmação (RN-TEN-18). As unidades são criadas pelo DEP-03 (US-102), pais antes dos filhos.
 */

/** entities.md §2 — `DepartmentType`. */
export const DEPARTMENT_TYPES = [
  'SECRETARIAT',
  'BOARD',
  'DEPARTMENT',
  'DIVISION',
  'SECTOR',
  'COMMITTEE',
  'OTHER',
] as const;
export type DepartmentType = (typeof DEPARTMENT_TYPES)[number];

export interface SuggestedUnit {
  /** Chave local estável (a hierarquia é por chave, não por nome). */
  readonly key: string;
  readonly name: string;
  readonly type: DepartmentType;
  readonly parentKey: string | null;
  readonly selected: boolean;
}

export const SUGGESTED_STRUCTURE: readonly SuggestedUnit[] = [
  { key: 'gabinete', name: 'Gabinete', type: 'SECRETARIAT', parentKey: null, selected: true },
  {
    key: 'administracao',
    name: 'Secretaria de Administração',
    type: 'SECRETARIAT',
    parentKey: null,
    selected: true,
  },
  {
    key: 'compras',
    name: 'Setor de Compras',
    type: 'SECTOR',
    parentKey: 'administracao',
    selected: true,
  },
];

/** RN-TEN-44 · DEP-03: nome com 3 a 200 caracteres (`DEPARTMENT_NAME_MIN`/`MAX`). */
export const UNIT_NAME_MIN = 3;
export const UNIT_NAME_MAX = 200;

/** RN-TEN-18: só para quem tem `DEPARTMENT_MANAGE` e com o órgão selecionado sem unidades. */
export function shouldShowImplementationAssistant(input: {
  readonly canManageDepartments: boolean;
  readonly departmentCount: number;
}): boolean {
  return input.canManageDepartments && input.departmentCount === 0;
}

/** A unidade pode ser marcada? Só se a superior também estiver marcada. */
export function isSelectable(units: readonly SuggestedUnit[], unit: SuggestedUnit): boolean {
  if (unit.parentKey === null) return true;
  const parent = units.find((candidate) => candidate.key === unit.parentKey);
  return parent !== undefined && parent.selected && isSelectable(units, parent);
}

/** Unidades a criar, pais antes dos filhos (filho de pai desmarcado não entra). */
export function creationOrder(units: readonly SuggestedUnit[]): SuggestedUnit[] {
  const chosen = units.filter((unit) => unit.selected && isSelectable(units, unit));
  const ordered: SuggestedUnit[] = [];
  const visit = (parentKey: string | null) => {
    for (const unit of chosen.filter((candidate) => candidate.parentKey === parentKey)) {
      ordered.push(unit);
      visit(unit.key);
    }
  };
  visit(null);
  return ordered;
}

/** Nomes inválidos (vazio, curto, longo ou repetido entre irmãos), por chave. */
export function nameErrors(
  units: readonly SuggestedUnit[],
): Record<string, 'REQUIRED' | 'TOO_SHORT' | 'TOO_LONG' | 'DUPLICATE'> {
  const errors: Record<string, 'REQUIRED' | 'TOO_SHORT' | 'TOO_LONG' | 'DUPLICATE'> = {};
  const chosen = creationOrder(units);
  for (const unit of chosen) {
    const name = unit.name.trim();
    if (name === '') errors[unit.key] = 'REQUIRED';
    else if (name.length < UNIT_NAME_MIN) errors[unit.key] = 'TOO_SHORT';
    else if (name.length > UNIT_NAME_MAX) errors[unit.key] = 'TOO_LONG';
    else if (
      chosen.some(
        (other) =>
          other.key !== unit.key &&
          other.parentKey === unit.parentKey &&
          other.name.trim().toLocaleLowerCase('pt-BR') === name.toLocaleLowerCase('pt-BR'),
      )
    ) {
      errors[unit.key] = 'DUPLICATE';
    }
  }
  return errors;
}

/** "Primeiros passos" depois da estrutura (FA-09), com as telas de destino. */
export const FIRST_STEPS = [
  { key: 'inviteUsers', href: '/admin/usuarios' },
  { key: 'defineHeads', href: '/admin/estrutura' },
  { key: 'purchasingUnit', href: '/admin/workflows' },
  { key: 'numbering', href: '/admin/configuracoes' },
  { key: 'holidays', href: '/admin/calendario' },
  { key: 'templates', href: '/admin/templates' },
] as const;
