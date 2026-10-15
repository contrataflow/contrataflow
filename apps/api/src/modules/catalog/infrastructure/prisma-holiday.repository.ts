import { Injectable } from '@nestjs/common';

import { isUniqueViolation } from '#shared/database/errors.js';
import { assertVersionMatched, updateVersioned } from '#shared/database/optimistic-concurrency.js';
import type { Prisma, TenantTx } from '#shared/database/prisma.js';

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

type Row = Prisma.HolidayGetPayload<object>;

const ORDER: Prisma.HolidayOrderByWithRelationInput[] = [
  { date: 'asc' },
  { name: 'asc' },
  { id: 'asc' },
];

/** `YYYY-MM-DD` → `DATE` do PostgreSQL (meia-noite UTC; a coluna não tem fuso). */
function toDbDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function fromDbDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function toDomain(row: Row): Holiday {
  return {
    id: row.id,
    tenantId: row.tenantId,
    date: fromDbDate(row.date),
    name: row.name,
    scope: row.scope,
    isRecurring: row.isRecurring,
    isSystem: row.isSystem,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdById: row.createdById,
    updatedById: row.updatedById,
    version: row.version,
  };
}

function toCreateData(holiday: Holiday): Prisma.HolidayUncheckedCreateInput {
  return {
    id: holiday.id,
    tenantId: holiday.tenantId,
    date: toDbDate(holiday.date),
    name: holiday.name,
    scope: holiday.scope,
    isRecurring: holiday.isRecurring,
    isSystem: holiday.isSystem,
    isActive: holiday.isActive,
    createdAt: holiday.createdAt,
    updatedAt: holiday.updatedAt,
    createdById: holiday.createdById,
    updatedById: holiday.updatedById,
    version: holiday.version,
  };
}

/**
 * `holidays` no PostgreSQL (US-106): leituras e escritas no `tx` do caso de uso, sob a RLS do
 * tenant e a extensão de isolamento (que injeta o `tenantId`). A exclusão física vale só para
 * feriado que não é de sistema (o gatilho do banco recusa o contrário — RN-TEN-77).
 */
@Injectable()
export class PrismaHolidayRepository implements HolidayRepository {
  async list(tx: TenantTx, filter: HolidayListFilter): Promise<HolidayPage> {
    const where: Prisma.HolidayWhereInput = {
      date: {
        gte: toDbDate(`${String(filter.year).padStart(4, '0')}-01-01`),
        lte: toDbDate(`${String(filter.year).padStart(4, '0')}-12-31`),
      },
    };
    const [rows, totalItems] = await Promise.all([
      tx.holiday.findMany({
        where,
        orderBy: ORDER,
        skip: (filter.page - 1) * filter.pageSize,
        take: filter.pageSize,
      }),
      tx.holiday.count({ where }),
    ]);
    return { items: rows.map(toDomain), totalItems };
  }

  async findById(tx: TenantTx, id: string): Promise<Holiday | null> {
    const row = await tx.holiday.findFirst({ where: { id } });
    return row === null ? null : toDomain(row);
  }

  async activeBetween(tx: TenantTx, from: string, to: string): Promise<Holiday[]> {
    const rows = await tx.holiday.findMany({
      where: { isActive: true, date: { gte: toDbDate(from), lte: toDbDate(to) } },
      orderBy: ORDER,
    });
    return rows.map(toDomain);
  }

  async insert(tx: TenantTx, holiday: Holiday): Promise<void> {
    try {
      await tx.holiday.create({ data: toCreateData(holiday) });
    } catch (error) {
      if (isUniqueViolation(error)) throw new HolidayAlreadyExistsError();
      throw error;
    }
  }

  async update(tx: TenantTx, holiday: Holiday, expectedVersion: number): Promise<void> {
    try {
      await updateVersioned(
        { aggregateType: 'Holiday', aggregateId: holiday.id, expectedVersion },
        () =>
          tx.holiday.updateMany({
            where: { id: holiday.id, version: expectedVersion },
            data: {
              name: holiday.name,
              scope: holiday.scope,
              isRecurring: holiday.isRecurring,
              isActive: holiday.isActive,
              updatedAt: holiday.updatedAt,
              updatedById: holiday.updatedById,
              version: { increment: 1 },
            },
          }),
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw new HolidayAlreadyExistsError();
      throw error;
    }
  }

  async delete(tx: TenantTx, holiday: Holiday, expectedVersion: number): Promise<void> {
    const result = await tx.holiday.deleteMany({
      where: { id: holiday.id, version: expectedVersion },
    });
    assertVersionMatched(result, {
      aggregateType: 'Holiday',
      aggregateId: holiday.id,
      expectedVersion,
    });
  }

  async insertMissing(tx: TenantTx, holidays: readonly Holiday[]): Promise<number> {
    const result = await tx.holiday.createMany({
      data: holidays.map(toCreateData),
      skipDuplicates: true,
    });
    return result.count;
  }

  async existingKeys(tx: TenantTx, from: string, to: string): Promise<ReadonlySet<string>> {
    const rows = await tx.holiday.findMany({
      where: { date: { gte: toDbDate(from), lte: toDbDate(to) } },
      select: { date: true, name: true },
    });
    return new Set(rows.map((row) => holidayKey(fromDbDate(row.date), row.name)));
  }
}

const DEFAULT_TIMEZONE = 'America/Sao_Paulo';
const OPTIONAL_KEY = 'calendar.optionalHolidaysAreNonBusiness';

/**
 * Fuso (`tenants.timezone`, tabela de plataforma com SELECT para a aplicação) e a configuração
 * `calendar.optionalHolidaysAreNonBusiness` (`tenant_settings`, sob RLS) do tenant.
 */
@Injectable()
export class PrismaCalendarSettingsReader implements CalendarSettingsReader {
  async read(tx: TenantTx, tenantId: string): Promise<CalendarSettings> {
    const [tenant, setting] = await Promise.all([
      tx.tenant.findFirst({ where: { id: tenantId }, select: { timezone: true } }),
      tx.tenantSetting.findFirst({ where: { key: OPTIONAL_KEY }, select: { value: true } }),
    ]);
    return {
      timezone: tenant?.timezone ?? DEFAULT_TIMEZONE,
      optionalHolidaysAreNonBusiness: setting?.value === true,
    };
  }
}
