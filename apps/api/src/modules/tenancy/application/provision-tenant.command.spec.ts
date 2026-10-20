import { provisionTenantSchema } from '@contrataflow/validation';
import type { ProvisionTenant } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuditEntry, AuditOutcome, AuditTrailPort } from '#shared/audit/audit-trail.js';
import { currentRequestContext } from '#shared/context/request-context.js';
import type { OutboxWriterPort, RecordedDomainEvent } from '#shared/outbox/outbox-writer.js';
import { TenantSeederRegistry } from '#shared/tenancy/tenant-seeding.js';
import type {
  FirstAdminInvitation,
  FirstAdminInvitationPort,
  TenantSeedContext,
  TenantSeeder,
} from '#shared/tenancy/tenant-seeding.js';

import { ApplyTenantSeedersCommand } from './apply-tenant-seeders.command.js';
import { ChangeTenantStatusCommand } from './change-tenant-status.command.js';
import { ProvisionTenantCommand } from './provision-tenant.command.js';
import { ProvisioningPlan } from './provisioning-plan.js';
import { GetTenantQuery, ResendFirstAdminInvitationCommand } from './tenant.queries.js';
import {
  InMemoryPlatformTransactions,
  InMemoryTenantRepository,
} from '../infrastructure/in-memory-tenant.repository.js';

/*
 * US-099 — checklist idempotente e retomável (RN-TEN-05/06/07 · FA-01/02/08/11), com seeders
 * dublês que contam o que gravam por tenant: falha injetada em cada etapa, retomada sem duplicar,
 * conclusão única, ativação com etapas pendentes e convite depois do commit.
 */

const NOW = new Date('2026-10-06T15:00:00.000Z');
const OPERATOR = { id: '0192a000-0000-7000-8000-0000000000c9', name: 'Carla Antunes' };

/** Seeder dublê: grava `size` itens por tenant; `failNext` simula o banco caindo na etapa. */
class FakeSeeder implements TenantSeeder {
  readonly module: string;
  readonly version = '2026.10.1';
  readonly rows = new Map<string, number>();
  seedCalls = 0;
  failNext: Error | null = null;
  contexts: { actor: string | undefined; tenantId: string | null | undefined }[] = [];

  constructor(
    readonly key: string,
    readonly dependsOn: readonly string[],
    readonly size: number,
    readonly applyToExistingTenants = true,
  ) {
    this.module = key.split('.')[0] ?? key;
  }

  seed(ctx: TenantSeedContext) {
    this.seedCalls += 1;
    const context = currentRequestContext();
    this.contexts.push({ actor: context?.actor.type, tenantId: context?.tenantId });
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      return Promise.reject(error);
    }
    const before = this.rows.get(ctx.tenantId) ?? 0;
    this.rows.set(ctx.tenantId, this.size);
    return Promise.resolve({ created: this.size - before, skipped: before });
  }

  verify(ctx: TenantSeedContext) {
    const count = this.rows.get(ctx.tenantId) ?? 0;
    return Promise.resolve({
      status: count === this.size ? ('DONE' as const) : ('PENDING' as const),
      details: { items: count },
    });
  }
}

class FakeInvitation implements FirstAdminInvitationPort {
  dispatched: string[] = [];
  failDispatch = false;

  describe(): Promise<FirstAdminInvitation | null> {
    return Promise.resolve({
      email: 'rafael@pmsj.gov.br',
      membershipStatus: 'INVITED',
      invitationDispatched: false,
    });
  }

  dispatch(tenantId: string): Promise<FirstAdminInvitation | null> {
    if (this.failDispatch) return Promise.reject(new Error('fila email indisponível'));
    this.dispatched.push(tenantId);
    return Promise.resolve({
      email: 'rafael@pmsj.gov.br',
      membershipStatus: 'INVITED',
      invitationDispatched: true,
    });
  }
}

