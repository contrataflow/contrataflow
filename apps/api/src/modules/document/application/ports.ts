import type { TenantTx } from '#shared/database/prisma.js';

import type { DocumentType } from '../domain/document-type.js';

/*
 * Portas da aplicação do módulo `document` (US-061): implementadas em `infrastructure/` (Prisma) e
 * em memória nos testes e no modo de identidade fake (local/dev/test sem banco).
 */

/** Código de tipo já usado no tenant (índice único `(tenant_id, code)` — V-05). */
export class DocumentTypeCodeTakenError extends Error {
  constructor(readonly code: string) {
    super('Código de tipo de documento já usado no tenant.');
    this.name = 'DocumentTypeCodeTakenError';
  }
}

export interface DocumentTypeRepository {
  /** Todos os tipos do tenant da transação (ativos e inativos), por ordem de exibição e nome. */
  list(tx: TenantTx): Promise<DocumentType[]>;
  /** `null` se o id não existe NO TENANT da transação (outro tenant → `null`, nunca o registro). */
  findById(tx: TenantTx, id: string): Promise<DocumentType | null>;
  findByCode(tx: TenantTx, code: string): Promise<DocumentType | null>;
  /** @throws DocumentTypeCodeTakenError */
  insert(tx: TenantTx, type: DocumentType): Promise<void>;
  /**
   * Grava o tipo com `version = version + 1` condicionada a `expectedVersion` (DEC-055).
   * @throws VersionConflictError
   */
  update(tx: TenantTx, type: DocumentType, expectedVersion: number): Promise<void>;
  /** Semeadura idempotente: grava só os códigos que o tenant ainda não tem. Devolve quantos. */
  insertMissing(tx: TenantTx, types: readonly DocumentType[]): Promise<number>;
}

export const DOCUMENT_TYPE_REPOSITORY = Symbol('DocumentTypeRepository');

/** Transações do módulo: Prisma (`TenantTransaction`) ou simulada em memória. */
export interface DocumentTransactions {
  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
}

export const DOCUMENT_TRANSACTIONS = Symbol('DocumentTransactions');

/**
 * Documentos existentes por tipo (RN-DOC-04 · prévia de impacto). A tabela `documents` chega com a
 * US-062/US-065; até lá não há documento algum e a contagem é 0.
 */
export interface DocumentCounter {
  countByType(tx: TenantTx, documentTypeId: string): Promise<number>;
}

export const DOCUMENT_COUNTER = Symbol('DocumentCounter');

export type DocumentClock = () => Date;

export const DOCUMENT_CLOCK = Symbol('DocumentClock');
