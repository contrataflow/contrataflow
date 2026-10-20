import type { ItemKind } from '@contrataflow/types';
import {
  PROCESS_ITEM_FIELDS,
  createProcessItemSchema,
  hasSequenceGaps,
  processItemReferenceSchema,
} from '@contrataflow/validation';
import type {
  CreateProcessItemInput,
  ItemCatalogSystem,
  ProcessItemDto,
  ProcessItemField,
  ProcessItemReference,
  UpdateProcessItemInput,
} from '@contrataflow/validation';
import { z } from 'zod';

import type { ApiError } from '@/lib/api/api-error';

/*
 * Regras de tela da aba "Itens" (US-006 · SCR-006), puras e testáveis: agrupamento por lote,
 * lacunas da numeração (FA-02), reordenação por teclado, valores do formulário ↔ corpo dos
 * PRC-14/15, avisos de natureza incomum (FA-05), unidade travada (FA-04), documentos concluídos
 * afetados (FA-03) e as referências do 409 `ITEM_IN_USE` (FA-01).
 */

export interface LotGroup {
  /** `null` = "Sem lote". */
  readonly lotNumber: number | null;
  readonly lotName: string | null;
  readonly items: readonly ProcessItemDto[];
}

/** Grupos por lote (ordem do menor número de item de cada grupo); "Sem lote" no fim. */
export function groupByLot(items: readonly ProcessItemDto[]): LotGroup[] {
  const groups = new Map<number | null, ProcessItemDto[]>();
  for (const item of [...items].sort((a, b) => a.sequence - b.sequence)) {
    const key = item.lotNumber;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => {
      if (a === null) return 1;
      if (b === null) return -1;
      return a - b;
    })
    .map(([lotNumber, list]) => ({
      lotNumber,
      lotName: list.find((item) => item.lotName !== null)?.lotName ?? null,
      items: list,
    }));
}

/** RN-PROC-75: "Há itens sem lote." quando ao menos um item tem lote e algum não tem. */
export function hasItemsWithoutLot(items: readonly ProcessItemDto[]): boolean {
  return (
    items.some((item) => item.lotNumber !== null) && items.some((item) => item.lotNumber === null)
  );
}

/** FA-02: números atuais quando há lacunas (para a mensagem), senão `null`. */
export function sequenceGaps(items: readonly ProcessItemDto[]): number[] | null {
  const sequences = items.map((item) => item.sequence).sort((a, b) => a - b);
  return hasSequenceGaps(sequences) ? sequences : null;
}

/** Move o item da posição `index` em `delta` (−1 sobe, +1 desce); fora dos limites, nada muda. */
export function moveItem<T>(order: readonly T[], index: number, delta: number): T[] {
  const target = index + delta;
  if (index < 0 || index >= order.length || target < 0 || target >= order.length) return [...order];
  const next = [...order];
  const [moved] = next.splice(index, 1);
  if (moved !== undefined) next.splice(target, 0, moved);
  return next;
}

/** Move o item `id` para a posição de `overId` (arrastar e soltar). */
export function moveTo(order: readonly string[], id: string, overId: string): string[] {
  const from = order.indexOf(id);
  const to = order.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return [...order];
  return moveItem(order, from, to - from);
}

export interface ItemFormValues {
  readonly description: string;
  readonly kind: ItemKind | '';
  readonly unitOfMeasureId: string;
  readonly lotNumber: string;
  readonly lotName: string;
  readonly catalogSystem: ItemCatalogSystem | '';
  readonly catalogCode: string;
  readonly notes: string;
}

/** Valores iniciais: o item em edição ou um novo, com a primeira natureza do tipo (story · Campos). */
export function formValuesOf(
  item: ProcessItemDto | null,
  defaultKind: ItemKind | null,
): ItemFormValues {
  return {
    description: item?.description ?? '',
    kind: item?.kind ?? defaultKind ?? '',
    unitOfMeasureId: item?.unitOfMeasure.id ?? '',
    lotNumber: item?.lotNumber === null || item === null ? '' : String(item.lotNumber),
    lotName: item?.lotName ?? '',
    catalogSystem: item?.catalogSystem ?? '',
    catalogCode: item?.catalogCode ?? '',
    notes: item?.notes ?? '',
  };
}

/** Lote informado como número (texto não numérico vira `NaN` → erro do schema). */
function lotNumberOf(value: string): number | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : Number(trimmed);
}

