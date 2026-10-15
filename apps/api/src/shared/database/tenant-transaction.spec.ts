import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '#config/env.js';
import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';

import { TenantTransaction } from './database.module.js';
import {
  DatabaseUnavailableError,
  TenantContextMissingError,
  TenantIsolationViolationError,
} from './errors.js';
import type { PrismaClient } from './generated/prisma/client.js';
import { PlatformTransaction } from './platform-transaction.js';
import { createTenantPrismaClient } from './prisma-client.js';
import { runPlatformTransaction, runTenantTransaction } from './tenant-transaction.js';
import type { TenantTx } from './tenant-transaction.js';
import { currentTransactionScope } from './transaction-scope.js';

const TENANT = '0192a000-0000-7000-8000-00000000000a';
const USER = '0192a000-0000-7000-8000-0000000000a1';
const settings = { maxWaitMs: 2_000, transactionTimeoutMs: 10_000, statementTimeoutMs: 5_000 };

interface RawCall {
  readonly sql: string;
  readonly values: unknown[];
}

/** `PrismaClient` falso: executa o callback da transação e registra o SQL do `set_config`. */
function fakeClient(failures: Error[] = []) {
  const raw: RawCall[] = [];
  const tx = {
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      raw.push({ sql: strings.join('?'), values });
      return Promise.resolve(1);
    },
  } as unknown as TenantTx;
  const $transaction = vi.fn(async (work: (client: TenantTx) => Promise<unknown>) => {
    const failure = failures.shift();
    if (failure !== undefined) throw failure;
    return work(tx);
  });
  return { base: { $transaction } as unknown as PrismaClient, $transaction, raw, tx };
}

function inTenant<T>(
  fn: () => Promise<T>,
  tenantId: string | null = TENANT,
  actorType: 'USER' | 'SYSTEM' | 'PLATFORM_OPERATOR' = 'USER',
): Promise<T> {
  return runWithRequestContext({ correlationId: 'corr-1', ip: '', userAgent: '' }, () => {
    updateRequestContext({
      tenantId,
      actor: { type: actorType, userId: actorType === 'USER' ? USER : null, membershipId: null },
    });
    return fn();
  });
}

const OTHER_TENANT = '0192a000-0000-7000-8000-00000000000b';

const deadlock = Object.assign(new Error('deadlock detected'), {
  code: 'P2010',
  meta: { driverAdapterError: { cause: { code: '40P01' } } },
});

