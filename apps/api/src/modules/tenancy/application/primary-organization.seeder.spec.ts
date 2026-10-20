import { describe, expect, it } from 'vitest';

import type { AuditEntry, AuditTrailPort } from '#shared/audit/audit-trail.js';
import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';
import type { TenantSeedContext } from '#shared/tenancy/tenant-seeding.js';

import { PrimaryOrganizationSeeder } from './primary-organization.seeder.js';
import type { Tenant } from '../domain/tenant.js';
import {
  InMemoryOrganizationRepository,
  InMemoryOrganizationTransactions,
} from '../infrastructure/in-memory-organization.repository.js';
import {
  InMemoryPlatformTransactions,
  InMemoryTenantRepository,
} from '../infrastructure/in-memory-tenant.repository.js';

const TENANT = '0192c000-0000-7000-8000-00000000a201';
const NOW = new Date('2026-10-15T12:00:00.000Z');

const tenant: Tenant = {
  id: TENANT,
  slug: 'sao-jose',
  name: 'Prefeitura de São José',
  legalName: null,
  type: 'MUNICIPALITY',
  status: 'PROVISIONING',
  stateCode: 'SC',
  ibgeCityCode: null,
  timezone: 'America/Sao_Paulo',
  locale: 'pt-BR',
  plan: 'STANDARD',
  primaryOrganizationId: null,
  activatedAt: null,
  suspendedAt: null,
  suspensionReason: null,
  deactivatedAt: null,
  offboardingStartedAt: null,
  offboardingEndsAt: null,
  provisioningFingerprint: null,
  createdAt: NOW,
  updatedAt: NOW,
  version: 1,
};

const request = {
  slug: 'sao-jose',
  name: 'Prefeitura de São José',
  type: 'MUNICIPALITY',
  stateCode: 'SC',
  timezone: 'America/Sao_Paulo',
  locale: 'pt-BR',
  plan: 'STANDARD',
  primaryOrganization: {
    name: 'Prefeitura Municipal de São José',
    shortName: 'PMSJ',
    cnpj: '11222333000181',
    type: 'DIRECT_ADMINISTRATION',
  },
  firstAdmin: { email: 'rafael@pmsj.test', name: 'Rafael Nogueira' },
  activate: true,
} as const;

function setup() {
  const tenants = new InMemoryTenantRepository([tenant]);
  const organizations = new InMemoryOrganizationRepository(tenants);
  const audits: AuditEntry[] = [];
  const audit = {
    record: (_tx: unknown, entry: AuditEntry) => {
      audits.push(entry);
      return Promise.resolve();
    },
  } as unknown as AuditTrailPort;
  const seeder = new PrimaryOrganizationSeeder(
    organizations,
    new InMemoryOrganizationTransactions(),
    tenants,
    new InMemoryPlatformTransactions(),
    audit,
  );
  const ctx = (withRequest: boolean): TenantSeedContext => ({
    tenantId: TENANT,
    slug: 'sao-jose',
    now: NOW,
    request: withRequest ? request : null,
  });
  const inTenant = <T>(fn: () => Promise<T>) =>
    runWithRequestContext({ correlationId: 'corr-seed-org', ip: '', userAgent: '' }, () => {
      updateRequestContext({
        tenantId: TENANT,
        actor: { type: 'SYSTEM', userId: null, membershipId: null, name: 'Provisionamento' },
      });
      return fn();
    });
  return { tenants, organizations, audits, seeder, ctx, inTenant };
}

describe('PrimaryOrganizationSeeder (tenancy.primaryOrganization)', () => {
  it('cria o órgão principal do pedido, aponta o tenant para ele e audita como SYSTEM', async () => {
    const { seeder, ctx, inTenant, organizations, tenants, audits } = setup();

    const result = await inTenant(() => seeder.seed(ctx(true)));

    expect(result).toEqual({ created: 1, skipped: 0 });
    const [created] = organizations.snapshot();
    expect(created).toMatchObject({
      tenantId: TENANT,
      shortName: 'PMSJ',
      cnpj: '11222333000181',
      type: 'DIRECT_ADMINISTRATION',
      isActive: true,
    });
    expect(tenants.primaryOrganizationOf(TENANT)).toBe(created?.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'organization.create',
      entityId: created?.id,
      metadata: { seeded: true, principal: true },
    });
    expect(await inTenant(() => seeder.verify(ctx(true)))).toEqual({
      status: 'DONE',
      details: { organizations: 1 },
    });
  });

  it('reexecução (FA-01) é idempotente: não duplica o órgão nem a auditoria', async () => {
    const { seeder, ctx, inTenant, organizations, audits } = setup();
    await inTenant(() => seeder.seed(ctx(true)));

    const again = await inTenant(() => seeder.seed(ctx(true)));

    expect(again).toEqual({ created: 0, skipped: 1 });
    expect(organizations.snapshot()).toHaveLength(1);
    expect(audits).toHaveLength(1);
  });

  it('antes de semear a etapa fica PENDING; sem o pedido nada é criado', async () => {
    const { seeder, ctx, inTenant, organizations } = setup();
    expect(await inTenant(() => seeder.verify(ctx(false)))).toEqual({
      status: 'PENDING',
      details: { organizations: 0 },
    });
    expect(await inTenant(() => seeder.seed(ctx(false)))).toEqual({ created: 0 });
    expect(organizations.snapshot()).toHaveLength(0);
  });

  it('não se aplica a tenants existentes (o órgão principal só nasce no provisionamento)', () => {
    expect(setup().seeder.applyToExistingTenants).toBe(false);
  });
});
