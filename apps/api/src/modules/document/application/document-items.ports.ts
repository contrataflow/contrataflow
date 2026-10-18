import type { TenantTx } from '#shared/database/prisma.js';

import type { DocumentItem } from '../domain/document-items.js';

/*
 * Porta de `document_items` (US-014 · DOC-06/07): PostgreSQL no `tx` da `TenantTransaction` (RLS
 * do tenant) ou memória (testes e modo de identidade fake).
 */

/** Documento que referencia um item do processo (uso do item — ITEM_IN_USE da US-006). */
export interface DocumentItemReference {
  readonly processItemId: string;
  readonly documentId: string;
}

export interface DocumentItemRepository {
  /** Linhas do documento por `sortOrder` e criação. */
  listByDocument(tx: TenantTx, documentId: string): Promise<DocumentItem[]>;
  /**
   * Substitui a coleção do documento (o documento já está travado pelo caso de uso): remove as
   * linhas fora de `items`, grava as alteradas e insere as novas.
   */
  replace(tx: TenantTx, documentId: string, items: readonly DocumentItem[]): Promise<void>;
  /** Linhas que referenciam os itens do processo (no tenant da transação). */
  referencesTo(tx: TenantTx, processItemIds: readonly string[]): Promise<DocumentItemReference[]>;
}

export const DOCUMENT_ITEM_REPOSITORY = Symbol('DocumentItemRepository');
