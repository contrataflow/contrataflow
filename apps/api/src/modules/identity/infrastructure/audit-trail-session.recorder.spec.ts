import type { SessionTombstone } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuditEntry, AuditOutcome, AuditTrailPort } from '#shared/audit/audit-trail.js';
import {
  currentRequestContext,
  runWithRequestContext,
  runWithTenantScope,
} from '#shared/context/request-context.js';
import type { RequestContext } from '#shared/context/request-context.js';

import { AuditTrailSessionRecorder } from './audit-trail-session.recorder.js';

/* US-088 — auth.session_end / auth.session_expired gravados pela varredura (RN-IAM-24/28). */

const MINUTE = 60_000;
const T0 = Date.parse('2026-10-14T10:00:00.000Z');

const TENANT_A = '0192f000-0000-7000-8000-00000000000a';
const TENANT_B = '0192f000-0000-7000-8000-00000000000b';
const CLAUDIA = '0192f000-0000-7000-8000-0000000000c1';
const CLAUDIA_MEMBERSHIP = '0192f000-0000-7000-8000-0000000001c1';
const DIEGO = '0192f000-0000-7000-8000-0000000000d1';
const DIEGO_MEMBERSHIP = '0192f000-0000-7000-8000-0000000001d1';
const KEY = 'a'.repeat(64);

function tombstone(overrides: Partial<SessionTombstone> = {}): SessionTombstone {
  return {
    key: KEY,
    userId: CLAUDIA,
    displayName: 'Cláudia Ramos',
    activeTenantId: TENANT_A,
    membershipId: CLAUDIA_MEMBERSHIP,
    reason: 'IDLE',
    occurredAt: T0 + 30 * MINUTE,
    createdAt: T0,
    lastSeenAt: T0,
    idleMinutes: 30,
    ip: '203.0.113.7',
    userAgent: 'Mozilla/5.0 (Vitest)',
    ...overrides,
  };
}

interface Call {
  readonly entry: AuditEntry;
  /** O contexto da requisição/job no instante da gravação (o que o AuditService lê). */
  readonly context: RequestContext;
}

/** Trilha fake: guarda a entrada e o contexto com que o `AuditService` seria chamado. */
class FakeAuditTrail implements AuditTrailPort {
  readonly calls: Call[] = [];
  outcome: 'recorded' | 'duplicate' = 'recorded';
  failure: Error | null = null;

  record(): Promise<AuditOutcome> {
    return Promise.reject(new Error('record não é usado pelo recorder'));
  }

  recordStandalone(entry: AuditEntry): Promise<AuditOutcome> {
    const context = currentRequestContext();
    if (!context) return Promise.reject(new Error('sem contexto'));
    this.calls.push({ entry, context });
    if (this.failure) return Promise.reject(this.failure);
    return Promise.resolve(
      this.outcome === 'duplicate'
        ? { kind: 'duplicate' }
        : {
            kind: 'recorded',
            id: 'id',
            occurredAt: entry.occurredAt ?? new Date(),
            rowHash: 'hash',
          },
    );
  }
}

