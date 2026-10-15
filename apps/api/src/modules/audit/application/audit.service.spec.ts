import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '#config/env.js';
import type { AppConfig } from '#config/env.js';
import { InMemoryAuditSamplingStore } from '#shared/audit/sampling-store.js';
import type { AuditSamplingStorePort } from '#shared/audit/sampling-store.js';
import {
  runAsSystem,
  runWithRequestContext,
  updateRequestContext,
} from '#shared/context/request-context.js';
import { runSimulatedTransaction } from '#shared/database/active-transaction.js';
import type { TenantTx } from '#shared/database/prisma.js';

import { AuditContractError, AuditUnavailableError } from './audit-errors.js';
import { AuditService } from './audit.service.js';
import { AuditPartitionMissingError } from './ports.js';
import type { AuditLogStore, AuditTransactions } from './ports.js';
import { rowHashOf } from '../domain/audit-record.js';
import type { SealedAuditRecord } from '../domain/audit-record.js';
import {
  InMemoryAuditLogStore,
  InMemoryAuditTransactions,
} from '../infrastructure/in-memory-audit.store.js';

const TENANT = '0192f000-0000-7000-8000-00000000000a';
const OTHER_TENANT = '0192f000-0000-7000-8000-00000000000b';
const ANA = '0192f000-0000-7000-8000-0000000000a1';
const ANA_MEMBERSHIP = '0192f000-0000-7000-8000-0000000001a1';
const DOCUMENT = '0192f000-0000-7000-8000-0000000000d1';

function config(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    APP_ENV: 'test',
    DATABASE_URL: 'postgresql://cf_app:test@127.0.0.1:1/contrataflow',
    REDIS_CACHE_URL: 'redis://127.0.0.1:1',
    OIDC_ISSUER_URL: 'https://issuer.test/',
    ...overrides,
  });
}

interface Setup {
  readonly service: AuditService;
  readonly store: InMemoryAuditLogStore;
  readonly clock: { now: Date };
}

function setup(
  options: {
    store?: InMemoryAuditLogStore;
    sampling?: AuditSamplingStorePort;
    transactions?: AuditTransactions;
    env?: Record<string, string>;
  } = {},
): Setup {
  const store = options.store ?? new InMemoryAuditLogStore();
  const clock = { now: new Date('2026-10-14T12:00:00.000Z') };
  const service = new AuditService(
    config(options.env),
    store,
    options.transactions ?? new InMemoryAuditTransactions(),
    options.sampling ?? new InMemoryAuditSamplingStore(() => clock.now.getTime()),
    () => clock.now,
  );
  return { service, store, clock };
}

/**
 * Requisição autenticada da Ana no tenant (o que o pipeline de guards monta), dentro de uma
 * transação simulada (o `tx` só vale durante `fn` — V-03).
 */
