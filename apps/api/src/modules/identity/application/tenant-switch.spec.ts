import { afterEach, describe, expect, it, vi } from 'vitest';

import { runWithRequestContext } from '#shared/context/request-context.js';
import { DatabaseUnavailableError } from '#shared/database/errors.js';
import { FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';

import type { SessionAuditPort } from './ports.js';
import { RecordSessionTenantCommand } from './record-session-tenant.command.js';
import type { RecordSessionTenantInput } from './record-session-tenant.command.js';
import { InMemoryIdentityRepository } from '../infrastructure/in-memory-identity.repositories.js';
import { InMemoryTenantMfaPolicy } from '../infrastructure/tenant-mfa-policy.js';

/*
 * US-093 — Selecionar órgão ativo: `ResolveSessionEventCommand` (`RecordSessionTenantCommand`) na
 * troca (`TENANT_SWITCHED`). "Helena" = Fábio no diretório fixo: vínculos ACTIVE nas Prefeituras
 * A (interno) e B (externo).
 */

const NOW = new Date('2026-10-14T12:00:00Z');
const A = FAKE_TENANTS.prefeituraA.id;
const B = FAKE_TENANTS.prefeituraB.id;
const HELENA_A = '0192a000-0000-7000-8000-0000000001f1';
const HELENA_B = '0192a000-0000-7000-8000-0000000002f1';
/** Vínculo da Ana (outra pessoa) na Prefeitura A. */
const ANA_A = '0192a000-0000-7000-8000-0000000001a1';

const SWITCH: RecordSessionTenantInput = {
  subject: 'sub-fabio',
  tenantId: null,
  membershipId: HELENA_B,
  kind: 'switch',
  selection: 'MANUAL',
  firstLogin: false,
  fromTenantId: A,
  setAsDefault: false,
  amr: ['pwd'],
  sessionIdHash: 'b'.repeat(64),
  ip: '203.0.113.9',
  userAgent: 'Firefox',
};

function setup(policies: Record<string, 'NONE' | 'ADMINS' | 'ALL'> = {}) {
  const repository = new InMemoryIdentityRepository();
  const tenantSwitched = vi.fn<SessionAuditPort['tenantSwitched']>(() => Promise.resolve());
  const sessionStarted = vi.fn<SessionAuditPort['sessionStarted']>(() => Promise.resolve());
  const audit: SessionAuditPort = {
    sessionStarted,
    tenantSwitched,
    sessionEnded: () => Promise.resolve('recorded'),
  };
  const command = new RecordSessionTenantCommand(
    repository,
    audit,
    new InMemoryTenantMfaPolicy(policies),
    () => NOW,
  );
  const execute = (input: Partial<RecordSessionTenantInput> = {}) =>
    runWithRequestContext({ correlationId: 'corr-0093', ip: '', userAgent: '' }, () =>
      command.execute({ ...SWITCH, ...input }),
    );
  return { repository, tenantSwitched, sessionStarted, execute };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Feature: Selecionar órgão ativo — revalidação na API (US-093)', () => {
  it('[Sucesso] troca pelo vínculo: grava auth.tenant_switch com origem, destino e seleção', async () => {
    const { execute, tenantSwitched, sessionStarted, repository } = setup();
    const result = await execute();
    expect(result).toMatchObject({
      outcome: 'activated',
      membership: { id: HELENA_B, tenant: { id: B } },
      readOnly: false,
      defaultTenantId: null,
    });
    expect(tenantSwitched).toHaveBeenCalledWith({
      tenantId: B,
      userId: FAKE_USERS.fabio.id,
      membershipId: HELENA_B,
      sessionIdHash: 'b'.repeat(64),
      ip: '203.0.113.9',
      userAgent: 'Firefox',
      fromTenantId: A,
      selection: 'MANUAL',
    });
    expect(sessionStarted).not.toHaveBeenCalled();
    expect(repository.snapshotMembership(HELENA_B)?.lastAccessAt).toEqual(NOW);
  });

  it('[Validação] vínculo de outra pessoa → 422 VALIDATION_ERROR com REFERENCE_NOT_FOUND', async () => {
    const { execute, tenantSwitched } = setup();
    const expected = {
      code: 'VALIDATION_ERROR',
      status: 422,
      errors: [
        {
          field: 'membershipId',
          code: 'REFERENCE_NOT_FOUND',
          message: 'Selecione uma instituição válida.',
        },
      ],
    };
    await expect(execute({ membershipId: ANA_A })).rejects.toMatchObject(expected);
    // Vínculo e instituição que não combinam: mesma resposta, sem revelar nada.
    await expect(execute({ membershipId: HELENA_A, tenantId: B })).rejects.toMatchObject(expected);
    expect(tenantSwitched).not.toHaveBeenCalled();
  });

  it('[Permissão] vínculo suspenso → 403 MEMBERSHIP_INACTIVE', async () => {
    const { execute } = setup();
    await expect(
      execute({ subject: 'sub-bruno', membershipId: '0192a000-0000-7000-8000-0000000001b1' }),
    ).rejects.toMatchObject({ code: 'MEMBERSHIP_INACTIVE', status: 403 });
  });

  it('[Tenant incorreto] instituição suspensa pela plataforma → 403 TENANT_SUSPENDED', async () => {
    const { execute, tenantSwitched } = setup();
    await expect(
      execute({ subject: 'sub-davi', membershipId: '0192a000-0000-7000-8000-0000000001d1' }),
    ).rejects.toMatchObject({ code: 'TENANT_SUSPENDED', status: 403 });
    expect(tenantSwitched).not.toHaveBeenCalled();
  });

  it('[Duplicidade] trocar para a instituição já ativa é no-op: sem auditoria nem acesso', async () => {
    const { execute, tenantSwitched, repository } = setup();
    const result = await execute({ membershipId: HELENA_A });
    expect(result.outcome).toBe('unchanged');
    expect(tenantSwitched).not.toHaveBeenCalled();
    expect(repository.snapshotMembership(HELENA_A)?.lastAccessAt).toBeNull();
  });

  it('FA-04 "Usar como padrão": grava preferences.defaultTenantId (também no no-op)', async () => {
    const { execute, repository } = setup();
    const switched = await execute({ setAsDefault: true });
    expect(switched.defaultTenantId).toBe(B);
    expect(repository.snapshotUser(FAKE_USERS.fabio.id)?.preferences).toEqual({
      defaultTenantId: B,
    });
    const setDefault = vi.spyOn(repository, 'setDefaultTenant');
    const again = await execute({ membershipId: HELENA_B, fromTenantId: B, setAsDefault: true });
    expect(again).toMatchObject({ outcome: 'unchanged', defaultTenantId: B });
    // Já era a padrão: nada a gravar.
    expect(setDefault).not.toHaveBeenCalled();
    const back = await execute({ membershipId: HELENA_A, fromTenantId: A, setAsDefault: true });
    expect(back).toMatchObject({ outcome: 'unchanged', defaultTenantId: A });
  });

  it('[Falha de integração] destino com mfaPolicy ALL e sessão sem MFA: troca suspensa, nada gravado', async () => {
    const { execute, tenantSwitched, repository } = setup({ [B]: 'ALL' });
    const suspended = await execute({ setAsDefault: true });
    expect(suspended.outcome).toBe('mfa_required');
    expect(tenantSwitched).not.toHaveBeenCalled();
    expect(repository.snapshotUser(FAKE_USERS.fabio.id)?.preferences).toEqual({});
    expect(repository.snapshotMembership(HELENA_B)?.lastAccessAt).toBeNull();
    // Depois do step-up (amr com segundo fator), a mesma troca se completa.
    const completed = await execute({ amr: ['pwd', 'otp'] });
    expect(completed.outcome).toBe('activated');
    expect(tenantSwitched).toHaveBeenCalledOnce();
  });

  it('o MFA é o do destino, nunca o da origem (A com ALL não bloqueia a ida para B)', async () => {
    const { execute } = setup({ [A]: 'ALL' });
    await expect(execute()).resolves.toMatchObject({ outcome: 'activated' });
  });

  it('[Falha de banco] banco indisponível ao revalidar o vínculo → 503 DEPENDENCY_UNAVAILABLE', async () => {
    const { execute, repository, tenantSwitched } = setup();
    vi.spyOn(repository, 'listMemberships').mockRejectedValue(
      new DatabaseUnavailableError(new Error('connection refused')),
    );
    await expect(execute()).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      status: 503,
    });
    expect(tenantSwitched).not.toHaveBeenCalled();
  });

  it('[Concorrência] duas trocas iguais em sequência rápida: a segunda vira no-op', async () => {
    const { execute, tenantSwitched } = setup();
    const [first, second] = await Promise.all([
      execute(),
      // O BFF serializa: a segunda chega com a origem já atualizada.
      execute({ fromTenantId: B }),
    ]);
    expect(first.outcome).toBe('activated');
    expect(second.outcome).toBe('unchanged');
    expect(tenantSwitched).toHaveBeenCalledOnce();
  });
});
