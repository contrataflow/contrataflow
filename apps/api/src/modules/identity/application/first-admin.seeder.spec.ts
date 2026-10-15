import { provisionTenantSchema } from '@contrataflow/validation';
import { describe, expect, it } from 'vitest';

import { runAsSystem } from '#shared/context/request-context.js';
import type { TenantSeedContext } from '#shared/tenancy/tenant-seeding.js';
import { FAKE_USERS } from '#shared/testing/fake-directory.js';

import { FirstAdminSeeder } from './first-admin.seeder.js';
import { InMemoryFirstAdminStore } from '../infrastructure/first-admin.store.js';

/*
 * US-099 — seeder `identity.firstAdmin` (fluxo principal, passo 7 · FA-10 · RN-TEN-14): identidade
 * global reutilizada pelo e-mail, vínculo `INTERNAL` `INVITED` só no tenant do contexto, idempotente.
 */

const TENANT = '0192a000-0000-7000-8000-000000000999';
const OTHER = '0192a000-0000-7000-8000-000000000998';
const NOW = new Date('2026-10-06T12:00:00.000Z');

function ctx(email: string, tenantId = TENANT): TenantSeedContext {
  return {
    tenantId,
    slug: 'sao-jose',
    now: NOW,
    request: provisionTenantSchema.parse({
      slug: 'sao-jose',
      name: 'Prefeitura de São José',
      type: 'AUTARCHY',
      stateCode: 'SC',
      primaryOrganization: {
        name: 'Prefeitura Municipal de São José',
        shortName: 'PMSJ',
        cnpj: '11222333000181',
        type: 'DIRECT_ADMINISTRATION',
      },
      firstAdmin: { email, name: 'Rafael Nogueira' },
    }),
  };
}

const inTenant = <T>(tenantId: string, fn: () => Promise<T>) =>
  runAsSystem({ name: 'Provisionamento de tenant', tenantId }, fn);

describe('FirstAdminSeeder (identity.firstAdmin)', () => {
  it('cria a identidade e o vínculo INVITED; a reexecução não grava nada', async () => {
    const store = new InMemoryFirstAdminStore();
    const seeder = new FirstAdminSeeder(store, store);
    const context = ctx('rafael@pmsj.gov.br');

    expect(await inTenant(TENANT, () => seeder.verify(context))).toEqual({
      status: 'PENDING',
      details: { memberships: 0 },
    });
    expect(await inTenant(TENANT, () => seeder.seed(context))).toEqual({ created: 2, skipped: 0 });
    expect(await inTenant(TENANT, () => seeder.seed(context))).toEqual({ created: 0, skipped: 2 });
    expect(await inTenant(TENANT, () => seeder.verify(context))).toEqual({
      status: 'DONE',
      details: { memberships: 1 },
    });
    expect(store.membersOf(TENANT)).toEqual([
      expect.objectContaining({ email: 'rafael@pmsj.gov.br', status: 'INVITED' }),
    ]);
  });

  it('[FA-10] reutiliza a identidade existente e cria só o novo vínculo, sem tocar no outro tenant', async () => {
    const store = new InMemoryFirstAdminStore();
    const seeder = new FirstAdminSeeder(store, store);
    const fabio = FAKE_USERS.fabio;
    expect(await inTenant(TENANT, () => seeder.seed(ctx(fabio.email)))).toEqual({
      created: 1,
      skipped: 1,
    });
    expect(store.membersOf(TENANT)).toEqual([expect.objectContaining({ userId: fabio.id })]);
    expect(store.membersOf(OTHER)).toEqual([]);
  });

  it('[RN-TEN-14] nunca cria vínculo para a operadora', async () => {
    const store = new InMemoryFirstAdminStore();
    const seeder = new FirstAdminSeeder(store, store);
    await inTenant(TENANT, () => seeder.seed(ctx('rafael@pmsj.gov.br')));
    expect(
      store.membersOf(TENANT).some((member) => member.userId === FAKE_USERS.operadora.id),
    ).toBe(false);
  });

  it('[Falha de integração] identidade indisponível: etapa fica PENDING e a retomada conclui', async () => {
    const store = new InMemoryFirstAdminStore();
    const seeder = new FirstAdminSeeder(store, store);
    store.failNextWrite = new Error('Authentik indisponível');
    await expect(inTenant(TENANT, () => seeder.seed(ctx('rafael@pmsj.gov.br')))).rejects.toThrow(
      'Authentik indisponível',
    );
    expect((await inTenant(TENANT, () => seeder.verify(ctx('rafael@pmsj.gov.br')))).status).toBe(
      'PENDING',
    );
    await inTenant(TENANT, () => seeder.seed(ctx('rafael@pmsj.gov.br')));
    expect((await inTenant(TENANT, () => seeder.verify(ctx('rafael@pmsj.gov.br')))).status).toBe(
      'DONE',
    );
  });

  it('sem os dados do provisionamento não semeia; verify cai na existência de vínculo', async () => {
    const store = new InMemoryFirstAdminStore();
    const seeder = new FirstAdminSeeder(store, store);
    const bare = { ...ctx('rafael@pmsj.gov.br'), request: null };
    await expect(inTenant(TENANT, () => seeder.seed(bare))).rejects.toThrow(
      /dados do provisionamento/,
    );
    expect((await inTenant(TENANT, () => seeder.verify(bare))).status).toBe('PENDING');
    await inTenant(TENANT, () => seeder.seed(ctx('rafael@pmsj.gov.br')));
    expect((await inTenant(TENANT, () => seeder.verify(bare))).status).toBe('DONE');
  });

  it('describe/dispatch informam o administrador; o envio ainda não existe (US-091)', async () => {
    const store = new InMemoryFirstAdminStore();
    const seeder = new FirstAdminSeeder(store, store);
    expect(await seeder.describe(TENANT)).toBeNull();
    await inTenant(TENANT, () => seeder.seed(ctx('rafael@pmsj.gov.br')));
    expect(await seeder.dispatch(TENANT)).toEqual({
      email: 'rafael@pmsj.gov.br',
      membershipStatus: 'INVITED',
      invitationDispatched: false,
    });
  });

  it('operadores do diretório: só quem tem isPlatformOperator', async () => {
    const store = new InMemoryFirstAdminStore();
    expect(await store.findOperatorByEmail('CARLA@contrataflow.com.br')).toMatchObject({
      id: FAKE_USERS.operadora.id,
      isPlatformOperator: true,
    });
    expect(await store.findOperatorById(FAKE_USERS.marta.id)).toMatchObject({
      isPlatformOperator: false,
    });
    expect(await store.findOperatorByEmail('ninguem@x.gov.br')).toBeNull();
  });
});
