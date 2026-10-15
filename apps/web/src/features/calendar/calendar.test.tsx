// @vitest-environment jsdom
import type { HolidayDto } from '@contrataflow/validation';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { CalendarView } from './calendar-view';

// A suíte completa roda em paralelo com as demais; o padrão de 1 s é curto para a primeira renderização.
configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

const YEAR = new Date().getFullYear();

let sequence = 0;
function holiday(overrides: Partial<HolidayDto>): HolidayDto {
  sequence += 1;
  return {
    id: `0192a000-0000-7000-8000-${String(sequence).padStart(12, '0')}`,
    date: `${String(YEAR)}-01-01`,
    name: `Feriado ${String(sequence)}`,
    scope: 'NATIONAL',
    isRecurring: true,
    isActive: true,
    isSystem: true,
    version: 1,
    ...overrides,
  };
}

const NATAL = holiday({ date: `${String(YEAR)}-12-25`, name: 'Natal', version: 3 });
const CARNAVAL = holiday({
  date: `${String(YEAR)}-02-17`,
  name: 'Carnaval (terça-feira)',
  scope: 'OPTIONAL',
});
const ANIVERSARIO = holiday({
  date: `${String(YEAR)}-10-12`,
  name: 'Aniversário da cidade',
  scope: 'MUNICIPAL',
  isRecurring: false,
  isSystem: false,
  version: 2,
});
const INATIVO = holiday({
  date: `${String(YEAR)}-11-02`,
  name: 'Finados',
  isActive: false,
});
const HOLIDAYS = [CARNAVAL, ANIVERSARIO, INATIVO, NATAL];

