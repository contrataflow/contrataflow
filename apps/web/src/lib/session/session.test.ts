import { toast } from '@contrataflow/ui';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import { MemoryDraftBackend, LocalDrafts } from '@/lib/drafts/local-drafts';
import { formatDateTime, formatMoney } from '@/lib/i18n/format';
import { tenantKey } from '@/lib/query/keys';

import { extendSession, fetchSessionState, logout, switchTenant } from './session-actions';
import {
  SESSION_CHANNEL,
  isSessionEvent,
  publishSessionEvent,
  subscribeSessionEvents,
} from './session-channel';

const A = '0192a000-0000-7000-8000-00000000000a';
const B = '0192a000-0000-7000-8000-00000000000b';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Próxima mensagem publicada no canal, como outra aba a recebe (sem o filtro de origem). */
function nextEvent(): Promise<unknown> {
  return new Promise((resolve) => {
    const raw = new BroadcastChannel(SESSION_CHANNEL);
    raw.onmessage = (message: MessageEvent<unknown>) => {
      if (!isSessionEvent(message.data)) return;
      raw.close();
      resolve(message.data);
    };
  });
}

describe('[Tenant incorreto] troca de tenant limpa o cache de dados (US-093)', () => {
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

    const outcome = await switchTenant('membership-b', {
      queryClient,
      currentTenantId: A,
      refresh: () => order.push('refresh'),
      fetchImpl,
    });

    expect(outcome.kind).toBe('switched');
    if (outcome.kind !== 'switched') throw new Error('esperado switched');
    expect(outcome.session.activeTenant?.id).toBe(B);
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(JSON.stringify(queryClient.getQueryCache().getAll())).not.toContain('Prefeitura A');
    expect(order).toEqual(['clear', 'refresh']);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(await broadcast).toMatchObject({ type: 'tenant-switched', tenantId: B });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe('/api/auth/switch-tenant');
    expect(new Headers(init?.headers).get('X-CF-Request')).toBe('1');
    expect(init?.body).toBe(JSON.stringify({ membershipId: 'membership-b' }));
  });

  it('[Duplicidade] a instituição já ativa volta como no-op: cache mantido (RN-IAM-70)', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(tenantKey(A, 'x'), 1);
    const refresh = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(json({ data: { activeTenant: { id: A } } })),
    );
    const outcome = await switchTenant('membership-a', {
      queryClient,
      currentTenantId: A,
      setAsDefault: true,
      refresh,
      fetchImpl,
    });
    expect(outcome.kind).toBe('unchanged');
    expect(queryClient.getQueryData(tenantKey(A, 'x'))).toBe(1);
    expect(refresh).not.toHaveBeenCalled();
    expect(fetchImpl.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ membershipId: 'membership-a', setAsDefault: true }),
    );
  });

  it('primeira escolha (sem cache, grupo (auth)) também avisa as abas', async () => {
    const refresh = vi.fn();
    const broadcast = nextEvent();
    const outcome = await switchTenant('membership-b', {
      currentTenantId: null,
      refresh,
      fetchImpl: () => Promise.resolve(json({ data: { activeTenant: { id: B } } })),
    });
    expect(outcome.kind).toBe('switched');
    expect(refresh).toHaveBeenCalledOnce();
    expect(await broadcast).toMatchObject({ type: 'tenant-switched', tenantId: B });
  });

  it('[Falha de integração] MFA_REQUIRED devolve o step-up do BFF (nunca um destino externo)', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(tenantKey(A, 'x'), 1);
    const reply = (stepUpUrl: unknown) => () =>
      Promise.resolve(json({ code: 'MFA_REQUIRED', stepUpUrl }, 403));
    const deps = { queryClient, currentTenantId: A, refresh: vi.fn() };
    await expect(
      switchTenant('membership-b', {
        ...deps,
        fetchImpl: reply('/api/auth/step-up?returnTo=%2Fexemplo'),
      }),
    ).resolves.toEqual({ kind: 'step-up', href: '/api/auth/step-up?returnTo=%2Fexemplo' });
    await expect(
      switchTenant('membership-b', { ...deps, fetchImpl: reply('https://evil.example/') }),
    ).resolves.toEqual({ kind: 'step-up', href: '/api/auth/step-up?returnTo=%2Fpainel' });
    expect(queryClient.getQueryData(tenantKey(A, 'x'))).toBe(1);
    expect(deps.refresh).not.toHaveBeenCalled();
  });

  it('troca recusada pelo BFF mantém o cache e lança ApiError', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(tenantKey(A, 'x'), 1);
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(json({ code: 'MEMBERSHIP_INACTIVE' }, 403)),
    );
    await expect(
      switchTenant('membership-b', {
        queryClient,
        currentTenantId: A,
        refresh: vi.fn(),
        fetchImpl,
      }),
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
      fetchImpl: () => Promise.resolve(json({ data: { logoutUrl: '/entrar?motivo=saiu' } })),
    });
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(storage.clear).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/entrar?motivo=saiu');
    expect(await broadcast).toMatchObject({ type: 'logout' });
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

  it('logout apaga os rascunhos locais do usuário (RN-IAM-31)', async () => {
    const drafts = new LocalDrafts(new MemoryDraftBackend());
    await drafts.save({ userId: 'u1', tenantId: 't', target: 'x', content: 1, baseRevision: null });
    await drafts.save({ userId: 'u2', tenantId: 't', target: 'x', content: 1, baseRevision: null });
    vi.stubGlobal('sessionStorage', { clear: vi.fn() });
    await logout({
      queryClient: new QueryClient(),
      navigate: vi.fn(),
      userId: 'u1',
      drafts,
      fetchImpl: () => Promise.resolve(json({ data: { logoutUrl: 'https://idp/fim' } })),
    });
    expect(await drafts.hasUnsynced('u1')).toBe(false);
    expect(await drafts.hasUnsynced('u2')).toBe(true);
    vi.unstubAllGlobals();
  });

  it('estado da sessão: sondagem sem renovar e "Continuar conectado" com keepalive', async () => {
    const session = { activeTenant: { id: A }, idleExpiresAt: '2026-10-14T12:30:00.000Z' };
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(json({ data: session })));
    expect(await fetchSessionState(fetchImpl)).toEqual({ kind: 'active', session });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/auth/session');
    await extendSession(fetchImpl);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('/api/auth/session?keepalive=true');
    const answer = (body: unknown, status: number) => () => Promise.resolve(json(body, status));
    expect(await fetchSessionState(answer({ code: 'SESSION_EXPIRED' }, 401))).toEqual({
      kind: 'expired',
    });
    expect(await fetchSessionState(answer({ code: 'UNAUTHENTICATED' }, 401))).toEqual({
      kind: 'no-session',
    });
    expect(await fetchSessionState(answer({ code: 'MEMBERSHIP_INACTIVE' }, 403))).toEqual({
      kind: 'membership-inactive',
    });
    // Redis de sessões fora (503) ou rede: indisponível, nunca "expirada" (RN-IAM-33).
    expect(await fetchSessionState(answer({ code: 'DEPENDENCY_UNAVAILABLE' }, 503))).toEqual({
      kind: 'unavailable',
    });
    expect(await fetchSessionState(() => Promise.reject(new TypeError('rede')))).toEqual({
      kind: 'unavailable',
    });
    expect(
      await fetchSessionState(() => Promise.resolve(new Response('x', { status: 200 }))),
    ).toEqual({ kind: 'unavailable' });
  });
});

describe('BroadcastChannel cf-session', () => {
  it('valida mensagens, ignora as da própria aba e entrega as das outras', async () => {
    expect(SESSION_CHANNEL).toBe('cf-session');
    expect(isSessionEvent({ type: 'expired' })).toBe(true);
    expect(isSessionEvent({ type: 'tenant-switched' })).toBe(false);
    expect(isSessionEvent({ type: 'extended', idleExpiresAt: 'ontem' })).toBe(false);
    expect(isSessionEvent('logout')).toBe(false);
    const handler = vi.fn();
    const stop = subscribeSessionEvents(handler);
    const raw = new BroadcastChannel(SESSION_CHANNEL);
    raw.postMessage({ type: 'outra-coisa', source: 'outra-aba' });
    // A aba que sai segue para o Authentik: a própria mensagem não a desvia para a SCR-001.
    publishSessionEvent({ type: 'logout' });
    raw.postMessage({
      type: 'extended',
      idleExpiresAt: '2026-10-14T12:30:00.000Z',
      source: 'outra-aba',
    });
    raw.close();
    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ type: 'extended' }));
    stop();
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
