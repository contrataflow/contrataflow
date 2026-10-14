import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '#config/env.js';
import { runWithRequestContext, updateRequestContext } from '#shared/context/request-context.js';

import { TenantTransaction } from './database.module.js';
import { DatabaseUnavailableError, TenantContextMissingError } from './errors.js';
import type { PrismaClient } from './generated/prisma/client.js';
import { runTenantTransaction } from './tenant-transaction.js';
import type { TenantTx } from './tenant-transaction.js';

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

function inTenant<T>(fn: () => Promise<T>, tenantId: string | null = TENANT): Promise<T> {
  return runWithRequestContext({ correlationId: 'corr-1', ip: '', userAgent: '' }, () => {
    updateRequestContext({
      tenantId,
      actor: { type: 'USER', userId: USER, membershipId: null },
    });
    return fn();
  });
}

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

  it('contexto ausente ou inválido falha fechado antes do banco e loga db.tenant_context_missing', async () => {
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
    expect(error).toHaveBeenCalledWith('db.tenant_context_missing correlationId=corr-1');
    expect(error).toHaveBeenCalledWith('db.tenant_context_missing correlationId=-');
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

describe('TenantTransaction (provider do Nest)', () => {
  const config = loadConfig({
    DATABASE_URL: 'postgresql://cf_app:x@127.0.0.1:1/contrataflow',
    REDIS_CACHE_URL: 'redis://127.0.0.1:1',
    OIDC_ISSUER_URL: 'https://issuer.contrataflow.test/',
  });

  it('run e read exigem tenant no contexto; o pool só conecta sob demanda', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const transaction = new TenantTransaction(config);
    await expect(transaction.run(() => Promise.resolve())).rejects.toBeInstanceOf(
      TenantContextMissingError,
    );
    await expect(transaction.read(() => Promise.resolve())).rejects.toBeInstanceOf(
      TenantContextMissingError,
    );
    await transaction.onModuleDestroy();
  });

  it('com o banco fora do ar, run e read respondem DatabaseUnavailableError', async () => {
    const transaction = new TenantTransaction(config);
    try {
      await expect(inTenant(() => transaction.run(() => Promise.resolve()))).rejects.toBeInstanceOf(
        DatabaseUnavailableError,
      );
      await expect(
        inTenant(() => transaction.read(() => Promise.resolve())),
      ).rejects.toBeInstanceOf(DatabaseUnavailableError);
    } finally {
      await transaction.onModuleDestroy();
    }
  });
});