/** O estado completo como corpo do PRC-14 (vazios = não informados). */
export function createBodyOf(values: ItemFormValues): CreateProcessItemInput {
  const lotNumber = lotNumberOf(values.lotNumber);
  return {
    description: values.description,
    kind: values.kind as ItemKind,
    unitOfMeasureId: values.unitOfMeasureId,
    ...(lotNumber === null ? {} : { lotNumber }),
    ...(values.lotName.trim() === '' ? {} : { lotName: values.lotName }),
    ...(values.catalogSystem === '' ? {} : { catalogSystem: values.catalogSystem }),
    ...(values.catalogCode.trim() === '' ? {} : { catalogCode: values.catalogCode }),
    ...(values.notes.trim() === '' ? {} : { notes: values.notes }),
  };
}

type FieldValue = string | number | null;

function fieldValuesOf(values: ItemFormValues): Record<ProcessItemField, FieldValue> {
  const text = (value: string) => (value.trim() === '' ? null : value.trim());
  return {
    lotNumber: lotNumberOf(values.lotNumber),
    lotName: text(values.lotName),
    kind: values.kind === '' ? null : values.kind,
    description: values.description.trim(),
    unitOfMeasureId: values.unitOfMeasureId === '' ? null : values.unitOfMeasureId,
    catalogSystem: values.catalogSystem === '' ? null : values.catalogSystem,
    catalogCode: text(values.catalogCode),
    notes: text(values.notes),
  };
}

/** PATCH do PRC-15: só os campos alterados (`null` limpa os opcionais). */
export function patchOf(item: ProcessItemDto, values: ItemFormValues): UpdateProcessItemInput {
  const before = fieldValuesOf(formValuesOf(item, null));
  const after = fieldValuesOf(values);
  const patch: Record<string, FieldValue> = {};
  for (const field of PROCESS_ITEM_FIELDS) {
    if (before[field] !== after[field]) patch[field] = after[field];
  }
  return patch;
}

export type FieldMessages = Partial<Record<ProcessItemField, string>>;

/** Validação do formulário com o MESMO schema da API (estado completo). */
export function validateItem(values: ItemFormValues): FieldMessages {
  const result = createProcessItemSchema.safeParse(createBodyOf(values));
  if (result.success) return {};
  const messages: FieldMessages = {};
  for (const issue of result.error.issues) {
    const field = issue.path[0];
    if (typeof field === 'string' && (PROCESS_ITEM_FIELDS as readonly string[]).includes(field)) {
      messages[field as ProcessItemField] ??= issue.message;
    }
  }
  return messages;
}

/** FA-05: natureza fora de `metadata.itemKinds` do tipo de contratação (só aviso). */
export function isUnusualKind(kind: ItemKind | '', itemKinds: readonly ItemKind[] | null): boolean {
  return kind !== '' && itemKinds !== null && itemKinds.length > 0 && !itemKinds.includes(kind);
}

/** `metadata.itemKinds` do item de catálogo `CONTRACTING_TYPE` (vazio/ausente = sem restrição). */
export function itemKindsOf(metadata: unknown): ItemKind[] | null {
  const parsed = z
    .object({ itemKinds: z.array(z.enum(['GOOD', 'SERVICE', 'ENGINEERING_SERVICE', 'WORK'])) })
    .safeParse(metadata);
  return parsed.success ? parsed.data.itemKinds : null;
}

/** FA-04 (RN-PROC-76): unidade travada quando o item tem quantidades em documentos. */
export function isUnitLocked(item: ProcessItemDto | null): boolean {
  return item !== null && item.references.length > 0;
}

const COMPLETED_STATUSES = new Set(['IN_REVIEW', 'FINALIZED', 'APPROVED']);
const SNAPSHOT_FIELDS = new Set<string>(['description', 'kind', 'catalogSystem', 'catalogCode']);

/** FA-03 (RN-PROC-80): documentos concluídos afetados por alteração de descrição/natureza/código. */
export function completedReferencesAffected(
  item: ProcessItemDto,
  patch: UpdateProcessItemInput,
): ProcessItemReference[] {
  if (!Object.keys(patch).some((field) => SNAPSHOT_FIELDS.has(field))) return [];
  return item.references.filter((reference) => COMPLETED_STATUSES.has(reference.status));
}

/** FA-01: `meta.references` do 409 `ITEM_IN_USE`. */
export function inUseReferencesOf(error: ApiError): ProcessItemReference[] {
  const parsed = z
    .looseObject({ meta: z.object({ references: z.array(processItemReferenceSchema) }) })
    .safeParse(error.problem);
  return parsed.success ? parsed.data.meta.references : [];
}
