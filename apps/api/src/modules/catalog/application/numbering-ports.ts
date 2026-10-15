import type { NumberingScope } from '@contrataflow/validation';

import type { TenantTx } from '#shared/database/prisma.js';

/*
 * Portas da numeração (US-105): implementadas em `infrastructure/` (PostgreSQL) e em memória nos
 * testes e no modo de identidade fake (local/dev/test sem banco). Transações e relógio são os do
 * módulo (`CATALOG_TRANSACTIONS`/`CATALOG_CLOCK`).
 */

export interface NumberSequenceRepository {
  /**
   * RN-TEN-69: cria a linha sob demanda (`INSERT … ON CONFLICT DO NOTHING`) e incrementa com
   * `UPDATE … SET last_value = last_value + 1 RETURNING last_value` — SEMPRE na transação do recurso
   * numerado: a linha fica bloqueada até o commit e o rollback desfaz o incremento.
   */
  increment(tx: TenantTx, sequenceKey: string): Promise<number>;
  /** Último valor emitido (0 se a sequência ainda não existe) — leitura sem bloqueio (RN-TEN-73). */
  lastValue(tx: TenantTx, sequenceKey: string): Promise<number>;
  /** Alguma chave de processo já aberta no ano (`PROCESS:<org|*>:<ano>`), ou `null` (RN-TEN-68). */
  openedProcessKeyOfYear(tx: TenantTx, year: number): Promise<string | null>;
}

export const NUMBER_SEQUENCE_REPOSITORY = Symbol('NumberSequenceRepository');

/** Configuração efetiva de numeração do tenant (`numbering.*` gravadas ou padrões, e o fuso). */
export interface NumberingSettings {
  /** Fuso IANA do tenant (`tenants.timezone` — RN-TEN-70). */
  readonly timezone: string;
  readonly processMask: string;
  readonly processScope: NumberingScope;
  readonly documentDefaultMask: string;
  /** `numbering.document.<TYPE>.mask` gravadas, por código do tipo (RN-TEN-72). */
  readonly documentMasks: ReadonlyMap<string, string>;
}

export interface NumberingOrganization {
  readonly id: string;
  /** Sigla (`Organization.shortName`) usada em `{org}`. */
  readonly shortName: string;
}

export interface NumberingSettingsReader {
  read(tx: TenantTx, tenantId: string): Promise<NumberingSettings>;
  /** Órgão do tenant da transação, ou `null` (outro tenant ou inexistente). */
  organization(tx: TenantTx, organizationId: string): Promise<NumberingOrganization | null>;
  /** Órgão principal do tenant (`tenants.primary_organization_id`), usado na prévia. */
  primaryOrganization(tx: TenantTx, tenantId: string): Promise<NumberingOrganization | null>;
}

export const NUMBERING_SETTINGS_READER = Symbol('NumberingSettingsReader');
