import { AsyncLocalStorage } from 'node:async_hooks';

import { describe, expect, it } from 'vitest';

import type { TenantTx } from './prisma.js';
import { inCurrentContext, pullInTransaction } from './transaction-stream.js';
import type { CursorReader } from './transaction-stream.js';

/** Transação simulada: registra abertura/fim e o resultado do trabalho. */
function fakeTransaction() {
  const state = { opened: 0, finished: 0, failed: 0 };
  const run = async (work: (tx: TenantTx) => Promise<void>) => {
    state.opened += 1;
    try {
      await work({} as TenantTx);
      state.finished += 1;
    } catch (error) {
      state.failed += 1;
      throw error;
    }
  };
  return { state, run };
}

/** Cursor de `total` linhas em lotes de `size`, contando os lotes lidos do "banco". */
function cursor(total: number, size: number, failAt: number | null = null) {
  const stats = { opened: 0, fetched: 0 };
  let position = 0;
  const reader: CursorReader<number> = {
    open: () => {
      stats.opened += 1;
      return Promise.resolve();
    },
    next: () => {
      stats.fetched += 1;
      if (failAt !== null && stats.fetched === failAt) {
        return Promise.reject(new Error('conexão perdida'));
      }
      const rows = Array.from(
        { length: Math.max(0, Math.min(size, total - position)) },
        (_, i) => position + i,
      );
      position += rows.length;
      return Promise.resolve(rows);
    },
  };
  return { stats, reader };
}

describe('pullInTransaction (US-003 · RN-PROC-45)', () => {
  it('entrega todos os lotes em ordem numa única transação e a encerra no fim', async () => {
    const tx = fakeTransaction();
    const source = cursor(1200, 500);
    const batches: number[][] = [];
    for await (const batch of pullInTransaction(tx.run, source.reader)) batches.push([...batch]);
    expect(batches.map((batch) => batch.length)).toEqual([500, 500, 200]);
    expect(batches.flat()).toEqual(Array.from({ length: 1200 }, (_, i) => i));
    expect(source.stats).toEqual({ opened: 1, fetched: 4 });
    expect(tx.state).toEqual({ opened: 1, finished: 1, failed: 0 });
  });

  it('backpressure: só lê o próximo lote quando o consumidor pede (memória constante)', async () => {
    const tx = fakeTransaction();
    const source = cursor(10_000, 500);
    const iterator = pullInTransaction(tx.run, source.reader);
    await iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Um lote entregue e nenhum lido adiante enquanto o consumidor não pede.
    expect(source.stats.fetched).toBe(1);
    await iterator.next();
    expect(source.stats.fetched).toBe(2);
    // Desistência no meio: a transação de leitura termina sem ler o resto.
    await iterator.return(undefined);
    expect(source.stats.fetched).toBe(2);
    expect(tx.state).toEqual({ opened: 1, finished: 1, failed: 0 });
  });

  it('falha do banco no meio chega ao consumidor como exceção', async () => {
    const tx = fakeTransaction();
    const source = cursor(5000, 500, 3);
    const received: number[] = [];
    await expect(async () => {
      for await (const batch of pullInTransaction(tx.run, source.reader))
        received.push(batch.length);
    }).rejects.toThrow('conexão perdida');
    expect(received).toEqual([500, 500]);
    expect(tx.state.failed).toBe(1);
  });

  it('falha ao abrir a transação também chega ao consumidor', async () => {
    const run = () => Promise.reject(new Error('pool esgotado'));
    const iterator = pullInTransaction(run, cursor(10, 5).reader);
    await expect(iterator.next()).rejects.toThrow('pool esgotado');
  });

  it('conjunto vazio: nenhum lote e transação encerrada', async () => {
    const tx = fakeTransaction();
    const batches: unknown[] = [];
    for await (const batch of pullInTransaction(tx.run, cursor(0, 500).reader)) batches.push(batch);
    expect(batches).toEqual([]);
    expect(tx.state.finished).toBe(1);
  });
});

describe('inCurrentContext', () => {
  it('cada passo do gerador roda no contexto capturado na criação', async () => {
    const storage = new AsyncLocalStorage<string>();
    async function* source() {
      await Promise.resolve();
      yield storage.getStore();
      yield storage.getStore();
    }
    const iterable = storage.run('requisição', () => inCurrentContext(source()));
    const seen: (string | undefined)[] = [];
    for await (const value of iterable) seen.push(value);
    expect(seen).toEqual(['requisição', 'requisição']);
    const early = storage.run('outra', () => inCurrentContext(source()))[Symbol.asyncIterator]();
    await early.next();
    await expect(early.return?.()).resolves.toMatchObject({ done: true });
    await expect(early.throw?.(new Error('x'))).rejects.toThrow('x');
  });
});
