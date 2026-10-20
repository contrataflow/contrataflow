import { describe, expect, it, vi } from 'vitest';

import { startQueueDashboard } from './queue-dashboard.js';

describe('Bull Board — limite de taxa (queues.md §15.1)', () => {
  it('acima do limite por origem responde 429 antes de autenticar e libera na janela seguinte', async () => {
    let clock = 0;
    const authenticate = vi.fn(() => Promise.resolve({ userId: 'op-1', name: 'Operadora' }));
    const dashboard = await startQueueDashboard(
      {
        queues: [],
        authenticator: { authenticate },
        audit: { record: () => Promise.resolve() },
        rateLimit: { limit: 2, windowMs: 60_000 },
        now: () => clock,
      },
      0,
      '127.0.0.1',
    );
    const get = (path: string) =>
      fetch(`http://127.0.0.1:${String(dashboard.port)}${path}`, {
        headers: { authorization: 'Bearer token-ok' },
      });
    try {
      expect((await get('/queues')).status).toBe(200);
      expect((await get('/queues')).status).toBe(200);
      clock = 15_000;
      const limited = await get('/queues');
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).toBe('45');
      expect(await limited.json()).toEqual({
        code: 'RATE_LIMITED',
        message: 'Muitas tentativas. Aguarde alguns segundos.',
      });
      // O excedente nem chega à verificação do token (JWKS + leitura de `users`).
      expect(authenticate).toHaveBeenCalledTimes(2);
      expect((await get('/health')).status).toBe(200);

      clock = 60_000;
      expect((await get('/queues')).status).toBe(200);
      expect(authenticate).toHaveBeenCalledTimes(3);
    } finally {
      await dashboard.close();
    }
  });
});
