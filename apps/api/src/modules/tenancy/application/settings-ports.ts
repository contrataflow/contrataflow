import type { TenantTx } from '#shared/database/prisma.js';

import type { StoredSetting } from '../domain/settings-update.js';

/*
 * Portas da aplicação das configurações do tenant (US-103): implementadas em `infrastructure/`
 * (Prisma) e em memória nos testes e no modo de identidade fake.
 */

/** Chave que ganhou linha entre a leitura e o INSERT (corrida de primeira gravação — RN-TEN-54). */
export class SettingAlreadyExistsError extends Error {
  constructor(readonly key: string) {
    super('Configuração já gravada por outra requisição.');
    this.name = 'SettingAlreadyExistsError';
  }
}

export interface SettingWrite {
  readonly tenantId: string;
  readonly key: string;
  readonly value: unknown;
  readonly userId: string | null;
  readonly now: Date;
}

export interface TenantSettingsRepository {
  /** Linhas do tenant da transação (outro tenant nunca aparece — RLS + extensão de isolamento). */
  list(tx: TenantTx): Promise<StoredSetting[]>;
  /** Primeira gravação da chave (versão 1). @throws SettingAlreadyExistsError */
  insert(tx: TenantTx, write: SettingWrite): Promise<void>;
  /**
   * Grava o valor com `version = version + 1` condicionada a `expectedVersion` (DEC-055).
   * @throws VersionConflictError
   */
  update(tx: TenantTx, write: SettingWrite, expectedVersion: number): Promise<void>;
  /** Grava as chaves AINDA sem linha (versão 1), sem tocar nas existentes; devolve quantas criou. */
  insertMissing(tx: TenantTx, writes: readonly SettingWrite[]): Promise<number>;
}

export const TENANT_SETTINGS_REPOSITORY = Symbol('TenantSettingsRepository');

/** Transações do módulo: Prisma (`TenantTransaction`) ou simulada em memória. */
export interface SettingsTransactions {
  run<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
  read<T>(work: (tx: TenantTx) => Promise<T>): Promise<T>;
}

export const SETTINGS_TRANSACTIONS = Symbol('SettingsTransactions');

export type SettingsClock = () => Date;

export const SETTINGS_CLOCK = Symbol('SettingsClock');