function asAna<T>(fn: (tx: TenantTx) => Promise<T>, tenantId: string | null = TENANT): Promise<T> {
  return runWithRequestContext(
    {
      correlationId: 'corr-0001',
      requestId: 'req-0001',
      ip: '::ffff:203.0.113.7',
      userAgent: 'Mozilla/5.0 (Vitest)',
      sessionIdHash: 'a'.repeat(64),
    },
    () => {
      updateRequestContext({
        tenantId,
        actor: { type: 'USER', userId: ANA, membershipId: ANA_MEMBERSHIP, name: 'Ana Ribeiro' },
      });
      return runSimulatedTransaction(fn);
    },
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AuditService.record (US-073)', () => {
  it('[Sucesso] completa o registro com o contexto, mascara e calcula o rowHash', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { service, store } = setup();
    const outcome = await asAna((tx) =>
      service.record(tx, {
        action: 'process.create',
        entityType: 'Process',
        entityId: DOCUMENT.toUpperCase(),
        processId: DOCUMENT,
        changes: [
          { path: 'title', old: null, new: 'Aquisição de papel' },
          { path: 'requester.cpf', old: null, new: '123.456.789-09' },
          { path: 'requester.accessToken', old: null, new: 'segredo' },
        ],
        metadata: { processCode: 'PRC-2026/0001', idempotencyKey: 'k-1' },
      }),
    );

    expect(store.records).toHaveLength(1);
    const [record] = store.records as [SealedAuditRecord];
    expect(outcome).toEqual({
      kind: 'recorded',
      id: record.id,
      occurredAt: new Date('2026-10-14T12:00:00.000Z'),
      rowHash: record.rowHash,
    });
    expect(record).toMatchObject({
      tenantId: TENANT,
      actorType: 'USER',
      actorUserId: ANA,
      actorName: 'Ana Ribeiro',
      actorMembershipId: ANA_MEMBERSHIP,
      onBehalfOfUserId: null,
      action: 'process.create',
      category: 'DATA_CHANGE',
      result: 'SUCCESS',
      entityId: DOCUMENT,
      reasonCode: null,
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0 (Vitest)',
      correlationId: 'corr-0001',
      requestId: 'req-0001',
      sessionIdHash: 'a'.repeat(64),
      metadata: { processCode: 'PRC-2026/0001', idempotencyKey: 'k-1' },
      changes: [
        { path: 'title', old: null, new: 'Aquisição de papel' },
        { path: 'requester.cpf', old: null, new: '***.456.789-**' },
        { path: 'requester.accessToken', old: null, new: '[REDACTED]' },
      ],
    });
    // O hash é o SHA-256 do registro canonicalizado (sem o próprio rowHash).
    const { rowHash, ...rest } = record;
    expect(rowHash).toBe(rowHashOf(rest));
    expect(JSON.stringify(record)).not.toContain('123.456.789-09');
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'audit.recorded', action: 'process.create' }),
      'audit.recorded',
    );
  });

  it('[Validação] V-01: ação fora do catálogo é recusada antes do INSERT', async () => {
    const { service, store } = setup();
    const insert = vi.spyOn(store, 'insert');
    await expect(
      asAna((tx) => service.record(tx, { action: 'foo.bar' as 'process.create' })),
    ).rejects.toThrow(AuditContractError);
    expect(insert).not.toHaveBeenCalled();
    expect(store.records).toHaveLength(0);
  });

  it('[Validação] V-02: DENIED/FAILURE sem reasonCode; V-03: fora de transação; ids inválidos', async () => {
    const { service, store } = setup();
    await expect(
      asAna((tx) => service.record(tx, { action: 'process.update', result: 'FAILURE' })),
    ).rejects.toMatchObject({ rule: 'V-02' });
    const rootClient = { $transaction: () => undefined } as unknown as TenantTx;
    await expect(
      asAna(() => service.record(rootClient, { action: 'process.update' })),
    ).rejects.toMatchObject({ rule: 'V-03' });
    await expect(
      asAna(() => service.record(undefined as unknown as TenantTx, { action: 'process.update' })),
    ).rejects.toMatchObject({ rule: 'V-03' });
    // O `tx` de uma transação já encerrada também é recusado.
    const finished = await asAna((tx) => Promise.resolve(tx));
    await expect(
      asAna(() => service.record(finished, { action: 'process.update' })),
    ).rejects.toMatchObject({ rule: 'V-03' });
    await expect(
      asAna((tx) => service.record(tx, { action: 'process.update', entityId: 'x' })),
    ).rejects.toMatchObject({ rule: 'IDS' });
    expect(store.records).toHaveLength(0);
  });

  it('FA-01/FA-04: job grava como SYSTEM, com o nome do job e sem IP/user-agent', async () => {
    const { service, store } = setup();
    await runAsSystem({ name: 'Job de selagem horária', tenantId: TENANT }, () =>
      runSimulatedTransaction((tx) => service.record(tx, { action: 'audit.seal' })),
    );
    expect(store.records[0]).toMatchObject({
      tenantId: TENANT,
      actorType: 'SYSTEM',
      actorUserId: null,
      actorMembershipId: null,
      actorName: 'Job de selagem horária',
      category: 'SYSTEM',
      ip: null,
      userAgent: null,
      sessionIdHash: null,
    });
    expect(store.records[0]?.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('FA-02: acesso de suporte registra em nome de quem', async () => {
    const { service, store } = setup();
    const supportUser = '0192f000-0000-7000-8000-0000000000e1';
    await asAna((tx) => {
      updateRequestContext({
        actor: {
          type: 'PLATFORM_OPERATOR',
          userId: supportUser,
          membershipId: null,
          onBehalfOfUserId: ANA,
        },
      });
      return service.record(tx, { action: 'process.update' });
    });
    expect(store.records[0]).toMatchObject({
      actorType: 'PLATFORM_OPERATOR',
      actorUserId: supportUser,
      onBehalfOfUserId: ANA,
    });
  });

  it('[Concorrência] 50 gravações simultâneas → 50 registros com rowHash distintos', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { service, store } = setup();
    await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        asAna((tx) =>
          service.record(tx, {
            action: 'process.update',
            metadata: { index },
          }),
        ),
      ),
    );
    expect(store.records).toHaveLength(50);
    expect(new Set(store.records.map((record) => record.rowHash)).size).toBe(50);
    expect(new Set(store.records.map((record) => record.id)).size).toBe(50);
  });

  it('não existe configuração que desligue a gravação (nem de tenant, nem de perfil)', () => {
    const keys = Object.keys(config().audit).sort();
    expect(keys).toEqual(['accessDeniedSampling', 'coalesce', 'partitionMonthsAhead']);
  });
});

