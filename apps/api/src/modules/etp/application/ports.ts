import type { TenantTx } from '#shared/database/prisma.js';

import type { Etp } from '../domain/etp.js';

/*
 * Portas da aplicação do ETP (US-019): implementadas em `infrastructure/` (Prisma) e em memória nos
 * testes e no modo de identidade fake (local/dev/test sem banco).
 */

export interface EtpRepository {
  insert(tx: TenantTx, etp: Etp): Promise<void>;
  /** `null` se inexistente ou de outro tenant (RLS — 404 indistinguível). */
  findById(tx: TenantTx, id: string): Promise<Etp | null>;
  /** ETPs do processo (ativos e cancelados), por criação. */
  listByProcess(tx: TenantTx, processId: string): Promise<Etp[]>;
}

export const ETP_REPOSITORY = Symbol('EtpRepository');

/** Transações do módulo: Prisma (`TenantTransaction`) ou simulada em memória. */
export interface EtpTransactions {
  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
}

export const ETP_TRANSACTIONS = Symbol('EtpTransactions');

export type EtpClock = () => Date;

export const ETP_CLOCK = Symbol('EtpClock');
