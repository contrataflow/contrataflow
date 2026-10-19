import type { TenantTx } from '#shared/database/prisma.js';

import type { PriceItem, PriceResearch } from '../domain/price-research.js';
import type { PriceSource, Quotation } from '../domain/price-source.js';

/*
 * Portas da aplicação da pesquisa de preços (US-024): implementadas em `infrastructure/` (Prisma) e
 * em memória nos testes e no modo de identidade fake (local/dev/test sem banco).
 */

export interface PriceItemFilter {
  readonly lot?: number | undefined;
  readonly hasAlerts?: boolean | undefined;
  /** Itens do processo do lote pedido (o lote é do `ProcessItem`, resolvido por quem chama). */
  readonly processItemIds?: readonly string[] | undefined;
}

export interface PriceResearchRepository {
  insert(tx: TenantTx, research: PriceResearch): Promise<void>;
  /** `null` se inexistente ou de outro tenant (RLS — 404 indistinguível). */
  findById(tx: TenantTx, id: string): Promise<PriceResearch | null>;
  /**
   * Trava a linha da pesquisa (`SELECT … FOR UPDATE`) até o fim do `tx` e a relê: toda mutação
   * serializa por aqui (recálculo dos contadores — "Impacto técnico").
   */
  lockById(tx: TenantTx, id: string): Promise<PriceResearch | null>;
  /** Pesquisas do processo (ativas e canceladas), por criação. */
  listByProcess(tx: TenantTx, processId: string): Promise<PriceResearch[]>;
  /** Grava com `version + 1`; `VersionConflictError` se a versão mudou. */
  update(tx: TenantTx, research: PriceResearch, expectedVersion: number): Promise<void>;

  /** Inserção em lote (`createMany` — até 1.000 itens). */
  insertItems(tx: TenantTx, items: readonly PriceItem[]): Promise<void>;
  /** Itens da pesquisa por `sortOrder` (todas as linhas — recálculo e contadores). */
  listItems(tx: TenantTx, priceResearchId: string): Promise<PriceItem[]>;
  /** Página de itens (PRS-05) por `sortOrder`, com o total filtrado. */
  pageItems(
    tx: TenantTx,
    priceResearchId: string,
    filter: PriceItemFilter,
    window: { readonly skip: number; readonly take: number },
  ): Promise<{ readonly items: PriceItem[]; readonly total: number }>;
  findItem(tx: TenantTx, itemId: string): Promise<PriceItem | null>;
  /** Regrava as colunas calculadas e os alertas das linhas (`version + 1` em cada). */
  updateItems(tx: TenantTx, items: readonly PriceItem[]): Promise<void>;
  /**
   * PRS-07 (US-029): quantidade, método, valor manual e as colunas calculadas do item, com a versão
   * do `If-Match` (`version + 1`); `VersionConflictError` se a versão mudou.
   */
  updateItem(tx: TenantTx, item: PriceItem, expectedVersion: number): Promise<void>;
  /**
   * Remoção física da linha (RN-PRICE-11) com a versão do `If-Match`; as cotações vão em cascata
   * (`ON DELETE CASCADE`). `VersionConflictError` se a versão mudou.
   */
  deleteItem(tx: TenantTx, item: PriceItem, expectedVersion: number): Promise<void>;
  /** Linhas que referenciam os itens do processo (uso do item — `ITEM_IN_USE` da US-006). */
  itemsReferencing(tx: TenantTx, processItemIds: readonly string[]): Promise<PriceItem[]>;
}

export const PRICE_RESEARCH_REPOSITORY = Symbol('PriceResearchRepository');

/**
 * Fontes e cotações (US-026). Toda escrita acontece com a linha da pesquisa travada
 * (`PriceResearchGate.writable`), o que serializa as gravações concorrentes da mesma pesquisa.
 */
export interface PriceSourceRepository {
  insertSource(tx: TenantTx, source: PriceSource): Promise<void>;
  /** `null` se inexistente ou de outro tenant (RLS — 404 indistinguível). */
  findSource(tx: TenantTx, id: string): Promise<PriceSource | null>;
  /** Fontes da pesquisa por `sortOrder` e criação. */
  listSources(tx: TenantTx, priceResearchId: string): Promise<PriceSource[]>;
  /** Próximo `sortOrder` da pesquisa (a fonte nova vai para o fim da lista). */
  nextSortOrder(tx: TenantTx, priceResearchId: string): Promise<number>;
  /** Grava com `version + 1`; `VersionConflictError` se a versão mudou. */
  updateSource(tx: TenantTx, source: PriceSource, expectedVersion: number): Promise<void>;
  /**
   * Remoção física (RN-PRICE-29) com a versão do `If-Match`; as cotações vão em cascata
   * (`ON DELETE CASCADE`). `VersionConflictError` se a versão mudou.
   */
  deleteSource(tx: TenantTx, source: PriceSource, expectedVersion: number): Promise<void>;

  /** Cotações da pesquisa (todas as fontes) — recálculo e PRS-09. */
  listQuotations(tx: TenantTx, priceResearchId: string): Promise<Quotation[]>;
  findQuotation(tx: TenantTx, id: string): Promise<Quotation | null>;
  insertQuotations(tx: TenantTx, quotations: readonly Quotation[]): Promise<void>;
  /** Grava preço/marca/validade com `version + 1`; `VersionConflictError` se a versão mudou. */
  updateQuotation(tx: TenantTx, quotation: Quotation, expectedVersion: number): Promise<void>;
  /** Remoção física da cotação (PRS-15) com a versão do `If-Match`. */
  deleteQuotation(tx: TenantTx, quotation: Quotation, expectedVersion: number): Promise<void>;
  /** Cotações registradas por item (válidas ou não) — `quotationsCount` e confirmação do PRS-08. */
  quotationCounts(tx: TenantTx, itemIds: readonly string[]): Promise<ReadonlyMap<string, number>>;
  /** Uso do fornecedor por alguma fonte do tenant (SUP-05 — RN-PRICE-19). */
  isSupplierInUse(tx: TenantTx, supplierId: string): Promise<boolean>;
}

export const PRICE_SOURCE_REPOSITORY = Symbol('PriceSourceRepository');

/** Transações do módulo: Prisma (`TenantTransaction`) ou simulada em memória. */
export interface PriceResearchTransactions {
  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
}

export const PRICE_RESEARCH_TRANSACTIONS = Symbol('PriceResearchTransactions');

export type PriceResearchClock = () => Date;

export const PRICE_RESEARCH_CLOCK = Symbol('PriceResearchClock');
