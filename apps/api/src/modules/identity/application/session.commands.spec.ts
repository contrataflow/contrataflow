import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { VerifiedToken } from '#shared/auth/ports.js';
import {
  currentRequestContext,
  runWithRequestContext,
  updateRequestContext,
} from '#shared/context/request-context.js';
import { ApiError } from '#shared/errors/api-error.js';
import { FAKE_MEMBERSHIPS, FAKE_TENANTS, FAKE_USERS } from '#shared/testing/fake-directory.js';
import type { FakeUser } from '#shared/testing/fake-directory.js';

import { GetMyProfileQuery, ListMyMembershipsQuery } from './me.queries.js';
import type { LoginRecord, SessionAuditPort } from './ports.js';
import { RecordSessionTenantCommand } from './record-session-tenant.command.js';
import type { RecordSessionTenantInput } from './record-session-tenant.command.js';
import { StartSessionCommand } from './start-session.command.js';
import {
  InMemoryAuthentikDirectory,
  InMemoryIdentityRepository,
} from '../infrastructure/in-memory-identity.repositories.js';
import { InMemoryTenantMfaPolicy } from '../infrastructure/tenant-mfa-policy.js';

/* US-087 — StartSessionCommand, RecordSessionTenantCommand, ME-01 e ME-04. */

const NOW = new Date('2026-10-14T12:00:00Z');
const clock = () => NOW;
const RAFAEL_SUB = '0192f000-0000-7000-8000-00000000aa01';

function token(subject: string, overrides: Partial<VerifiedToken> = {}): VerifiedToken {
  return {
    subject,
    amr: ['pwd'],
    authTime: NOW,
    email: null,
    emailVerified: false,
    ...overrides,
  };
}

function inRequest<T>(fn: () => Promise<T>, userId: string | null = null): Promise<T> {
  return runWithRequestContext({ correlationId: 'corr-0001', ip: '', userAgent: '' }, () => {
    if (userId) updateRequestContext({ actor: { type: 'USER', userId, membershipId: null } });
    return fn();
  });
}

