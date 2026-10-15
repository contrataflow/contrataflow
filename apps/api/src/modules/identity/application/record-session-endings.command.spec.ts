import { createHash } from 'node:crypto';

import type { SessionHeader, SessionTombstone } from '@contrataflow/validation';
import { Logger } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import type { Meter } from '@opentelemetry/api';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { InMemorySessionRegistry } from '#shared/sessions/in-memory-session-registry.js';
import { DisabledSessionRegistry } from '#shared/sessions/session-registry.js';
import type { SessionRegistryPort } from '#shared/sessions/session-registry.js';

import type { SessionAuditPort } from './ports.js';
import {
  RecordSessionEndingsCommand,
  SESSION_SWEEP_BATCH_SIZE,
  SESSION_SWEEP_LOCK_TTL_MS,
  SESSION_SWEEP_MAX_CONSECUTIVE_DEFERRALS,
} from './record-session-endings.command.js';
import { sessionMetrics } from './session-telemetry.js';

/* US-088 — varredura de encerramentos de sessão (RN-IAM-24/28). */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = Date.parse('2026-10-14T12:00:00.000Z');

const TENANT_A = '0192f000-0000-7000-8000-00000000000a';
const TENANT_B = '0192f000-0000-7000-8000-00000000000b';
const CLAUDIA = '0192f000-0000-7000-8000-0000000000c1';
const CLAUDIA_MEMBERSHIP = '0192f000-0000-7000-8000-0000000001c1';
const DIEGO = '0192f000-0000-7000-8000-0000000000d1';
const DIEGO_MEMBERSHIP = '0192f000-0000-7000-8000-0000000001d1';

function sessionKey(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

const CLAUDIA_KEY = sessionKey('sid-claudia');
const DIEGO_KEY = sessionKey('sid-diego');

/** Sessão viva da Cláudia: 30 min de ociosidade, 12 h absolutas, último acesso às 12:00. */
function claudia(overrides: Partial<SessionHeader> = {}): SessionHeader {
  return {
    key: CLAUDIA_KEY,
    userId: CLAUDIA,
    displayName: 'Cláudia Ramos',
    activeTenantId: TENANT_A,
    membershipId: CLAUDIA_MEMBERSHIP,
    createdAt: T0,
    lastSeenAt: T0,
    idleExpiresAt: T0 + 30 * MINUTE,
    absoluteExpiresAt: T0 + 12 * HOUR,
    idleMinutes: 30,
    ...overrides,
  };
}

function diego(overrides: Partial<SessionHeader> = {}): SessionHeader {
  return claudia({
    key: DIEGO_KEY,
    userId: DIEGO,
    displayName: 'Diego Alves',
    activeTenantId: TENANT_B,
    membershipId: DIEGO_MEMBERSHIP,
    ...overrides,
  });
}

/** Porta de auditoria de sessão fake: guarda o que recebeu e imita a deduplicação por sessão. */
class FakeSessionAudit implements SessionAuditPort {
  readonly ended: SessionTombstone[] = [];
  /** Quantas gravações seguintes falham (banco fora). */
  failures = 0;
  private readonly recorded = new Set<string>();

  sessionStarted(): Promise<void> {
    return Promise.resolve();
  }

  tenantSwitched(): Promise<void> {
    return Promise.resolve();
  }

  sessionEnded(tombstone: SessionTombstone): Promise<'recorded' | 'duplicate'> {
    this.ended.push(tombstone);
    if (this.failures > 0) {
      this.failures -= 1;
      return Promise.reject(new Error('Connection terminated unexpectedly'));
    }
    const identity = `${tombstone.activeTenantId}|${tombstone.key}|${tombstone.occurredAt}`;
    if (this.recorded.has(identity)) return Promise.resolve('duplicate');
    this.recorded.add(identity);
    return Promise.resolve('recorded');
  }
}

const expiredCounter = { add: vi.fn() };

beforeAll(() => {
  // O contador é criado de forma preguiçosa e guardado: fixa o falso antes do primeiro uso.
  const getMeter = vi.spyOn(metrics, 'getMeter').mockReturnValue({
    createCounter: () => expiredCounter,
  } as unknown as Meter);
  sessionMetrics();
  getMeter.mockRestore();
});

interface Setup {
  readonly clock: { now: number };
  readonly registry: InMemorySessionRegistry;
  readonly audit: FakeSessionAudit;
  /** Uma réplica da API: comando sobre o mesmo Redis e a mesma auditoria. */
  readonly replica: (registry?: SessionRegistryPort) => RecordSessionEndingsCommand;
}

function setup(): Setup {
  const clock = { now: T0 };
  const registry = new InMemorySessionRegistry(() => clock.now);
  const audit = new FakeSessionAudit();
  return {
    clock,
    registry,
    audit,
    replica: (port = registry) =>
      new RecordSessionEndingsCommand(port, audit, () => new Date(clock.now)),
  };
}

function quietLogs() {
  return {
    log: vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined),
    warn: vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
  };
}

