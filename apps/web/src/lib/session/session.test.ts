import { toast } from '@contrataflow/ui';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import { formatDateTime, formatMoney } from '@/lib/i18n/format';
import { tenantKey } from '@/lib/query/keys';

import { fetchActiveTenantId, logout, switchTenant } from './session-actions';
import {
  SESSION_CHANNEL,
  isSessionEvent,
  publishSessionEvent,
  subscribeSessionEvents,
} from './session-channel';
import type { SessionEvent } from './session-channel';

const A = '0192a000-0000-7000-8000-00000000000a';
const B = '0192a000-0000-7000-8000-00000000000b';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function nextEvent(): Promise<SessionEvent> {
  return new Promise((resolve) => {
    const stop = subscribeSessionEvents((event) => {
      stop();
      resolve(event);
    });
  });
}

describe('[Tenant incorreto] troca de tenant limpa o cache de dados', () => {
  it('apaga 100% do cache antes de recarregar e avisa as outras abas', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(tenantKey(A, 'processes', 'list'), [
      { title: 'Processo da Prefeitura A' },
    ]);
    queryClient.setQueryData(tenantKey(A, 'me', 'permissions'), { permissions: [] });
    queryClient.setQueryData(['me'], { name: 'Ana' });
    toast({ title: 'Aviso da Prefeitura A' });
    const order: string[] = [];
    const clear = vi.spyOn(queryClient, 'clear').mockImplementation(function (this: QueryClient) {
      order.push('clear');
      QueryClient.prototype.clear.call(this);
    });
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(json({ data: { activeTenant: { id: B, name: 'Prefeitura B' } } })),
    );
    const broadcast = nextEvent();

    const session = await switchTenant(B, {
      queryClient,
      refresh: () => order.push('refresh'),
      fetchImpl,
    });

    expect(session.activeTenant?.id).toBe(B);
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(JSON.stringify(queryClient.getQueryCache().getAll())).not.toContain('Prefeitura A');
    expect(order).toEqual(['clear', 'refresh']);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(await broadcast).toEqual({ type: 'tenant-switched', tenantId: B });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('/api/auth/switch-tenant');
    expect(new Headers(init?.headers).get('X-CF-Request')).toBe('1');
    expect(init?.body).toBe(JSON.stringify({ tenantId: B }));
  });

  it('troca recusada pelo BFF mantém o cache e lança ApiError', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(tenantKey(A, 'x'), 1);
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(json({ code: 'MEMBERSHIP_INACTIVE' }, 403)),
    );
    await expect(
      switchTenant(B, { queryClient, refresh: vi.fn(), fetchImpl }),
    ).rejects.toMatchObject({
      code: 'MEMBERSHIP_INACTIVE',
    });
    expect(queryClient.getQueryData(tenantKey(A, 'x'))).toBe(1);
  });
});

describe('logout e sondagem de sessão', () => {
  it('logout limpa cache, sessionStorage e avisa as abas', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['me'], 1);
    const storage = { clear: vi.fn() };
    vi.stubGlobal('sessionStorage', storage);
    const navigate = vi.fn();
    const broadcast = nextEvent();
    await logout({
      queryClient,
      navigate,
      fetchImpl: () => Promise.resolve(json({ data: { redirectTo: '/entrar?motivo=saiu' } })),
    });
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(storage.clear).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/entrar?motivo=saiu');
    expect(await broadcast).toEqual({ type: 'logout' });
    vi.unstubAllGlobals();

    const fallback = vi.fn();
    vi.stubGlobal('sessionStorage', {
      clear: () => {
        throw new Error('bloqueado');
      },
    });
    await logout({
      queryClient,
      navigate: fallback,
      fetchImpl: () => Promise.resolve(new Response('x')),
    });
    expect(fallback).toHaveBeenCalledWith('/entrar?motivo=saiu');
    vi.unstubAllGlobals();
  });

  it('keepalive: sem sessão, tenant ativo ou resposta inútil', async () => {
    expect(await fetchActiveTenantId(() => Promise.resolve(json({}, 401)))).toEqual({
      kind: 'no-session',
    });
    expect(
      await fetchActiveTenantId(() => Promise.resolve(json({ data: { activeTenant: { id: A } } }))),
    ).toEqual({
      kind: 'tenant',
      tenantId: A,
    });
    expect(await fetchActiveTenantId(() => Promise.resolve(json({}, 503)))).toEqual({
      kind: 'tenant',
      tenantId: null,
    });
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(json({ data: {} })));
    expect(await fetchActiveTenantId(fetchImpl)).toEqual({ kind: 'tenant', tenantId: null });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/auth/session?keepalive=1');
  });
});

describe('BroadcastChannel cf-session', () => {
  it('valida mensagens e entrega às outras instâncias', async () => {
    expect(SESSION_CHANNEL).toBe('cf-session');
    expect(isSessionEvent({ type: 'expired' })).toBe(true);
    expect(isSessionEvent({ type: 'tenant-switched' })).toBe(false);
    expect(isSessionEvent('logout')).toBe(false);
    const received = nextEvent();
    // Mensagem estranha é ignorada; a válida chega.
    const raw = new BroadcastChannel(SESSION_CHANNEL);
    raw.postMessage({ type: 'outra-coisa' });
    raw.close();
    publishSessionEvent({ type: 'expired' });
    expect(await received).toEqual({ type: 'expired' });
  });

  it('sem BroadcastChannel (navegador antigo) não quebra', () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    expect(() => {
      publishSessionEvent({ type: 'logout' });
    }).not.toThrow();
    subscribeSessionEvents(vi.fn())();
    vi.unstubAllGlobals();
  });
});

describe('formatação pt-BR (RN-FND-95)', () => {
  it('dinheiro a partir da string decimal, sem perda de precisão', () => {
    // O Intl separa o símbolo com espaço não separável (U+00A0).
    expect(formatMoney('1234567.89')).toBe('R$ 1.234.567,89');
    expect(formatMoney('90071992547409.93')).toBe('R$ 90.071.992.547.409,93');
    expect(() => formatMoney('1,5')).toThrow(/string decimal/);
  });

  it('data no fuso da instituição', () => {
    expect(formatDateTime('2026-10-14T03:30:00Z', 'America/Sao_Paulo')).toBe('14/10/2026, 00:30');
    expect(formatDateTime('2026-10-14T03:30:00Z', 'America/Manaus')).toBe('13/10/2026, 23:30');
  });
});