function setup(options: { pks?: Record<string, string>; users?: FakeUser[] } = {}) {
  const repository = new InMemoryIdentityRepository(options.users);
  const directory = new InMemoryAuthentikDirectory(options.pks);
  const sessionStarted = vi.fn<SessionAuditPort['sessionStarted']>(() => Promise.resolve());
  const tenantSwitched = vi.fn<SessionAuditPort['tenantSwitched']>(() => Promise.resolve());
  const sessionEnded = vi.fn<SessionAuditPort['sessionEnded']>(() => Promise.resolve('recorded'));
  const audit: SessionAuditPort = { sessionStarted, tenantSwitched, sessionEnded };
  return {
    repository,
    audit: { sessionStarted, tenantSwitched, sessionEnded },
    start: new StartSessionCommand(repository, directory, clock),
    record: new RecordSessionTenantCommand(repository, audit, new InMemoryTenantMfaPolicy(), clock),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('StartSessionCommand (passo 7 · RN-IAM-06/07/16)', () => {
  it('[Sucesso] usuário já vinculado: atualiza lastLoginAt e devolve os vínculos', async () => {
    const { start, repository } = setup();
    const result = await start.execute(token('sub-ana'));
    expect(result).toMatchObject({ kind: 'started', firstLogin: false });
    if (result.kind !== 'started') throw new Error('esperado started');
    expect(result.user.id).toBe(FAKE_USERS.ana.id);
    expect(result.memberships.map((membership) => membership.tenant.id)).toEqual([
      FAKE_TENANTS.prefeituraA.id,
    ]);
    expect(repository.snapshotUser(FAKE_USERS.ana.id)?.lastLoginAt).toEqual(NOW);
  });

  it('[Sucesso] primeiro login vincula o sub ao convidado pelo authentikUserId confirmado no Authentik', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { start, repository } = setup({
      pks: { [RAFAEL_SUB]: FAKE_USERS.rafael.authentikUserId },
    });
    const result = await start.execute(token(RAFAEL_SUB));
    expect(result).toMatchObject({ kind: 'started', firstLogin: true });
    expect(repository.snapshotUser(FAKE_USERS.rafael.id)).toMatchObject({
      subject: RAFAEL_SUB,
      lastLoginAt: NOW,
    });
    // Segundo login: já vinculado, não é mais o primeiro.
    await expect(start.execute(token(RAFAEL_SUB))).resolves.toMatchObject({ firstLogin: false });
  });

  it('[Sucesso] sem authentikUserId, aceita o e-mail verificado de quem tem convite', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const invited: FakeUser = {
      ...FAKE_USERS.rafael,
      authentikUserId: null,
      email: 'Rafael@Prefeitura-A.test',
    };
    const users = Object.values(FAKE_USERS).map((user) =>
      user.id === invited.id ? invited : user,
    );
    const { start } = setup({ users });
    const verified = token(RAFAEL_SUB, { email: 'rafael@prefeitura-a.test', emailVerified: true });
    await expect(start.execute(verified)).resolves.toMatchObject({ firstLogin: true });
  });

  it('[Validação] e-mail não verificado, sem convite ou com authentikUserId não vincula', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { start } = setup();
    // Rafael tem authentikUserId: o e-mail não basta.
    await expect(
      start.execute(token(RAFAEL_SUB, { email: FAKE_USERS.rafael.email, emailVerified: true })),
    ).resolves.toEqual({ kind: 'unknown_user' });
    const noInvite: FakeUser = { ...FAKE_USERS.rafael, authentikUserId: null };
    const lonely = new InMemoryIdentityRepository(
      [noInvite],
      FAKE_MEMBERSHIPS.filter((membership) => membership.userId !== noInvite.id),
    );
    const withoutInvite = new StartSessionCommand(lonely, new InMemoryAuthentikDirectory(), clock);
    await expect(
      withoutInvite.execute(token(RAFAEL_SUB, { email: noInvite.email, emailVerified: true })),
    ).resolves.toEqual({ kind: 'unknown_user' });
    await expect(
      withoutInvite.execute(token(RAFAEL_SUB, { email: noInvite.email, emailVerified: false })),
    ).resolves.toEqual({ kind: 'unknown_user' });
  });

  it('[Permissão] usuário bloqueado pela plataforma não abre sessão nem registra login', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { start, repository } = setup();
    await expect(start.execute(token('sub-eva'))).resolves.toEqual({ kind: 'blocked' });
    expect(repository.snapshotUser(FAKE_USERS.eva.id)?.lastLoginAt).toBeNull();
  });

  it('[Validação] sub sem usuário: "sem vínculo", nenhum usuário criado', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { start } = setup();
    await expect(start.execute(token('sub-desconhecido'))).resolves.toEqual({
      kind: 'unknown_user',
    });
  });

  it('[Concorrência] dois primeiros logins simultâneos: o perdedor relê e segue sem novo vínculo', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { repository } = setup();
    const start = new StartSessionCommand(
      repository,
      new InMemoryAuthentikDirectory({ [RAFAEL_SUB]: FAKE_USERS.rafael.authentikUserId }),
      clock,
    );
    const results = await Promise.all([
      start.execute(token(RAFAEL_SUB)),
      start.execute(token(RAFAEL_SUB)),
    ]);
    expect(results.map((result) => result.kind)).toEqual(['started', 'started']);
    expect(results.filter((result) => result.kind === 'started' && result.firstLogin)).toHaveLength(
      1,
    );
    expect(repository.snapshotUser(FAKE_USERS.rafael.id)?.subject).toBe(RAFAEL_SUB);
  });

  it('conflito de vínculo resolvido pelo banco: se o vencedor é a mesma pessoa, segue; senão "sem vínculo"', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const repository = new InMemoryIdentityRepository();
    const pks = new InMemoryAuthentikDirectory({ [RAFAEL_SUB]: FAKE_USERS.rafael.authentikUserId });
    const original = repository.recordLogin.bind(repository);
    // O banco aceitou o vínculo de outra transação (mesma pessoa) antes desta.
    vi.spyOn(repository, 'recordLogin').mockImplementationOnce(
      async (userId, at): Promise<LoginRecord> => {
        await original(userId, at, RAFAEL_SUB);
        return { kind: 'subject_conflict' };
      },
    );
    const start = new StartSessionCommand(repository, pks, clock);
    await expect(start.execute(token(RAFAEL_SUB))).resolves.toMatchObject({
      kind: 'started',
      firstLogin: false,
    });

    const other = new InMemoryIdentityRepository();
    vi.spyOn(other, 'recordLogin').mockResolvedValue({ kind: 'subject_conflict' });
    const lost = new StartSessionCommand(other, pks, clock);
    await expect(lost.execute(token(RAFAEL_SUB))).resolves.toEqual({ kind: 'unknown_user' });
  });
});