beforeEach(() => {
  expiredCounter.add.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RecordSessionEndingsCommand — sessão expirada que ninguém acessou mais', () => {
  it('[Sucesso] ociosa de Cláudia: auth.session_expired IDLE com o horário do limite, não o da varredura', async () => {
    const { log } = quietLogs();
    const { clock, registry, audit, replica } = setup();
    registry.seedLive(claudia());
    // Ninguém voltou: a varredura só passa 45 min depois do último acesso.
    clock.now = T0 + 45 * MINUTE;

    await expect(replica().run()).resolves.toEqual({ processed: 1, recorded: 1, deferred: 0 });

    expect(audit.ended).toHaveLength(1);
    expect(audit.ended[0]).toMatchObject({
      key: CLAUDIA_KEY,
      userId: CLAUDIA,
      displayName: 'Cláudia Ramos',
      activeTenantId: TENANT_A,
      membershipId: CLAUDIA_MEMBERSHIP,
      reason: 'IDLE',
      occurredAt: T0 + 30 * MINUTE,
      createdAt: T0,
      idleMinutes: 30,
      ip: null,
      userAgent: null,
    });
    // Registro vivo e de encerramento apagados, e a chave fora do conjunto de prazos.
    expect(registry.hasLive(CLAUDIA_KEY)).toBe(false);
    expect(registry.hasTombstone(CLAUDIA_KEY)).toBe(false);
    expect(registry.deadlineOf(CLAUDIA_KEY)).toBeUndefined();
    expect(expiredCounter.add).toHaveBeenCalledExactlyOnceWith(1, { reason: 'IDLE' });
    expect(log).toHaveBeenCalledWith(
      { event: 'auth.sessions_swept', processed: 1, recorded: 1, deferred: 0 },
      'auth.sessions_swept',
    );
  });

  it('o fim absoluto vence antes da ociosidade quando é o primeiro limite: ABSOLUTE no horário do fim', async () => {
    quietLogs();
    const { clock, registry, audit, replica } = setup();
    registry.seedLive(
      claudia({
        lastSeenAt: T0 + 11 * HOUR + 50 * MINUTE,
        idleExpiresAt: T0 + 12 * HOUR + 20 * MINUTE,
      }),
    );
    clock.now = T0 + 13 * HOUR;

    await replica().run();

    expect(audit.ended[0]).toMatchObject({ reason: 'ABSOLUTE', occurredAt: T0 + 12 * HOUR });
    expect(expiredCounter.add).toHaveBeenCalledWith(1, { reason: 'ABSOLUTE' });
  });

  it('sessão sem ociosidade registrada (criada antes da US-088) usa o padrão de 30 min', async () => {
    quietLogs();
    const { clock, registry, audit, replica } = setup();
    registry.seedLive(claudia({ idleMinutes: undefined }));
    clock.now = T0 + 31 * MINUTE;
    await replica().run();
    expect(audit.ended[0]).toMatchObject({ reason: 'IDLE', idleMinutes: 30 });
  });

  it('sessão acessada depois de o prazo ser agendado só é reagendada, sem auditoria', async () => {
    quietLogs();
    const { clock, registry, audit, replica } = setup();
    // O BFF estendeu a ociosidade (acesso às 12:25), mas o prazo antigo (12:30) ficou no conjunto.
    registry.seedLive(claudia({ lastSeenAt: T0 + 25 * MINUTE, idleExpiresAt: T0 + 55 * MINUTE }));
    await registry.reschedule(CLAUDIA_KEY, T0 + 30 * MINUTE);
    clock.now = T0 + 31 * MINUTE;

    await expect(replica().run()).resolves.toEqual({ processed: 1, recorded: 0, deferred: 0 });

    expect(audit.ended).toHaveLength(0);
    expect(registry.hasLive(CLAUDIA_KEY)).toBe(true);
    expect(registry.deadlineOf(CLAUDIA_KEY)).toBe(T0 + 55 * MINUTE);
    expect(expiredCounter.add).not.toHaveBeenCalled();

    // Ninguém volta mais: no prazo novo ela expira, com o horário do novo limite.
    clock.now = T0 + 56 * MINUTE;
    await expect(replica().run()).resolves.toEqual({ processed: 1, recorded: 1, deferred: 0 });
    expect(audit.ended[0]).toMatchObject({ reason: 'IDLE', occurredAt: T0 + 55 * MINUTE });
  });
});

