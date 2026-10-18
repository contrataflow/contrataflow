import type { ItemKind } from '@contrataflow/types';
import {
  PROCESS_ITEM_FIELDS,
  PROCESS_ITEM_LIMITS,
  PROCESS_ITEM_MESSAGES,
  processItemIssues,
} from '@contrataflow/validation';
import type {
  CreateProcessItem,
  ItemCatalogSystem,
  ProcessItemField,
  ProcessStatus,
  UpdateProcessItem,
} from '@contrataflow/validation';

import type { ProcessIssue } from './process.js';

/*
 * Itens da contratação no agregado `Process` (US-006 · RN-PROC-71..84): numeração estável
 * (RN-PROC-73), reordenação (RN-PROC-74), política do nome do lote (`LotNamePolicy` — RN-PROC-75),
 * regras cruzadas sobre o estado resultante (RN-PROC-75/77), limite (RN-PROC-83) e o diff único
 * que alimenta evento, auditoria e timeline. Puro: sem NestJS, Prisma nem outro módulo.
 */

export interface ProcessItem {
  readonly id: string;
  readonly tenantId: string;
  readonly processId: string;
  readonly sequence: number;
  readonly lotNumber: number | null;
  readonly lotName: string | null;
  readonly kind: ItemKind;
  readonly description: string;
  readonly unitOfMeasureId: string;
  readonly catalogSystem: ItemCatalogSystem | null;
  readonly catalogCode: string | null;
  readonly notes: string | null;
  /** Decimal(18,4) como string; só os documentos e a pesquisa o alteram (DEC-019). */
  readonly referenceQuantity: string | null;
  readonly referenceQuantitySourceDocumentId: string | null;
  readonly referenceUnitPrice: string | null;
  readonly referenceUnitPriceSourceDocumentId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly createdById: string | null;
  readonly updatedById: string | null;
  readonly version: number;
}

export interface ItemCopyTarget {
  readonly tenantId: string;
  readonly processId: string;
  readonly now: Date;
  readonly userId: string;
  readonly newId: () => string;
}

/**
 * Itens copiados na duplicação (US-011 · RN-PROC-118/119 · DEC-033): natureza, descrição, unidade,
 * catálogo, lote e observações, renumerados a partir de 1 na ordem da origem (sequência própria do
 * novo processo). Quantidade e preço de referência ficam vazios: vinham de documentos da origem e o
 * valor estimado do novo processo é recalculado do zero.
 */
export function duplicateItems(
  items: readonly ProcessItem[],
  target: ItemCopyTarget,
): ProcessItem[] {
  return [...items]
    .sort((a, b) => a.sequence - b.sequence)
    .map((item, index) => ({
      ...item,
      id: target.newId(),
      tenantId: target.tenantId,
      processId: target.processId,
      sequence: index + 1,
      referenceQuantity: null,
      referenceQuantitySourceDocumentId: null,
      referenceUnitPrice: null,
      referenceUnitPriceSourceDocumentId: null,
      createdAt: target.now,
      updatedAt: target.now,
      createdById: target.userId,
      updatedById: target.userId,
      version: 1,
    }));
}

/**
 * Itens clonados para o processo de destino da duplicação do DFD (US-018 · RN-DFD-75): natureza,
 * descrição, unidade, catálogo e observações; numerados a partir do próximo disponível do destino
 * (RN-PROC-73), na ordem recebida; sem lote (o lote é da origem) nem valores de referência.
 */
export function cloneItemsAsNext(
  items: readonly ProcessItem[],
  existing: readonly Pick<ProcessItem, 'sequence'>[],
  target: ItemCopyTarget,
): ProcessItem[] {
  const first = nextSequence(existing);
  return duplicateItems(
    items.map((item, index) => ({ ...item, sequence: index + 1 })),
    target,
  ).map((copy, index) => ({ ...copy, sequence: first + index, lotNumber: null, lotName: null }));
}

