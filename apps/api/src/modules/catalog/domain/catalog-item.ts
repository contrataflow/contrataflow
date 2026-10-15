import type { CatalogType } from '@contrataflow/types';
import { catalogMetadataSchema } from '@contrataflow/validation';
import type { CreateCatalogItem, FieldError, UpdateCatalogItem } from '@contrataflow/validation';

import { toFieldErrors } from '#shared/validation/zod-issues.js';

/*
 * `CatalogItem` (US-104 · entities.md §4 · RN-TEN-59..66): regras puras de criação, edição,
 * ativação e reordenação, sem NestJS nem Prisma. O `code` nasce na criação e nunca muda; item de
 * sistema pode ser editado e desativado, nunca excluído (e a API não exclui nenhum — RN-TEN-64).
 */

export interface CatalogItem {
  readonly id: string;
  readonly tenantId: string;
  readonly catalogType: CatalogType;
  readonly code: string;
  readonly label: string;
  readonly description: string | null;
  readonly isSystem: boolean;
  readonly isActive: boolean;
  readonly sortOrder: number;
  readonly parentId: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly createdById: string | null;
  readonly updatedById: string | null;
  readonly version: number;
}

/** Campo editável por CAT-03 (entra em `changes` da auditoria). */
export type CatalogItemUpdatableField =
  'label' | 'description' | 'parentId' | 'sortOrder' | 'metadata';

export interface CatalogItemChange {
  readonly path: CatalogItemUpdatableField;
  readonly old: unknown;
  readonly new: unknown;
}

/** RN-TEN-62 / V-03: `metadata` fora do schema do tipo → erros por campo (`metadata.<chave>`). */
export class CatalogMetadataInvalidError extends Error {
  constructor(readonly errors: readonly FieldError[]) {
    super('Metadados fora do schema do catálogo.');
    this.name = 'CatalogMetadataInvalidError';
  }
}

/** FA-01 / V-05: tentativa de alterar o `code` de um item de sistema. */
export class CatalogItemSystemError extends Error {
  constructor(readonly code: string) {
    super('Itens padrão do sistema não podem ter o código alterado.');
    this.name = 'CatalogItemSystemError';
  }
}

/** Tentativa de alterar o `code` de um item que não é de sistema (RN-TEN-59: imutável). */
export class CatalogCodeImmutableError extends Error {
  constructor() {
    super('O código do item não pode ser alterado.');
    this.name = 'CatalogCodeImmutableError';
  }
}

/** RN-TEN-62: valida e normaliza `metadata` pelo schema do `catalogType` (`{}` quando omitida). */
export function parseCatalogMetadata(
  catalogType: CatalogType,
  metadata: unknown,
): Record<string, unknown> {
  const result = catalogMetadataSchema(catalogType).safeParse(metadata ?? {}, {
    reportInput: true,
  });
  if (!result.success) {
    throw new CatalogMetadataInvalidError(toFieldErrors(result.error.issues, 'metadata'));
  }
  return result.data;
}

function descriptionOf(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? null : trimmed;
}

export interface CreateContext {
  readonly id: string;
  readonly tenantId: string;
  readonly catalogType: CatalogType;
  readonly now: Date;
  readonly userId: string | null;
  /** Próxima posição: o item novo entra no fim da lista (`max(sortOrder) + 1`). */
  readonly sortOrder: number;
}

/** RN-TEN-59/62: item novo, sempre `isSystem = false` e ativo. */
export function createCatalogItem(body: CreateCatalogItem, ctx: CreateContext): CatalogItem {
  return {
    id: ctx.id,
    tenantId: ctx.tenantId,
    catalogType: ctx.catalogType,
    code: body.code,
    label: body.label,
    description: descriptionOf(body.description),
    isSystem: false,
    isActive: true,
    sortOrder: ctx.sortOrder,
    parentId: body.parentId ?? null,
    metadata: parseCatalogMetadata(ctx.catalogType, body.metadata),
    createdAt: ctx.now,
    updatedAt: ctx.now,
    createdById: ctx.userId,
    updatedById: ctx.userId,
    version: 1,
  };
}

export interface UpdateContext {
  readonly now: Date;
  readonly userId: string | null;
}

