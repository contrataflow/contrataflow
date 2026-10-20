import { Injectable } from '@nestjs/common';

import { currentRequestContext } from '#shared/context/request-context.js';
import { VersionConflictError } from '#shared/database/errors.js';
import type { TenantTx } from '#shared/database/prisma.js';
import { FAKE_TENANTS } from '#shared/testing/fake-directory.js';

import { HolidayAlreadyExistsError } from '../application/holiday-ports.js';
import type {
  CalendarSettings,
  CalendarSettingsReader,
  HolidayListFilter,
  HolidayPage,
  HolidayRepository,
} from '../application/holiday-ports.js';
import { holidayKey } from '../domain/holiday.js';
import type { Holiday } from '../domain/holiday.js';

function byDate(a: Holiday, b: Holiday): number {
  return a.date.localeCompare(b.date) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

/**
 * Feriados em memória (testes e modo de identidade fake de local/dev/test): mesma semântica do
 * adaptador Prisma — isolamento pelo tenant do contexto da requisição (como o `app.tenant_id` da
 * RLS), unicidade `(tenant, data, nome em minúsculas)` e concorrência otimista por versão.
 */
@Injectable()
export class InMemoryHolidayRepository implements HolidayRepository {
  private readonly rows = new Map<string, Holiday>();

  private tenantId(): string | null {
    return currentRequestContext()?.tenantId ?? null;
  }

  private inTenant(): Holiday[] {
    const tenantId = this.tenantId();
    return [...this.rows.values()].filter((holiday) => holiday.tenantId === tenantId);
  }

  private taken(holiday: Holiday): boolean {
    const key = holidayKey(holiday.date, holiday.name);
    return this.inTenant().some(
      (existing) => existing.id !== holiday.id && holidayKey(existing.date, existing.name) === key,
    );
  }

  list(_tx: TenantTx, filter: HolidayListFilter): Promise<HolidayPage> {
    const prefix = `${String(filter.year).padStart(4, '0')}-`;
    const matching = this.inTenant()
      .filter((holiday) => holiday.date.startsWith(prefix))
      .sort(byDate);
    const start = (filter.page - 1) * filter.pageSize;
    return Promise.resolve({
      items: matching.slice(start, start + filter.pageSize),
      totalItems: matching.length,
    });
  }

  findById(_tx: TenantTx, id: string): Promise<Holiday | null> {
    return Promise.resolve(this.inTenant().find((holiday) => holiday.id === id) ?? null);
  }

  activeBetween(_tx: TenantTx, from: string, to: string): Promise<Holiday[]> {
    return Promise.resolve(
      this.inTenant()
        .filter((holiday) => holiday.isActive && holiday.date >= from && holiday.date <= to)
        .sort(byDate),
    );
  }

  insert(_tx: TenantTx, holiday: Holiday): Promise<void> {
    if (this.taken(holiday)) return Promise.reject(new HolidayAlreadyExistsError());
    this.rows.set(holiday.id, holiday);
    return Promise.resolve();
  }

  update(_tx: TenantTx, holiday: Holiday, expectedVersion: number): Promise<void> {
    const current = this.inTenant().find((existing) => existing.id === holiday.id);
    if (current?.version !== expectedVersion) {
      return Promise.reject(
        new VersionConflictError({
          aggregateType: 'Holiday',
          aggregateId: holiday.id,
          expectedVersion,
        }),
      );
    }
    if (this.taken(holiday)) return Promise.reject(new HolidayAlreadyExistsError());
    // `date`, tenant e `isSystem` nunca mudam (gatilho do banco).
    this.rows.set(holiday.id, {
      ...current,
      name: holiday.name,
      scope: holiday.scope,
      isRecurring: holiday.isRecurring,
      isActive: holiday.isActive,
      updatedAt: holiday.updatedAt,
      updatedById: holiday.updatedById,
      version: expectedVersion + 1,
    });
    return Promise.resolve();
  }

  delete(_tx: TenantTx, holiday: Holiday, expectedVersion: number): Promise<void> {
    const current = this.inTenant().find((existing) => existing.id === holiday.id);
    if (current?.version !== expectedVersion) {
      return Promise.reject(
        new VersionConflictError({
          aggregateType: 'Holiday',
          aggregateId: holiday.id,
          expectedVersion,
        }),
      );
    }
    this.rows.delete(holiday.id);
    return Promise.resolve();
  }

  insertMissing(_tx: TenantTx, holidays: readonly Holiday[]): Promise<number> {
    let created = 0;
    for (const holiday of holidays) {
      const key = holidayKey(holiday.date, holiday.name);
      const exists = [...this.rows.values()].some(
        (existing) =>
          existing.tenantId === holiday.tenantId &&
          holidayKey(existing.date, existing.name) === key,
      );
      if (exists) continue;
      this.rows.set(holiday.id, holiday);
      created += 1;
    }
    return Promise.resolve(created);
  }

  existingKeys(_tx: TenantTx, from: string, to: string): Promise<ReadonlySet<string>> {
    return Promise.resolve(
      new Set(
        this.inTenant()
          .filter((holiday) => holiday.date >= from && holiday.date <= to)
          .map((holiday) => holidayKey(holiday.date, holiday.name)),
      ),
    );
  }

  /** Inspeção e carga de testes: todos os feriados de todos os tenants. */
  snapshot(): readonly Holiday[] {
    return [...this.rows.values()];
  }

  /** Carga de testes (feriado de outro tenant, feriados já existentes…). */
  seed(...holidays: readonly Holiday[]): void {
    for (const holiday of holidays) this.rows.set(holiday.id, holiday);
  }
}

/**
 * Fuso e configuração de calendário em memória: o fuso vem do diretório fake de tenants (padrão
 * `America/Sao_Paulo`); `set` ajusta um tenant nos testes.
 */
@Injectable()
export class InMemoryCalendarSettingsReader implements CalendarSettingsReader {
  private readonly overrides = new Map<string, Partial<CalendarSettings>>();

  read(_tx: TenantTx, tenantId: string): Promise<CalendarSettings> {
    const fake = Object.values(FAKE_TENANTS).find((tenant) => tenant.id === tenantId);
    const override = this.overrides.get(tenantId);
    return Promise.resolve({
      timezone: override?.timezone ?? fake?.timezone ?? 'America/Sao_Paulo',
      optionalHolidaysAreNonBusiness: override?.optionalHolidaysAreNonBusiness ?? false,
    });
  }

  set(tenantId: string, settings: Partial<CalendarSettings>): void {
    this.overrides.set(tenantId, settings);
  }
}
