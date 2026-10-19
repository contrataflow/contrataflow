import type { TenantTx } from '#shared/database/prisma.js';

import type { TermOfReference } from '../domain/term-of-reference.js';

/*
 * Portas da aplicação do TR (US-036): implementadas em `infrastructure/` (Prisma) e em memória nos
 * testes e no modo de identidade fake (local/dev/test sem banco).
 */

export interface TermRepository {
  insert(tx: TenantTx, term: TermOfReference): Promise<void>;
  /** `null` se inexistente ou de outro tenant (RLS — 404 indistinguível). */
  findById(tx: TenantTx, id: string): Promise<TermOfReference | null>;
  /** TRs do processo (ativos e cancelados), por criação. */
  listByProcess(tx: TenantTx, processId: string): Promise<TermOfReference[]>;
  /**
   * Objeto e valor estimado com `version = expectedVersion + 1`, condicionado à versão (DEC-055).
   * @throws VersionConflictError
   */
  updateHeader(tx: TenantTx, term: TermOfReference, expectedVersion: number): Promise<void>;
}

export const TERM_REPOSITORY = Symbol('TermRepository');

/** Transações do módulo: Prisma (`TenantTransaction`) ou simulada em memória. */
export interface TermTransactions {
  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
}

export const TERM_TRANSACTIONS = Symbol('TermTransactions');

export type TermClock = () => Date;

export const TERM_CLOCK = Symbol('TermClock');
