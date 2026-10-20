import type { TenantTx } from '#shared/database/prisma.js';

import type { EtpAlternative } from '../domain/etp-alternative.js';
import type { Etp } from '../domain/etp.js';

/*
 * Portas da aplicação do ETP (US-019) e das alternativas (US-021): implementadas em `infrastructure/` (Prisma) e em memória nos
 * testes e no modo de identidade fake (local/dev/test sem banco).
 */

export interface EtpRepository {
  insert(tx: TenantTx, etp: Etp): Promise<void>;
  /** `null` se inexistente ou de outro tenant (RLS — 404 indistinguível). */
  findById(tx: TenantTx, id: string): Promise<Etp | null>;
  /** ETPs do processo (ativos e cancelados), por criação. */
  listByProcess(tx: TenantTx, processId: string): Promise<Etp[]>;
  /**
   * RN-ETP-21: grava `recommendedAlternativeId` (desnormalizado) com `version + 1` — no `tx` da
   * decisão, com o documento ETP travado pela guarda (sem `If-Match` próprio).
   */
  setRecommendedAlternative(tx: TenantTx, etp: Etp): Promise<void>;
  /**
   * ETP-04: origem, valor e pesquisa vinculada (US-022), conclusão e parcelamento (US-023) com
   * `version = expectedVersion + 1`, condicionado à versão (DEC-055). @throws VersionConflictError
   */
  updateHeader(tx: TenantTx, etp: Etp, expectedVersion: number): Promise<void>;
}

export const ETP_REPOSITORY = Symbol('EtpRepository');

/**
 * Índice único parcial violado na gravação (a corrida que a leitura prévia não viu): o nome no
 * ETP-06/07 (a decisão não muda ali) ou a segunda recomendada no ETP-09 (o nome não muda ali).
 */
export class EtpAlternativeUniqueViolation extends Error {
  constructor() {
    super('etp_alternatives: unicidade parcial violada');
    this.name = 'EtpAlternativeUniqueViolation';
  }
}

export interface EtpAlternativeRepository {
  /** Não excluídas do ETP por `sortOrder`, criação e id (RN-ETP-23). */
  listByEtp(tx: TenantTx, etpId: string): Promise<EtpAlternative[]>;
  /** `null` se inexistente, excluída ou de outro tenant (a RLS decide — 404). */
  findById(tx: TenantTx, id: string): Promise<EtpAlternative | null>;
  /** @throws EtpAlternativeUniqueViolation nome repetido no ETP (RN-ETP-18). */
  insert(tx: TenantTx, alternative: EtpAlternative): Promise<void>;
  /**
   * `version = expectedVersion + 1`, condicionado à versão (DEC-055).
   * @throws VersionConflictError
   * @throws EtpAlternativeUniqueViolation nome repetido ou segunda recomendada (RN-ETP-18/20)
   */
  update(tx: TenantTx, alternative: EtpAlternative, expectedVersion: number): Promise<void>;
  /** RN-ETP-22: exclusão lógica condicionada à versão. @throws VersionConflictError */
  softDelete(
    tx: TenantTx,
    alternative: EtpAlternative,
    expectedVersion: number,
    deletion: { readonly at: Date; readonly userId: string | null },
  ): Promise<void>;
  /** Nomes (inclusive excluídas — o fato já aconteceu) para a timeline. */
  names(tx: TenantTx, ids: readonly string[]): Promise<Map<string, { readonly name: string }>>;
}

export const ETP_ALTERNATIVE_REPOSITORY = Symbol('EtpAlternativeRepository');

/** Transações do módulo: Prisma (`TenantTransaction`) ou simulada em memória. */
export interface EtpTransactions {
  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
}

export const ETP_TRANSACTIONS = Symbol('EtpTransactions');

export type EtpClock = () => Date;

export const ETP_CLOCK = Symbol('EtpClock');
