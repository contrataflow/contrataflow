// @vitest-environment jsdom
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_TYPES,
  defaultChannelEnabled,
  isNotificationChannelEditable,
} from '@contrataflow/types';
import type { NotificationChannel, NotificationType } from '@contrataflow/types';
import { Toaster, clearToasts } from '@contrataflow/ui';
import type { NotificationPreferenceDto } from '@contrataflow/validation';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { jsonResponse, problem, renderWithShell, requestUrl } from '@test/support/render';

import {
  NOTIFICATION_AREAS,
  NOTIFICATION_TYPES_BY_AREA,
  buildChanges,
  resetType,
  toPreferencesDraft,
  toggleCell,
} from './notification-preferences-model';
import { ProfileView } from './profile-view';

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
  usePathname: () => '/perfil',
}));

const LINKS = { password: null, mfa: null };

type Saved = Map<string, boolean>;

const keyOf = (type: string, channel: string) => `${type}:${channel}`;

/** O que ME-05 devolve: o salvo, ou o padrão do registro. */
function snapshot(saved: Saved): NotificationPreferenceDto[] {
  return NOTIFICATION_TYPES.flatMap((notificationType) =>
    NOTIFICATION_CHANNELS.map((channel) => {
      const editable = isNotificationChannelEditable(notificationType, channel);
      return {
        notificationType,
        channel,
        editable,
        enabled: editable
          ? (saved.get(keyOf(notificationType, channel)) ??
            defaultChannelEnabled(notificationType, channel))
          : true,
      };
    }),
  );
}

interface Change {
  notificationType: NotificationType;
  channel: NotificationChannel;
  enabled: boolean | null;
}

function validationProblem(code: string): Response {
  return new Response(
    JSON.stringify({
      type: 'https://docs.contrataflow.com.br/errors/validation_error',
      title: 'VALIDATION_ERROR',
      status: 422,
      detail: 'VALIDATION_ERROR',
      instance: '/api/v1/me/notification-preferences',
      code: 'VALIDATION_ERROR',
      correlationId: 'c-test-1',
      errors: [{ field: 'preferences[0].enabled', code, message: 'x' }],
      violations: [],
    }),
    { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

function mockApi(
  options: { emailEnabled?: boolean; saved?: Saved; putResponse?: () => Response } = {},
) {
  const saved: Saved = options.saved ?? new Map<string, boolean>();
  let failGet = false;
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    if (url === '/api/v1/me' && method === 'GET') {
      return Promise.resolve(
        jsonResponse({
          data: {
            id: '0192a000-0000-7000-8000-0000000000a1',
            name: 'Elisa Prado',
            socialName: null,
            email: 'elisa@prefeitura-a.test',
            phone: null,
            preferences: { density: 'comfortable', theme: 'system' },
            membership: { jobTitle: null, departments: [] },
            mfaVerified: false,
            version: 1,
          },
        }),
      );
    }
    if (url === '/api/v1/me/notification-preferences') {
      if (method === 'GET') {
        if (failGet) return Promise.resolve(problem(503, 'DEPENDENCY_UNAVAILABLE'));
        return Promise.resolve(
          jsonResponse({
            data: snapshot(saved),
            meta: { emailEnabled: options.emailEnabled ?? true },
          }),
        );
      }
      if (options.putResponse) return Promise.resolve(options.putResponse());
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        preferences: Change[];
      };
      for (const item of body.preferences) {
        if (item.enabled === null) saved.delete(keyOf(item.notificationType, item.channel));
        else saved.set(keyOf(item.notificationType, item.channel), item.enabled);
      }
      return Promise.resolve(
        jsonResponse({
          data: snapshot(saved),
          meta: { emailEnabled: options.emailEnabled ?? true },
        }),
      );
    }
    return Promise.resolve(problem(404, 'NOT_FOUND'));
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    fetchMock,
    saved,
    failNextGets: () => {
      failGet = true;
    },
    recover: () => {
      failGet = false;
    },
    puts: () =>
      fetchMock.mock.calls
        .filter(([, init]) => init?.method === 'PUT')
        .map(
          ([, init]) =>
            JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
              preferences: Change[];
            },
        ),
  };
}

function renderTab() {
  return renderWithShell(
    <>
      <ProfileView links={LINKS} initialTab="notifications" />
      <Toaster label="Notificações" closeLabel="Fechar" />
    </>,
  );
}

const switchOf = (type: string, channel: 'No sistema' | 'Por e-mail') => {
  const group = screen.getByRole('group', { name: type });
  return within(group).getByRole('switch', { name: channel });
};
const saveButton = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Salvar' });

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