describe('RecordSessionEndingsCommand — registro de encerramento do BFF', () => {
  it('logout: grava auth.session_end (LOGOUT) e remove o registro; não conta como expiração', async () => {
    quietLogs();
    const { clock, registry, audit, replica } = setup();
    registry.seedLive(claudia());
    await registry.end({
      header: claudia(),
      reason: 'LOGOUT',
      occurredAt: T0 + 10 * MINUTE,
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0',
    });
    expect(registry.hasLive(CLAUDIA_KEY)).toBe(false);
    clock.now = T0 + 11 * MINUTE;

    await expect(replica().run()).resolves.toEqual({ processed: 1, recorded: 1, deferred: 0 });

    expect(audit.ended[0]).toMatchObject({
      reason: 'LOGOUT',
      occurredAt: T0 + 10 * MINUTE,
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0',
    });
    expect(registry.hasTombstone(CLAUDIA_KEY)).toBe(false);
    expect(registry.deadlineOf(CLAUDIA_KEY)).toBeUndefined();
    expect(expiredCounter.add).not.toHaveBeenCalled();
  });

  it.each(['IDLE', 'ABSOLUTE', 'REFRESH_FAILED'] as const)(
    'encerramento %s do BFF conta em auth_sessions_expired_total com o motivo',
    async (reason) => {
      quietLogs();
      const { clock, registry, replica } = setup();
      registry.seedLive(claudia());
      await registry.end({ header: claudia(), reason, occurredAt: T0 + 20 * MINUTE });
      clock.now = T0 + 21 * MINUTE;
      await replica().run();
      expect(expiredCounter.add).toHaveBeenCalledExactlyOnceWith(1, { reason });
    },
  );

  it.each([
    'SESSION_LIMIT',
    'MEMBERSHIP_SUSPENDED',
    'MEMBERSHIP_REVOKED',
    'MEMBERSHIP_EXPIRED',
  ] as const)('encerramento %s é auth.session_end e não conta como expiração', async (reason) => {
    quietLogs();
    const { clock, registry, audit, replica } = setup();
    registry.seedLive(claudia());
    await registry.end({ header: claudia(), reason, occurredAt: T0 + 20 * MINUTE });
    clock.now = T0 + 21 * MINUTE;
    await replica().run();
    expect(audit.ended[0]).toMatchObject({ reason });
    expect(expiredCounter.add).not.toHaveBeenCalled();
  });

  it('sessão sem instituição ativa (FA-07): sem auditoria de tenant, só remove o registro', async () => {
    quietLogs();
    const { clock, registry, audit, replica } = setup();
    registry.seedLive(claudia({ activeTenantId: null, membershipId: null }));
    clock.now = T0 + 45 * MINUTE;

    await expect(replica().run()).resolves.toEqual({ processed: 1, recorded: 0, deferred: 0 });

    expect(audit.ended).toHaveLength(0);
    expect(registry.hasTombstone(CLAUDIA_KEY)).toBe(false);
    expect(registry.deadlineOf(CLAUDIA_KEY)).toBeUndefined();
  });

  it('chave sem registro vivo nem de encerramento: sai do conjunto de prazos', async () => {
    quietLogs();
    const { clock, registry, audit, replica } = setup();
    await registry.reschedule(CLAUDIA_KEY, T0);
    clock.now = T0 + MINUTE;

    await expect(replica().run()).resolves.toEqual({ processed: 1, recorded: 0, deferred: 0 });

    expect(audit.ended).toHaveLength(0);
    expect(registry.deadlineOf(CLAUDIA_KEY)).toBeUndefined();
  });

  it('o BFF encerra entre as duas leituras: o registro de encerramento recém-criado não é descartado', async () => {
    quietLogs();
    const { clock, registry, audit, replica } = setup();
    registry.seedLive(claudia());
    clock.now = T0 + 5 * MINUTE;
    // A leitura do registro vivo acontece depois de o BFF ter encerrado (logout em voo).
    const readLive = registry.readLive.bind(registry);
    vi.spyOn(registry, 'readLive').mockImplementationOnce(async (key) => {
      const header = await readLive(key);
      if (header) await registry.end({ header, reason: 'LOGOUT', occurredAt: T0 + 4 * MINUTE });
      return null;
    });
    await registry.reschedule(CLAUDIA_KEY, T0);

    await expect(replica().run()).resolves.toEqual({ processed: 1, recorded: 1, deferred: 0 });

    expect(audit.ended[0]).toMatchObject({ reason: 'LOGOUT', occurredAt: T0 + 4 * MINUTE });
    expect(registry.hasTombstone(CLAUDIA_KEY)).toBe(false);
  });

  it('só trata prazos vencidos: sessões que ainda não venceram ficam intactas', async () => {
    quietLogs();
    const { clock, registry, audit, replica } = setup();
    registry.seedLive(claudia());
    clock.now = T0 + 10 * MINUTE;

    await expect(replica().run()).resolves.toEqual({ processed: 0, recorded: 0, deferred: 0 });

    expect(audit.ended).toHaveLength(0);
    expect(registry.hasLive(CLAUDIA_KEY)).toBe(true);
    expect(registry.deadlineOf(CLAUDIA_KEY)).toBe(T0 + 30 * MINUTE);
  });

  it('pede no máximo 500 chaves por ciclo e segura a trava por 50 s', async () => {
    quietLogs();
    const { clock, registry, replica } = setup();
    const lock = vi.spyOn(registry, 'acquireSweepLock');
    const due = vi.spyOn(registry, 'due');
    clock.now = T0 + HOUR;
    await replica().run();
    expect(lock).toHaveBeenCalledExactlyOnceWith(SESSION_SWEEP_LOCK_TTL_MS);
    expect(due).toHaveBeenCalledExactlyOnceWith(T0 + HOUR, SESSION_SWEEP_BATCH_SIZE);
    expect(SESSION_SWEEP_LOCK_TTL_MS).toBe(50_000);
    expect(SESSION_SWEEP_BATCH_SIZE).toBe(500);
  });
});

