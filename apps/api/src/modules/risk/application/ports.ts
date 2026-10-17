import type { RiskPhase, RiskStatus } from '@contrataflow/validation';

import type { TenantTx } from '#shared/database/prisma.js';

import type { Risk } from '../domain/risk.js';

/*
 * Portas da aplicação dos riscos (US-033): implementadas em `infrastructure/` (Prisma) e em memória
 * nos testes e no modo de identidade fake (local/dev/test sem banco).
 */

export interface RiskListFilter {
  readonly phase?: RiskPhase | undefined;
  readonly categoryId?: string | undefined;
  readonly status?: RiskStatus | undefined;
}

/** Tratamento vinculado (US-034), como a exclusão do risco o lê e remove (RN-RISK-10). */
export interface RiskTreatmentRef {
  readonly id: string;
  readonly riskId: string;
  readonly type: 'PREVENTIVE' | 'CONTINGENCY';
  readonly description: string;
  readonly status: 'PLANNED' | 'IN_PROGRESS' | 'DONE' | 'CANCELED';
}

export interface RiskRepository {
  /** Riscos não excluídos do processo por `sortOrder`, `code` (RSK-01). */
  listByProcess(tx: TenantTx, processId: string, filter: RiskListFilter): Promise<Risk[]>;
  /** `null` se inexistente, excluído ou de outro tenant (a RLS decide — 404). */
  findById(tx: TenantTx, id: string): Promise<Risk | null>;
  /** Processo do risco (inclusive excluído — para a fonte da timeline); `null` fora do tenant. */
  processOf(tx: TenantTx, id: string): Promise<string | null>;
  /**
   * Serializa a numeração do processo até o fim do `tx` (`pg_advisory_xact_lock` por processo):
   * duas criações simultâneas leem os códigos uma depois da outra (RN-RISK-02 · Concorrência).
   */
  lockProcessCodes(tx: TenantTx, processId: string): Promise<void>;
  /** Todos os códigos já usados no processo, INCLUSIVE os excluídos (nunca reaproveitados). */
  usedCodes(tx: TenantTx, processId: string): Promise<string[]>;
  insert(tx: TenantTx, risk: Risk): Promise<void>;
  /** `version = expectedVersion + 1`, condicionado à versão (DEC-055). @throws VersionConflictError */
  update(tx: TenantTx, risk: Risk, expectedVersion: number): Promise<void>;
  /** Exclusão lógica condicionada à versão. @throws VersionConflictError */
  softDelete(
    tx: TenantTx,
    risk: Risk,
    expectedVersion: number,
    deletion: { readonly at: Date; readonly userId: string | null },
  ): Promise<void>;
  /** Tratamentos não excluídos dos riscos (diálogo de exclusão e DTO). */
  treatmentsOf(tx: TenantTx, riskIds: readonly string[]): Promise<RiskTreatmentRef[]>;
  /** RN-RISK-10: exclusão lógica em cascata dos tratamentos do risco; devolve quantos. */
  softDeleteTreatments(
    tx: TenantTx,
    riskId: string,
    deletion: { readonly at: Date; readonly userId: string | null },
  ): Promise<number>;
  /** Código e título (inclusive excluídos — o fato já aconteceu) para a timeline. */
  labels(
    tx: TenantTx,
    ids: readonly string[],
  ): Promise<Map<string, { readonly code: string; readonly title: string }>>;
}

export const RISK_REPOSITORY = Symbol('RiskRepository');

/** Transações do módulo: Prisma (`TenantTransaction`) ou simulada em memória. */
export interface RiskTransactions {
  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
}

export const RISK_TRANSACTIONS = Symbol('RiskTransactions');

export type RiskClock = () => Date;

export const RISK_CLOCK = Symbol('RiskClock');
