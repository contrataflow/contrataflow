// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiRequest } from '@/lib/api/client';
import { LocalDrafts, MemoryDraftBackend } from '@/lib/drafts/local-drafts';
import { SESSION_CHANNEL } from '@/lib/session/session-channel';
import { emitSessionSignal } from '@/lib/session/session-signals';
import type { ActiveShellSession } from '@/lib/session/types';
import { afterActivity, deadlinesFrom, formatCountdown, sessionPhase } from '@/lib/session/watcher';
import { seriousA11yViolations } from '@test/support/axe';
import { jsonResponse, renderWithShell, requestUrl, shellSession } from '@test/support/render';
import { postFromOtherTab } from '@test/support/session-tabs';

import { LogoutGuard, useLogout } from './logout-guard';
import { SessionWatcher } from './session-watcher';

/*
 * US-088 na interface (relógio simulado): aviso de ociosidade, "Continuar conectado", expiração
 * com o modal, aviso de término absoluto, indisponibilidade e "Sair" com rascunho local.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => '/exemplo',
}));

const T = (time: string) => Date.parse(`2026-10-14T${time}Z`);

/** Sessão de "Cláudia": ociosidade às 12:30, fim absoluto à 00:00. */
const SESSION = shellSession();

let channelMessages: unknown[];
let otherTab: BroadcastChannel;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T('12:00:00'));
  channelMessages = [];
  otherTab = new BroadcastChannel(SESSION_CHANNEL);
  otherTab.onmessage = (message: MessageEvent<unknown>) => channelMessages.push(message.data);
});

