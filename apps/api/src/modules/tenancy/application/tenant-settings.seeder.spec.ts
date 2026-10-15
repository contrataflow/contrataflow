import { SETTING_DEFINITIONS } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';
import type { TenantSeedContext } from '#shared/tenancy/tenant-seeding.js';

import { TenantSettingsSeeder } from './tenant-settings.seeder.js';
import { SettingsRegistry } from '../domain/settings-registry.js';
import {
  InMemorySettingsTransactions,
  InMemoryTenantSettingsRepository,
} from '../infrastructure/in-memory-tenant-settings.repository.js';

const TENANT = '0192c000-0000-7000-8000-00000000a301';
const OTHER = '0192c000-0000-7000-8000-00000000a302';
const NOW = new Date('2026-10-15T12:00:00.000Z');
const TOTAL = SETTING_DEFINITIONS.length;

function setup(definitions = SETTING_DEFINITIONS) {
  const repository = new InMemoryTenantSettingsRepository(() => TENANT);
  const seeder = new TenantSettingsSeeder(
    new SettingsRegistry([definitions]),
    repository,
    new InMemorySettingsTransactions(),
  );
  const ctx: TenantSeedContext = { tenantId: TENANT, slug: 'sao-jose', now: NOW, request: null };
  const inTenant = <T>(fn: () => Promise<T>) =>
    runWithRequestContext({ correlationId: 'corr-seed-settings', ip: '', userAgent: '' }, () => {
      updateRequestContext({
        tenantId: TENANT,
        actor: { type: 'SYSTEM', userId: null, membershipId: null, name: 'Provisionamento' },
      });
      return fn();
    });
  return { repository, seeder, ctx, inTenant };
}

describe('TenantSettingsSeeder (tenancy.settings — RN-TEN-57)', () => {
  it('grava toda chave do registro com o padrão na versão 1 e fecha a etapa como DONE', async () => {
    const { repository, seeder, ctx, inTenant } = setup();
    expect(await inTenant(() => seeder.verify(ctx))).toEqual({
      status: 'PENDING',
      details: { settings: 0 },
    });

    const result = await inTenant(() => seeder.seed(ctx));

    expect(result).toEqual({ created: TOTAL, skipped: 0 });
    const rows = repository.snapshot();
    expect(rows).toHaveLength(TOTAL);
    expect(new Set(rows.map((row) => row.tenantId))).toEqual(new Set([TENANT]));
    expect(rows.every((row) => row.version === 1)).toBe(true);
    for (const definition of SETTING_DEFINITIONS) {
      expect(rows.find((row) => row.key === definition.key)?.value).toEqual(
        definition.defaultValue,
      );
    }
    expect(await inTenant(() => seeder.verify(ctx))).toEqual({
      status: 'DONE',
      details: { settings: TOTAL },
    });
  });

  it('reexecução é idempotente: não duplica linhas nem sobrescreve valor alterado', async () => {
    const { repository, seeder, ctx, inTenant } = setup();
    await inTenant(() => seeder.seed(ctx));
    repository.seed(TENANT, 'labels.secretariat', 'Diretoria', 4);

    const again = await inTenant(() => seeder.seed(ctx));

    expect(again).toEqual({ created: 0, skipped: TOTAL });
    expect(repository.snapshot()).toHaveLength(TOTAL);
    expect(repository.snapshot().find((row) => row.key === 'labels.secretariat')).toMatchObject({
      value: 'Diretoria',
      version: 4,
    });
  });

  it('aplica só a chave nova a tenant existente (tenant:seed — FA-03/FA-08)', async () => {
    const { repository, seeder, ctx, inTenant } = setup(SETTING_DEFINITIONS.slice(0, -1));
    await inTenant(() => seeder.seed(ctx));
    expect(repository.snapshot()).toHaveLength(TOTAL - 1);

    const withNewKey = new TenantSettingsSeeder(
      new SettingsRegistry([SETTING_DEFINITIONS]),
      repository,
      new InMemorySettingsTransactions(),
    );
    expect(await inTenant(() => withNewKey.verify(ctx))).toMatchObject({ status: 'PENDING' });
    expect(await inTenant(() => withNewKey.seed(ctx))).toEqual({ created: 1, skipped: TOTAL - 1 });
    expect(await inTenant(() => withNewKey.verify(ctx))).toMatchObject({ status: 'DONE' });
  });

  it('não toca nas linhas de outro tenant e é aplicável a tenants existentes', async () => {
    const { repository, seeder, ctx, inTenant } = setup();
    repository.seed(OTHER, 'labels.secretariat', 'Pasta', 7);

    await inTenant(() => seeder.seed(ctx));

    expect(repository.snapshot().filter((row) => row.tenantId === OTHER)).toHaveLength(1);
    expect(seeder.applyToExistingTenants).toBe(true);
    expect(seeder.key).toBe('tenancy.settings');
  });
});