function problemResponse(
  status: number,
  code: string,
  detail: string,
  errors: { field: string; code: string; message: string }[] = [],
): Response {
  return new Response(
    JSON.stringify({
      type: `https://docs.contrataflow.com.br/errors/${code.toLowerCase()}`,
      title: code,
      status,
      detail,
      instance: '/api/v1/holidays',
      code,
      correlationId: 'c-test',
      errors,
      violations: [],
    }),
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function mockApi(
  routes: { list?: Handler; post?: Handler; patch?: Handler; remove?: Handler } = {},
  permissions: readonly string[] = ['CALENDAR_MANAGE'],
) {
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    if (url.startsWith('/api/v1/me/permissions')) {
      return Promise.resolve(
        jsonResponse({
          data: { permissions: permissions.map((code) => ({ code, scopes: [] })) },
        }),
      );
    }
    const fail = () => problemResponse(500, 'INTERNAL_ERROR', 'x');
    if (method === 'GET' && url.startsWith('/api/v1/holidays')) {
      const handler =
        routes.list ??
        (() =>
          jsonResponse({
            data: HOLIDAYS,
            meta: { page: 1, pageSize: 200, totalItems: HOLIDAYS.length, totalPages: 1 },
          }));
      return Promise.resolve(handler(url, init));
    }
    if (method === 'POST' && url === '/api/v1/holidays') {
      return Promise.resolve((routes.post ?? fail)(url, init));
    }
    if (method === 'PATCH') return Promise.resolve((routes.patch ?? fail)(url, init));
    if (method === 'DELETE') {
      return Promise.resolve((routes.remove ?? fail)(url, init));
    }
    return Promise.resolve(problemResponse(404, 'NOT_FOUND', 'x'));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const bodyOf = (init?: RequestInit): Record<string, unknown> =>
  JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;

const callsTo = (api: ReturnType<typeof mockApi>, method: string) =>
  api.mock.calls.filter(([, init]) => (init?.method ?? 'GET') === method);

function callOf(api: ReturnType<typeof mockApi>, method: string, index = 0) {
  const call = callsTo(api, method)[index];
  if (!call) throw new Error(`sem chamada ${method} #${String(index)}`);
  return {
    url: requestUrl(call[0]),
    init: call[1],
    headers: new Headers(call[1]?.headers),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[Sucesso] SCR-110 · lista', () => {
  it('feriados do ano por data, com escopo, selos "Padrão do sistema"/"Recorrente" e situação; sem violações de a11y', async () => {
    const api = mockApi();
    renderWithShell(<CalendarView />);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Calendário de dias úteis' }),
    ).toBeTruthy();
    const table = await screen.findByRole('table', { name: `Feriados de ${String(YEAR)}` });
    expect(
      api.mock.calls.some(([url]) =>
        requestUrl(url).startsWith(`/api/v1/holidays?year=${String(YEAR)}&`),
      ),
    ).toBe(true);

    const rows = within(table).getAllByRole('row');
    expect(rows.map((row) => within(row).queryByRole('rowheader')?.textContent).slice(1)).toEqual([
      'Carnaval (terça-feira)',
      'Aniversário da cidade',
      'Finados',
      'Natal',
    ]);
    const natal = within(table).getByRole('row', { name: /Natal/ });
    expect(within(natal).getByText('25/12/' + String(YEAR))).toBeTruthy();
    expect(within(natal).getByText('Nacional')).toBeTruthy();
    expect(within(natal).getByText('Padrão do sistema')).toBeTruthy();
    expect(within(natal).getByText('Recorrente')).toBeTruthy();
    const carnaval = within(table).getByRole('row', { name: /Carnaval/ });
    expect(within(carnaval).getByText('Ponto facultativo')).toBeTruthy();
    const proprio = within(table).getByRole('row', { name: /Aniversário da cidade/ });
    expect(within(proprio).getByText('Municipal')).toBeTruthy();
    expect(within(proprio).queryByText('Padrão do sistema')).toBeNull();
    expect(within(proprio).queryByText('Recorrente')).toBeNull();
    expect(
      within(within(table).getByRole('row', { name: /Finados/ })).getByText('Inativo'),
    ).toBeTruthy();
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('FA-01: "Excluir" só aparece em feriado que não é de sistema', async () => {
    mockApi();
    renderWithShell(<CalendarView />);
    await screen.findByRole('table');
    expect(
      await screen.findByRole('button', { name: 'Excluir Aniversário da cidade' }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Excluir Natal' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Excluir Carnaval (terça-feira)' })).toBeNull();
    expect(screen.getAllByRole('button', { name: /^Excluir / })).toHaveLength(1);
  });

  it('trocar o ano relê a lista desse ano', async () => {
    const api = mockApi();
    renderWithShell(<CalendarView />);
    await screen.findByRole('table');
    await userEvent.selectOptions(screen.getByLabelText('Ano'), String(YEAR + 1));
    await waitFor(() => {
      expect(
        api.mock.calls.some(([url]) =>
          requestUrl(url).startsWith(`/api/v1/holidays?year=${String(YEAR + 1)}&`),
        ),
      ).toBe(true);
    });
  });

  it('carregando, vazio e erro com "Tentar novamente"', async () => {
    mockApi({ list: () => new Promise<Response>(() => undefined) });
    const first = renderWithShell(<CalendarView />);
    expect((await screen.findByText('Carregando os feriados…')).textContent).toBeTruthy();
    first.unmount();

    mockApi({ list: () => jsonResponse({ data: [], meta: { page: 1 } }) });
    const second = renderWithShell(<CalendarView />);
    expect(await screen.findByText('Nenhum feriado cadastrado para este ano')).toBeTruthy();
    second.unmount();

    let calls = 0;
    mockApi({
      list: () => {
        calls += 1;
        return calls === 1
          ? problemResponse(429, 'RATE_LIMITED', 'Muitas tentativas.')
          : jsonResponse({ data: HOLIDAYS, meta: { page: 1 } });
      },
    });
    renderWithShell(<CalendarView />);
    expect(await screen.findByText('Não foi possível carregar o calendário.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByRole('table')).toBeTruthy();
  });
});

describe('[Permissão] ações de edição', () => {
  it('403 na leitura: mensagem de permissão no lugar da lista', async () => {
    mockApi({ list: () => problemResponse(403, 'PERMISSION_DENIED', 'Você não tem permissão.') });
    renderWithShell(<CalendarView />);
    expect(
      await screen.findByText('Você não tem permissão para gerenciar o calendário.'),
    ).toBeTruthy();
  });

  it('sem CALENDAR_MANAGE a lista fica visível e as ações de edição, ocultas', async () => {
    mockApi({}, []);
    renderWithShell(<CalendarView />);
    expect(await screen.findByRole('table')).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Novo feriado' })).toBeNull();
    });
    expect(screen.queryByRole('button', { name: /Editar/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Excluir/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Desativar/ })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Ações' })).toBeNull();
  });
});

describe('[Sucesso] cadastrar, editar, desativar e excluir', () => {
  it('cadastrar feriado municipal: corpo de CAL-02 e lista relida', async () => {
    const created = holiday({
      date: `${String(YEAR)}-10-12`,
      name: 'Aniversário da cidade',
      scope: 'MUNICIPAL',
      isSystem: false,
      isRecurring: false,
    });
    const api = mockApi({
      post: () => jsonResponse({ data: created }, { status: 201, headers: { ETag: '"1"' } }),
    });
    renderWithShell(<CalendarView />);
    await userEvent.click(await screen.findByRole('button', { name: 'Novo feriado' }));
    const dialog = await screen.findByRole('dialog', { name: 'Novo feriado' });

    await userEvent.type(within(dialog).getByLabelText('Data *'), `${String(YEAR)}-10-12`);
    await userEvent.type(within(dialog).getByLabelText('Nome *'), 'Aniversário da cidade');
    await userEvent.selectOptions(within(dialog).getByLabelText('Escopo *'), 'MUNICIPAL');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    await waitFor(() => {
      expect(callsTo(api, 'POST')).toHaveLength(1);
    });
    const post = callOf(api, 'POST');
    expect(post.url).toBe('/api/v1/holidays');
    expect(bodyOf(post.init)).toEqual({
      date: `${String(YEAR)}-10-12`,
      name: 'Aniversário da cidade',
      scope: 'MUNICIPAL',
      isRecurring: false,
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expect(
        api.mock.calls.filter(([url]) => requestUrl(url).startsWith('/api/v1/holidays?')).length,
      ).toBeGreaterThan(1);
    });
  });

  it('validação inline: data e escopo ausentes e data inexistente; nada é enviado', async () => {
    const api = mockApi();
    renderWithShell(<CalendarView />);
    await userEvent.click(await screen.findByRole('button', { name: 'Novo feriado' }));
    const dialog = await screen.findByRole('dialog', { name: 'Novo feriado' });

    await userEvent.type(within(dialog).getByLabelText('Nome *'), 'Sem data');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    expect(await within(dialog).findByText('Informe a data.')).toBeTruthy();
    expect(within(dialog).getByText('Informe o escopo.')).toBeTruthy();
    expect(callsTo(api, 'POST')).toHaveLength(0);
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('409 CONFLICT: mensagem de duplicidade no formulário, que permanece aberto', async () => {
    mockApi({
      post: () => problemResponse(409, 'CONFLICT', 'Já existe um feriado com esta data e nome.'),
    });
    renderWithShell(<CalendarView />);
    await userEvent.click(await screen.findByRole('button', { name: 'Novo feriado' }));
    const dialog = await screen.findByRole('dialog', { name: 'Novo feriado' });
    await userEvent.type(within(dialog).getByLabelText('Data *'), `${String(YEAR)}-10-12`);
    await userEvent.type(within(dialog).getByLabelText('Nome *'), 'Aniversário da cidade');
    await userEvent.selectOptions(within(dialog).getByLabelText('Escopo *'), 'MUNICIPAL');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    expect(
      await within(dialog).findByText('Já existe um feriado com esta data e nome.'),
    ).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Novo feriado' })).toBeTruthy();
  });

  it('editar: data bloqueada, envia só o que mudou com If-Match da versão lida', async () => {
    const api = mockApi({
      patch: () =>
        jsonResponse({ data: { ...ANIVERSARIO, isRecurring: true, version: 3 } }, { status: 200 }),
    });
    renderWithShell(<CalendarView />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Editar Aniversário da cidade' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Editar Aniversário da cidade' });

    const date = within(dialog).getByLabelText<HTMLInputElement>('Data *');
    expect(date.readOnly).toBe(true);
    expect(date.value).toBe(`${String(YEAR)}-10-12`);
    await userEvent.click(within(dialog).getByLabelText('Repetir todos os anos'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    await waitFor(() => {
      expect(callsTo(api, 'PATCH')).toHaveLength(1);
    });
    const patch = callOf(api, 'PATCH');
    expect(patch.url).toBe(`/api/v1/holidays/${ANIVERSARIO.id}`);
    expect(patch.headers.get('If-Match')).toBe('"2"');
    expect(bodyOf(patch.init)).toEqual({ isRecurring: true });
  });

  it('feriado de sistema: nome bloqueado com a explicação', async () => {
    mockApi();
    renderWithShell(<CalendarView />);
    await userEvent.click(await screen.findByRole('button', { name: 'Editar Natal' }));
    const dialog = await screen.findByRole('dialog', { name: 'Editar Natal' });
    expect(within(dialog).getByLabelText<HTMLInputElement>('Nome *').readOnly).toBe(true);
    expect(
      within(dialog).getByText('O nome de um feriado padrão do sistema não pode ser alterado.'),
    ).toBeTruthy();
    expect(within(dialog).getByLabelText('Feriado ativo')).toBeTruthy();
  });

  it('desativar feriado de sistema (aviso sem efeito retroativo) e ativar outro; ambos com If-Match', async () => {
    const api = mockApi({
      patch: () => jsonResponse({ data: { ...NATAL, isActive: false, version: 4 } }),
    });
    renderWithShell(<CalendarView />);
    await userEvent.click(await screen.findByRole('button', { name: 'Desativar Natal' }));
    const dialog = await screen.findByRole('dialog', { name: 'Desativar Natal?' });
    expect(
      within(dialog).getByText(
        'Este dia volta a contar como dia útil nos novos cálculos de prazo. Prazos já gravados não são recalculados.',
      ),
    ).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Desativar' }));
    await waitFor(() => {
      expect(callsTo(api, 'PATCH')).toHaveLength(1);
    });
    expect(callOf(api, 'PATCH').url).toBe(`/api/v1/holidays/${NATAL.id}`);
    expect(callOf(api, 'PATCH').headers.get('If-Match')).toBe('"3"');
    expect(bodyOf(callOf(api, 'PATCH').init)).toEqual({ isActive: false });

    await userEvent.click(screen.getByRole('button', { name: 'Ativar Finados' }));
    await waitFor(() => {
      expect(callsTo(api, 'PATCH')).toHaveLength(2);
    });
    expect(bodyOf(callOf(api, 'PATCH', 1).init)).toEqual({ isActive: true });
  });

  it('excluir feriado do administrador: confirmação e DELETE com If-Match', async () => {
    const api = mockApi({ remove: () => new Response(null, { status: 204 }) });
    renderWithShell(<CalendarView />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Excluir Aniversário da cidade' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Excluir Aniversário da cidade?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Excluir' }));

    await waitFor(() => {
      expect(callsTo(api, 'DELETE')).toHaveLength(1);
    });
    const del = callOf(api, 'DELETE');
    expect(del.url).toBe(`/api/v1/holidays/${ANIVERSARIO.id}`);
    expect(del.headers.get('If-Match')).toBe('"2"');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });
});

describe('[Concorrência] e [Falha]', () => {
  it('412 ao desativar: aviso de conflito e a lista é relida', async () => {
    const api = mockApi({
      patch: () => problemResponse(412, 'VERSION_CONFLICT', 'Versão desatualizada.'),
    });
    renderWithShell(<CalendarView />);
    await userEvent.click(await screen.findByRole('button', { name: 'Desativar Natal' }));
    await userEvent.click(
      within(await screen.findByRole('dialog', { name: 'Desativar Natal?' })).getByRole('button', {
        name: 'Desativar',
      }),
    );

    expect(
      await screen.findByText(
        'Este feriado foi alterado por outra pessoa. Recarregue o calendário.',
      ),
    ).toBeTruthy();
    await waitFor(() => {
      expect(
        api.mock.calls.filter(([url]) => requestUrl(url).startsWith('/api/v1/holidays?')).length,
      ).toBeGreaterThan(1);
    });
  });

  it('503 ao excluir: mensagem de indisponibilidade com "Tentar novamente"', async () => {
    mockApi({
      remove: () => problemResponse(503, 'DEPENDENCY_UNAVAILABLE', 'fora do ar'),
    });
    renderWithShell(<CalendarView />);
    await userEvent.click(
      await screen.findByRole('button', { name: 'Excluir Aniversário da cidade' }),
    );
    await userEvent.click(
      within(
        await screen.findByRole('dialog', { name: 'Excluir Aniversário da cidade?' }),
      ).getByRole('button', { name: 'Excluir' }),
    );
    expect(
      await screen.findByText('Não foi possível salvar agora. Tente novamente em instantes.'),
    ).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Tentar novamente' }).length).toBeGreaterThan(0);
  });
});