describe('RecordSessionEndingsCommand — [Falha de banco]', () => {
  it('auditoria falha no 1º ciclo (registro mantido) e grava no 2º com o horário original', async () => {
    const { warn, log } = quietLogs();
    const { clock, registry, audit, replica } = setup();
    registry.seedLive(claudia());
    clock.now = T0 + 45 * MINUTE;
    audit.failures = 1;
    const command = replica();

    await expect(command.run()).resolves.toEqual({ processed: 1, recorded: 0, deferred: 1 });

    // O registro de encerramento fica no Redis, ainda agendado para a próxima varredura.
    expect(registry.hasTombstone(CLAUDIA_KEY)).toBe(true);
    expect(registry.deadlineOf(CLAUDIA_KEY)).toBe(T0 + 30 * MINUTE);
    expect(expiredCounter.add).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      { event: 'auth.session_audit_deferred', endReason: 'IDLE', reason: 'Error' },
      'auth.session_audit_deferred',
    );
    expect(log).toHaveBeenCalledWith(
      { event: 'auth.sessions_swept', processed: 1, recorded: 0, deferred: 1 },
      'auth.sessions_swept',
    );

    // Passado o ciclo (a trava de 50 s expirou), o banco voltou.
    clock.now += MINUTE;
    await expect(command.run()).resolves.toEqual({ processed: 1, recorded: 1, deferred: 0 });

    expect(audit.ended).toHaveLength(2);
    expect(audit.ended[1]).toMatchObject({ reason: 'IDLE', occurredAt: T0 + 30 * MINUTE });
    expect(registry.hasTombstone(CLAUDIA_KEY)).toBe(false);
    expect(registry.deadlineOf(CLAUDIA_KEY)).toBeUndefined();
    expect(expiredCounter.add).toHaveBeenCalledExactlyOnceWith(1, { reason: 'IDLE' });
  });

  it('falhas seguidas (banco fora) encerram o ciclo; o restante fica para o próximo', async () => {
    quietLogs();
    const { clock, registry, audit, replica } = setup();
    for (let index = 0; index < 5; index += 1) {
      registry.seedLive(claudia({ key: sessionKey(`sid-${String(index)}`) }));
    }
    clock.now = T0 + 45 * MINUTE;
    audit.failures = 10;
    await expect(replica().run()).resolves.toEqual({
      processed: SESSION_SWEEP_MAX_CONSECUTIVE_DEFERRALS,
      recorded: 0,
      deferred: SESSION_SWEEP_MAX_CONSECUTIVE_DEFERRALS,
    });
    expect(audit.ended).toHaveLength(SESSION_SWEEP_MAX_CONSECUTIVE_DEFERRALS);
  });

  it('a falha de uma sessão não impede as seguintes do mesmo ciclo', async () => {
    quietLogs();
    const { clock, registry, audit, replica } = setup();
    registry.seedLive(claudia());
    registry.seedLive(diego());
    clock.now = T0 + 45 * MINUTE;
    audit.failures = 1;

    await expect(replica().run()).resolves.toEqual({ processed: 2, recorded: 1, deferred: 1 });

    expect(audit.ended).toHaveLength(2);
    const kept = [CLAUDIA_KEY, DIEGO_KEY].filter((key) => registry.hasTombstone(key));
    expect(kept).toHaveLength(1);
  });

  it('o aviso de auditoria adiada e o resumo não expõem a chave da sessão, o nome nem o IP', async () => {
    const { log, warn } = quietLogs();
    const { clock, registry, audit, replica } = setup();
    registry.seedLive(claudia());
    await registry.end({
      header: claudia(),
      reason: 'LOGOUT',
      occurredAt: T0 + MINUTE,
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0',
    });
    clock.now = T0 + 2 * MINUTE;
    audit.failures = 1;
    await replica().run();

    const logged = JSON.stringify([...log.mock.calls, ...warn.mock.calls]);
    expect(logged).toContain('auth.session_audit_deferred');
    expect(logged).not.toContain(CLAUDIA_KEY);
    expect(logged).not.toContain('Cláudia');
    expect(logged).not.toContain('203.0.113.7');
    expect(logged).not.toContain('tokens-cifrados');
  });
});