describe('notification-preferences-model (RN-NTF-22/23/25)', () => {
  it('toda notificação pertence a exatamente uma área', () => {
    const listed = NOTIFICATION_AREAS.flatMap((area) => NOTIFICATION_TYPES_BY_AREA[area]);
    expect([...listed].sort()).toEqual([...NOTIFICATION_TYPES].sort());
  });

  it('envia só as combinações alteradas; desfazer a mudança zera a lista', () => {
    const server = snapshot(new Map());
    const draft = toPreferencesDraft(server);
    expect(buildChanges(draft, server)).toEqual([]);
    const changed = toggleCell(draft, 'PROCESS_RECEIVED', 'EMAIL', false);
    expect(buildChanges(changed, server)).toEqual([
      { notificationType: 'PROCESS_RECEIVED', channel: 'EMAIL', enabled: false },
    ]);
    expect(buildChanges(toggleCell(changed, 'PROCESS_RECEIVED', 'EMAIL', true), server)).toEqual(
      [],
    );
  });

  it('canal obrigatório não muda no rascunho', () => {
    const server = snapshot(new Map());
    const draft = toPreferencesDraft(server);
    expect(toggleCell(draft, 'APPROVAL_REQUESTED', 'IN_APP', false)).toBe(draft);
    expect(buildChanges(resetType(draft, 'APPROVAL_REQUESTED'), server)).toEqual([
      { notificationType: 'APPROVAL_REQUESTED', channel: 'EMAIL', enabled: null },
    ]);
  });

  it('"usar padrão" volta aos valores do registro e manda enabled nulo (FA-01)', () => {
    const server = snapshot(new Map([[keyOf('COMMENT_REPLY', 'EMAIL'), true]]));
    const reset = resetType(toPreferencesDraft(server), 'COMMENT_REPLY');
    expect(buildChanges(reset, server)).toEqual([
      { notificationType: 'COMMENT_REPLY', channel: 'IN_APP', enabled: null },
      { notificationType: 'COMMENT_REPLY', channel: 'EMAIL', enabled: null },
    ]);
    // Mexer à mão depois cancela o "usar padrão" daquela célula.
    expect(
      buildChanges(toggleCell(reset, 'COMMENT_REPLY', 'EMAIL', true), server).map((c) => c.channel),
    ).toEqual(['IN_APP']);
  });
});

