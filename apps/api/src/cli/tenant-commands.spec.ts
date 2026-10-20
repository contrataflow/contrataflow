import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '#shared/errors/api-error.js';

import { EXIT_INCOMPLETE, EXIT_INVALID, EXIT_OK, runTenantCli } from './tenant-commands.js';
import type { TenantCliDeps } from './tenant-commands.js';
import type { ProvisioningOutcome } from '../modules/tenancy/application/provision-tenant.command.js';
import type { ProvisioningChecklist } from '../modules/tenancy/domain/seeding-plan.js';
import type { Tenant } from '../modules/tenancy/domain/tenant.js';

/*
 * US-099 — CLI `pnpm cf tenant:*` (FA-01..08 · V-10 · códigos de saída 0/1/2). Os casos de uso são
 * dublês: o comportamento deles é coberto pelas rotas (`platform-tenants.routes.spec.ts`) e pela
 * integração (`test/tenancy`).
 */

const OPERATOR = {
  id: '0192a000-0000-7000-8000-0000000000c9',
  name: 'Carla Antunes',
  email: 'carla@contrataflow.com.br',
  status: 'ACTIVE' as const,
  isPlatformOperator: true,
};

const TENANT: Tenant = {
  id: '0192a000-0000-7000-8000-000000000099',
  slug: 'sao-jose',
  name: 'Prefeitura de São José',
  legalName: null,
  type: 'MUNICIPALITY',
  status: 'ACTIVE',
  stateCode: 'SC',
  ibgeCityCode: '4216602',
  timezone: 'America/Sao_Paulo',
  locale: 'pt-BR',
  plan: 'STANDARD',
  primaryOrganizationId: null,
  activatedAt: new Date('2026-10-06T12:00:00Z'),
  suspendedAt: null,
  suspensionReason: null,
  deactivatedAt: null,
  offboardingStartedAt: null,
  offboardingEndsAt: null,
  provisioningFingerprint: null,
  createdAt: new Date('2026-10-06T12:00:00Z'),
  updatedAt: new Date('2026-10-06T12:00:00Z'),
  version: 2,
};

const CHECKLIST: ProvisioningChecklist = {
  complete: true,
  steps: [
    { key: 'tenancy.tenantRecord', status: 'DONE', version: null },
    { key: 'access.defaultRoles', status: 'DONE', version: '2026.10.1', details: { roles: 15 } },
    { key: 'tenancy.complete', status: 'DONE', version: null },
  ],
};

const FILE = JSON.stringify({
  slug: 'sao-jose',
  name: 'Prefeitura de São José',
  type: 'MUNICIPALITY',
  stateCode: 'SC',
  ibgeCityCode: '4216602',
  primaryOrganization: {
    name: 'Prefeitura Municipal de São José',
    shortName: 'PMSJ',
    cnpj: '11.222.333/0001-81',
    type: 'DIRECT_ADMINISTRATION',
  },
  firstAdmin: { email: 'rafael.nogueira@pmsj.exemplo.gov.br', name: 'Rafael Nogueira' },
});

