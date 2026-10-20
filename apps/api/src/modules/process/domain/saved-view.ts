import {
  PROCESS_COLUMN_KEYS,
  SAVED_VIEW_LIMIT,
  upcastSavedViewFilters,
} from '@contrataflow/validation';
import type {
  ProcessColumnKey,
  SavedViewFilters,
  SavedViewScope,
  UpdateSavedView,
} from '@contrataflow/validation';

/*
 * `SavedView` (US-003 · RN-PROC-34..38): critérios da lista por dono e escopo. Regras puras —
 * nome único sem diferenciar maiúsculas, limite por dono e escopo, uma única padrão, posse e
 * compartilhamento somente leitura. A visão compartilha critérios, nunca dados (RN-PROC-37): o
 * resultado de quem a aplica sai sempre do predicado de visibilidade e do mascaramento dele.
 */

export interface SavedView {
  readonly id: string;
  readonly tenantId: string;
  readonly ownerId: string;
  readonly scope: SavedViewScope;
  readonly name: string;
  readonly filters: SavedViewFilters;
  readonly sort: string | null;
  readonly columns: readonly ProcessColumnKey[];
  readonly isShared: boolean;
  readonly isDefault: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly createdById: string | null;
  readonly updatedById: string | null;
  readonly version: number;
}

/** Chave de unicidade do nome (`lower(name)` do índice — RN-PROC-34). */
export function savedViewNameKey(name: string): string {
  return name.trim().toLowerCase();
}

/** RN-PROC-34: outro registro do mesmo dono e escopo já usa o nome. */
export function isSavedViewNameTaken(
  views: readonly Pick<SavedView, 'id' | 'name'>[],
  name: string,
  exceptId: string | null = null,
): boolean {
  const key = savedViewNameKey(name);
  return views.some((view) => view.id !== exceptId && savedViewNameKey(view.name) === key);
}

/** RN-PROC-38: cabe mais uma visão para o dono no escopo? */
export function canCreateSavedView(ownedCount: number): boolean {
  return ownedCount < SAVED_VIEW_LIMIT;
}

/**
 * Como o usuário enxerga a visão (RN-PROC-37 · "Permissões"): dono altera; compartilhada de outro
 * é só leitura (alterar = 403); privada de outro não existe para ele (404).
 */
export type SavedViewAccess = 'OWNER' | 'SHARED' | 'HIDDEN';

export function savedViewAccess(
  view: Pick<SavedView, 'ownerId' | 'isShared'>,
  userId: string,
): SavedViewAccess {
  if (view.ownerId === userId) return 'OWNER';
  return view.isShared ? 'SHARED' : 'HIDDEN';
}

/** Dados persistidos de volta ao domínio: filtros pelo upcaster, colunas desconhecidas fora. */
export function restoreSavedViewCriteria(raw: {
  readonly filters: unknown;
  readonly columns: unknown;
}): {
  readonly filters: SavedViewFilters;
  readonly columns: readonly ProcessColumnKey[];
} {
  const known = new Set<string>(PROCESS_COLUMN_KEYS);
  const columns = Array.isArray(raw.columns)
    ? raw.columns.filter(
        (column): column is ProcessColumnKey => typeof column === 'string' && known.has(column),
      )
    : [];
  return { filters: upcastSavedViewFilters(raw.filters) ?? { v: 1 }, columns };
}

/** PATCH (PRC-37): a visão com os campos informados; `changed = false` quando nada mudou. */
export function applySavedViewPatch(
  view: SavedView,
  patch: UpdateSavedView,
  change: { readonly at: Date; readonly userId: string },
): { readonly view: SavedView; readonly changed: boolean } {
  const next: SavedView = {
    ...view,
    ...(patch.name === undefined ? {} : { name: patch.name }),
    ...(patch.filters === undefined ? {} : { filters: patch.filters }),
    ...(patch.sort === undefined ? {} : { sort: patch.sort }),
    ...(patch.columns === undefined ? {} : { columns: patch.columns }),
    ...(patch.isShared === undefined ? {} : { isShared: patch.isShared }),
    ...(patch.isDefault === undefined ? {} : { isDefault: patch.isDefault }),
  };
  const changed =
    next.name !== view.name ||
    JSON.stringify(next.filters) !== JSON.stringify(view.filters) ||
    next.sort !== view.sort ||
    JSON.stringify(next.columns) !== JSON.stringify(view.columns) ||
    next.isShared !== view.isShared ||
    next.isDefault !== view.isDefault;
  if (!changed) return { view, changed: false };
  return {
    view: { ...next, updatedAt: change.at, updatedById: change.userId, version: view.version + 1 },
    changed: true,
  };
}