describe('coalescência (RN-AUD-06 · [Duplicidade])', () => {
  const draftUpdate = (revision: number, size: number, scope = 'JUSTIFICATION') => ({
    action: 'document.draft_update' as const,
    entityType: 'Document',
    entityId: DOCUMENT,
    coalesce: { scope, revision, size },
  });

  it('autosave em rajada na janela grava só o primeiro; salto de revisão ou tamanho reabre', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { service, store, clock } = setup();
    const save = (revision: number, size: number, scope?: string) =>
      asAna((tx) => service.record(tx, draftUpdate(revision, size, scope)));

    expect((await save(1, 1_000)).kind).toBe('recorded');
    clock.now = new Date('2026-10-14T12:02:00.000Z');
    expect((await save(2, 1_100)).kind).toBe('coalesced');
    expect(store.records).toHaveLength(1);
    expect(store.records[0]?.metadata).toEqual({
      coalesce: { scope: 'JUSTIFICATION', revision: 1, size: 1_000 },
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'audit.coalesced', suppressed: 1 }),
      'audit.coalesced',
    );

    // Outra seção é outra chave.
    expect((await save(1, 50, 'OBJECT')).kind).toBe('recorded');
    // FA-05: variação de tamanho > 30% ou salto de revisão > 20 reabrem a janela.
    expect((await save(3, 1_400)).kind).toBe('recorded');
    expect((await save(24, 1_400)).kind).toBe('recorded');
    expect((await save(25, 1_450)).kind).toBe('coalesced');
    // Passados 10 min do último registro gravado, grava de novo.
    clock.now = new Date('2026-10-14T12:12:01.000Z');
    expect((await save(26, 1_450)).kind).toBe('recorded');
    expect(store.records.map((record) => record.metadata.coalesce)).toEqual([
      { scope: 'JUSTIFICATION', revision: 1, size: 1_000 },
      { scope: 'OBJECT', revision: 1, size: 50 },
      { scope: 'JUSTIFICATION', revision: 3, size: 1_400 },
      { scope: 'JUSTIFICATION', revision: 24, size: 1_400 },
      { scope: 'JUSTIFICATION', revision: 26, size: 1_450 },
    ]);
  });

  it('a janela é por tenant e por ator; sem entidade não coalesce', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { service, store } = setup();
    await asAna((tx) => service.record(tx, draftUpdate(1, 10)));
    await asAna((tx) => service.record(tx, draftUpdate(1, 10)), OTHER_TENANT);
    await asAna((tx) => service.record(tx, { ...draftUpdate(1, 10), entityId: null }));
    await asAna((tx) => service.record(tx, { ...draftUpdate(1, 10), entityId: null }));
    expect(store.records).toHaveLength(4);
  });
});

describe('amostragem de access.denied (RN-AUD-07 · RN-AUD-10)', () => {
  const denial = {
    action: 'access.denied' as const,
    result: 'DENIED' as const,
    reasonCode: 'PROCESS_CREATE',
  };

  it('grava até o limite da janela e soma o excedente no próximo registro', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { service, store, clock } = setup({
      env: { AUDIT_ACCESS_DENIED_SAMPLING_MAX_PER_WINDOW: '3' },
    });
    const deny = () => asAna((tx) => service.record(tx, denial));
    const outcomes = [];
    for (let attempt = 0; attempt < 5; attempt += 1) outcomes.push((await deny()).kind);
    expect(outcomes).toEqual(['recorded', 'recorded', 'recorded', 'sampled_out', 'sampled_out']);
    expect(store.records).toHaveLength(3);

    clock.now = new Date('2026-10-14T12:01:00.000Z');
    await deny();
    expect(store.records).toHaveLength(4);
    expect(store.records[3]).toMatchObject({
      category: 'ACCESS',
      result: 'DENIED',
      reasonCode: 'PROCESS_CREATE',
      metadata: { suppressedCount: 2 },
    });
  });

  it('[Falha de integração] Redis fora: cada negação grava o próprio registro e loga warn', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const unavailable: AuditSamplingStorePort = {
      sample: () =>
        Promise.reject(
          Object.assign(new Error('Connection is closed.'), { name: 'MaxRetriesPerRequestError' }),
        ),
    };
    const { service, store } = setup({ sampling: unavailable });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await asAna((tx) => service.record(tx, denial));
    }
    expect(store.records).toHaveLength(5);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'audit.sampling_unavailable' }),
      'audit.sampling_unavailable',
    );
  });

  it('sem usuário, a chave da amostragem é o IP', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const sample = vi.fn<AuditSamplingStorePort['sample']>(() =>
      Promise.resolve({ record: true, suppressed: 0 }),
    );
    const { service } = setup({ sampling: { sample } });
    await runWithRequestContext({ correlationId: 'c-1', ip: '198.51.100.1', userAgent: '' }, () =>
      runSimulatedTransaction((tx) => service.record(tx, denial)),
    );
    expect(sample).toHaveBeenCalledWith(
      { tenantId: null, subject: 'ip:198.51.100.1', action: 'access.denied' },
      60,
      20,
    );
  });
});