describe('RecordSessionEndingsCommand — [Tenant incorreto]', () => {
  it('cada auditoria vai para a instituição ativa da própria sessão', async () => {
    quietLogs();
    const { clock, registry, audit, replica } = setup();
    registry.seedLive(claudia());
    registry.seedLive(diego());
    clock.now = T0 + 45 * MINUTE;

    await expect(replica().run()).resolves.toEqual({ processed: 2, recorded: 2, deferred: 0 });

    const byKey = Object.fromEntries(audit.ended.map((tombstone) => [tombstone.key, tombstone]));
    expect(byKey[CLAUDIA_KEY]).toMatchObject({
      activeTenantId: TENANT_A,
      membershipId: CLAUDIA_MEMBERSHIP,
      userId: CLAUDIA,
    });
    expect(byKey[DIEGO_KEY]).toMatchObject({
      activeTenantId: TENANT_B,
      membershipId: DIEGO_MEMBERSHIP,
      userId: DIEGO,
    });
  });
});

describe('RecordSessionEndingsCommand — [Duplicidade]', () => {
  it('duas réplicas no mesmo minuto: a que não obtém a trava não faz nada', async () => {
    quietLogs();
    const { clock, registry, audit, replica } = setup();
    registry.seedLive(claudia());
    clock.now = T0 + 45 * MINUTE;
    const [first, second] = [replica(), replica()];
    const due = vi.spyOn(registry, 'due');

    const results = await Promise.all([first.run(), second.run()]);

    expect(results).toEqual([
      { processed: 1, recorded: 1, deferred: 0 },
      { processed: 0, recorded: 0, deferred: 0 },
    ]);
    expect(due).toHaveBeenCalledTimes(1);
    expect(audit.ended).toHaveLength(1);

    // No ciclo seguinte (a trava expirou) não resta nada a gravar.
    clock.now += MINUTE;
    await expect(second.run()).resolves.toEqual({ processed: 0, recorded: 0, deferred: 0 });
    expect(audit.ended).toHaveLength(1);
  });

  it('registro já gravado (duplicate) ainda remove o registro de encerramento, sem contar de novo', async () => {
    quietLogs();
    const { clock, registry, audit, replica } = setup();
    registry.seedLive(claudia());
    clock.now = T0 + 45 * MINUTE;
    // A gravação anterior foi commitada, mas o Redis falhou ao apagar o registro de encerramento.
    const forget = vi
      .spyOn(registry, 'forget')
      .mockRejectedValueOnce(new Error('Connection is closed.'));
    const command = replica();
    await command.run();
    expect(audit.ended).toHaveLength(1);
    expect(registry.hasTombstone(CLAUDIA_KEY)).toBe(true);
    expect(forget).toHaveBeenCalledTimes(1);
    expect(expiredCounter.add).toHaveBeenCalledTimes(1);

    clock.now += MINUTE;
    await expect(command.run()).resolves.toEqual({ processed: 1, recorded: 0, deferred: 0 });

    expect(audit.ended).toHaveLength(2);
    expect(registry.hasTombstone(CLAUDIA_KEY)).toBe(false);
    expect(registry.deadlineOf(CLAUDIA_KEY)).toBeUndefined();
    expect(expiredCounter.add).toHaveBeenCalledTimes(1);
  });
});