export interface UpdateResult {
  readonly next: CatalogItem;
  readonly changes: readonly CatalogItemChange[];
  /** `parentId` novo a validar (existência, mesmo catálogo, sem ciclo); `null` se não mudou. */
  readonly parentToValidate: string | null;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * RN-TEN-59/60/62/63: aplica o patch do CAT-03. `code` diferente do atual é recusado
 * (`CatalogItemSystemError` para item de sistema; `CatalogCodeImmutableError` para os demais);
 * `metadata` substitui o objeto inteiro e é revalidada pelo schema do tipo. Nada alterado →
 * `changes` vazio (sem nova versão, auditoria nem evento).
 */
export function updateCatalogItem(
  current: CatalogItem,
  patch: UpdateCatalogItem,
  ctx: UpdateContext,
): UpdateResult {
  if (patch.code !== undefined && patch.code !== current.code) {
    throw current.isSystem
      ? new CatalogItemSystemError(current.code)
      : new CatalogCodeImmutableError();
  }

  const changes: CatalogItemChange[] = [];
  let next: CatalogItem = current;
  const set = <K extends CatalogItemUpdatableField>(path: K, value: CatalogItem[K]): void => {
    if (sameJson(current[path], value)) return;
    changes.push({ path, old: current[path], new: value });
    next = { ...next, [path]: value };
  };

  if (patch.label !== undefined) set('label', patch.label);
  if (patch.description !== undefined) set('description', descriptionOf(patch.description));
  if (patch.parentId !== undefined) set('parentId', patch.parentId);
  if (patch.sortOrder !== undefined) set('sortOrder', patch.sortOrder);
  if (patch.metadata !== undefined) {
    set('metadata', parseCatalogMetadata(current.catalogType, patch.metadata));
  }

  if (changes.length === 0) return { next: current, changes, parentToValidate: null };
  const parentChanged = changes.some((change) => change.path === 'parentId');
  return {
    next: { ...next, updatedAt: ctx.now, updatedById: ctx.userId },
    changes,
    parentToValidate: parentChanged ? next.parentId : null,
  };
}

/** RN-TEN-61: ativa/desativa; já no estado pedido → `null` (nada a gravar). */
export function setCatalogItemActive(
  current: CatalogItem,
  isActive: boolean,
  ctx: UpdateContext,
): CatalogItem | null {
  if (current.isActive === isActive) return null;
  return { ...current, isActive, updatedAt: ctx.now, updatedById: ctx.userId };
}

/**
 * RN-TEN-63: `parentId` válido = outro item do mesmo catálogo e tenant (a leitura sob RLS já
 * descarta outro tenant) que não crie ciclo — a cadeia de ancestrais do pai não pode passar pelo
 * próprio item. `ancestors(id)` devolve o `parentId` do item (ou `null`).
 */
export async function createsParentCycle(
  itemId: string,
  parentId: string,
  parentOf: (id: string) => Promise<string | null>,
): Promise<boolean> {
  const seen = new Set<string>();
  for (let cursor: string | null = parentId; cursor !== null; cursor = await parentOf(cursor)) {
    if (cursor === itemId) return true;
    if (seen.has(cursor)) return false;
    seen.add(cursor);
  }
  return false;
}

export class CatalogOrderInvalidError extends Error {
  constructor(
    readonly reason: 'UNKNOWN_ID' | 'INCOMPLETE',
    readonly ids: readonly string[],
  ) {
    super('Lista de ordenação inconsistente com o catálogo.');
    this.name = 'CatalogOrderInvalidError';
  }
}

export interface PlannedReorder {
  /** Itens cuja posição mudou, com o `sortOrder` novo (sequencial a partir de 1). */
  readonly moves: readonly { readonly item: CatalogItem; readonly sortOrder: number }[];
  /** Todos os itens do catálogo na ordem final. */
  readonly ordered: readonly CatalogItem[];
}

/**
 * RN-TEN-65: `orderedIds` é a lista COMPLETA do catálogo (ativos e inativos) na ordem final.
 * ID de outro catálogo/tenant (ou inexistente) bloqueia a operação inteira, assim como a lista
 * incompleta; `sortOrder` é recalculado sequencialmente (1, 2, 3…).
 */
export function planReorder(
  items: readonly CatalogItem[],
  orderedIds: readonly string[],
): PlannedReorder {
  const byId = new Map(items.map((item) => [item.id, item]));
  const unknown = orderedIds.filter((id) => !byId.has(id));
  if (unknown.length > 0) throw new CatalogOrderInvalidError('UNKNOWN_ID', unknown);
  const missing = items.filter((item) => !orderedIds.includes(item.id)).map((item) => item.id);
  if (missing.length > 0) throw new CatalogOrderInvalidError('INCOMPLETE', missing);

  const ordered = orderedIds.flatMap((id) => {
    const found = byId.get(id);
    return found ? [found] : [];
  });
  const moves = ordered
    .map((item, index) => ({ item, sortOrder: index + 1 }))
    .filter(({ item, sortOrder }) => item.sortOrder !== sortOrder);
  return { moves, ordered };
}