describe('falhas de gravação (RN-AUD-01 · [Falha de banco])', () => {
  it('partição ausente → 503 DEPENDENCY_UNAVAILABLE, logs audit.partition_missing e write_failed', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    const store = new InMemoryAuditLogStore();
    vi.spyOn(store, 'insert').mockRejectedValue(
      new AuditPartitionMissingError(new Date('2026-10-14T12:00:00Z')),
    );
    const { service } = setup({ store });
    const failure = await asAna((tx) => service.record(tx, { action: 'process.create' })).catch(
      (caught: unknown) => caught,
    );
    expect(failure).toBeInstanceOf(AuditUnavailableError);
    expect(failure).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', status: 503 });
    expect(error).toHaveBeenCalledWith(
      { event: 'audit.partition_missing', month: '2026-10' },
      'audit.partition_missing',
    );
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'audit.write_failed',
        reason: 'partition_missing',
        correlationId: 'corr-0001',
      }),
      'audit.write_failed',
    );
  });

  it('erro não transitório propaga como está; deadlock propaga sem log (a transação é refeita)', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    const store = new InMemoryAuditLogStore();
    const constraint = Object.assign(new Error('violates check constraint'), { code: '23514' });
    const deadlock = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    const insert = vi.spyOn(store, 'insert');
    const { service } = setup({ store });

    insert.mockRejectedValueOnce(constraint);
    await expect(asAna((tx) => service.record(tx, { action: 'process.create' }))).rejects.toBe(
      constraint,
    );
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'audit.write_failed', reason: 'database_error' }),
      'audit.write_failed',
    );

    error.mockClear();
    insert.mockRejectedValueOnce(deadlock);
    await expect(asAna((tx) => service.record(tx, { action: 'process.create' }))).rejects.toBe(
      deadlock,
    );
    expect(error).not.toHaveBeenCalled();
  });
});

describe('recordStandalone', () => {
  it('abre a transação do tenant do contexto ou, sem tenant, a de plataforma', async () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const opened: string[] = [];
    const transactions: AuditTransactions = {
      inTenant: (work) => {
        opened.push('tenant');
        return runSimulatedTransaction(work);
      },
      inPlatform: (work) => {
        opened.push('platform');
        return runSimulatedTransaction(work);
      },
    };
    const { service, store } = setup({ transactions });

    await asAna(() => service.recordStandalone({ action: 'auth.tenant_switch' }));
    await asAna(
      () =>
        service.recordStandalone({
          action: 'access.denied',
          result: 'DENIED',
          reasonCode: 'MEMBERSHIP_INACTIVE',
        }),
      null,
    );
    expect(opened).toEqual(['tenant', 'platform']);
    expect(store.records.map((record) => [record.tenantId, record.action])).toEqual([
      [TENANT, 'auth.tenant_switch'],
      [null, 'access.denied'],
    ]);
  });

  it('banco fora ao abrir a transação: loga audit.write_failed e propaga', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const down = new Error('Connection terminated unexpectedly');
    const { service } = setup({
      transactions: {
        inTenant: () => Promise.reject(down),
        inPlatform: () => Promise.reject(down),
      },
    });
    await expect(
      asAna(() => service.recordStandalone({ action: 'auth.session_start' })),
    ).rejects.toBe(down);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'audit.write_failed', action: 'auth.session_start' }),
      'audit.write_failed',
    );
  });

  it('o mesmo store em memória isola a coalescência por tenant', async () => {
    const store: AuditLogStore = new InMemoryAuditLogStore();
    const last = await store.findLastCoalesced({} as TenantTx, {
      tenantId: TENANT,
      action: 'document.draft_update',
      entityType: 'Document',
      entityId: DOCUMENT,
      actorUserId: ANA,
      scope: null,
      since: new Date(0),
    });
    expect(last).toBeNull();
  });
});
