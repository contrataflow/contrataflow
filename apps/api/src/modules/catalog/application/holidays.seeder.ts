import { seedHolidaysOf } from '@contrataflow/types';
import { Inject, Injectable } from '@nestjs/common';

import { newId } from '#shared/database/ids.js';
import type { TenantTx } from '#shared/database/prisma.js';
import type {
  TenantSeedContext,
  TenantSeeder,
  TenantSeedResult,
  TenantSeedStatus,
} from '#shared/tenancy/tenant-seeding.js';

import { CATALOG_CLOCK, CATALOG_TRANSACTIONS } from './catalog-ports.js';
import type { CatalogClock, CatalogTransactions } from './catalog-ports.js';
import { CALENDAR_SETTINGS_READER, HOLIDAY_REPOSITORY } from './holiday-ports.js';
import type { CalendarSettingsReader, HolidayRepository } from './holiday-ports.js';
import { localDateOf } from '../domain/business-calendar.js';
import { holidayKey } from '../domain/holiday.js';
import type { Holiday } from '../domain/holiday.js';

/**
 * Seeder `catalog.holidays` (US-106 · US-099 · entities.md §7 · RN-TEN-76): feriados do ano
 * corrente (no fuso do tenant) e do seguinte, com `isSystem = true`, recorrentes — os nacionais de
 * data fixa, a Sexta-feira Santa e os pontos facultativos móveis, calculados pela Páscoa
 * (Meeus/Butcher). Grava só os que ainda não existem por `(data, nome)` — sem tocar no que o
 * administrador editou —, logo é idempotente e serve a tenants existentes (`tenant:seed`). Os anos
 * seguintes nascem do job de manutenção do calendário (`HolidayYearGeneratorJob`, no worker).
 */
@Injectable()
export class HolidaysSeeder implements TenantSeeder {
  readonly key = 'catalog.holidays';
  readonly module = 'catalog';
  readonly version = '2026.10.1';
  readonly dependsOn: readonly string[] = [];
  readonly applyToExistingTenants = true;

  constructor(
    @Inject(HOLIDAY_REPOSITORY) private readonly holidays: HolidayRepository,
    @Inject(CALENDAR_SETTINGS_READER) private readonly settings: CalendarSettingsReader,
    @Inject(CATALOG_TRANSACTIONS) private readonly transactions: CatalogTransactions,
    @Inject(CATALOG_CLOCK) private readonly clock: CatalogClock,
  ) {}

  async seed(ctx: TenantSeedContext): Promise<TenantSeedResult> {
    const now = this.clock();
    let total = 0;
    const created = await this.transactions.run(async (tx) => {
      const years = await this.years(tx, ctx.tenantId, now);
      const drafts: Holiday[] = years.flatMap((year) =>
        seedHolidaysOf(year).map((seed) => ({
          id: newId(),
          tenantId: ctx.tenantId,
          date: seed.date,
          name: seed.name,
          scope: seed.scope,
          isRecurring: seed.isRecurring,
          isSystem: true,
          isActive: true,
          createdAt: now,
          updatedAt: now,
          createdById: null,
          updatedById: null,
          version: 1,
        })),
      );
      total = drafts.length;
      return this.holidays.insertMissing(tx, drafts);
    });
    return { created, skipped: total - created };
  }

  async verify(ctx: TenantSeedContext): Promise<TenantSeedStatus> {
    const now = this.clock();
    return this.transactions.read(async (tx) => {
      const years = await this.years(tx, ctx.tenantId, now);
      const existing = await this.holidays.existingKeys(
        tx,
        `${String(years[0])}-01-01`,
        `${String(years[1])}-12-31`,
      );
      const expected = years.flatMap((year) => seedHolidaysOf(year));
      const found = expected.filter((seed) => existing.has(holidayKey(seed.date, seed.name)));
      return {
        status: found.length === expected.length ? 'DONE' : 'PENDING',
        details: { holidays: found.length },
      };
    });
  }

  /** Ano corrente no fuso do tenant e o seguinte. */
  private async years(tx: TenantTx, tenantId: string, now: Date): Promise<[number, number]> {
    const { timezone } = await this.settings.read(tx, tenantId);
    const current = Number(localDateOf(now, timezone).slice(0, 4));
    return [current, current + 1];
  }
}
