import type { TenantTx } from '#shared/database/prisma.js';

import type { Holiday } from '../domain/holiday.js';

/*
 * Portas da aplicação do calendário (US-106): implementadas em `infrastructure/` (Prisma) e em
 * memória nos testes e no modo de identidade fake (local/dev/test sem banco). As transações e o
 * relógio são os do módulo (`CATALOG_TRANSACTIONS`/`CATALOG_CLOCK`).
 */

/** `(date, lower(name))` já existe no tenant (índice único — V-03 · RN-TEN-75). */
export class HolidayAlreadyExistsError extends Error {
  constructor() {
    super('Já existe um feriado com esta data e nome no tenant.');
    this.name = 'HolidayAlreadyExistsError';
  }
}

export interface HolidayListFilter {
  /** Ano civil da data do feriado. */
  readonly year: number;
  readonly page: number;
  readonly pageSize: number;
}

export interface HolidayPage {
  readonly items: readonly Holiday[];
  readonly totalItems: number;
}

export interface HolidayRepository {
  /** Feriados (ativos e inativos) do ano, por data e nome — tenant da transação (RLS). */
  list(tx: TenantTx, filter: HolidayListFilter): Promise<HolidayPage>;
  /** `null` se o id não existe NO TENANT da transação (outro tenant → `null`, nunca o registro). */
  findById(tx: TenantTx, id: string): Promise<Holiday | null>;
  /** Feriados ATIVOS de `from` a `to` (inclusive), para o cálculo de dias úteis. */
  activeBetween(tx: TenantTx, from: string, to: string): Promise<Holiday[]>;
  /** @throws HolidayAlreadyExistsError */
  insert(tx: TenantTx, holiday: Holiday): Promise<void>;
  /**
   * Grava nome, escopo, recorrência e `isActive` com `version = version + 1` condicionada a
   * `expectedVersion` (DEC-055). `date`, tenant e `isSystem` nunca mudam.
   * @throws VersionConflictError
   */
  update(tx: TenantTx, holiday: Holiday, expectedVersion: number): Promise<void>;
  /** @throws VersionConflictError */
  delete(tx: TenantTx, holiday: Holiday, expectedVersion: number): Promise<void>;
  /** Seeder: grava só os feriados cujo `(date, lower(name))` ainda não existe; devolve quantos criou. */
  insertMissing(tx: TenantTx, holidays: readonly Holiday[]): Promise<number>;
  /** Seeder: chaves `holidayKey(date, name)` dos feriados existentes entre as datas. */
  existingKeys(tx: TenantTx, from: string, to: string): Promise<ReadonlySet<string>>;
}

export const HOLIDAY_REPOSITORY = Symbol('HolidayRepository');

/** Fuso e configuração de calendário do tenant (`tenants.timezone`, `calendar.*`). */
export interface CalendarSettings {
  /** Fuso IANA (DEC-003). */
  readonly timezone: string;
  /** `calendar.optionalHolidaysAreNonBusiness` (padrão `false`). */
  readonly optionalHolidaysAreNonBusiness: boolean;
}

export interface CalendarSettingsReader {
  read(tx: TenantTx, tenantId: string): Promise<CalendarSettings>;
}

export const CALENDAR_SETTINGS_READER = Symbol('CalendarSettingsReader');
