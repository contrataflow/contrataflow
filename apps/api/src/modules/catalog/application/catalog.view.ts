import type { CatalogItemDto } from '@contrataflow/validation';

import type { CatalogItem } from '../domain/catalog-item.js';

/** `CatalogItem` → resposta de CAT-01..06 (datas ISO, `metadata` como objeto). */
export function toCatalogItemDto(item: CatalogItem): CatalogItemDto {
  return {
    id: item.id,
    catalogType: item.catalogType,
    code: item.code,
    label: item.label,
    description: item.description,
    isSystem: item.isSystem,
    isActive: item.isActive,
    sortOrder: item.sortOrder,
    parentId: item.parentId,
    metadata: { ...item.metadata },
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
    version: item.version,
  };
}