afterEach(() => {
  otherTab.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function stubSessionApi(handler: (url: string, init?: RequestInit) => Response) {
  const fetchMock = vi.fn<typeof fetch>((input, init) =>
    Promise.resolve(handler(requestUrl(input), init)),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function activeSession(overrides: Partial<ActiveShellSession> = {}) {
  return jsonResponse({ data: { ...SESSION, ...overrides } });
}

function renderWatcher(session: ActiveShellSession = SESSION, navigate = vi.fn()) {
  renderWithShell(<SessionWatcher tickMs={10} onNavigate={navigate} />, { session });
  return navigate;
}

describe('contador local (função pura)', () => {
  it('aviso 2 min antes da ociosidade, 5 min antes do fim absoluto; ação reinicia', () => {
    const deadlines = deadlinesFrom(SESSION);
    expect(sessionPhase(deadlines, T('12:27:59'))).toMatchObject({
      idleWarning: false,
      expired: false,
    });
    expect(sessionPhase(deadlines, T('12:28:00'))).toMatchObject({
      idleWarning: true,
      secondsLeft: 120,
    });
    expect(sessionPhase(deadlines, T('12:30:00'))).toMatchObject({
      idleWarning: false,
      expired: true,
    });
    expect(afterActivity(deadlines, T('12:29:00')).idleExpiresAt).toBe(T('12:59:00'));
    // Perto do fim absoluto: a ociosidade não passa dele e só vale o aviso absoluto.
    const late = { ...deadlines, absoluteExpiresAt: T('12:40:00') };
    expect(afterActivity(late, T('12:36:00')).idleExpiresAt).toBe(T('12:40:00'));
    expect(sessionPhase(afterActivity(late, T('12:36:00')), T('12:38:30'))).toMatchObject({
      idleWarning: false,
      absoluteWarning: true,
    });
    expect(formatCountdown(119)).toBe('01:59');
  });
});

describe('SessionWatcher — ociosidade (RN-IAM-21/23)', () => {
  it('[Sucesso] "Você continua aí?" 2 min antes; "Continuar conectado" renova e avisa as abas', async () => {
    const fetchMock = stubSessionApi((url) =>
      url.includes('keepalive=true')
        ? activeSession({ idleExpiresAt: '2026-10-14T12:58:30.000Z' })
        : activeSession(),
    );
    renderWatcher();
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => {
      vi.setSystemTime(T('12:28:30'));
    });
    const dialog = await screen.findByRole('dialog', { name: 'Você continua aí?' });
    expect(dialog.textContent).toContain('Sua sessão será encerrada por inatividade em 2 minutos.');
    expect(screen.getByRole('timer').textContent).toMatch(/^01:(30|29)$/);
    expect(await seriousA11yViolations()).toEqual([]);
    // O contador conferiu o BFF antes de avisar (sondagem, sem renovar).
    expect(requestUrl(fetchMock.mock.calls[0]?.[0] ?? '')).toBe('/api/auth/session');

    await userEvent.click(screen.getByRole('button', { name: 'Continuar conectado' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(fetchMock.mock.calls.map(([input]) => requestUrl(input))).toContain(
      '/api/auth/session?keepalive=true',
    );
    await waitFor(() => {
      expect(channelMessages).toMatchObject([
        { type: 'extended', idleExpiresAt: '2026-10-14T12:58:30.000Z' },
      ]);
    });
  });

  it('clique ou foco fora não renovam a sessão; Esc equivale a "Continuar conectado"', async () => {
    const fetchMock = stubSessionApi((url) =>
      url.includes('keepalive=true')
        ? activeSession({ idleExpiresAt: '2026-10-14T12:59:00.000Z' })
        : activeSession(),
    );
    renderWatcher();
    act(() => {
      vi.setSystemTime(T('12:29:00'));
    });
    await screen.findByRole('dialog', { name: 'Você continua aí?' });
    // Clique e foco fora do diálogo (o Radix trata como "fechar"): ignorados.
    fireEvent.pointerDown(document.body);
    fireEvent.focusIn(document.body);
    expect(screen.getByRole('dialog', { name: 'Você continua aí?' })).toBeTruthy();
    const keepalives = () =>
      fetchMock.mock.calls.filter(([input]) => requestUrl(input).includes('keepalive=true'));
    expect(keepalives()).toHaveLength(0);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(keepalives()).toHaveLength(1);
  });

  it('[Sucesso] FA-02 ação do usuário durante o aviso fecha o diálogo', async () => {
    stubSessionApi(() => activeSession());
    renderWatcher();
    act(() => {
      vi.setSystemTime(T('12:29:00'));
    });
    await screen.findByRole('dialog', { name: 'Você continua aí?' });
    act(() => {
      emitSessionSignal({ type: 'activity' });
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('outra aba manteve a sessão viva: o contador se atualiza e não avisa', async () => {
    const fetchMock = stubSessionApi(() =>
      activeSession({ idleExpiresAt: '2026-10-14T12:55:00.000Z' }),
    );
    renderWatcher();
    act(() => {
      vi.setSystemTime(T('12:28:30'));
    });
    // O diálogo só abre depois da conferência com o BFF — que aqui adia o prazo.
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(screen.queryByRole('dialog')).toBeNull();
    // "Continuar conectado" em outra aba também reinicia este contador.
    postFromOtherTab({ type: 'extended', idleExpiresAt: '2026-10-14T13:30:00.000Z' });
    act(() => {
      vi.setSystemTime(T('12:58:00'));
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('SessionWatcher — expiração (CA-T-09 · RN-IAM-24/29/30)', () => {
  it('[Sucesso] ao vencer, o BFF confirma e o modal bloqueante aparece; as outras abas são avisadas', async () => {
    stubSessionApi(() => jsonResponse({ code: 'SESSION_EXPIRED' }, { status: 401 }));
    renderWatcher();
    act(() => {
      vi.setSystemTime(T('12:31:00'));
    });
    const modal = await screen.findByRole('dialog', { name: 'Sua sessão expirou' });
    expect(modal.textContent).toContain(
      'Por segurança, sua sessão foi encerrada. O que você digitou foi guardado neste navegador.',
    );
    const login = screen.getByRole('link', { name: 'Entrar novamente' });
    // Volta ao ponto e pede a senha de novo (RN-IAM-32).
    expect(login.getAttribute('href')).toMatch(/^\/api\/auth\/login\?returnTo=.+&reauth=1$/);
    expect(screen.queryByRole('button', { name: 'Fechar' })).toBeNull();
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Sua sessão expirou' })).toBeTruthy();
    expect(await seriousA11yViolations()).toEqual([]);
    await waitFor(() => {
      expect(channelMessages).toMatchObject([{ type: 'expired' }]);
    });
  });

  it('[Falha de integração] autosave recebe 401 SESSION_EXPIRED: modal, sem sair da tela', async () => {
    const navigate = renderWatcher();
    await expect(
      apiRequest('/dfds/1/sections/JUSTIFICATION', {
        method: 'PUT',
        body: { content: 'trecho' },
        fetchImpl: () =>
          Promise.resolve(jsonResponse({ code: 'SESSION_EXPIRED' }, { status: 401 })),
      }),
    ).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    await screen.findByRole('dialog', { name: 'Sua sessão expirou' });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('expiração avisada por outra aba abre o modal sem reenviar o aviso', async () => {
    renderWatcher();
    postFromOtherTab({ type: 'expired' });
    await screen.findByRole('dialog', { name: 'Sua sessão expirou' });
    // Só a mensagem da outra aba passou pelo canal.
    expect(channelMessages).toHaveLength(1);
  });

  it('sem sessão (logout em outra aba) → login; vínculo inativo → SCR-111', async () => {
    stubSessionApi(() => jsonResponse({ code: 'UNAUTHENTICATED' }, { status: 401 }));
    const navigate = renderWatcher();
    act(() => {
      vi.setSystemTime(T('12:31:00'));
    });
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith(
        expect.stringMatching(/^\/api\/auth\/login\?returnTo=/),
      );
    });
  });

  it('vínculo encerrado durante o uso (FA-08) → SCR-111', async () => {
    stubSessionApi(() => jsonResponse({ code: 'MEMBERSHIP_INACTIVE' }, { status: 403 }));
    const navigate = renderWatcher();
    act(() => {
      vi.setSystemTime(T('12:28:30'));
    });
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith('/erro/vinculo-inativo');
    });
  });
});

describe('SessionWatcher — duração absoluta e indisponibilidade', () => {
  it('[Validação] aviso não bloqueante 5 min antes do fim absoluto, sem "Continuar conectado"', async () => {
    stubSessionApi(() => activeSession());
    renderWatcher(
      shellSession({
        idleExpiresAt: '2026-10-14T12:20:00.000Z',
        absoluteExpiresAt: '2026-10-14T12:20:00.000Z',
      }),
    );
    act(() => {
      vi.setSystemTime(T('12:16:00'));
    });
    const notice = await screen.findByText(/^Sua sessão termina às \d{2}:20\./);
    expect(notice.textContent).toContain('depois será preciso entrar novamente');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('[Falha de integração] 503 mostra indisponibilidade — nunca "Sua sessão expirou"', async () => {
    const fetchMock = stubSessionApi(() => activeSession());
    renderWatcher();
    // Consulta com 503: o error.tsx do segmento mostra a indisponibilidade (sem banner duplicado).
    await expect(
      apiRequest('/processes', {
        fetchImpl: () =>
          Promise.resolve(jsonResponse({ code: 'DEPENDENCY_UNAVAILABLE' }, { status: 503 })),
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(screen.queryByText('Serviço temporariamente indisponível')).toBeNull();
    // Comando (salvar) com 503: banner com "Tentar novamente"; a tela e o rascunho continuam.
    await expect(
      apiRequest('/dfds/1', {
        method: 'PATCH',
        body: {},
        fetchImpl: () =>
          Promise.resolve(jsonResponse({ code: 'DEPENDENCY_UNAVAILABLE' }, { status: 503 })),
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(await screen.findByText('Serviço temporariamente indisponível')).toBeTruthy();
    expect(screen.queryByText('Sua sessão expirou')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    await waitFor(() => {
      expect(screen.queryByText('Serviço temporariamente indisponível')).toBeNull();
    });
    expect(requestUrl(fetchMock.mock.calls.at(-1)?.[0] ?? '')).toBe('/api/auth/session');
  });

  it('falha de rede e sondagem do contador não reiniciam a ociosidade', async () => {
    stubSessionApi(() => activeSession());
    renderWatcher();
    await apiRequest('/notifications/unread-count', {
      fetchImpl: () => Promise.resolve(jsonResponse({ data: { count: 1 } })),
    });
    await expect(
      apiRequest('/processes', { fetchImpl: () => Promise.reject(new TypeError('rede')) }),
    ).rejects.toMatchObject({ status: 503 });
    act(() => {
      vi.setSystemTime(T('12:29:00'));
    });
    await screen.findByRole('dialog', { name: 'Você continua aí?' });
  });
});

describe('LogoutGuard (RN-IAM-31)', () => {
  function LogoutButton() {
    const { requestLogout } = useLogout();
    return (
      <button type="button" onClick={requestLogout}>
        Sair
      </button>
    );
  }

  it('com rascunho não sincronizado, confirma antes; ao sair apaga os rascunhos e segue ao logoutUrl', async () => {
    const fetchMock = stubSessionApi(() =>
      jsonResponse({ data: { logoutUrl: 'https://idp.example/end-session' } }),
    );
    const navigate = vi.fn();
    const drafts = new LocalDrafts(new MemoryDraftBackend());
    await drafts.save({
      userId: SESSION.user.id,
      tenantId: SESSION.activeTenant.id,
      target: 'dfd:1:JUSTIFICATION',
      content: 'trecho',
      baseRevision: 1,
    });
    renderWithShell(
      <LogoutGuard drafts={drafts} onNavigate={navigate}>
        <LogoutButton />
      </LogoutGuard>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Sair' }));
    const confirm = await screen.findByRole('dialog', { name: 'Sair com alterações não salvas?' });
    expect(confirm).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Continuar aqui' }));
    expect(navigate).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Sair' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Sair mesmo assim' }));
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith('https://idp.example/end-session');
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/auth/logout');
    expect(new Headers(init?.headers).get('X-CF-Request')).toBe('1');
    expect(await drafts.hasUnsynced(SESSION.user.id)).toBe(false);
    await waitFor(() => {
      expect(channelMessages).toMatchObject([{ type: 'logout' }]);
    });
  });

  it('sem rascunho sai direto; falha de rede avisa e mantém a sessão', async () => {
    const navigate = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('rede'))),
    );
    renderWithShell(
      <LogoutGuard drafts={new LocalDrafts(new MemoryDraftBackend())} onNavigate={navigate}>
        <LogoutButton />
      </LogoutGuard>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Sair' }));
    await waitFor(() => {
      expect(fetch).toHaveBeenCalled();
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('useLogout fora do LogoutGuard é erro de programação', () => {
    function Orphan() {
      useLogout();
      return null;
    }
    expect(() => render(<Orphan />)).toThrow('useLogout fora do LogoutGuard.');
  });
});