function setup() {
  const trail = new FakeAuditTrail();
  return { trail, recorder: new AuditTrailSessionRecorder(trail) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AuditTrailSessionRecorder.sessionEnded', () => {
  it('[Sucesso] expiração por ociosidade: auth.session_expired no horário do limite, com o ator da sessão', async () => {
    const { recorder, trail } = setup();

    await expect(recorder.sessionEnded(tombstone())).resolves.toBe('recorded');

    expect(trail.calls).toHaveLength(1);
    const [{ entry, context }] = trail.calls as [Call];
    expect(entry).toEqual({
      action: 'auth.session_expired',
      occurredAt: new Date(T0 + 30 * MINUTE),
      oncePerSession: true,
      metadata: { reason: 'IDLE', idleMinutes: 30 },
    });
    expect(context).toMatchObject({
      tenantId: TENANT_A,
      actor: {
        type: 'USER',
        userId: CLAUDIA,
        membershipId: CLAUDIA_MEMBERSHIP,
        name: 'Cláudia Ramos',
      },
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0 (Vitest)',
      sessionIdHash: KEY,
    });
    expect(context.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    // O contexto da varredura não vaza para quem chamou.
    expect(currentRequestContext()).toBeUndefined();
  });

  it.each(['IDLE', 'ABSOLUTE', 'REFRESH_FAILED'] as const)(
    'expiração %s grava auth.session_expired com a ociosidade vigente',
    async (reason) => {
      const { recorder, trail } = setup();
      await recorder.sessionEnded(tombstone({ reason, idleMinutes: 45 }));
      expect(trail.calls[0]?.entry).toMatchObject({
        action: 'auth.session_expired',
        metadata: { reason, idleMinutes: 45 },
      });
    },
  );

  it.each([
    'LOGOUT',
    'SESSION_LIMIT',
    'MEMBERSHIP_SUSPENDED',
    'MEMBERSHIP_REVOKED',
    'MEMBERSHIP_EXPIRED',
  ] as const)(
    'encerramento %s grava auth.session_end com a duração da sessão em minutos',
    async (reason) => {
      const { recorder, trail } = setup();
      // 42 min e 40 s de sessão: arredonda para 43.
      await recorder.sessionEnded(tombstone({ reason, occurredAt: T0 + 42 * MINUTE + 40_000 }));
      expect(trail.calls[0]?.entry).toMatchObject({
        action: 'auth.session_end',
        occurredAt: new Date(T0 + 42 * MINUTE + 40_000),
        oncePerSession: true,
        metadata: { reason, sessionAgeMinutes: 43 },
      });
    },
  );

  it('relógio do BFF atrás da criação não gera duração negativa', async () => {
    const { recorder, trail } = setup();
    await recorder.sessionEnded(tombstone({ reason: 'LOGOUT', occurredAt: T0 - MINUTE }));
    expect(trail.calls[0]?.entry.metadata).toEqual({ reason: 'LOGOUT', sessionAgeMinutes: 0 });
  });

  it('[Duplicidade] registro que a trilha já tem (varredura refeita) devolve duplicate', async () => {
    const { recorder, trail } = setup();
    trail.outcome = 'duplicate';
    await expect(recorder.sessionEnded(tombstone())).resolves.toBe('duplicate');
    expect(trail.calls).toHaveLength(1);
  });

  it('[Tenant incorreto] cada encerramento é gravado só na instituição ativa da própria sessão', async () => {
    const { recorder, trail } = setup();
    await recorder.sessionEnded(tombstone());
    await recorder.sessionEnded(
      tombstone({
        key: 'b'.repeat(64),
        userId: DIEGO,
        displayName: 'Diego Alves',
        activeTenantId: TENANT_B,
        membershipId: DIEGO_MEMBERSHIP,
      }),
    );

    expect(
      trail.calls.map(({ context }) => [
        context.tenantId,
        context.actor.userId,
        context.actor.membershipId,
        context.sessionIdHash,
      ]),
    ).toEqual([
      [TENANT_A, CLAUDIA, CLAUDIA_MEMBERSHIP, KEY],
      [TENANT_B, DIEGO, DIEGO_MEMBERSHIP, 'b'.repeat(64)],
    ]);
  });

  it('sem instituição ativa não há onde gravar: nada é gravado', async () => {
    const { recorder, trail } = setup();
    await expect(
      recorder.sessionEnded(tombstone({ activeTenantId: null, membershipId: null })),
    ).resolves.toBe('duplicate');
    expect(trail.calls).toHaveLength(0);
  });

  it('instituição sem vínculo: não grava, avisa sem expor a sessão e não trava a fila', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { recorder, trail } = setup();

    await expect(recorder.sessionEnded(tombstone({ membershipId: null }))).resolves.toBe(
      'duplicate',
    );

    expect(trail.calls).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      { event: 'auth.session_audit_skipped', reason: 'MEMBERSHIP_MISSING', tenantId: TENANT_A },
      'auth.session_audit_skipped',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(KEY);
  });

  it('encerramento sem IP nem user-agent (varredura) grava sem eles', async () => {
    const { recorder, trail } = setup();
    await recorder.sessionEnded(tombstone({ ip: null, userAgent: null }));
    expect(trail.calls[0]?.context).toMatchObject({ ip: '', userAgent: '', sessionIdHash: KEY });
  });

  it('[Falha de banco] a falha da gravação propaga para o chamador manter o encerramento', async () => {
    const { recorder, trail } = setup();
    const down = new Error('Connection terminated unexpectedly');
    trail.failure = down;
    await expect(recorder.sessionEnded(tombstone())).rejects.toBe(down);
  });
});

describe('AuditTrailSessionRecorder — início e troca de instituição (US-087)', () => {
  it('sessionStarted e tenantSwitched usam o IP, o user-agent e o hash informados pelo BFF', async () => {
    const { recorder, trail } = setup();
    const base = {
      tenantId: TENANT_A,
      userId: CLAUDIA,
      membershipId: CLAUDIA_MEMBERSHIP,
      sessionIdHash: KEY,
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0',
    };
    // Requisição do BFF já no escopo do usuário (o que `RecordSessionTenantCommand` monta).
    await runWithRequestContext({ correlationId: 'corr-bff', ip: '', userAgent: '' }, () =>
      runWithTenantScope(
        { tenantId: TENANT_A, userId: CLAUDIA, membershipId: CLAUDIA_MEMBERSHIP },
        async () => {
          await recorder.sessionStarted({
            ...base,
            selection: 'AUTO',
            firstLogin: false,
            amr: ['pwd'],
          });
          await recorder.tenantSwitched({ ...base, fromTenantId: TENANT_B });
        },
      ),
    );

    expect(trail.calls.map(({ entry }) => entry)).toEqual([
      {
        action: 'auth.session_start',
        metadata: { selection: 'AUTO', firstLogin: false, amr: ['pwd'] },
      },
      {
        action: 'auth.tenant_switch',
        metadata: { fromTenantId: TENANT_B, toTenantId: TENANT_A },
      },
    ]);
    expect(trail.calls.map(({ context }) => [context.sessionIdHash, context.ip])).toEqual([
      [KEY, '203.0.113.7'],
      [KEY, '203.0.113.7'],
    ]);
  });
});