/** RN-PROC-73: maior número entre os itens não excluídos + 1 (1 no primeiro). */
export function nextSequence(active: readonly Pick<ProcessItem, 'sequence'>[]): number {
  return active.reduce((max, item) => Math.max(max, item.sequence), 0) + 1;
}

/** RN-PROC-83 (V-06): mais um item ultrapassaria `PROCESS_ITEMS_MAX`. */
export function itemLimitIssues(activeCount: number): ProcessIssue[] {
  return activeCount >= PROCESS_ITEM_LIMITS.maxItems
    ? [{ field: 'description', code: 'OUT_OF_RANGE', message: PROCESS_ITEM_MESSAGES.limitReached }]
    : [];
}

export interface LotResolution {
  /** Nome efetivo do lote do item. */
  readonly lotName: string | null;
  /** Demais itens do lote cujo nome muda junto (listados em `updated` do evento). */
  readonly renamed: readonly ProcessItem[];
}

/**
 * `LotNamePolicy` (RN-PROC-75): itens do mesmo lote compartilham o nome. Sem lote → sem nome. Nome
 * NÃO informado (`undefined`) → herda o do lote existente (ou mantém o atual, se o lote não mudou).
 * Nome informado (inclusive `null`, que limpa) → vale para o lote inteiro: os outros itens do lote
 * com nome diferente são renomeados na mesma transação.
 */
export function resolveLot(
  siblings: readonly ProcessItem[],
  lotNumber: number | null,
  requestedName: string | null | undefined,
  current: { readonly lotNumber: number | null; readonly lotName: string | null } = {
    lotNumber: null,
    lotName: null,
  },
): LotResolution {
  if (lotNumber === null) return { lotName: null, renamed: [] };
  const lot = siblings.filter((item) => item.lotNumber === lotNumber);
  if (requestedName === undefined) {
    const existing = lot.find((item) => item.lotName !== null)?.lotName ?? null;
    if (lot.length > 0) return { lotName: existing, renamed: [] };
    return { lotName: current.lotNumber === lotNumber ? current.lotName : null, renamed: [] };
  }
  return {
    lotName: requestedName,
    renamed: lot.filter((item) => item.lotName !== requestedName),
  };
}

/** Regras cruzadas (RN-PROC-75/77) sobre o estado completo do item, como `ProcessIssue`. */
export function itemRuleIssues(item: Parameters<typeof processItemIssues>[0]): ProcessIssue[] {
  return processItemIssues(item).map((issue) => ({
    field: issue.path,
    code: issue.code,
    message: issue.message,
  }));
}

export interface NewItemContext {
  readonly id: string;
  readonly tenantId: string;
  readonly processId: string;
  readonly sequence: number;
  readonly lotName: string | null;
  readonly now: Date;
  readonly userId: string;
}

/** O item criado pelo PRC-14 (versão 1, sem valores de referência — DEC-019). */
export function newProcessItem(body: CreateProcessItem, context: NewItemContext): ProcessItem {
  const lotNumber = body.lotNumber ?? null;
  return {
    id: context.id,
    tenantId: context.tenantId,
    processId: context.processId,
    sequence: context.sequence,
    lotNumber,
    lotName: lotNumber === null ? null : context.lotName,
    kind: body.kind,
    description: body.description,
    unitOfMeasureId: body.unitOfMeasureId,
    catalogSystem: body.catalogSystem ?? null,
    catalogCode: body.catalogCode ?? null,
    notes: body.notes ?? null,
    referenceQuantity: null,
    referenceQuantitySourceDocumentId: null,
    referenceUnitPrice: null,
    referenceUnitPriceSourceDocumentId: null,
    createdAt: context.now,
    updatedAt: context.now,
    createdById: context.userId,
    updatedById: context.userId,
    version: 1,
  };
}