describe('runTenantTransaction (RN-FND-43/44)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('[Sucesso] a primeira instrução define app.tenant_id com escopo de transação', async () => {
    const client = fakeClient();
    const result = await inTenant(() =>
      runTenantTransaction(client.base, settings, () => Promise.resolve('ok'), {}),
    );
    expect(result).toBe('ok');
    expect(client.raw).toHaveLength(1);
    expect(client.raw[0]?.sql).toMatch(/^SELECT set_config\('app\.tenant_id', \?, true\)/);
    expect(client.raw[0]?.sql).not.toMatch(/false\)/);
    expect(client.raw[0]?.sql).not.toContain('transaction_read_only');
    expect(client.raw[0]?.values).toEqual([TENANT, USER, '5000']);
    expect(client.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'ReadCommitted',
      maxWait: 2_000,
      timeout: 10_000,
    });
  });

  it('FA-02: leitura marca a transação como somente leitura', async () => {
    const client = fakeClient();
    await inTenant(() =>
      runTenantTransaction(client.base, settings, () => Promise.resolve(), { readOnly: true }),
    );
    expect(client.raw[0]?.sql).toContain("set_config('transaction_read_only', 'on', true)");
  });

  it('contexto ausente ou inválido falha fechado antes do banco e loga security.tenant_context_missing', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const client = fakeClient();
    const work = () => Promise.resolve();
    await expect(
      inTenant(() => runTenantTransaction(client.base, settings, work, {}), null),
    ).rejects.toBeInstanceOf(TenantContextMissingError);
    await expect(
      inTenant(() => runTenantTransaction(client.base, settings, work, {}), "x', true); --"),
    ).rejects.toBeInstanceOf(TenantContextMissingError);
    await expect(runTenantTransaction(client.base, settings, work, {})).rejects.toBeInstanceOf(
      TenantContextMissingError,
    );
    expect(client.$transaction).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'security.tenant_context_missing',
        barrier: 'context',
        correlationId: 'corr-1',
      }),
      'security.tenant_context_missing',
    );
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'security.tenant_context_missing', correlationId: null }),
      'security.tenant_context_missing',
    );
  });

  it('deadlock/serialização: refaz a transação até 2 vezes', async () => {
    const client = fakeClient([deadlock, deadlock]);
    const work = vi.fn(() => Promise.resolve('feito'));
    await expect(
      inTenant(() => runTenantTransaction(client.base, settings, work, {})),
    ).resolves.toBe('feito');
    expect(client.$transaction).toHaveBeenCalledTimes(3);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('esgotadas as retentativas, o erro original propaga', async () => {
    const client = fakeClient([deadlock, deadlock, deadlock]);
    await expect(
      inTenant(() => runTenantTransaction(client.base, settings, () => Promise.resolve(), {})),
    ).rejects.toBe(deadlock);
  });

  it('[Falha de banco] erro transitório vira DatabaseUnavailableError (503)', async () => {
    const offline = Object.assign(new Error("Can't reach database server"), { code: 'P1001' });
    const client = fakeClient([offline]);
    const attempt = inTenant(() =>
      runTenantTransaction(client.base, settings, () => Promise.resolve(), {}),
    );
    await expect(attempt).rejects.toBeInstanceOf(DatabaseUnavailableError);
    expect(client.$transaction).toHaveBeenCalledTimes(1);
  });

  it('[Falha de banco] a conexão cai no set_config: nenhuma consulta de negócio e 503 com Retry-After', async () => {
    const work = vi.fn(() => Promise.resolve());
    const tx = {
      $executeRaw: () => Promise.reject(new Error('Connection terminated unexpectedly')),
    } as unknown as TenantTx;
    const base = {
      $transaction: (callback: (client: TenantTx) => Promise<unknown>) => callback(tx),
    } as unknown as PrismaClient;
    const error = await inTenant(() => runTenantTransaction(base, settings, work, {})).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(DatabaseUnavailableError);
    expect(error).toMatchObject({
      status: 503,
      code: 'DEPENDENCY_UNAVAILABLE',
      headers: { 'Retry-After': '5' },
    });
    expect(work).not.toHaveBeenCalled();
  });

  it('erro do caso de uso propaga sem retentativa nem reclassificação', async () => {
    const client = fakeClient();
    const failure = new Error('regra de negócio');
    await expect(
      inTenant(() =>
        runTenantTransaction(client.base, settings, () => Promise.reject(failure), {}),
      ),
    ).rejects.toBe(failure);
    expect(client.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe('isolamento na TenantTransaction (US-100)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('o escopo TENANT da transação fica visível à extensão só durante o trabalho', async () => {
    const client = fakeClient();
    const seen = await inTenant(() =>
      runTenantTransaction(
        client.base,
        settings,
        () => Promise.resolve(currentTransactionScope()),
        {},
      ),
    );
    expect(seen).toEqual({ kind: 'TENANT', tenantId: TENANT });
    expect(currentTransactionScope()).toBeUndefined();
    const platform = await runPlatformTransaction(
      client.base,
      settings,
      () => Promise.resolve(currentTransactionScope()),
      {},
    );
    expect(platform).toEqual({ kind: 'PLATFORM', tenantId: null });
  });

  it('FA-02: caso de uso de plataforma (SYSTEM/PLATFORM_OPERATOR) abre transação para o tenant alvo', async () => {
    const client = fakeClient();
    for (const actor of ['SYSTEM', 'PLATFORM_OPERATOR'] as const) {
      await inTenant(
        () =>
          runTenantTransaction(client.base, settings, () => Promise.resolve(), {
            tenantId: OTHER_TENANT,
          }),
        null,
        actor,
      );
    }
    expect(client.raw.map((call) => call.values[0])).toEqual([OTHER_TENANT, OTHER_TENANT]);
    // No mesmo tenant do contexto, qualquer ator.
    await inTenant(() =>
      runTenantTransaction(client.base, settings, () => Promise.resolve(), { tenantId: TENANT }),
    );
    expect(client.raw.at(-1)?.values[0]).toBe(TENANT);
  });

  it('RN-TEN-21: dentro de um contexto TENANT, transação para outro tenant é violação', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const client = fakeClient();
    const work = () => Promise.resolve();
    await expect(
      inTenant(() => runTenantTransaction(client.base, settings, work, { tenantId: OTHER_TENANT })),
    ).rejects.toBeInstanceOf(TenantIsolationViolationError);
    // Sem tenant no contexto, mas ator comum (usuário): também recusado.
    await expect(
      inTenant(
        () => runTenantTransaction(client.base, settings, work, { tenantId: OTHER_TENANT }),
        null,
      ),
    ).rejects.toBeInstanceOf(TenantIsolationViolationError);
    await expect(
      inTenant(
        () => runTenantTransaction(client.base, settings, work, { tenantId: 'x' }),
        null,
        'SYSTEM',
      ),
    ).rejects.toBeInstanceOf(TenantContextMissingError);
    expect(client.$transaction).not.toHaveBeenCalled();
  });

  it('[Tenant incorreto] FK composta violada → 422 REFERENCE_NOT_FOUND; RLS → violação (500 + alerta)', async () => {
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const fk = Object.assign(new Error('fk'), {
      code: 'P2010',
      meta: {
        driverAdapterError: {
          cause: { code: '23503', constraint: { fields: ['tenant_id', 'membership_id'] } },
        },
      },
    });
    const rls = Object.assign(
      new Error('new row violates row-level security policy for table "x"'),
      {
        code: 'P2010',
      },
    );
    const client = fakeClient([fk, rls]);
    const work = () => Promise.resolve();
    await expect(
      inTenant(() => runTenantTransaction(client.base, settings, work, {})),
    ).rejects.toMatchObject({
      status: 422,
      code: 'VALIDATION_ERROR',
      errors: [expect.objectContaining({ field: 'membershipId', code: 'REFERENCE_NOT_FOUND' })],
    });
    await expect(
      inTenant(() => runTenantTransaction(client.base, settings, work, {})),
    ).rejects.toBeInstanceOf(TenantIsolationViolationError);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'security.tenant_isolation_violation', barrier: 'rls' }),
      'security.tenant_isolation_violation',
    );
  });
});

