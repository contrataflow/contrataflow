import { EventEmitter } from 'node:events';

import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { checkoutClient } from './pooled-client.js';

class FakeClient extends EventEmitter {
  readonly release = vi.fn<(broken?: boolean) => void>();
}

function poolWith(client: FakeClient): pg.Pool {
  return { connect: () => Promise.resolve(client) } as unknown as pg.Pool;
}

describe('checkoutClient (cliente do pool em uso)', () => {
  it("escuta 'error' enquanto o cliente está em uso: o evento não vira exceção", async () => {
    const client = new FakeClient();
    const checkout = await checkoutClient(poolWith(client));

    expect(client.listenerCount('error')).toBe(1);
    expect(() =>
      client.emit('error', new Error('Connection terminated unexpectedly')),
    ).not.toThrow();
    expect(checkout.failed).toBe(true);
  });

  it("descarta o cliente que emitiu 'error', mesmo sem o chamador marcar como quebrado", async () => {
    const client = new FakeClient();
    const checkout = await checkoutClient(poolWith(client));
    client.emit('error', new Error('boom'));

    checkout.release(false);

    expect(client.release).toHaveBeenCalledWith(true);
    expect(client.listenerCount('error')).toBe(0);
  });

  it('devolve ao pool o cliente saudável e remove o próprio listener', async () => {
    const client = new FakeClient();
    const checkout = await checkoutClient(poolWith(client));

    checkout.release(false);

    expect(checkout.failed).toBe(false);
    expect(client.release).toHaveBeenCalledWith(false);
    expect(client.listenerCount('error')).toBe(0);
  });

  it('respeita o quebrado indicado pelo chamador (ROLLBACK que falhou)', async () => {
    const client = new FakeClient();
    const checkout = await checkoutClient(poolWith(client));

    checkout.release(true);

    expect(client.release).toHaveBeenCalledWith(true);
  });
});
