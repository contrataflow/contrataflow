// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SESSION_CHANNEL } from '@/lib/session/session-channel';
import type { ShellMembership } from '@/lib/session/types';
import { seriousA11yViolations } from '@test/support/axe';
import {
  IntlProvider,
  TENANT_A,
  TENANT_B,
  jsonResponse,
  problem,
  shellSession,
} from '@test/support/render';

import { TenantSelection } from './tenant-selection';

afterEach(() => {
  vi.unstubAllGlobals();
});

function membership(overrides: Partial<ShellMembership> = {}): ShellMembership {
  return {
    membershipId: 'm-x',
    tenant: { id: 'tenant-x', name: 'Prefeitura X', status: 'ACTIVE' },
    type: 'INTERNAL',
    expiresAt: null,
    usable: true,
    ...overrides,
  };
}

function renderSelection(
  activeTenantId: string | null,
  options: {
    readonly memberships?: readonly ShellMembership[];
    readonly returnTo?: string | null;
  } = {},
) {
  const assign = vi.fn();
  vi.stubGlobal('location', { href: window.location.href, assign });
  const view = render(
    <IntlProvider>
      <TenantSelection
        memberships={options.memberships ?? shellSession().memberships}
        activeTenantId={activeTenantId}
        returnTo={options.returnTo ?? null}
      />
    </IntlProvider>,
  );
  return { assign, ...view };
}