function setup(overrides: Partial<TenantCliDeps> = {}) {
  const outcome: ProvisioningOutcome = {
    kind: 'complete',
    tenant: TENANT,
    checklist: CHECKLIST,
    firstAdmin: {
      email: 'rafael.nogueira@pmsj.exemplo.gov.br',
      membershipStatus: 'INVITED',
      invitationDispatched: false,
    },
  };
  const deps: TenantCliDeps = {
    findOperatorByEmail: vi.fn((email: string) =>
      Promise.resolve(email === OPERATOR.email ? OPERATOR : null),
    ),
    readFile: vi.fn(() => Promise.resolve(FILE)),
    provision: vi.fn(() => Promise.resolve(outcome)),
    dryRun: vi.fn(() =>
      Promise.resolve({
        kind: 'planned' as const,
        existingTenantId: null,
        steps: [{ key: 'tenancy.tenantRecord', action: 'CREATE' as const }],
      }),
    ),
    status: vi.fn(() => Promise.resolve({ tenant: TENANT, provisioning: CHECKLIST })),
    changeStatus: vi.fn(() => Promise.resolve({ tenant: TENANT, invitation: null })),
    applySeeders: vi.fn(() =>
      Promise.resolve([
        { key: 'access.defaultRoles', version: '1', result: 'UP_TO_DATE' as const },
      ]),
    ),
    resendInvite: vi.fn(() => Promise.resolve(null)),
    runId: () => 'run-1',
    ...overrides,
  };
  const out: string[] = [];
  const err: string[] = [];
  const run = (...argv: string[]) =>
    runTenantCli(argv, deps, { out: (text) => out.push(text), err: (text) => err.push(text) });
  return { deps, run, out, err };
}

const AS_CARLA = ['--operator', 'Carla@ContrataFlow.com.br'];