function input(overrides: Record<string, unknown> = {}): ProvisionTenant {
  return provisionTenantSchema.parse({
    slug: 'sao-jose',
    name: 'Prefeitura de São José',
    type: 'MUNICIPALITY',
    stateCode: 'SC',
    ibgeCityCode: '4216602',
    primaryOrganization: {
      name: 'Prefeitura Municipal de São José',
      shortName: 'PMSJ',
      cnpj: '11222333000181',
      type: 'DIRECT_ADMINISTRATION',
    },
    firstAdmin: { email: 'rafael@pmsj.gov.br', name: 'Rafael Nogueira' },
    ...overrides,
  });
}

function build() {
  const seeders = {
    items: new FakeSeeder('catalog.items', [], 84),
    roles: new FakeSeeder('access.defaultRoles', [], 15),
    types: new FakeSeeder('document.systemTypes', [], 11),
    templates: new FakeSeeder('document.templateLibrary', ['document.systemTypes'], 11),
    workflows: new FakeSeeder(
      'workflow.seedWorkflows',
      ['document.systemTypes', 'access.defaultRoles'],
      2,
    ),
    holidays: new FakeSeeder('catalog.holidays', [], 28),
    admin: new FakeSeeder('identity.firstAdmin', ['access.defaultRoles'], 1, false),
  };
  const registry = new TenantSeederRegistry();
  for (const seeder of Object.values(seeders)) registry.register(seeder);
  const invitation = new FakeInvitation();
  registry.registerFirstAdminInvitation(invitation);

  const repository = new InMemoryTenantRepository([]);
  const platform = new InMemoryPlatformTransactions();
  const audits: (AuditEntry & { tenantId: string | null; actorType: string | undefined })[] = [];
  const events: RecordedDomainEvent[] = [];
  let failAudit: Error | null = null;
  const audit: AuditTrailPort = {
    record: (_tx, entry) => {
      if (failAudit) {
        const error = failAudit;
        failAudit = null;
        return Promise.reject(error);
      }
      const context = currentRequestContext();
      audits.push({
        ...entry,
        tenantId: context?.tenantId ?? null,
        actorType: context?.actor.type,
      });
      return Promise.resolve({ kind: 'recorded' } as AuditOutcome);
    },
    recordStandalone: (entry) => audit.record({} as never, entry),
  };
  const outbox: OutboxWriterPort = {
    record: (_tx, draft) => {
      const event = {
        eventType: draft.definition.eventType,
        tenantId: currentRequestContext()?.tenantId ?? null,
        aggregateId: draft.aggregateId,
        payload: draft.payload,
      } as unknown as RecordedDomainEvent;
      events.push(event);
      return Promise.resolve(event);
    },
    recordOnce: () => Promise.reject(new Error('não usado no provisionamento')),
  };
  const statusCache = { invalidate: vi.fn(() => Promise.resolve()) };
  const clock = () => NOW;

  const plan = new ProvisioningPlan(registry, repository, platform);
  plan.onApplicationBootstrap();
  const lifecycle = new ChangeTenantStatusCommand(
    repository,
    platform,
    statusCache,
    audit,
    outbox,
    clock,
    plan,
  );
  const provision = new ProvisionTenantCommand(
    repository,
    platform,
    audit,
    outbox,
    clock,
    plan,
    lifecycle,
  );
  return {
    seeders,
    invitation,
    repository,
    audits,
    events,
    statusCache,
    plan,
    lifecycle,
    provision,
    apply: new ApplyTenantSeedersCommand(repository, platform, clock, plan),
    detail: new GetTenantQuery(repository, platform, clock, plan),
    resend: new ResendFirstAdminInvitationCommand(repository, platform, lifecycle),
    failNextAudit: (error: Error) => {
      failAudit = error;
    },
    run: (body: ProvisionTenant = input(), channel: 'API' | 'CLI' = 'CLI') =>
      provision.execute({ input: body, operator: OPERATOR, channel, idempotencyKey: null }),
  };
}

