// @vitest-environment jsdom
import type { HolidayDto } from '@contrataflow/validation';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { CalendarView } from './calendar-view';

// A suíte completa roda em paralelo com as demais; o padrão de 1 s é curto para a primeira renderização.
configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

// Só o relógio (`Date`) é fixo: 10/06/2026 — os mostradores dependem do ano exibido.
vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-06-10T15:00:00Z') });
const YEAR = 2026;

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

/** Datas úteis do CAL-05: segunda a sexta fora de `nonBusiness`. */
function businessDatesOf(year: number, nonBusiness: readonly string[]): string[] {
  const dates: string[] = [];
  for (let day = new Date(Date.UTC(year, 0, 1)); day.getUTCFullYear() === year;) {
    const iso = day.toISOString().slice(0, 10);
    const weekday = day.getUTCDay();
    if (weekday !== 0 && weekday !== 6 && !nonBusiness.includes(iso)) dates.push(iso);
    day = new Date(day.getTime() + 86_400_000);
  }
  return dates;
}

function mockApi(
  routes: {
    list?: Handler;
    businessDays?: Handler;
    post?: Handler;
    patch?: Handler;
    remove?: Handler;
  } = {},
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
    if (method === 'GET' && url.startsWith('/api/v1/calendar/business-days')) {
      return Promise.resolve(
        (routes.businessDays ?? (() => problemResponse(404, 'NOT_FOUND', 'x')))(url, init),
      );
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

afterAll(() => {
  vi.useRealTimers();
});

/** Espera a lista lateral "Feriados de {ano}" (a tela carregada). */
const loaded = () => screen.findByRole('region', { name: `Feriados de ${String(YEAR)}` });

/** Item da lista lateral pelo nome do feriado. */
function itemOf(list: HTMLElement, name: string): HTMLElement {
  const item = within(list)
    .getAllByRole('listitem')
    .find((candidate) => within(candidate).queryByText(name) !== null);
  if (!item) throw new Error(`feriado ${name} não está na lista`);
  return item;
}

/** Escolhe uma opção no `Select` do kit (Radix): abre o gatilho e clica na opção. */
async function choose(trigger: HTMLElement, option: string) {
  await userEvent.click(trigger);
  await userEvent.click(await screen.findByRole('option', { name: option }));
}

/** Ação da linha no menu ⋯ (prd-5 · regra 3). */
async function rowAction(name: string, action: string) {
  await userEvent.click(await screen.findByRole('button', { name: `Ações de ${name}` }));
  await userEvent.click(await screen.findByRole('menuitem', { name: action }));
}

/** Escolhe o dia 15 do mês corrente no `DatePicker` do kit; devolve a data `aaaa-MM-dd`. */
async function pickFifteenth(dialog: HTMLElement): Promise<string> {
  await userEvent.click(within(dialog).getByRole('button', { name: 'Data *' }));
  const calendar = await screen.findByRole('dialog', { name: 'Escolher data' });
  const [day] = within(calendar).getAllByRole('button', { name: /, 15 de / });
  if (!day) throw new Error('dia 15 não encontrado no calendário');
  await userEvent.click(day);
  const month = String(new Date().getMonth() + 1).padStart(2, '0');
  return `${String(YEAR)}-${month}-15`;
}

describe('[Sucesso] SCR-110 · lista', () => {
  it('lista lateral do ano agrupada por mês, com tipo, efeito no prazo, selos e situação; sem violações de a11y', async () => {
    const api = mockApi();
    renderWithShell(<CalendarView />);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Calendário de dias úteis' }),
    ).toBeTruthy();
    const list = await loaded();
    expect(
      api.mock.calls.some(([url]) =>
        requestUrl(url).startsWith(`/api/v1/holidays?year=${String(YEAR)}&`),
      ),
    ).toBe(true);

    expect(
      within(list)
        .getAllByRole('heading', { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(['fevereiro', 'outubro', 'novembro', 'dezembro']);
    const natal = itemOf(list, 'Natal');
    expect(within(natal).getByText('25/12 · sexta-feira')).toBeTruthy();
    expect(within(natal).getByText('Feriado nacional · não conta como dia útil')).toBeTruthy();
    expect(within(natal).getByText('Padrão do sistema')).toBeTruthy();
    expect(within(natal).getByText('Recorrente')).toBeTruthy();
    const carnaval = itemOf(list, 'Carnaval (terça-feira)');
    expect(within(carnaval).getByText('Ponto facultativo · conta como dia útil')).toBeTruthy();
    const proprio = itemOf(list, 'Aniversário da cidade');
    expect(within(proprio).getByText('Feriado municipal · não conta como dia útil')).toBeTruthy();
    expect(within(proprio).queryByText('Padrão do sistema')).toBeNull();
    expect(within(proprio).queryByText('Recorrente')).toBeNull();
    const finados = itemOf(list, 'Finados');
    expect(within(finados).getByText('Inativo')).toBeTruthy();
    expect(within(finados).getByText('Feriado nacional · conta como dia útil')).toBeTruthy();
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('mostradores do ano (sem o CAL-05, o padrão: facultativo conta como dia útil), legenda e doze meses', async () => {
    mockApi();
    renderWithShell(<CalendarView />);
    await loaded();

    const stats = screen.getByRole('region', { name: `Resumo de ${String(YEAR)}` });
    // 2026: 261 dias de segunda a sexta; 12/10 (seg.) e 25/12 (sex.) sem expediente.
    expect(stats.textContent).toContain('Dias úteis 259');
    expect(stats.textContent).toContain('Sem expediente 2');
    expect(stats.textContent).toContain('Feriados da instituição 1');
    expect(stats.textContent).toContain('Pontos facultativos 1');
    expect(within(stats).getByText('contam como dia útil nos prazos')).toBeTruthy();

    const legend = screen.getByRole('region', { name: 'Legenda' });
    expect(
      within(legend)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Feriado nacional1',
      'Feriado estadual0',
      'Feriado municipal1',
      'Ponto facultativo1',
      'Sem expediente',
      'Facultativo que conta como dia útil',
      'Sábado e domingo',
      'Hoje',
    ]);

    const months = screen.getByRole('region', { name: `${String(YEAR)}, mês a mês` });
    expect(within(months).getAllByRole('table')).toHaveLength(12);
    const december = within(months).getByRole('table', { name: 'dezembro' });
    expect(
      within(december)
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual([
      'Ssegunda-feira',
      'Tterça-feira',
      'Qquarta-feira',
      'Qquinta-feira',
      'Ssexta-feira',
      'Ssábado',
      'Ddomingo',
    ]);
    expect(within(months).getByText('dezembro').parentElement?.textContent).toContain('1 data');
    expect(
      await within(december).findByRole('button', {
        name: `sexta-feira, 25 de dezembro de ${String(YEAR)} · Natal · feriado nacional`,
      }),
    ).toBeTruthy();
    expect(
      within(months).getByRole('button', {
        name: `quarta-feira, 10 de junho de ${String(YEAR)} · hoje`,
      }),
    ).toBeTruthy();
  });

  it('com as datas úteis do CAL-05, o ponto facultativo adotado entra em "Sem expediente"', async () => {
    const api = mockApi({
      businessDays: () => {
        const dates = businessDatesOf(YEAR, [
          `${String(YEAR)}-02-17`,
          `${String(YEAR)}-10-12`,
          `${String(YEAR)}-12-25`,
        ]);
        return jsonResponse({ data: { businessDays: dates.length, dates } });
      },
    });
    renderWithShell(<CalendarView />);
    const list = await loaded();
    const stats = screen.getByRole('region', { name: `Resumo de ${String(YEAR)}` });
    await waitFor(() => {
      expect(stats.textContent).toContain('Sem expediente 3');
    });
    expect(stats.textContent).toContain('Dias úteis 258');
    expect(within(stats).getByText('não contam como dia útil nos prazos')).toBeTruthy();
    expect(
      within(itemOf(list, 'Carnaval (terça-feira)')).getByText(
        'Ponto facultativo · não conta como dia útil',
      ),
    ).toBeTruthy();
    expect(
      api.mock.calls.some(
        ([url]) =>
          requestUrl(url) ===
          `/api/v1/calendar/business-days?from=${String(YEAR)}-01-01&to=${String(YEAR)}-12-31`,
      ),
    ).toBe(true);
  });

  it('filtro por tipo na lista: Públicos, Da instituição e Facultativos, com a contagem', async () => {
    mockApi();
    renderWithShell(<CalendarView />);
    const list = await loaded();
    const filters = within(list).getByRole('group', { name: 'Filtrar feriados por tipo' });
    expect(
      within(filters)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Todos4', 'Públicos3', 'Da instituição1', 'Facultativos1']);
    expect(
      within(filters).getByRole('button', { name: /Todos/ }).getAttribute('aria-pressed'),
    ).toBe('true');

    await userEvent.click(within(filters).getByRole('button', { name: /Facultativos/ }));
    expect(within(list).getByText('Carnaval (terça-feira)')).toBeTruthy();
    expect(within(list).queryByText('Natal')).toBeNull();
    await userEvent.click(within(filters).getByRole('button', { name: /Da instituição/ }));
    expect(within(list).getByText('Aniversário da cidade')).toBeTruthy();
    expect(within(list).queryByText('Carnaval (terça-feira)')).toBeNull();
    await userEvent.click(within(filters).getByRole('button', { name: /Públicos/ }));
    expect(within(list).queryByText('Carnaval (terça-feira)')).toBeNull();
    expect(within(list).getByText('Natal')).toBeTruthy();
  });

  it('dia da grade: abre a edição do feriado do dia ou o cadastro com a data preenchida; setas navegam no mês', async () => {
    const api = mockApi({
      post: () =>
        jsonResponse(
          { data: holiday({ date: `${String(YEAR)}-03-10`, name: 'Padroeira', isSystem: false }) },
          { status: 201 },
        ),
    });
    renderWithShell(<CalendarView />);
    await loaded();

    await userEvent.click(
      await screen.findByRole('button', {
        name: new RegExp(`25 de dezembro de ${String(YEAR)} · Natal`),
      }),
    );
    expect(await screen.findByRole('dialog', { name: 'Editar Natal' })).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    await userEvent.click(
      screen.getByRole('button', { name: `terça-feira, 10 de março de ${String(YEAR)}` }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Novo feriado' });
    expect(within(dialog).getByRole('button', { name: 'Data *' }).textContent).toContain(
      `10/03/${String(YEAR)}`,
    );
    await userEvent.type(within(dialog).getByLabelText('Nome *'), 'Padroeira');
    await choose(within(dialog).getByRole('combobox', { name: 'Escopo *' }), 'Municipal');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => {
      expect(callsTo(api, 'POST')).toHaveLength(1);
    });
    expect(bodyOf(callOf(api, 'POST').init)).toMatchObject({ date: `${String(YEAR)}-03-10` });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    // Um dia por mês na tabulação (hoje, em junho); as setas andam dentro do mês.
    const june = screen.getByRole('table', { name: 'junho' });
    const today = within(june).getByRole('button', { name: /10 de junho .* · hoje$/ });
    expect(today.tabIndex).toBe(0);
    expect(
      within(june)
        .getAllByRole('button')
        .filter((button) => button.tabIndex === 0),
    ).toHaveLength(1);
    today.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(document.activeElement?.getAttribute('aria-label')).toBe(
      `quinta-feira, 11 de junho de ${String(YEAR)}`,
    );
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement?.getAttribute('aria-label')).toBe(
      `quinta-feira, 18 de junho de ${String(YEAR)}`,
    );
  });

  it('a data na lista abre a edição do feriado', async () => {
    mockApi();
    renderWithShell(<CalendarView />);
    const list = await loaded();
    await userEvent.click(
      await within(list).findByRole('button', {
        name: 'Abrir Aniversário da cidade, 12/10 · segunda-feira',
      }),
    );
    expect(
      await screen.findByRole('dialog', { name: 'Editar Aniversário da cidade' }),
    ).toBeTruthy();
  });

  it('FA-01: "Excluir" só aparece em feriado que não é de sistema', async () => {
    mockApi();
    renderWithShell(<CalendarView />);
    await loaded();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Ações de Aniversário da cidade' }),
    );
    expect(await screen.findByRole('menuitem', { name: 'Excluir' })).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByRole('button', { name: 'Ações de Natal' }));
    expect(await screen.findByRole('menuitem', { name: 'Desativar' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Excluir' })).toBeNull();
  });

  it('trocar o ano (seletor ou anterior/próximo) relê a lista desse ano', async () => {
    const api = mockApi();
    renderWithShell(<CalendarView />);
    await loaded();
    const readYear = (year: number) =>
      api.mock.calls.some(([url]) =>
        requestUrl(url).startsWith(`/api/v1/holidays?year=${String(year)}&`),
      );
    await choose(screen.getByRole('combobox', { name: 'Ano' }), String(YEAR + 1));
    await waitFor(() => {
      expect(readYear(YEAR + 1)).toBe(true);
    });
    await userEvent.click(screen.getByRole('button', { name: 'Ano anterior' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Ano anterior' }));
    await waitFor(() => {
      expect(readYear(YEAR - 1)).toBe(true);
    });
    expect(
      await screen.findByRole('region', { name: `Feriados de ${String(YEAR - 1)}` }),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Próximo ano' }));
    expect(await loaded()).toBeTruthy();
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
    expect(await loaded()).toBeTruthy();
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

  it('sem CALENDAR_MANAGE a grade e a lista ficam visíveis e as ações de edição, ocultas', async () => {
    const api = mockApi({}, []);
    renderWithShell(<CalendarView />);
    const list = await loaded();
    await waitFor(() => {
      expect(
        api.mock.calls.some(([url]) => requestUrl(url).startsWith('/api/v1/me/permissions')),
      ).toBe(true);
    });
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Novo feriado' })).toBeNull();
    });
    expect(screen.queryByRole('button', { name: /^Ações de / })).toBeNull();
    expect(within(list).queryByRole('button', { name: /^Abrir / })).toBeNull();
    const december = screen.getByRole('table', { name: 'dezembro' });
    expect(within(december).queryAllByRole('button')).toHaveLength(0);
    expect(
      within(december).getByText(/25 de dezembro de 2026 · Natal · feriado nacional/),
    ).toBeTruthy();
    expect(screen.getByText('Os dias marcados são feriados e pontos facultativos.')).toBeTruthy();
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

    const date = await pickFifteenth(dialog);
    await userEvent.type(within(dialog).getByLabelText('Nome *'), 'Aniversário da cidade');
    await choose(within(dialog).getByRole('combobox', { name: 'Escopo *' }), 'Municipal');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Salvar' }));

    await waitFor(() => {
      expect(callsTo(api, 'POST')).toHaveLength(1);
    });
    const post = callOf(api, 'POST');
    expect(post.url).toBe('/api/v1/holidays');
    expect(bodyOf(post.init)).toEqual({
      date,
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
    await pickFifteenth(dialog);
    await userEvent.type(within(dialog).getByLabelText('Nome *'), 'Aniversário da cidade');
    await choose(within(dialog).getByRole('combobox', { name: 'Escopo *' }), 'Municipal');
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
    await rowAction('Aniversário da cidade', 'Editar');
    const dialog = await screen.findByRole('dialog', { name: 'Editar Aniversário da cidade' });

    const date = within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Data *' });
    expect(date.disabled).toBe(true);
    expect(date.textContent).toContain(`12/10/${String(YEAR)}`);
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Repetir todos os anos' }));
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
    await rowAction('Natal', 'Editar');
    const dialog = await screen.findByRole('dialog', { name: 'Editar Natal' });
    expect(within(dialog).getByLabelText<HTMLInputElement>('Nome *').readOnly).toBe(true);
    expect(
      within(dialog).getByText('O nome de um feriado padrão do sistema não pode ser alterado.'),
    ).toBeTruthy();
    expect(within(dialog).getByRole('checkbox', { name: 'Feriado ativo' })).toBeTruthy();
  });

  it('desativar feriado de sistema (aviso sem efeito retroativo) e ativar outro; ambos com If-Match', async () => {
    const api = mockApi({
      patch: () => jsonResponse({ data: { ...NATAL, isActive: false, version: 4 } }),
    });
    renderWithShell(<CalendarView />);
    await rowAction('Natal', 'Desativar');
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

    await rowAction('Finados', 'Ativar');
    await waitFor(() => {
      expect(callsTo(api, 'PATCH')).toHaveLength(2);
    });
    expect(bodyOf(callOf(api, 'PATCH', 1).init)).toEqual({ isActive: true });
  });

  it('excluir feriado do administrador: confirmação e DELETE com If-Match', async () => {
    const api = mockApi({ remove: () => new Response(null, { status: 204 }) });
    renderWithShell(<CalendarView />);
    await rowAction('Aniversário da cidade', 'Excluir');
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
    await rowAction('Natal', 'Desativar');
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
    await rowAction('Aniversário da cidade', 'Excluir');
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