describe('RecordSessionTenantCommand (passo 10 · RN-IAM-08/16/17)', () => {
  const base: Omit<RecordSessionTenantInput, 'subject' | 'tenantId'> = {
    kind: 'start',
    membershipId: null,
    setAsDefault: false,
    selection: 'AUTO',
    firstLogin: false,
    fromTenantId: null,
    amr: ['pwd'],
    sessionIdHash: 'a'.repeat(64),
    ip: '203.0.113.7',
    userAgent: 'Mozilla/5.0',
  };

  it('[Sucesso] confere o vínculo, registra o acesso e grava auth.session_start na instituição', async () => {
    const { record, audit, repository } = setup();
    const result = await inRequest(() =>
      record.execute({ ...base, subject: 'sub-ana', tenantId: FAKE_TENANTS.prefeituraA.id }),
    );
    expect(result).toMatchObject({ readOnly: false, membership: { id: FAKE_MEMBERSHIPS[0]?.id } });
    expect(repository.snapshotMembership(FAKE_MEMBERSHIPS[0]?.id ?? '')?.lastAccessAt).toEqual(NOW);
    expect(audit.sessionStarted).toHaveBeenCalledWith({
      tenantId: FAKE_TENANTS.prefeituraA.id,
      userId: FAKE_USERS.ana.id,
      membershipId: FAKE_MEMBERSHIPS[0]?.id,
      sessionIdHash: 'a'.repeat(64),
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0',
      selection: 'AUTO',
      firstLogin: false,
      amr: ['pwd'],
    });
  });

  it('grava no contexto do tenant escolhido sem alterar o contexto da requisição', async () => {
    const { repository, audit: spies } = setup();
    const audit: SessionAuditPort = spies;
    const seen: (string | null | undefined)[] = [];
    vi.spyOn(repository, 'touchMembershipAccess').mockImplementation(() => {
      seen.push(currentRequestContext()?.tenantId);
      return Promise.resolve();
    });
    const record = new RecordSessionTenantCommand(
      repository,
      audit,
      new InMemoryTenantMfaPolicy(),
      clock,
    );
    await inRequest(async () => {
      await record.execute({ ...base, subject: 'sub-ana', tenantId: FAKE_TENANTS.prefeituraA.id });
      seen.push(currentRequestContext()?.tenantId);
    });
    expect(seen).toEqual([FAKE_TENANTS.prefeituraA.id, null]);
  });

  it('[Tenant incorreto] instituição sem vínculo do usuário → 403 MEMBERSHIP_INACTIVE', async () => {
    const { record, audit } = setup();
    const attempt = inRequest(() =>
      record.execute({ ...base, subject: 'sub-ana', tenantId: FAKE_TENANTS.prefeituraB.id }),
    );
    await expect(attempt).rejects.toMatchObject({ code: 'MEMBERSHIP_INACTIVE', status: 403 });
    expect(audit.sessionStarted).not.toHaveBeenCalled();
  });

  it('[Permissão] vínculo suspenso → MEMBERSHIP_INACTIVE; instituição suspensa → TENANT_SUSPENDED', async () => {
    const { record } = setup();
    await expect(
      inRequest(() =>
        record.execute({ ...base, subject: 'sub-bruno', tenantId: FAKE_TENANTS.prefeituraA.id }),
      ),
    ).rejects.toMatchObject({ code: 'MEMBERSHIP_INACTIVE' });
    await expect(
      inRequest(() =>
        record.execute({
          ...base,
          subject: 'sub-davi',
          tenantId: FAKE_TENANTS.prefeituraSuspensa.id,
        }),
      ),
    ).rejects.toMatchObject({ code: 'TENANT_SUSPENDED' });
  });

  it('[Tenant incorreto] AUDITOR em instituição em encerramento entra em somente leitura', async () => {
    const { record } = setup();
    const result = await inRequest(() =>
      record.execute({
        ...base,
        selection: 'MANUAL',
        subject: 'sub-paulo',
        tenantId: FAKE_TENANTS.prefeituraEncerrando.id,
      }),
    );
    expect(result.readOnly).toBe(true);
  });

  it('[Permissão] usuário bloqueado → 403 PERMISSION_DENIED (USER_BLOCKED); sub desconhecido → MEMBERSHIP_INACTIVE', async () => {
    const { record } = setup();
    const blocked = inRequest(() =>
      record.execute({ ...base, subject: 'sub-eva', tenantId: FAKE_TENANTS.prefeituraA.id }),
    );
    await expect(blocked).rejects.toBeInstanceOf(ApiError);
    await expect(blocked).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      extensions: { reason: 'USER_BLOCKED' },
    });
    await expect(
      inRequest(() =>
        record.execute({ ...base, subject: 'sub-x', tenantId: FAKE_TENANTS.prefeituraA.id }),
      ),
    ).rejects.toMatchObject({ code: 'MEMBERSHIP_INACTIVE' });
  });

  it('troca de instituição grava auth.tenant_switch com a origem', async () => {
    const { record, audit } = setup();
    await inRequest(() =>
      record.execute({
        ...base,
        kind: 'switch',
        fromTenantId: FAKE_TENANTS.prefeituraA.id,
        subject: 'sub-fabio',
        tenantId: FAKE_TENANTS.prefeituraB.id,
      }),
    );
    expect(audit.tenantSwitched).toHaveBeenCalledWith(
      expect.objectContaining({
        fromTenantId: FAKE_TENANTS.prefeituraA.id,
        tenantId: FAKE_TENANTS.prefeituraB.id,
      }),
    );
    expect(audit.sessionStarted).not.toHaveBeenCalled();
  });
});