describe('CLI de tenants (US-099)', () => {
  it('tenant:provision imprime o checklist e sai com 0', async () => {
    const { run, deps, out } = setup();
    expect(await run('tenant:provision', '--file', 'sao-jose.json', ...AS_CARLA)).toBe(EXIT_OK);
    expect(deps.provision).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'CLI',
        runId: 'run-1',
        idempotencyKey: null,
        operator: { id: OPERATOR.id, name: OPERATOR.name },
        input: expect.objectContaining({ slug: 'sao-jose', activate: true }) as unknown,
      }),
    );
    const printed = out.join('\n');
    expect(printed).toContain('access.defaultRoles');
    expect(printed).toContain('roles=15');
    expect(printed).toContain('r***@pmsj.exemplo.gov.br');
    expect(printed).not.toContain('rafael.nogueira@');
  });

  it('--no-activate envia activate=false; --json imprime JSON com e-mail mascarado', async () => {
    const { run, deps, out } = setup();
    await run('tenant:provision', '--file', 'x.json', '--no-activate', '--json', ...AS_CARLA);
    expect(deps.provision).toHaveBeenCalledWith(
      expect.objectContaining({ input: expect.objectContaining({ activate: false }) as unknown }),
    );
    const json = JSON.parse(out.join('\n')) as { kind: string; firstAdmin: { email: string } };
    expect(json.kind).toBe('complete');
    expect(json.firstAdmin.email).toBe('r***@pmsj.exemplo.gov.br');
  });

  it('[Falha de banco] provisionamento incompleto sai com 2', async () => {
    const { run, err } = setup({
      provision: () =>
        Promise.resolve({
          kind: 'incomplete' as const,
          tenant: { ...TENANT, status: 'PROVISIONING' as const },
          checklist: { ...CHECKLIST, complete: false },
          firstAdmin: null,
          failedStep: 'document.templateLibrary',
          errorCode: 'DEPENDENCY_UNAVAILABLE',
        }),
    });
    expect(await run('tenant:provision', '--file', 'x.json', ...AS_CARLA)).toBe(EXIT_INCOMPLETE);
    expect(err.join('\n')).toContain('document.templateLibrary');
  });

  it('--dry-run mostra o plano sem provisionar', async () => {
    const { run, deps, out } = setup();
    expect(await run('tenant:provision', '--file', 'x.json', '--dry-run', ...AS_CARLA)).toBe(
      EXIT_OK,
    );
    expect(deps.provision).not.toHaveBeenCalled();
    expect(out.join('\n')).toContain('nada foi gravado');
  });

  it('arquivo inválido lista campo e motivo e sai com 1', async () => {
    const { run, err } = setup({
      readFile: () => Promise.resolve(JSON.stringify({ ...JSON.parse(FILE), slug: 'admin' })),
    });
    expect(await run('tenant:provision', '--file', 'x.json', ...AS_CARLA)).toBe(EXIT_INVALID);
    expect(err.join('\n')).toContain('slug: INVALID_FORMAT');
  });

  it('arquivo ilegível sai com 1', async () => {
    const { run } = setup({ readFile: () => Promise.reject(new Error('ENOENT')) });
    expect(await run('tenant:provision', '--file', 'x.json', ...AS_CARLA)).toBe(EXIT_INVALID);
  });

  it('[Permissão] sem --operator ou com quem não é operador sai com 1, sem efeito', async () => {
    const { run, deps, err } = setup();
    expect(await run('tenant:provision', '--file', 'x.json')).toBe(EXIT_INVALID);
    expect(await run('tenant:provision', '--file', 'x.json', '--operator', 'rafael@x.gov.br')).toBe(
      EXIT_INVALID,
    );
    expect(deps.provision).not.toHaveBeenCalled();
    expect(err.join('\n')).toContain('PERMISSION_DENIED');
  });

  it('[Validação] suspensão e encerramento exigem motivo de 10+ caracteres', async () => {
    const { run, deps, err } = setup();
    expect(await run('tenant:suspend', 'sao-jose', '--reason', 'curto', ...AS_CARLA)).toBe(
      EXIT_INVALID,
    );
    expect(err.join('\n')).toContain('reason: TOO_SHORT');
    expect(
      await run('tenant:offboard', 'sao-jose', '--reason', 'Fim do contrato vigente', ...AS_CARLA),
    ).toBe(EXIT_OK);
    expect(deps.changeStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant: { slug: 'sao-jose' },
        action: 'OFFBOARD',
        reason: 'Fim do contrato vigente',
        expectedVersion: null,
        channel: 'CLI',
      }),
    );
  });

  it('encerramento aceita --ends-at futuro e recusa data passada ou inválida', async () => {
    const { run, deps } = setup();
    const reason = ['--reason', 'Fim do contrato vigente'];
    expect(
      await run('tenant:offboard', 'sao-jose', ...reason, '--ends-at', '2099-12-31', ...AS_CARLA),
    ).toBe(EXIT_OK);
    expect(deps.changeStatus).toHaveBeenCalledWith(
      expect.objectContaining({ offboardingEndsAt: new Date('2099-12-31T23:59:59-03:00') }),
    );
    expect(
      await run('tenant:offboard', 'sao-jose', ...reason, '--ends-at', '2020-01-01', ...AS_CARLA),
    ).toBe(EXIT_INVALID);
    expect(
      await run('tenant:offboard', 'sao-jose', ...reason, '--ends-at', 'amanhã', ...AS_CARLA),
    ).toBe(EXIT_INVALID);
    expect(deps.changeStatus).toHaveBeenCalledTimes(1);
  });

  it('[V-10] desativação exige --confirm-slug igual ao slug', async () => {
    const { run, deps, err } = setup();
    expect(
      await run('tenant:deactivate', 'sao-jose', '--confirm-slug', 'sao-joze', ...AS_CARLA),
    ).toBe(EXIT_INVALID);
    expect(deps.changeStatus).not.toHaveBeenCalled();
    expect(err.join('\n')).toContain('A confirmação não corresponde ao identificador.');
    expect(
      await run('tenant:deactivate', 'sao-jose', '--confirm-slug', 'sao-jose', ...AS_CARLA),
    ).toBe(EXIT_OK);
    expect(deps.changeStatus).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'DEACTIVATE' }),
    );
  });

  it('tenant:activate e tenant:suspend chamam o mesmo caso de uso da API', async () => {
    const { run, deps } = setup();
    await run('tenant:activate', 'sao-jose', ...AS_CARLA);
    await run(
      'tenant:suspend',
      'sao-jose',
      '--reason',
      'Contrato com pagamento em atraso',
      ...AS_CARLA,
    );
    expect(vi.mocked(deps.changeStatus).mock.calls.map(([call]) => call.action)).toEqual([
      'ACTIVATE',
      'SUSPEND',
    ]);
  });

  it('erros de domínio: 4xx sai com 1, 5xx sai com 2', async () => {
    const conflict = setup({
      changeStatus: () =>
        Promise.reject(new ApiError('INVALID_STATE', { detail: 'Não é possível.' })),
    });
    expect(await conflict.run('tenant:activate', 'sao-jose', ...AS_CARLA)).toBe(EXIT_INVALID);
    expect(conflict.err.join('\n')).toContain('INVALID_STATE: Não é possível.');
    const down = setup({
      status: () => Promise.reject(new ApiError('DEPENDENCY_UNAVAILABLE')),
    });
    expect(await down.run('tenant:status', 'sao-jose', ...AS_CARLA)).toBe(EXIT_INCOMPLETE);
    const unexpected = setup({ status: () => Promise.reject(new Error('boom')) });
    expect(await unexpected.run('tenant:status', 'sao-jose', ...AS_CARLA)).toBe(EXIT_INCOMPLETE);
  });

  it('tenant:status imprime tabela ou JSON', async () => {
    const { run, out } = setup();
    expect(await run('tenant:status', 'sao-jose', ...AS_CARLA)).toBe(EXIT_OK);
    expect(out.join('\n')).toContain('Prefeitura de São José (sao-jose) — ACTIVE');
    expect(await run('tenant:status', 'sao-jose', '--json', ...AS_CARLA)).toBe(EXIT_OK);
    expect(() => JSON.parse(out.at(-1) ?? '') as unknown).not.toThrow();
  });

  it('tenant:seed repassa seeder e simulação; falha de um seeder sai com 2', async () => {
    const { run, deps } = setup();
    expect(
      await run(
        'tenant:seed',
        'sao-jose',
        '--seeder',
        'access.defaultRoles',
        '--dry-run',
        ...AS_CARLA,
      ),
    ).toBe(EXIT_OK);
    expect(deps.applySeeders).toHaveBeenCalledWith({
      slug: 'sao-jose',
      seederKey: 'access.defaultRoles',
      dryRun: true,
    });
    const failing = setup({
      applySeeders: () =>
        Promise.resolve([
          {
            key: 'x.y',
            version: '1',
            result: 'FAILED' as const,
            errorCode: 'DEPENDENCY_UNAVAILABLE',
          },
        ]),
    });
    expect(await failing.run('tenant:seed', 'sao-jose', ...AS_CARLA)).toBe(EXIT_INCOMPLETE);
  });

  it('tenant:resend-invite sai com 0 só quando o convite foi enviado', async () => {
    const pending = setup();
    expect(await pending.run('tenant:resend-invite', 'sao-jose', ...AS_CARLA)).toBe(
      EXIT_INCOMPLETE,
    );
    const sent = setup({
      resendInvite: () =>
        Promise.resolve({
          email: 'rafael.nogueira@pmsj.exemplo.gov.br',
          membershipStatus: 'INVITED',
          invitationDispatched: true,
        }),
    });
    expect(await sent.run('tenant:resend-invite', 'sao-jose', ...AS_CARLA)).toBe(EXIT_OK);
    expect(sent.out.join('\n')).toContain('convite enviado');
  });

  it('uso inválido: comando desconhecido, opção desconhecida ou slug ausente → 1', async () => {
    const { run } = setup();
    expect(await run()).toBe(EXIT_INVALID);
    expect(await run('tenant:explode', ...AS_CARLA)).toBe(EXIT_INVALID);
    expect(await run('tenant:status', '--force', ...AS_CARLA)).toBe(EXIT_INVALID);
    expect(await run('tenant:status', ...AS_CARLA)).toBe(EXIT_INVALID);
    expect(await run('tenant:provision', ...AS_CARLA)).toBe(EXIT_INVALID);
  });
});
