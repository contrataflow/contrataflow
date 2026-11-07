import { Logger } from '@nestjs/common';
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

  it('a API do painel passa pelo limite e o bloqueio gera um único log por origem e janela', async () => {
    let clock = 0;
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const rateLimitedLogs = () =>
      warn.mock.calls.filter(
        ([entry]) => (entry as { event?: string }).event === 'queue_dashboard.rate_limited',
      );
    const dashboard = await startQueueDashboard(
      {
        queues: [],
        authenticator: {
          authenticate: () => Promise.resolve({ userId: 'op-1', name: 'Operadora' }),
        },
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
      // O painel segue funcionando atrás do limite: a página e a API que ela consulta.
      expect((await get('/queues')).status).toBe(200);
      const api = await get('/queues/api/queues');
      expect(api.status).toBe(200);
      expect(await api.json()).toMatchObject({ queues: [] });

      // A página e a API contam juntas; uma varredura acima do limite registra só uma linha.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        expect((await get('/queues/api/queues')).status).toBe(429);
      }
      expect(rateLimitedLogs()).toEqual([
        [{ event: 'queue_dashboard.rate_limited', limit: 2, windowMs: 60_000 }],
      ]);

      // Janela nova: volta a registrar no primeiro excedente.
      clock = 60_000;
      expect((await get('/queues')).status).toBe(200);
      expect((await get('/queues')).status).toBe(200);
      expect((await get('/queues')).status).toBe(429);
      expect(rateLimitedLogs()).toHaveLength(2);
    } finally {
      warn.mockRestore();
      await dashboard.close();
    }
  });
});