describe('SCR-039 — aba Notificações (US-113)', () => {
  it('[Carga] agrupa por área, reflete o padrão do registro e trava o in-app obrigatório', async () => {
    mockApi();
    renderTab();
    expect(
      await screen.findByRole('heading', { name: 'Preferências de notificação' }),
    ).toBeTruthy();
    await screen.findByRole('heading', { name: 'Processos' });
    for (const area of ['Processos', 'Aprovações', 'Colaboração', 'Prazos', 'Segurança']) {
      expect(screen.getByRole('heading', { name: area })).toBeTruthy();
    }
    // Padrões do registro: e-mail ligado em PROCESS_RECEIVED e desligado em COMMENT_REPLY.
    expect(
      switchOf('Processo recebido na sua unidade', 'Por e-mail').getAttribute('aria-checked'),
    ).toBe('true');
    expect(switchOf('Resposta ao seu comentário', 'Por e-mail').getAttribute('aria-checked')).toBe(
      'false',
    );
    const locked = switchOf('Aprovação solicitada a você', 'No sistema') as HTMLButtonElement;
    expect(locked.getAttribute('aria-checked')).toBe('true');
    expect(locked.disabled).toBe(true);
    expect(screen.getAllByText('Este aviso não pode ser desligado.')).toHaveLength(3);
    expect(saveButton().disabled).toBe(true);
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('[Sucesso] desliga o e-mail de um tipo, salva só a combinação alterada e avisa', async () => {
    const api = mockApi();
    renderTab();
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Processos' });
    await user.click(switchOf('Processo recebido na sua unidade', 'Por e-mail'));
    expect(
      switchOf('Processo recebido na sua unidade', 'Por e-mail').getAttribute('aria-checked'),
    ).toBe('false');
    await user.click(saveButton());

    expect(await screen.findByText('Preferências salvas')).toBeTruthy();
    expect(api.puts()).toEqual([
      {
        preferences: [{ notificationType: 'PROCESS_RECEIVED', channel: 'EMAIL', enabled: false }],
      },
    ]);
    // Mantém o novo estado e o botão volta a desabilitado (nada pendente).
    await waitFor(() => {
      expect(saveButton().disabled).toBe(true);
    });
    expect(
      switchOf('Processo recebido na sua unidade', 'Por e-mail').getAttribute('aria-checked'),
    ).toBe('false');
  });

  it('[FA-01] "Usar padrão" apaga a preferência salva do tipo', async () => {
    const api = mockApi({ saved: new Map([[keyOf('COMMENT_REPLY', 'EMAIL'), true]]) });
    renderTab();
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Colaboração' });
    expect(switchOf('Resposta ao seu comentário', 'Por e-mail').getAttribute('aria-checked')).toBe(
      'true',
    );
    await user.click(
      screen.getByRole('button', { name: 'Usar padrão: Resposta ao seu comentário' }),
    );
    expect(switchOf('Resposta ao seu comentário', 'Por e-mail').getAttribute('aria-checked')).toBe(
      'false',
    );
    await user.click(saveButton());
    await screen.findByText('Preferências salvas');
    expect(api.puts()[0]?.preferences).toEqual([
      { notificationType: 'COMMENT_REPLY', channel: 'IN_APP', enabled: null },
      { notificationType: 'COMMENT_REPLY', channel: 'EMAIL', enabled: null },
    ]);
    expect(api.saved.has(keyOf('COMMENT_REPLY', 'EMAIL'))).toBe(false);
  });

  it('[RN-NTF-24] e-mail desligado no órgão: coluna desabilitada com a explicação', async () => {
    mockApi({ emailEnabled: false });
    renderTab();
    await screen.findByRole('heading', { name: 'Processos' });
    const email = switchOf('Processo recebido na sua unidade', 'Por e-mail') as HTMLButtonElement;
    expect(email.disabled).toBe(true);
    expect(screen.getAllByText('E-mails estão desligados para este órgão.').length).toBeGreaterThan(
      0,
    );
    // O in-app segue editável.
    expect(
      (switchOf('Processo recebido na sua unidade', 'No sistema') as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('[Falha de integração] erro ao carregar mostra "Tentar novamente" e recarrega', async () => {
    const api = mockApi();
    api.failNextGets();
    renderTab();
    const user = userEvent.setup();
    expect(
      await screen.findByText('Não foi possível carregar as preferências de notificação.'),
    ).toBeTruthy();
    api.recover();
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByRole('heading', { name: 'Processos' })).toBeTruthy();
  });

  it('[Falha de banco] 503 ao salvar mantém as alterações locais e permite tentar de novo', async () => {
    let attempts = 0;
    const api = mockApi({
      putResponse: () => {
        attempts += 1;
        return attempts === 1 ? problem(503, 'DEPENDENCY_UNAVAILABLE') : jsonResponse({ data: [] });
      },
    });
    renderTab();
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Processos' });
    await user.click(switchOf('Resposta ao seu comentário', 'Por e-mail'));
    await user.click(saveButton());
    expect(await screen.findByText('Não foi possível salvar agora. Tente novamente.')).toBeTruthy();
    expect(switchOf('Resposta ao seu comentário', 'Por e-mail').getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(saveButton().disabled).toBe(false);
    expect(api.puts()).toHaveLength(1);
  });

  it('[Permissão] NOT_ALLOWED da API reverte os interruptores e explica', async () => {
    mockApi({ putResponse: () => validationProblem('NOT_ALLOWED') });
    renderTab();
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Processos' });
    await user.click(switchOf('Resposta ao seu comentário', 'Por e-mail'));
    await user.click(saveButton());
    expect(await screen.findAllByText('Este aviso não pode ser desligado.')).not.toHaveLength(0);
    await waitFor(() => {
      expect(
        switchOf('Resposta ao seu comentário', 'Por e-mail').getAttribute('aria-checked'),
      ).toBe('false');
    });
  });

  it('as seções: "Dados" é a inicial sem ?aba= e a navegação troca de seção', async () => {
    mockApi();
    renderWithShell(<ProfileView links={LINKS} />);
    const user = userEvent.setup();
    const nav = await screen.findByRole('navigation', { name: 'Seções do perfil' });
    const data = within(nav).getByRole('button', { name: 'Dados' });
    expect(data.getAttribute('aria-current')).toBe('true');
    expect(screen.queryByRole('heading', { name: 'Preferências de notificação' })).toBeNull();
    data.focus();
    await user.tab();
    await user.tab();
    const notifications = within(nav).getByRole('button', { name: 'Notificações' });
    expect(document.activeElement).toBe(notifications);
    await user.keyboard('{Enter}');
    expect(notifications.getAttribute('aria-current')).toBe('true');
    expect(
      await screen.findByRole('heading', { name: 'Preferências de notificação' }),
    ).toBeTruthy();
  });
});
