import type { DocumentSnapshot } from '@contrataflow/validation';

/*
 * POL-09 sobre o snapshot da versão (RN-DOC-61 · api.md §1.4): para quem não pode ver o orçamento
 * sigiloso, todo campo monetário do cabeçalho tipado e das coleções (inclusive aninhadas — cotações
 * dentro de itens de preço) vira `null` com `<campo>Masked: true`. Nunca omite o campo (contrato
 * estável). As seções narrativas são texto livre e não são mascaradas aqui (o sigilo do texto é do
 * documento `RESTRICTED`, regra de renderização — US-067).
 */

/**
 * Campos monetários dos documentos tipados (entities.md §4: `Dfd`, `Etp`, `TermOfReference`,
 * `PriceResearch`, `PriceItem`, `Quotation`) — valores como string decimal no snapshot (§5.3.2).
 */
export const MONETARY_SNAPSHOT_FIELDS: ReadonlySet<string> = new Set([
  'estimatedValue',
  'estimatedTotalValue',
  'totalEstimatedValue',
  'estimatedCost',
  'unitPrice',
  'totalPrice',
  'manualUnitPrice',
  'referenceUnitPrice',
  'recommendedUnitPrice',
  'meanPrice',
  'medianPrice',
  'lowestPrice',
  'highestPrice',
  'stdDeviation',
]);

/** Sufixo da marca de campo mascarado (`estimatedValueMasked: true`). */
export const MASKED_SUFFIX = 'Masked';

export const maskedFlagOf = (field: string): string => `${field}${MASKED_SUFFIX}`;

/** O campo está mascarado no objeto (marca `<campo>Masked: true`). */
export function isMaskedField(record: Readonly<Record<string, unknown>>, field: string): boolean {
  return record[maskedFlagOf(field)] === true;
}

/** Marca de mascaramento (não é um campo de dado — fica fora das comparações). */
export function isMaskFlag(record: Readonly<Record<string, unknown>>, key: string): boolean {
  if (!key.endsWith(MASKED_SUFFIX) || record[key] !== true) return false;
  return MONETARY_SNAPSHOT_FIELDS.has(key.slice(0, -MASKED_SUFFIX.length));
}

function maskValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskValue);
  if (value === null || typeof value !== 'object') return value;
  return maskRecord(value as Record<string, unknown>);
}

function maskRecord(record: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (MONETARY_SNAPSHOT_FIELDS.has(key)) {
      result[key] = null;
      result[maskedFlagOf(key)] = true;
    } else if (!(key in result)) {
      result[key] = maskValue(value);
    }
  }
  return result;
}

/** Um registro (resumo do painel — RN-DOC-17) como quem não atende POL-09 o vê. */
export function maskConfidentialRecord(
  record: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return maskRecord(record);
}

/** O snapshot como quem não atende POL-09 o vê (cabeçalho e coleções mascarados). */
export function maskConfidentialSnapshot(snapshot: DocumentSnapshot): DocumentSnapshot {
  return {
    ...snapshot,
    header: maskRecord(snapshot.header),
    collections: Object.fromEntries(
      Object.entries(snapshot.collections).map(([key, items]) => [key, items.map(maskValue)]),
    ),
  };
}
