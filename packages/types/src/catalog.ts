/**
 * Catálogos parametrizáveis do tenant (US-104 · entities.md §2 `CatalogType`, §5.9): listas
 * fechadas compartilhadas pela API (validação, seeder), pelo worker e pelo web (SCR-109).
 */

/** entities.md §2 — `CatalogType`. */
export const CATALOG_TYPES = [
  'CONTRACTING_TYPE',
  'MODALITY',
  'PROCESS_ORIGIN',
  'UNIT_OF_MEASURE',
  'RISK_CATEGORY',
  'PRICE_SOURCE_TYPE',
  'JUDGMENT_CRITERION',
  'ATTACHMENT_CATEGORY',
] as const;

export type CatalogType = (typeof CATALOG_TYPES)[number];

/** `CatalogItemChanged.change` (events.md §4.5): reordenação usa `UPDATED` por item afetado. */
export const CATALOG_ITEM_CHANGES = ['CREATED', 'UPDATED', 'ACTIVATED', 'DEACTIVATED'] as const;

export type CatalogItemChange = (typeof CATALOG_ITEM_CHANGES)[number];

/** entities.md §2 — `ItemKind` (metadata de `CONTRACTING_TYPE`). */
export const ITEM_KINDS = ['GOOD', 'SERVICE', 'ENGINEERING_SERVICE', 'WORK'] as const;

export type ItemKind = (typeof ITEM_KINDS)[number];

/** entities.md §2 — `PcaStatus` (metadata de `PROCESS_ORIGIN`). */
export const PCA_STATUSES = ['PLANNED', 'NOT_PLANNED', 'NOT_APPLICABLE'] as const;

export type PcaStatus = (typeof PCA_STATUSES)[number];
