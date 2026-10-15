import { Module } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';

import { APP_CONFIG } from '#config/config.module.js';
import type { AppConfig } from '#config/env.js';
import { TenantSeederRegistry, TenantSeedingModule } from '#shared/tenancy/tenant-seeding.js';

import { BusinessCalendarFacade } from './application/business-calendar.facade.js';
import {
  AddBusinessDaysQuery,
  BusinessDaysQueryHandler,
  ListHolidaysQuery,
} from './application/calendar.queries.js';
import { CatalogItemsSeeder } from './application/catalog-items.seeder.js';
import {
  CATALOG_CLOCK,
  CATALOG_ITEM_REPOSITORY,
  CATALOG_TRANSACTIONS,
} from './application/catalog-ports.js';
import { CatalogFacade } from './application/catalog.facade.js';
import { ListCatalogItemsQuery } from './application/catalog.queries.js';
import { CreateCatalogItemCommand } from './application/create-catalog-item.command.js';
import { CreateHolidayCommand } from './application/create-holiday.command.js';
import { DeleteHolidayCommand } from './application/delete-holiday.command.js';
import { CALENDAR_SETTINGS_READER, HOLIDAY_REPOSITORY } from './application/holiday-ports.js';
import { HolidaysSeeder } from './application/holidays.seeder.js';
import { ReorderCatalogItemsCommand } from './application/reorder-catalog-items.command.js';
import {
  ActivateCatalogItemCommand,
  DeactivateCatalogItemCommand,
  UpdateCatalogItemCommand,
} from './application/update-catalog-item.command.js';
import { UpdateHolidayCommand } from './application/update-holiday.command.js';
import {
  InMemoryCatalogItemRepository,
  InMemoryCatalogTransactions,
} from './infrastructure/in-memory-catalog-item.repository.js';
import {
  InMemoryCalendarSettingsReader,
  InMemoryHolidayRepository,
} from './infrastructure/in-memory-holiday.repository.js';
import {
  PrismaCatalogItemRepository,
  PrismaCatalogTransactions,
} from './infrastructure/prisma-catalog-item.repository.js';
import {
  PrismaCalendarSettingsReader,
  PrismaHolidayRepository,
} from './infrastructure/prisma-holiday.repository.js';
import { CalendarController } from './presentation/calendar.controller.js';
import { CatalogController } from './presentation/catalog.controller.js';
import { AccessModule } from '../access/access.module.js';
import { IdentityModule } from '../identity/identity.module.js';

/** Modo de identidade fake (local/dev/test sem banco — FA-02 da US-080): itens em memória. */
const inMemory = (config: AppConfig) => config.oidc.fakeSigningKey !== null;

/**
 * Módulo `catalog` (DEC-040): outros módulos usam somente a fachada exportada (`CatalogFacade`,
 * ex.: `assertActive` na criação de processo). Dono dos catálogos parametrizáveis do tenant
 * (US-104: CAT-01..06 e o seeder `catalog.items`) e do calendário de dias úteis (US-106: CAL-01..06,
 * o seeder `catalog.holidays` e a `BusinessCalendarFacade`); autorização e MFA vêm de `access`/`identity`
 * — exceção registrada em `tools/module-levels.json` (mesma de `tenancy`).
 */
@Module({
  imports: [AccessModule, IdentityModule, TenantSeedingModule],
  controllers: [CatalogController, CalendarController],
  providers: [
    CatalogFacade,
    ListCatalogItemsQuery,
    CreateCatalogItemCommand,
    UpdateCatalogItemCommand,
    ActivateCatalogItemCommand,
    DeactivateCatalogItemCommand,
    ReorderCatalogItemsCommand,
    CatalogItemsSeeder,
    BusinessCalendarFacade,
    ListHolidaysQuery,
    BusinessDaysQueryHandler,
    AddBusinessDaysQuery,
    CreateHolidayCommand,
    UpdateHolidayCommand,
    DeleteHolidayCommand,
    HolidaysSeeder,
    PrismaHolidayRepository,
    InMemoryHolidayRepository,
    PrismaCalendarSettingsReader,
    InMemoryCalendarSettingsReader,
    PrismaCatalogItemRepository,
    PrismaCatalogTransactions,
    InMemoryCatalogItemRepository,
    InMemoryCatalogTransactions,
    {
      provide: CATALOG_ITEM_REPOSITORY,
      inject: [APP_CONFIG, PrismaCatalogItemRepository, InMemoryCatalogItemRepository],
      useFactory: (
        config: AppConfig,
        prisma: PrismaCatalogItemRepository,
        memory: InMemoryCatalogItemRepository,
      ) => (inMemory(config) ? memory : prisma),
    },
    {
      provide: CATALOG_TRANSACTIONS,
      inject: [APP_CONFIG, PrismaCatalogTransactions, InMemoryCatalogTransactions],
      useFactory: (
        config: AppConfig,
        prisma: PrismaCatalogTransactions,
        memory: InMemoryCatalogTransactions,
      ) => (inMemory(config) ? memory : prisma),
    },
    {
      provide: HOLIDAY_REPOSITORY,
      inject: [APP_CONFIG, PrismaHolidayRepository, InMemoryHolidayRepository],
      useFactory: (
        config: AppConfig,
        prisma: PrismaHolidayRepository,
        memory: InMemoryHolidayRepository,
      ) => (inMemory(config) ? memory : prisma),
    },
    {
      provide: CALENDAR_SETTINGS_READER,
      inject: [APP_CONFIG, PrismaCalendarSettingsReader, InMemoryCalendarSettingsReader],
      useFactory: (
        config: AppConfig,
        prisma: PrismaCalendarSettingsReader,
        memory: InMemoryCalendarSettingsReader,
      ) => (inMemory(config) ? memory : prisma),
    },
    { provide: CATALOG_CLOCK, useValue: () => new Date() },
  ],
  exports: [CatalogFacade, BusinessCalendarFacade],
})
export class CatalogModule implements OnModuleInit {
  constructor(
    private readonly seeders: TenantSeederRegistry,
    private readonly items: CatalogItemsSeeder,
    private readonly holidays: HolidaysSeeder,
  ) {}

  /** Seeders `catalog.items` e `catalog.holidays` no checklist do provisionamento (US-099). */
  onModuleInit(): void {
    this.seeders.register(this.items);
    this.seeders.register(this.holidays);
  }
}
