import { beforeEach, describe, expect, it, vi } from 'vitest';

import HomePage from './page';

class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT ${url}`);
  }
}

const server: { lookup: { status: string } } = vi.hoisted(() => ({
  lookup: { status: 'none' },
}));

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));

vi.mock('@/bff/server-session', () => ({
  currentSessionOrUnavailable: () => Promise.resolve(server.lookup),
}));

async function redirectOf(): Promise<string> {
  try {
    await HomePage();
  } catch (error) {
    if (error instanceof RedirectSignal) return error.url;
    throw error;
  }
  throw new Error('Esperava redirecionamento.');
}

describe('raiz / (redirecionamento pela sessão)', () => {
  beforeEach(() => {
    server.lookup = { status: 'none' };
  });

  it('sem sessão leva à entrada (SCR-001)', async () => {
    expect(await redirectOf()).toBe('/entrar');
  });

  it('com sessão ativa leva ao destino padrão da área autenticada', async () => {
    server.lookup = { status: 'active' };
    expect(await redirectOf()).toBe('/painel');
  });

  it('sessão vencida ou vínculo encerrado seguem para o layout de (app), que trata cada caso', async () => {
    server.lookup = { status: 'expired' };
    expect(await redirectOf()).toBe('/painel');
    server.lookup = { status: 'membership_ended' };
    expect(await redirectOf()).toBe('/painel');
  });

  it('Redis de sessões fora do ar cai na entrada, que continua acessível (DEC-131)', async () => {
    server.lookup = { status: 'unavailable' };
    expect(await redirectOf()).toBe('/entrar');
  });
});