describe('runPlatformTransaction (multi-tenancy.md §6 · US-087)', () => {
  it('define só app.user_id (do contexto) e o statement_timeout — nunca app.tenant_id', async () => {
    const client = fakeClient();
    await inTenant(() =>
      runPlatformTransaction(client.base, settings, () => Promise.resolve(), {}),
    );
    expect(client.raw[0]?.sql).toMatch(/^SELECT set_config\('app\.user_id', \?, true\)/);
    expect(client.raw[0]?.sql).not.toContain('app.tenant_id');
    expect(client.raw[0]?.values).toEqual([USER, '5000']);
  });

  it('usuário explícito (início de sessão) e leitura somente leitura', async () => {
    const client = fakeClient();
    const other = '0192a000-0000-7000-8000-0000000000b1';
    await runPlatformTransaction(client.base, settings, () => Promise.resolve(), {
      userId: other,
      readOnly: true,
    });
    expect(client.raw[0]?.values).toEqual([other, '5000']);
    expect(client.raw[0]?.sql).toContain("set_config('transaction_read_only', 'on', true)");
  });

  it('fora de requisição e sem usuário: app.user_id vazio (cf_user_memberships não responde)', async () => {
    const client = fakeClient();
    await runPlatformTransaction(client.base, settings, () => Promise.resolve(), {});
    expect(client.raw[0]?.values).toEqual(['', '5000']);
  });

  it('usuário que não é UUID falha fechado antes do banco', async () => {
    const client = fakeClient();
    await expect(
      runPlatformTransaction(client.base, settings, () => Promise.resolve(), {
        userId: "x', true); --",
      }),
    ).rejects.toBeInstanceOf(TenantContextMissingError);
    expect(client.$transaction).not.toHaveBeenCalled();
  });
});

describe('TenantTransaction (provider do Nest)', () => {
  const config = loadConfig({
    DATABASE_URL: 'postgresql://cf_app:x@127.0.0.1:1/contrataflow',
    REDIS_CACHE_URL: 'redis://127.0.0.1:1',
    OIDC_ISSUER_URL: 'https://issuer.contrataflow.test/',
  });

  it('run e read exigem tenant no contexto; o pool só conecta sob demanda', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const client = createTenantPrismaClient(config.database);
    const transaction = new TenantTransaction(client);
    await expect(transaction.run(() => Promise.resolve())).rejects.toBeInstanceOf(
      TenantContextMissingError,
    );
    await expect(transaction.read(() => Promise.resolve())).rejects.toBeInstanceOf(
      TenantContextMissingError,
    );
    await client.$disconnect();
  });

  it('com o banco fora do ar, run e read respondem DatabaseUnavailableError', async () => {
    const client = createTenantPrismaClient(config.database);
    const transaction = new TenantTransaction(client);
    const platform = new PlatformTransaction(client);
    try {
      await expect(inTenant(() => transaction.run(() => Promise.resolve()))).rejects.toBeInstanceOf(
        DatabaseUnavailableError,
      );
      await expect(
        inTenant(() => transaction.read(() => Promise.resolve())),
      ).rejects.toBeInstanceOf(DatabaseUnavailableError);
      await expect(platform.read(() => Promise.resolve())).rejects.toBeInstanceOf(
        DatabaseUnavailableError,
      );
      await expect(platform.run(() => Promise.resolve(), { userId: USER })).rejects.toBeInstanceOf(
        DatabaseUnavailableError,
      );
    } finally {
      await client.$disconnect();
    }
  });
});