describe('ME-01 e ME-04', () => {
  it('ME-04 lista todos os vínculos do próprio usuário com usable/readOnly', async () => {
    const repository = new InMemoryIdentityRepository();
    const query = new ListMyMembershipsQuery(repository, clock);
    const list = await inRequest(() => query.execute(), FAKE_USERS.fabio.id);
    expect(list).toEqual([
      {
        membershipId: '0192a000-0000-7000-8000-0000000001f1',
        tenant: { id: FAKE_TENANTS.prefeituraA.id, name: 'Prefeitura A', status: 'ACTIVE' },
        type: 'INTERNAL',
        status: 'ACTIVE',
        expiresAt: null,
        usable: true,
        readOnly: false,
      },
      {
        membershipId: '0192a000-0000-7000-8000-0000000002f1',
        tenant: { id: FAKE_TENANTS.prefeituraB.id, name: 'Prefeitura B', status: 'ACTIVE' },
        type: 'EXTERNAL',
        status: 'ACTIVE',
        expiresAt: '2099-12-31T23:59:59.000Z',
        usable: true,
        readOnly: false,
      },
    ]);
    const carla = await inRequest(() => query.execute(), FAKE_USERS.carla.id);
    expect(carla).toEqual([expect.objectContaining({ usable: false, readOnly: false })]);
  });

  it('ME-01 devolve o perfil com preferências padrão e versão; sem usuário no contexto → 401', async () => {
    const query = new GetMyProfileQuery(new InMemoryIdentityRepository());
    await expect(inRequest(() => query.execute(), FAKE_USERS.fabio.id)).resolves.toEqual({
      id: FAKE_USERS.fabio.id,
      name: 'Fábio Nunes',
      socialName: 'Fabi Nunes',
      phone: null,
      preferences: { density: 'comfortable', theme: 'system' },
      version: 1,
    });
    await expect(inRequest(() => query.execute())).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    await expect(
      inRequest(() => query.execute(), '0192a000-0000-7000-8000-0000000000ff'),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});
