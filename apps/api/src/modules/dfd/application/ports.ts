import type { TenantTx } from '#shared/database/prisma.js';

import type { Dfd } from '../domain/dfd.js';

/*
 * Portas da aplicação do DFD (US-014): implementadas em `infrastructure/` (Prisma) e em memória nos
 * testes e no modo de identidade fake (local/dev/test sem banco).
 */

export interface DfdRepository {
  insert(tx: TenantTx, dfd: Dfd): Promise<void>;
  /** `null` se inexistente ou de outro tenant (RLS — 404 indistinguível). */
  findById(tx: TenantTx, id: string): Promise<Dfd | null>;
  /** DFDs do processo (ativos e cancelados), por criação. */
  listByProcess(tx: TenantTx, processId: string): Promise<Dfd[]>;
}

export const DFD_REPOSITORY = Symbol('DfdRepository');

/** Transações do módulo: Prisma (`TenantTransaction`) ou simulada em memória. */
export interface DfdTransactions {
  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
}

export const DFD_TRANSACTIONS = Symbol('DfdTransactions');

export type DfdClock = () => Date;

export const DFD_CLOCK = Symbol('DfdClock');