describe('seleção de instituição (FA-01)', () => {
  it('troca a instituição, avisa as abas e vai ao início quando não há returnTo', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse({ data: { activeTenant: { id: TENANT_B.id } } })),
    );
    vi.stubGlobal('fetch', fetchMock);
    // Como outra aba recebe: um objeto do canal sem o filtro de origem desta aba.
    const events: unknown[] = [];
    const otherTab = new BroadcastChannel(SESSION_CHANNEL);
    otherTab.onmessage = (message: MessageEvent<unknown>) => events.push(message.data);
    const { assign } = renderSelection(null);
    await userEvent.click(screen.getByRole('button', { name: 'Prefeitura B' }));
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith('/processos');
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/auth/switch-tenant');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('X-CF-Request')).toBe('1');
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(typeof init?.body === 'string' ? init.body : '')).toEqual({
      membershipId: 'm-b',
    });
    await waitFor(() => {
      expect(events).toMatchObject([{ type: 'tenant-switched', tenantId: TENANT_B.id }]);
    });
    otherTab.close();
  });

  it('sucesso navega para o returnTo recebido do servidor', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ data: {} }))),
    );
    const { assign } = renderSelection(null, { returnTo: '/processos/0192aa?aba=2' });
    await userEvent.click(screen.getByRole('button', { name: 'Prefeitura A' }));
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith('/processos/0192aa?aba=2');
    });
  });

  it('mostra o vínculo externo com a validade em dd/mm/aaaa e o aviso de instituição em encerramento', () => {
    renderSelection(null, {
      memberships: [
        membership({
          membershipId: 'm-ext',
          tenant: { id: 'tenant-ext', name: 'Câmara Municipal de Vila Nova', status: 'ACTIVE' },
          type: 'EXTERNAL',
          expiresAt: '2026-12-31T23:59:59-03:00',
        }),
        membership({
          membershipId: 'm-off',
          tenant: { id: 'tenant-off', name: 'Prefeitura em Encerramento', status: 'OFFBOARDING' },
        }),
        membership({
          membershipId: 'm-int',
          tenant: { id: 't-int', name: 'Prefeitura Interna', status: 'ACTIVE' },
        }),
      ],
    });
    const external = screen.getByRole('button', { name: /Câmara Municipal de Vila Nova/ });
    expect(within(external).getByText('Vínculo externo')).toBeTruthy();
    expect(within(external).getByText('Válido até 31/12/2026')).toBeTruthy();
    const offboarding = screen.getByRole('button', { name: /Prefeitura em Encerramento/ });
    expect(offboarding.textContent).toContain(
      'Instituição em encerramento: somente leitura e exportação',
    );
    expect(offboarding.getAttribute('aria-disabled')).toBeNull();
    const internal = screen.getByRole('button', { name: /Prefeitura Interna/ });
    expect(within(internal).queryByText('Vínculo externo')).toBeNull();
    expect(within(internal).queryByText(/Válido até/)).toBeNull();
  });

  it('FA-08: instituição indisponível e vínculo sem acesso aparecem desabilitados e não são enviados', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({ data: {} })));
    vi.stubGlobal('fetch', fetchMock);
    const { assign } = renderSelection(null, {
      memberships: [
        membership({
          membershipId: 'm-sus',
          tenant: { id: 't-sus', name: 'Prefeitura Suspensa', status: 'SUSPENDED' },
          usable: false,
        }),
        membership({
          membershipId: 'm-exp',
          tenant: { id: 't-exp', name: 'Prefeitura Vencida', status: 'ACTIVE' },
          type: 'EXTERNAL',
          expiresAt: '2025-01-31T12:00:00-03:00',
          usable: false,
        }),
        membership({
          membershipId: 'm-ok',
          tenant: { id: 't-ok', name: 'Prefeitura Ativa', status: 'ACTIVE' },
        }),
      ],
    });
    const suspended = screen.getByRole('button', { name: /Prefeitura Suspensa/ });
    expect(suspended.getAttribute('aria-disabled')).toBe('true');
    expect(suspended.textContent).toContain('Instituição temporariamente indisponível');
    const expired = screen.getByRole('button', { name: /Prefeitura Vencida/ });
    expect(expired.getAttribute('aria-disabled')).toBe('true');
    expect(expired.textContent).toContain('Seu acesso a esta instituição não está ativo.');
    // A validade só é mostrada para vínculos utilizáveis.
    expect(expired.textContent).not.toContain('Válido até');
    // Descrição acessível: o motivo é lido junto com o botão.
    expect(suspended.getAttribute('aria-describedby')).toBeTruthy();

    // Utilizáveis vêm primeiro.
    const names = screen
      .getAllByRole('button', { name: /Prefeitura/ })
      .map((button) => button.textContent);
    expect(names[0]).toContain('Prefeitura Ativa');

    await userEvent.click(suspended);
    await userEvent.click(expired);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it('durante a troca o botão fica com aria-busy e novos cliques são ignorados', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', fetchMock);
    renderSelection(null);
    const chosen = screen.getByRole('button', { name: /Prefeitura B/ });
    await userEvent.click(chosen);
    expect(chosen.getAttribute('aria-busy')).toBe('true');
    expect(chosen.textContent).toContain('Entrando…');
    const other = screen.getByRole('button', { name: /Prefeitura A/ });
    expect(other.getAttribute('aria-disabled')).toBe('true');
    await userEvent.click(other);
    await userEvent.click(chosen);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falha de rede mostra o aviso e permite tentar de novo', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(jsonResponse({ data: {} }));
    vi.stubGlobal('fetch', fetchMock);
    const { assign } = renderSelection(TENANT_B.id);
    await userEvent.click(screen.getByRole('button', { name: /Prefeitura B/ }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Não foi possível selecionar a instituição. Tente novamente.');
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Prefeitura B/ }).getAttribute('aria-busy')).toBe(
      'false',
    );

    await userEvent.click(screen.getByRole('button', { name: /Prefeitura B/ }));
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith('/processos');
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each([
    [422, 'VALIDATION_ERROR', 'Selecione uma instituição válida.'],
    [403, 'MEMBERSHIP_INACTIVE', 'Você não tem mais acesso a esta instituição.'],
    [403, 'TENANT_SUSPENDED', 'Esta instituição está indisponível no momento.'],
    [403, 'PERMISSION_DENIED', 'Requisição não permitida. Recarregue a página.'],
    [403, 'CSRF_REJECTED', 'Requisição não permitida. Recarregue a página.'],
    [503, 'DEPENDENCY_UNAVAILABLE', 'Não foi possível trocar agora. Tente novamente.'],
    [500, 'INTERNAL_ERROR', 'Não foi possível selecionar a instituição. Tente novamente.'],
  ])('erro %s %s vira mensagem inline com role=alert', async (status, code, message) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(problem(status, code))),
    );
    const { assign } = renderSelection(null);
    await userEvent.click(screen.getByRole('button', { name: 'Prefeitura A' }));
    expect((await screen.findByRole('alert')).textContent).toBe(message);
    expect(assign).not.toHaveBeenCalled();
  });

  it('V-02: vínculo recusado (MEMBERSHIP_INACTIVE) sai das opções selecionáveis', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(problem(403, 'MEMBERSHIP_INACTIVE')));
    vi.stubGlobal('fetch', fetchMock);
    renderSelection(TENANT_A.id);
    const target = screen.getByRole('button', { name: /Prefeitura B/ });
    await userEvent.click(target);
    await screen.findByRole('alert');
    const updated = screen.getByRole('button', { name: /Prefeitura B/ });
    expect(updated.getAttribute('aria-disabled')).toBe('true');
    await userEvent.click(updated);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a instituição ativa aparece destacada como "Atual" (troca pelo cabeçalho)', () => {
    renderSelection(TENANT_A.id);
    const active = screen.getByRole('button', { name: /Prefeitura A/ });
    expect(active.getAttribute('aria-current')).toBe('true');
    expect(within(active).getByText('Atual')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /Prefeitura B/ }).getAttribute('aria-current'),
    ).toBeNull();
  });

  it('FA-04 "Usar como padrão" vai no pedido de troca', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse({ data: { activeTenant: { id: TENANT_B.id } } })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { assign } = renderSelection(TENANT_A.id);
    const toggle = screen.getByRole('switch', { name: /Usar como padrão/ });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    await userEvent.click(toggle);
    await userEvent.click(screen.getByRole('button', { name: /Prefeitura B/ }));
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith('/processos');
    });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(typeof init?.body === 'string' ? init.body : '')).toEqual({
      membershipId: 'm-b',
      setAsDefault: true,
    });
  });

  it('[Falha de integração] destino exige MFA: segue ao step-up devolvido pelo BFF', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          jsonResponse(
            { code: 'MFA_REQUIRED', stepUpUrl: '/api/auth/step-up?returnTo=%2Fexemplo' },
            { status: 403 },
          ),
        ),
      ),
    );
    const { assign } = renderSelection(TENANT_A.id);
    await userEvent.click(screen.getByRole('button', { name: /Prefeitura B/ }));
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith('/api/auth/step-up?returnTo=%2Fexemplo');
    });
  });

  it('sessão expirada durante a escolha leva à entrada com o motivo e o returnTo', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(problem(401, 'SESSION_EXPIRED'))),
    );
    const { assign } = renderSelection(null, { returnTo: '/processos?x=1' });
    await userEvent.click(screen.getByRole('button', { name: 'Prefeitura A' }));
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith(
        '/entrar?motivo=sessao-expirada&returnTo=%2Fprocessos%3Fx%3D1',
      );
    });
  });

  it('rodapé: orientação de convite e "Sair" que encerra a sessão', async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse({ data: { logoutUrl: '/entrar?motivo=saiu' } })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { assign } = renderSelection(null);
    expect(
      screen.getByText(
        'Não encontrou sua instituição? Peça ao administrador do órgão um convite para o seu e-mail.',
      ),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Sair' }));
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith('/entrar?motivo=saiu');
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/auth/logout');
  });

  it('sem violação de acessibilidade (lista, desabilitados, erro)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(problem(403, 'MEMBERSHIP_INACTIVE'))),
    );
    renderSelection(null, {
      memberships: [
        ...shellSession().memberships,
        membership({
          membershipId: 'm-sus',
          tenant: { id: 't-sus', name: 'Prefeitura Suspensa', status: 'SUSPENDED' },
          usable: false,
        }),
      ],
    });
    await userEvent.click(screen.getByRole('button', { name: TENANT_A.name }));
    await screen.findByRole('alert');
    expect(await seriousA11yViolations()).toEqual([]);
  });
});