const ORDER = [
  'tenancy.tenantRecord',
  'catalog.items',
  'access.defaultRoles',
  'document.systemTypes',
  'document.templateLibrary',
  'workflow.seedWorkflows',
  'catalog.holidays',
  'identity.firstAdmin',
  'tenancy.complete',
];

describe('ProvisionTenantCommand (US-099)', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('[Sucesso] executa as etapas em ordem topológica, conclui e ativa', async () => {
    const t = build();
    const outcome = await t.run();
    expect(outcome.kind).toBe('complete');
    expect(outcome.tenant).toMatchObject({ status: 'ACTIVE', activatedAt: NOW, version: 2 });
    expect(outcome.checklist.complete).toBe(true);
    expect(outcome.checklist.steps.map((step) => step.key)).toEqual(ORDER);
    expect(outcome.firstAdmin?.invitationDispatched).toBe(true);
    expect(t.invitation.dispatched).toEqual([outcome.tenant.id]);
    expect(t.audits.map((entry) => [entry.action, entry.actorType, entry.tenantId])).toEqual([
      ['tenant.provision', 'PLATFORM_OPERATOR', outcome.tenant.id],
      ['tenant.activate', 'PLATFORM_OPERATOR', outcome.tenant.id],
    ]);
    expect(t.audits[0]?.metadata).toMatchObject({
      channel: 'CLI',
      seedVersions: { 'catalog.items': '2026.10.1', 'identity.firstAdmin': '2026.10.1' },
      steps: ORDER,
    });
    expect(t.events.map((event) => event.eventType)).toEqual([
      'TenantProvisioned',
      'TenantActivated',
    ]);
    expect(t.statusCache.invalidate).toHaveBeenCalledWith(outcome.tenant.id);
  });

  it('seeders rodam como SYSTEM no tenant novo (RLS do tenant, nunca o operador)', async () => {
    const t = build();
    const outcome = await t.run();
    expect(t.seeders.items.contexts).toEqual([{ actor: 'SYSTEM', tenantId: outcome.tenant.id }]);
  });

  const seederSteps = ORDER.slice(1, -1);

  it.each(seederSteps)(
    '[Falha de banco] falha em %s preserva o feito e a reexecução só roda o pendente',
    async (failing) => {
      const t = build();
      const target = Object.values(t.seeders).find((seeder) => seeder.key === failing);
      if (!target) throw new Error(failing);
      target.failNext = Object.assign(new Error('conexão perdida'), {
        code: 'DEPENDENCY_UNAVAILABLE',
      });

      const first = await t.run();
      expect(first.kind).toBe('incomplete');
      expect(first.failedStep).toBe(failing);
      expect(first.errorCode).toBe('DEPENDENCY_UNAVAILABLE');
      expect(first.tenant.status).toBe('PROVISIONING');
      const index = ORDER.indexOf(failing);
      expect(
        first.checklist.steps.filter((step) => step.status === 'PENDING').map((step) => step.key),
      ).toEqual(ORDER.slice(index));
      const failure = t.audits.find((entry) => entry.result === 'FAILURE');
      expect(failure).toMatchObject({
        action: 'tenant.provision',
        tenantId: first.tenant.id,
        reasonCode: 'DEPENDENCY_UNAVAILABLE',
        metadata: expect.objectContaining({ failedStep: failing }) as unknown,
      });

      const second = await t.run();
      expect(second.kind).toBe('complete');
      expect(second.tenant.id).toBe(first.tenant.id);
      // Etapas já concluídas não voltam a gravar; as contagens não mudam (84 itens).
      for (const seeder of Object.values(t.seeders)) {
        expect(seeder.seedCalls, seeder.key).toBe(seeder.key === failing ? 2 : 1);
      }
      expect(t.seeders.items.rows.get(first.tenant.id)).toBe(84);
      expect(t.events.filter((event) => event.eventType === 'TenantProvisioned')).toHaveLength(1);
    },
  );

  it('[Falha de banco] falha na conclusão: retomada grava TenantProvisioned uma única vez', async () => {
    const t = build();
    t.failNextAudit(new Error('banco fora'));
    const first = await t.run();
    expect(first.kind).toBe('incomplete');
    expect(first.failedStep).toBe('tenancy.complete');
    expect(t.events).toHaveLength(0);

    const second = await t.run();
    expect(second.kind).toBe('complete');
    expect(t.events.filter((event) => event.eventType === 'TenantProvisioned')).toHaveLength(1);
  });

  it('[Duplicidade] reexecutar um tenant já ativo → 409 TENANT_SLUG_TAKEN', async () => {
    const t = build();
    await t.run();
    await expect(t.run()).rejects.toMatchObject({ code: 'TENANT_SLUG_TAKEN' });
    expect(t.audits.at(-1)).toMatchObject({
      action: 'tenant.provision',
      result: 'FAILURE',
      tenantId: null,
      reasonCode: 'TENANT_SLUG_TAKEN',
    });
  });

  it('[FA-01] retomada com CNPJ ou e-mail divergentes → 409', async () => {
    const t = build();
    t.seeders.holidays.failNext = new Error('falha');
    await t.run();
    await expect(
      t.run(input({ firstAdmin: { email: 'outro@pmsj.gov.br', name: 'Outro Admin' } })),
    ).rejects.toMatchObject({ code: 'TENANT_SLUG_TAKEN' });
    await expect(
      t.run(
        input({
          primaryOrganization: {
            name: 'Outro órgão',
            shortName: 'OUT',
            cnpj: '12ABC34501DE35',
            type: 'FUND',
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'TENANT_SLUG_TAKEN' });
    expect((await t.run()).kind).toBe('complete');
  });

  it('[FA-02] sem ativar: PROVISIONING com checklist completo; ativação posterior envia o convite', async () => {
    const t = build();
    const outcome = await t.run(input({ activate: false }));
    expect(outcome.tenant.status).toBe('PROVISIONING');
    expect(outcome.checklist.complete).toBe(true);
    expect(outcome.firstAdmin?.invitationDispatched).toBe(false);
    expect(t.invitation.dispatched).toEqual([]);

    const activated = await t.lifecycle.execute({
      tenant: { id: outcome.tenant.id },
      action: 'ACTIVATE',
      expectedVersion: outcome.tenant.version,
      operator: OPERATOR,
      channel: 'API',
    });
    expect(activated.tenant.status).toBe('ACTIVE');
    expect(activated.invitation?.invitationDispatched).toBe(true);
  });

  it('[V-08] ativar a partir de PROVISIONING com etapas pendentes → 409 com as etapas', async () => {
    const t = build();
    t.seeders.workflows.failNext = new Error('falha');
    const outcome = await t.run();
    await expect(
      t.lifecycle.execute({
        tenant: { id: outcome.tenant.id },
        action: 'ACTIVATE',
        expectedVersion: null,
        operator: OPERATOR,
        channel: 'CLI',
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_STATE',
      extensions: {
        pendingSteps: [
          'workflow.seedWorkflows',
          'catalog.holidays',
          'identity.firstAdmin',
          'tenancy.complete',
        ],
      },
    });
  });

  it('[Falha de integração] fila de e-mail indisponível: tenant ACTIVE e convite não enviado', async () => {
    const t = build();
    t.invitation.failDispatch = true;
    const outcome = await t.run();
    expect(outcome.tenant.status).toBe('ACTIVE');
    expect(outcome.firstAdmin?.invitationDispatched).toBe(false);

    t.invitation.failDispatch = false;
    const resent = await t.resend.execute('sao-jose');
    expect(resent?.invitationDispatched).toBe(true);
  });

  it('reenviar convite só com o tenant ACTIVE (RN-TEN-08)', async () => {
    const t = build();
    await t.run(input({ activate: false }));
    await expect(t.resend.execute('sao-jose')).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(t.resend.execute('nao-existe')).rejects.toMatchObject({
      code: 'TENANT_NOT_FOUND',
    });
  });

  it('[FA-11] simulação mostra o plano sem gravar; com tenant pendente, mostra o que falta', async () => {
    const t = build();
    const fresh = await t.provision.dryRun(input());
    expect(fresh.existingTenantId).toBeNull();
    expect(fresh.steps.map((step) => step.action)).toEqual([
      'CREATE',
      ...Array<string>(7).fill('RUN'),
      'RUN',
    ]);
    expect(await t.repository.findBySlug({} as never, 'sao-jose')).toBeNull();

    t.seeders.templates.failNext = new Error('falha');
    const partial = await t.run();
    const resumed = await t.provision.dryRun(input());
    expect(resumed.existingTenantId).toBe(partial.tenant.id);
    expect(resumed.steps.filter((step) => step.action === 'RUN').map((step) => step.key)).toEqual([
      'document.templateLibrary',
      'workflow.seedWorkflows',
      'catalog.holidays',
      'identity.firstAdmin',
      'tenancy.complete',
    ]);
  });

  it('[FA-03] consulta devolve o checklist calculado', async () => {
    const t = build();
    await t.run();
    const detail = await t.detail.execute({ slug: 'sao-jose' });
    expect(detail.provisioning.complete).toBe(true);
    expect(detail.provisioning.steps.find((step) => step.key === 'catalog.items')).toMatchObject({
      details: { items: 84 },
    });
    await expect(t.detail.execute({ slug: 'x-y-z' })).rejects.toMatchObject({
      code: 'TENANT_NOT_FOUND',
    });
  });
});

describe('ApplyTenantSeedersCommand (FA-08 · RM-07)', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('aplica só os seeders aplicáveis e pendentes, sem tocar no que existe', async () => {
    const t = build();
    const outcome = await t.run();
    t.seeders.holidays.rows.delete(outcome.tenant.id);

    const planned = await t.apply.execute({ slug: 'sao-jose', dryRun: true });
    expect(planned.filter((result) => result.result === 'PLANNED').map((r) => r.key)).toEqual([
      'catalog.holidays',
    ]);
    expect(planned.some((result) => result.key === 'identity.firstAdmin')).toBe(false);

    const applied = await t.apply.execute({ slug: 'sao-jose', dryRun: false });
    expect(applied.find((result) => result.key === 'catalog.holidays')).toMatchObject({
      result: 'APPLIED',
      created: 28,
    });
    expect(t.seeders.items.seedCalls).toBe(1);
  });

  it('seeder específico, inexistente ou com falha', async () => {
    const t = build();
    await t.run();
    expect(
      await t.apply.execute({ slug: 'sao-jose', seederKey: 'catalog.items', dryRun: false }),
    ).toEqual([{ key: 'catalog.items', version: '2026.10.1', result: 'UP_TO_DATE' }]);
    await expect(
      t.apply.execute({ slug: 'sao-jose', seederKey: 'identity.firstAdmin', dryRun: false }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(t.apply.execute({ slug: 'nenhum', dryRun: false })).rejects.toMatchObject({
      code: 'TENANT_NOT_FOUND',
    });

    const tenant = await t.repository.findBySlug({} as never, 'sao-jose');
    t.seeders.items.rows.delete(tenant?.id ?? '');
    t.seeders.items.failNext = new Error('falha');
    expect(
      await t.apply.execute({ slug: 'sao-jose', seederKey: 'catalog.items', dryRun: false }),
    ).toEqual([
      { key: 'catalog.items', version: '2026.10.1', result: 'FAILED', errorCode: 'Error' },
    ]);
  });

  it('tenant desativado não recebe seeders', async () => {
    const t = build();
    await t.run(input({ activate: false }));
    await t.lifecycle.execute({
      tenant: { slug: 'sao-jose' },
      action: 'DEACTIVATE',
      expectedVersion: null,
      operator: OPERATOR,
      channel: 'CLI',
    });
    await expect(t.apply.execute({ slug: 'sao-jose', dryRun: false })).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
  });
});

describe('ChangeTenantStatusCommand (RN-TEN-09..13)', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('encerra e desativa pela CLI com auditoria tenant.deactivate e eventos próprios', async () => {
    const t = build();
    const { tenant } = await t.run();
    const offboarded = await t.lifecycle.execute({
      tenant: { slug: 'sao-jose' },
      action: 'OFFBOARD',
      expectedVersion: null,
      reason: 'Fim do contrato com a prefeitura',
      operator: OPERATOR,
      channel: 'CLI',
      runId: 'run-42',
    });
    expect(offboarded.tenant).toMatchObject({ status: 'OFFBOARDING', offboardingStartedAt: NOW });
    const reverted = await t.lifecycle.execute({
      tenant: { id: tenant.id },
      action: 'ACTIVATE',
      expectedVersion: offboarded.tenant.version,
      operator: OPERATOR,
      channel: 'API',
    });
    expect(reverted.tenant).toMatchObject({
      status: 'ACTIVE',
      activatedAt: NOW,
      offboardingStartedAt: null,
    });
    // Reativação não reenvia convite.
    expect(reverted.invitation).toBeNull();
    await t.lifecycle.execute({
      tenant: { slug: 'sao-jose' },
      action: 'OFFBOARD',
      expectedVersion: null,
      reason: 'Fim do contrato com a prefeitura',
      operator: OPERATOR,
      channel: 'CLI',
    });
    const deactivated = await t.lifecycle.execute({
      tenant: { slug: 'sao-jose' },
      action: 'DEACTIVATE',
      expectedVersion: null,
      operator: OPERATOR,
      channel: 'CLI',
    });
    expect(deactivated.tenant).toMatchObject({ status: 'DEACTIVATED', deactivatedAt: NOW });

    const lifecycleAudits = t.audits.filter((entry) => entry.action === 'tenant.deactivate');
    expect(lifecycleAudits.map((entry) => entry.metadata?.toStatus)).toEqual([
      'OFFBOARDING',
      'OFFBOARDING',
      'DEACTIVATED',
    ]);
    expect(lifecycleAudits[0]?.metadata).toMatchObject({
      reason: 'Fim do contrato com a prefeitura',
      channel: 'CLI',
      runId: 'run-42',
    });
    expect(t.events.map((event) => event.eventType)).toEqual([
      'TenantProvisioned',
      'TenantActivated',
      'TenantOffboarded',
      'TenantActivated',
      'TenantOffboarded',
      'TenantDeactivated',
    ]);

    await expect(
      t.lifecycle.execute({
        tenant: { slug: 'sao-jose' },
        action: 'ACTIVATE',
        expectedVersion: null,
        operator: OPERATOR,
        channel: 'CLI',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('[Concorrência] If-Match desatualizado → 412 VERSION_CONFLICT; inexistente → 404', async () => {
    const t = build();
    const { tenant } = await t.run();
    t.repository.bumpVersion(tenant.id);
    await expect(
      t.lifecycle.execute({
        tenant: { id: tenant.id },
        action: 'SUSPEND',
        expectedVersion: tenant.version,
        reason: 'Contrato com pagamento em atraso',
        operator: OPERATOR,
        channel: 'API',
      }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(
      t.lifecycle.execute({
        tenant: { slug: 'nao-existe' },
        action: 'SUSPEND',
        expectedVersion: null,
        reason: 'Contrato com pagamento em atraso',
        operator: OPERATOR,
        channel: 'CLI',
      }),
    ).rejects.toMatchObject({ code: 'TENANT_NOT_FOUND' });
  });
});