describe('RecordSessionEndingsCommand — Redis de sessões', () => {
  it('[Falha de integração] Redis fora: o ciclo termina sem lançar e registra o aviso', async () => {
    const { warn } = quietLogs();
    const { registry, audit, replica } = setup();
    const unavailable = Object.assign(new Error('Connection is closed.'), {
      name: 'MaxRetriesPerRequestError',
    });
    vi.spyOn(registry, 'acquireSweepLock').mockRejectedValue(unavailable);

    await expect(replica().run()).resolves.toEqual({ processed: 0, recorded: 0, deferred: 0 });

    expect(audit.ended).toHaveLength(0);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      { event: 'auth.session_sweep_failed', reason: 'MaxRetriesPerRequestError' },
      'auth.session_sweep_failed',
    );
  });

  it('Redis cai no meio do ciclo: o que já foi tratado vale e o restante fica para o próximo', async () => {
    const { warn, log } = quietLogs();
    const { clock, registry, audit, replica } = setup();
    registry.seedLive(claudia());
    registry.seedLive(diego({ lastSeenAt: T0 + MINUTE, idleExpiresAt: T0 + 31 * MINUTE }));
    clock.now = T0 + 45 * MINUTE;
    const readTombstone = registry.readTombstone.bind(registry);
    const readSpy = vi.spyOn(registry, 'readTombstone').mockImplementation(async (key) => {
      if (key === DIEGO_KEY)
        throw Object.assign(new Error('timeout'), { name: 'CommandTimeoutError' });
      return readTombstone(key);
    });
    const command = replica();

    // Cláudia vence primeiro (limite às 12:30); a leitura do Diego falha.
    await expect(command.run()).resolves.toEqual({ processed: 1, recorded: 1, deferred: 0 });

    expect(audit.ended).toHaveLength(1);
    expect(audit.ended[0]?.key).toBe(CLAUDIA_KEY);
    expect(registry.deadlineOf(DIEGO_KEY)).toBe(T0 + 31 * MINUTE);
    expect(warn).toHaveBeenCalledWith(
      { event: 'auth.session_sweep_failed', reason: 'CommandTimeoutError' },
      'auth.session_sweep_failed',
    );
    expect(log).toHaveBeenCalledWith(
      { event: 'auth.sessions_swept', processed: 1, recorded: 1, deferred: 0 },
      'auth.sessions_swept',
    );

    // Redis de volta no ciclo seguinte.
    readSpy.mockImplementation(readTombstone);
    clock.now += MINUTE;
    await expect(command.run()).resolves.toEqual({ processed: 1, recorded: 1, deferred: 0 });
    expect(audit.ended.map((tombstone) => tombstone.key)).toEqual([CLAUDIA_KEY, DIEGO_KEY]);
  });

  it('sem Redis de sessões configurado a varredura não faz nada e não loga', async () => {
    const { warn, log } = quietLogs();
    const audit = new FakeSessionAudit();
    const command = new RecordSessionEndingsCommand(
      new DisabledSessionRegistry(),
      audit,
      () => new Date(T0),
    );

    await expect(command.run()).resolves.toEqual({ processed: 0, recorded: 0, deferred: 0 });

    expect(audit.ended).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('ciclo sem nada vencido não gera o resumo auth.sessions_swept', async () => {
    const { log } = quietLogs();
    const { replica } = setup();
    await replica().run();
    expect(log).not.toHaveBeenCalled();
  });
});