/** O estado resultante do PATCH (campos ausentes ficam como estão; `null` limpa os opcionais). */
export function patchedItem(item: ProcessItem, patch: UpdateProcessItem): ProcessItem {
  const pick = <K extends keyof UpdateProcessItem & keyof ProcessItem>(key: K) =>
    patch[key] === undefined ? item[key] : (patch[key] as ProcessItem[K]);
  const lotNumber = pick('lotNumber');
  return {
    ...item,
    description: pick('description'),
    kind: pick('kind'),
    unitOfMeasureId: pick('unitOfMeasureId'),
    lotNumber,
    lotName: lotNumber === null ? null : pick('lotName'),
    catalogSystem: pick('catalogSystem'),
    catalogCode: pick('catalogCode'),
    notes: pick('notes'),
  };
}

export interface ItemChange {
  readonly field: ProcessItemField;
  readonly old: unknown;
  readonly new: unknown;
}

/** Diferença efetiva entre dois estados do item, na ordem canônica de `PROCESS_ITEM_FIELDS`. */
export function diffItem(before: ProcessItem | null, after: ProcessItem): ItemChange[] {
  return PROCESS_ITEM_FIELDS.flatMap((field) => {
    const old = before === null ? null : before[field];
    const next = after[field];
    if (old === next || (before === null && next === null)) return [];
    return [{ field, old, new: next }];
  });
}

/** Nova versão do item e autoria da alteração (RN-PROC-81). */
export function touchItem(item: ProcessItem, at: Date, userId: string): ProcessItem {
  return { ...item, updatedAt: at, updatedById: userId, version: item.version + 1 };
}

/** RN-PROC-80: campos cuja alteração em item de documento concluído pede confirmação na UI. */
export const SNAPSHOT_SENSITIVE_FIELDS: readonly ProcessItemField[] = [
  'description',
  'kind',
  'catalogSystem',
  'catalogCode',
];

/**
 * RN-PROC-74 (V-08): `itemIds` com TODOS os itens ativos, cada um uma vez. Repetido →
 * `DUPLICATE_IN_LIST`; inexistente/excluído → `REFERENCE_NOT_FOUND`; ativo ausente → `REQUIRED`.
 * Um erro por código, todos no campo `itemIds`.
 */
export function reorderIssues(
  activeIds: readonly string[],
  itemIds: readonly string[],
): ProcessIssue[] {
  const active = new Set(activeIds);
  const seen = new Set<string>();
  let duplicate = false;
  let unknown = false;
  for (const id of itemIds) {
    if (seen.has(id)) duplicate = true;
    seen.add(id);
    if (!active.has(id)) unknown = true;
  }
  const missing = activeIds.some((id) => !seen.has(id));
  const issue = (code: ProcessIssue['code']): ProcessIssue => ({
    field: 'itemIds',
    code,
    message: PROCESS_ITEM_MESSAGES.invalidOrder,
  });
  return [
    ...(duplicate ? [issue('DUPLICATE_IN_LIST')] : []),
    ...(unknown ? [issue('REFERENCE_NOT_FOUND')] : []),
    ...(missing ? [issue('REQUIRED')] : []),
  ];
}

export interface Resequencing {
  readonly id: string;
  readonly from: number;
  readonly to: number;
}

/** RN-PROC-74: `sequence` = posição (1..n) na nova ordem; só os itens cujo número muda. */
export function resequence(
  active: readonly ProcessItem[],
  itemIds: readonly string[],
): Resequencing[] {
  const current = new Map(active.map((item) => [item.id, item.sequence]));
  return itemIds.flatMap((id, index) => {
    const from = current.get(id);
    return from === undefined || from === index + 1 ? [] : [{ id, from, to: index + 1 }];
  });
}

/** POL-01/RN-PROC-71 (FA-07): mensagem do status em que os itens não podem ser alterados. */
export function itemsNotEditableMessage(status: ProcessStatus): string {
  if (status === 'AWAITING_APPROVAL') return PROCESS_ITEM_MESSAGES.awaitingApproval;
  const labels: Partial<Record<ProcessStatus, string>> = {
    SUSPENDED: 'suspenso',
    CANCELED: 'cancelado',
    COMPLETED: 'concluído',
    PUBLISHED: 'publicado',
  };
  return `Itens não podem ser alterados com o processo ${labels[status] ?? status}.`;
}
