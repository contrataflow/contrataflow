import type { CatalogType } from '@contrataflow/types';
import {
  PRICE_SOURCE_AGE_REFERENCES,
  PRICE_SOURCE_REQUIRED_FIELDS,
} from '@contrataflow/validation';
import type { PriceSourceRequiredField } from '@contrataflow/validation';
import { Inject, Injectable } from '@nestjs/common';

import type { TenantTx } from '#shared/database/prisma.js';
import { validationError } from '#shared/errors/api-error.js';

import { CATALOG_ITEM_REPOSITORY } from './catalog-ports.js';
import type { CatalogItemRepository } from './catalog-ports.js';

/** Item de catálogo visto por outros módulos (somente o necessário para exibir e referenciar). */
export interface CatalogItemRef {
  readonly id: string;
  readonly catalogType: CatalogType;
  readonly code: string;
  readonly label: string;
  readonly isActive: boolean;
}

/** Tipo de fonte de pesquisa (`PRICE_SOURCE_TYPE`) com as regras de `metadata` (US-026). */
export interface PriceSourceTypeRef extends CatalogItemRef {
  readonly requiredFields: readonly PriceSourceRequiredField[];
  readonly maxAgeDays: number | null;
  /** Padrão `quoteDate` quando o tipo não informa. */
  readonly ageReference: 'quoteDate' | 'accessedAt';
}

/** Leitura defensiva de `metadata` do tipo de fonte (já validada pelo schema do catálogo). */
function priceSourceRulesOf(metadata: Readonly<Record<string, unknown>>) {
  const fields = Array.isArray(metadata.requiredFields) ? metadata.requiredFields : [];
  const known = new Set<unknown>(PRICE_SOURCE_REQUIRED_FIELDS);
  const reference = metadata.ageReference;
  return {
    requiredFields: fields.filter((field): field is PriceSourceRequiredField => known.has(field)),
    maxAgeDays:
      typeof metadata.maxAgeDays === 'number' && Number.isInteger(metadata.maxAgeDays)
        ? metadata.maxAgeDays
        : null,
    ageReference: (PRICE_SOURCE_AGE_REFERENCES as readonly unknown[]).includes(reference)
      ? (reference as 'quoteDate' | 'accessedAt')
      : 'quoteDate',
  };
}

/**
 * API pública do módulo `catalog` para os demais módulos (DEC-041): métodos de intenção,
 * nunca exposição de repositório.
 */
@Injectable()
export class CatalogFacade {
  constructor(@Inject(CATALOG_ITEM_REPOSITORY) private readonly items: CatalogItemRepository) {}

  /**
   * Ponto único de validação de referência a `CatalogItem` (US-104 · RN-PROC-16): o item existe
   * NO TENANT da transação (a RLS esconde os de outro tenant), é do `catalogType` esperado e está
   * ativo. Senão → 422 `VALIDATION_ERROR` em `field` com `REFERENCE_NOT_FOUND` (inexistente, de
   * outro tenant ou de outro catálogo — indistinguíveis) ou `REFERENCE_INACTIVE`. Itens JÁ
   * referenciados que foram desativados não passam por aqui: seguem exibidos (RN-TEN-61).
   */
  async assertActive(
    tx: TenantTx,
    catalogType: CatalogType,
    id: string,
    field: string,
  ): Promise<CatalogItemRef> {
    const item = await this.items.findById(tx, id);
    if (item?.catalogType !== catalogType) {
      throw validationError([
        { field, code: 'REFERENCE_NOT_FOUND', message: 'Selecione uma opção válida.' },
      ]);
    }
    if (!item.isActive) {
      throw validationError([
        { field, code: 'REFERENCE_INACTIVE', message: 'Esta opção não está mais disponível.' },
      ]);
    }
    return {
      id: item.id,
      catalogType: item.catalogType,
      code: item.code,
      label: item.label,
      isActive: item.isActive,
    };
  }

  /**
   * Unidades de medida (`UNIT_OF_MEASURE`) para os itens de documento (US-014 · FA-11): rótulo e
   * `metadata.allowsDecimal` (padrão `true` quando ausente), mesmo inativas (RN-TEN-61). Id de outro
   * tipo de catálogo ou de outro tenant fica fora do mapa.
   */
  async unitsOf(
    tx: TenantTx,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, { readonly label: string; readonly allowsDecimal: boolean }>> {
    const units = new Map<string, { readonly label: string; readonly allowsDecimal: boolean }>();
    for (const id of new Set(ids)) {
      const item = await this.items.findById(tx, id);
      if (item?.catalogType !== 'UNIT_OF_MEASURE') continue;
      units.set(id, { label: item.label, allowsDecimal: item.metadata.allowsDecimal !== false });
    }
    return units;
  }

  /**
   * US-026 (RN-PRICE-21 · V-02): o tipo de fonte ativo do tenant com os campos exigidos e a validade,
   * lidos no momento da gravação (não há cópia por fonte). Inválido → 422 como `assertActive`.
   */
  async assertActivePriceSourceType(
    tx: TenantTx,
    id: string,
    field: string,
  ): Promise<PriceSourceTypeRef> {
    const ref = await this.assertActive(tx, 'PRICE_SOURCE_TYPE', id, field);
    const item = await this.items.findById(tx, id);
    return { ...ref, ...priceSourceRulesOf(item?.metadata ?? {}) };
  }

  /** Tipos de fonte das fontes já gravadas (mesmo inativos — RN-TEN-61); outro tipo fica fora. */
  async priceSourceTypesOf(
    tx: TenantTx,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, PriceSourceTypeRef>> {
    const types = new Map<string, PriceSourceTypeRef>();
    for (const id of new Set(ids)) {
      const item = await this.items.findById(tx, id);
      if (item?.catalogType !== 'PRICE_SOURCE_TYPE') continue;
      types.set(id, {
        id: item.id,
        catalogType: item.catalogType,
        code: item.code,
        label: item.label,
        isActive: item.isActive,
        ...priceSourceRulesOf(item.metadata),
      });
    }
    return types;
  }

  /** Itens ATIVOS do catálogo no tenant da transação, por `sortOrder` e `code` (ex.: contexto da IA). */
  async activeItemsOf(tx: TenantTx, catalogType: CatalogType): Promise<CatalogItemRef[]> {
    return (await this.items.listAll(tx, catalogType, false))
      .filter((item) => item.isActive)
      .map((item) => ({
        id: item.id,
        catalogType: item.catalogType,
        code: item.code,
        label: item.label,
        isActive: item.isActive,
      }));
  }

  /** Leitura para exibição de registro existente: devolve o item mesmo inativo (RN-TEN-61). */
  async find(tx: TenantTx, id: string): Promise<CatalogItemRef | null> {
    const item = await this.items.findById(tx, id);
    return item === null
      ? null
      : {
          id: item.id,
          catalogType: item.catalogType,
          code: item.code,
          label: item.label,
          isActive: item.isActive,
        };
  }
}
