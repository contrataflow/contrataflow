import { seedHolidaysOf } from '@contrataflow/types';
import { describe, expect, it } from 'vitest';

import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';
import type { TenantSeedContext } from '#shared/tenancy/tenant-seeding.js';

import { HolidaysSeeder } from './holidays.seeder.js';
import { InMemoryCatalogTransactions } from '../infrastructure/in-memory-catalog-item.repository.js';
import {
  InMemoryCalendarSettingsReader,
  InMemoryHolidayRepository,
} from '../infrastructure/in-memory-holiday.repository.js';

const TENANT = '0192c000-0000-7000-8000-00000000a601';
const OTHER = '0192c000-0000-7000-8000-00000000a602';
const NOW = new Date('2026-10-15T12:00:00.000Z');
/** 2026 + 2027. */
const EXPECTED = seedHolidaysOf(2026).length + seedHolidaysOf(2027).length;

function setup(now: Date = NOW) {
  const repository = new InMemoryHolidayRepository();
  const settings = new InMemoryCalendarSettingsReader();
  const seeder = new HolidaysSeeder(
    repository,
    settings,
    new InMemoryCatalogTransactions(),
    () => now,
  );
  const ctx: TenantSeedContext = { tenantId: TENANT, slug: 'sao-jose', now, request: null };
  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) =>
    runWithRequestContext({ correlationId: 'corr-seed-holidays', ip: '', userAgent: '' }, () => {
      updateRequestContext({
        tenantId,
        actor: { type: 'SYSTEM', userId: null, membershipId: null, name: 'Provisionamento' },
      });
      return fn();
    });
  return { repository, settings, seeder, ctx, inTenant };
}

describe('HolidaysSeeder (catalog.holidays — entities.md §7 · US-099)', () => {
  it('semeia o ano corrente e o seguinte, de sistema e recorrentes, e fecha a etapa como DONE', async () => {
    const { repository, seeder, ctx, inTenant } = setup();
    expect(await inTenant(TENANT, () => seeder.verify(ctx))).toEqual({
      status: 'PENDING',
      details: { holidays: 0 },
    });

    const result = await inTenant(TENANT, () => seeder.seed(ctx));

    expect(result).toEqual({ created: EXPECTED, skipped: 0 });
    const rows = repository.snapshot();
    expect(rows).toHaveLength(EXPECTED);
    expect(rows.every((row) => row.isSystem && row.isActive && row.isRecurring)).toBe(true);
    expect(rows.every((row) => row.tenantId === TENANT)).toBe(true);
    const names2026 = rows.filter((row) => row.date.startsWith('2026')).map((row) => row.name);
    expect(names2026).toContain('Natal');
    expect(rows.find((row) => row.date === '2026-04-03')?.name).toBe('Sexta-feira Santa');
    expect(rows.find((row) => row.date === '2027-03-26')?.name).toBe('Sexta-feira Santa');
    expect(await inTenant(TENANT, () => seeder.verify(ctx))).toEqual({
      status: 'DONE',
      details: { holidays: EXPECTED },
    });
  });

  it('usa o ano corrente do fuso do tenant (31/12 à noite em Manaus ainda é o ano velho)', async () => {
    // 2027-01-01 02:00Z = 31/12/2026 22:00 em Manaus (UTC-4).
    const { repository, settings, seeder, ctx, inTenant } = setup(
      new Date('2027-01-01T02:00:00.000Z'),
    );
    settings.set(TENANT, { timezone: 'America/Manaus' });

    await inTenant(TENANT, () => seeder.seed(ctx));

    const years = new Set(repository.snapshot().map((row) => row.date.slice(0, 4)));
    expect([...years].sort()).toEqual(['2026', '2027']);
  });

  it('reexecução é idempotente e preserva o que o administrador desativou', async () => {
    const { repository, seeder, ctx, inTenant } = setup();
    await inTenant(TENANT, () => seeder.seed(ctx));
    const natal = repository.snapshot().find((row) => row.date === '2026-12-25');
    if (!natal) throw new Error('Natal não semeado');
    repository.seed({ ...natal, isActive: false });

    const again = await inTenant(TENANT, () => seeder.seed(ctx));

    expect(again).toEqual({ created: 0, skipped: EXPECTED });
    expect(repository.snapshot()).toHaveLength(EXPECTED);
    expect(repository.snapshot().find((row) => row.date === '2026-12-25')?.isActive).toBe(false);
  });

  it('feriado do administrador com o mesmo (data, nome) conta como existente (tenant:seed)', async () => {
    const { repository, seeder, ctx, inTenant } = setup();
    const custom = {
      id: '0192c000-0000-7000-8000-0000000a6001',
      tenantId: TENANT,
      date: '2026-12-25',
      name: 'NATAL',
      scope: 'MUNICIPAL' as const,
      isRecurring: false,
      isSystem: false,
      isActive: true,
      createdAt: NOW,
      updatedAt: NOW,
      createdById: null,
      updatedById: null,
      version: 1,
    };
    repository.seed(custom);

    const result = await inTenant(TENANT, () => seeder.seed(ctx));

    expect(result).toEqual({ created: EXPECTED - 1, skipped: 1 });
    expect(await inTenant(TENANT, () => seeder.verify(ctx))).toMatchObject({ status: 'DONE' });
  });

  it('semeia por tenant sem tocar nos feriados de outro', async () => {
    const { repository, seeder, ctx, inTenant } = setup();
    await inTenant(OTHER, () => seeder.seed({ ...ctx, tenantId: OTHER }));
    await inTenant(TENANT, () => seeder.seed(ctx));

    expect(repository.snapshot().filter((row) => row.tenantId === OTHER)).toHaveLength(EXPECTED);
    expect(repository.snapshot().filter((row) => row.tenantId === TENANT)).toHaveLength(EXPECTED);
    expect(seeder.key).toBe('catalog.holidays');
    expect(seeder.applyToExistingTenants).toBe(true);
  });
});
