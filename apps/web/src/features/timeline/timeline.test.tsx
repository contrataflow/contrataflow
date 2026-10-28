// @vitest-environment jsdom
import type { TimelineEntryDto } from '@contrataflow/validation';
import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { PROCESS_ID, mockProcessApi } from '@test/support/process-fixtures';
import { jsonResponse, problem, renderWithShell, requestUrl } from '@test/support/render';

import { TimelineFeed } from './timeline-feed';
import { ProcessPanel } from '../process-panel/process-panel';

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

/** Navegação simulada: `?aba=` é estado observável (`useSearchParams`) e o roteador o altera. */
const nav = vi.hoisted(() => {
  let search = '';
  const listeners = new Set<() => void>();
  return {
    get: () => search,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    replace: (href: string) => {
      search = href.includes('?') ? (href.split('?')[1] ?? '') : '';
      listeners.forEach((listener) => {
        listener();
      });
    },
  };
});
const push = vi.fn();
vi.mock('next/navigation', async () => {
  const React = await import('react');
  return {
    useRouter: () => ({ push, replace: nav.replace, refresh: vi.fn() }),
    usePathname: () => `/processos/${PROCESS_ID}`,
    useSearchParams: () => {
      const search = React.useSyncExternalStore(nav.subscribe, nav.get, nav.get);
      return React.useMemo(() => new URLSearchParams(search), [search]);
    },
  };
});

const NOW = new Date('2026-10-05T15:00:00.000Z');
const CARLOS = '0192d060-0000-7000-8000-00000000c001';
const PAULA = '0192d060-0000-7000-8000-00000000c002';
const TIMELINE_URL = `/api/v1/processes/${PROCESS_ID}/timeline`;

let sequence = 0;
function entry(
  occurredAt: string,
  type: string,
  overrides: Partial<TimelineEntryDto> = {},
): TimelineEntryDto {
  sequence += 1;
  return {
    id: `0192d060-0000-7000-8000-${String(sequence).padStart(12, '0')}`,
    occurredAt,
    type,
    actorType: 'USER',
    actorId: CARLOS,
    actorName: 'Carlos Lima',
    actorDepartmentName: 'Setor de Cotações',
    entityType: 'Process',
    entityId: PROCESS_ID,
    movementId: null,
    params: {},
    visibility: 'STANDARD',
    ...overrides,
  };
}

const ENTRIES: TimelineEntryDto[] = [
  entry('2026-10-05T14:00:00.000Z', 'APPROVAL_DECIDED', {
    params: { decision: 'APPROVED', title: 'Aprovação do TR' },
  }),
  entry('2026-10-05T13:00:00.000Z', 'COMMENT_ADDED', { params: { excerpt: 'Conferir item 3.' } }),
  // 21:30 de 04/10 em São Paulo.
  entry('2026-10-05T00:30:00.000Z', 'APPROVAL_REQUESTED', {
    actorType: 'SYSTEM',
    actorId: null,
    actorName: null,
    actorDepartmentName: null,
    params: { approverLabel: 'Autoridade Competente' },
  }),
  entry('2026-10-01T12:00:00.000Z', 'PROCESS_FORWARDED', {
    actorId: PAULA,
    actorName: 'Paula Reis',
    params: { toStageName: 'Pesquisa de preços', toDepartmentName: 'Setor de Cotações' },
  }),
];

type TimelineHandler = (params: URLSearchParams) => Response;

function feedResponse(data: readonly TimelineEntryDto[], nextCursor: string | null = null) {
  return jsonResponse({ data, meta: { nextCursor, hasMore: nextCursor !== null } });
}

/** Mock de PRC-12 (o resto vai ao `fetch` padrão dos testes de processo). */
function mockTimeline(handler: TimelineHandler = () => feedResponse(ENTRIES)) {
  const base = mockProcessApi();
  const calls: URLSearchParams[] = [];
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    if (url.startsWith(TIMELINE_URL)) {
      const params = new URL(url, 'http://x').searchParams;
      calls.push(params);
      return Promise.resolve(handler(params));
    }
    return base(input, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  push.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('SCR-006 · aba "Timeline" (US-060)', () => {
  it('[Sucesso] skeleton, dias "Hoje"/"Ontem"/data completa como <h3> e mensagens do dicionário', async () => {
    const calls = mockTimeline();
    renderWithShell(<TimelineFeed processId={PROCESS_ID} />);
    expect(screen.getByRole('status', { name: 'Carregando a timeline…' })).toBeTruthy();

    expect(await screen.findByRole('heading', { level: 3, name: 'Hoje' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: 'Ontem' })).toBeTruthy();
    expect(
      screen.getByRole('heading', { level: 3, name: 'quinta-feira, 1 de outubro de 2026' }),
    ).toBeTruthy();
    expect(screen.getByText('Carlos Lima aprovou — Aprovação do TR')).toBeTruthy();
    expect(screen.getByText('Carlos Lima comentou')).toBeTruthy();
    expect(screen.getByText('“Conferir item 3.”')).toBeTruthy();
    expect(screen.getByText('Aprovação solicitada a Autoridade Competente')).toBeTruthy();
    expect(
      screen.getByText('Paula Reis encaminhou para Pesquisa de preços — Setor de Cotações'),
    ).toBeTruthy();
    // Item com aria-label combinando mensagem e horário (fuso do tenant).
    expect(
      screen.getByRole('listitem', { name: 'Carlos Lima aprovou — Aprovação do TR, às 11:00' }),
    ).toBeTruthy();
    expect(screen.getByText('Início da timeline.')).toBeTruthy();

    expect(calls).toHaveLength(1);
    expect(Object.fromEntries(calls[0] ?? [])).toEqual({ limit: '50' });
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('[Sucesso] filtros por grupo, autor (atores já carregados) e período reiniciam a paginação', async () => {
    const calls = mockTimeline((params) =>
      params.has('group') || params.has('actorId') || params.has('occurredFrom')
        ? feedResponse(ENTRIES.slice(0, 1))
        : feedResponse(ENTRIES),
    );
    renderWithShell(<TimelineFeed processId={PROCESS_ID} />);
    await screen.findByRole('heading', { level: 3, name: 'Hoje' });
    const filters = screen.getByRole('region', { name: 'Filtros da timeline' });

    fireEvent.click(within(filters).getByRole('checkbox', { name: 'Aprovações' }));
    await waitFor(() => {
      expect(calls.at(-1)?.get('group')).toBe('APROVACOES');
    });
    // Autores: só os vistos na timeline (sem o ator de sistema).
    const actor = within(filters).getByRole('group', { name: 'Autor' });
    expect(
      within(actor)
        .getAllByRole('checkbox')
        .map((box) => box.parentElement?.textContent),
    ).toEqual(['Carlos Lima', 'Paula Reis']);
    fireEvent.click(within(actor).getByRole('checkbox', { name: 'Carlos Lima' }));
    await waitFor(() => {
      expect(calls.at(-1)?.get('actorId')).toBe(CARLOS);
    });
    fireEvent.change(within(filters).getByLabelText('De'), { target: { value: '2026-09-28' } });
    await waitFor(() => {
      expect(calls.at(-1)?.get('occurredFrom')).toBe('2026-09-28T03:00:00.000Z');
    });
    const last = calls.at(-1);
    expect(last?.get('group')).toBe('APROVACOES');
    expect(last?.get('cursor')).toBeNull();
    expect(last?.get('limit')).toBe('50');
  });

  it('[Validação] período invertido marca os campos e não é enviado (V-01)', async () => {
    const calls = mockTimeline();
    renderWithShell(<TimelineFeed processId={PROCESS_ID} />);
    await screen.findByRole('heading', { level: 3, name: 'Hoje' });
    fireEvent.change(screen.getByLabelText('De'), { target: { value: '2026-10-05' } });
    await waitFor(() => {
      expect(calls.at(-1)?.get('occurredFrom')).not.toBeNull();
    });
    const before = calls.length;
    fireEvent.change(screen.getByLabelText('Até'), { target: { value: '2026-10-01' } });
    expect(
      await screen.findByText('O período final deve ser igual ou posterior ao inicial.'),
    ).toBeTruthy();
    expect(screen.getByLabelText('Até').getAttribute('aria-invalid')).toBe('true');
    expect(calls).toHaveLength(before);
  });

  it('[FA-01] sem entradas: "Nenhum evento registrado ainda."', async () => {
    mockTimeline(() => feedResponse([]));
    renderWithShell(<TimelineFeed processId={PROCESS_ID} />);
    expect(await screen.findByText('Nenhum evento registrado ainda.')).toBeTruthy();
  });

  it('[FA-02] filtro sem resultados com "Limpar filtros", que volta à lista completa', async () => {
    const calls = mockTimeline((params) =>
      params.has('group') ? feedResponse([]) : feedResponse(ENTRIES),
    );
    renderWithShell(<TimelineFeed processId={PROCESS_ID} />);
    await screen.findByRole('heading', { level: 3, name: 'Hoje' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Comentários e anexos' }));
    expect(
      await screen.findByText('Nenhum evento encontrado para os filtros selecionados.'),
    ).toBeTruthy();
    const clear = screen.getAllByRole('button', { name: 'Limpar filtros' });
    const last = clear.at(-1);
    if (!last) throw new Error('botão ausente');
    fireEvent.click(last);
    expect(await screen.findByRole('heading', { level: 3, name: 'Hoje' })).toBeTruthy();
    expect(calls.some((params) => params.get('group') === 'COMENTARIOS')).toBe(true);
    expect(
      screen.getByRole<HTMLInputElement>('checkbox', { name: 'Comentários e anexos' }).checked,
    ).toBe(false);
  });

  it('[Paginação] "Carregar mais" busca a próxima página pelo cursor e acrescenta as entradas', async () => {
    const calls = mockTimeline((params) =>
      params.get('cursor') === 'C1'
        ? feedResponse(ENTRIES.slice(2))
        : feedResponse(ENTRIES.slice(0, 2), 'C1'),
    );
    renderWithShell(<TimelineFeed processId={PROCESS_ID} />);
    await screen.findByText('Carlos Lima aprovou — Aprovação do TR');
    expect(screen.queryByRole('heading', { level: 3, name: 'Ontem' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
    expect(await screen.findByRole('heading', { level: 3, name: 'Ontem' })).toBeTruthy();
    expect(calls.at(-1)?.get('cursor')).toBe('C1');
    expect(screen.getByText('Início da timeline.')).toBeTruthy();
  });

  it('[V-02] cursor inválido recomeça do início e avisa', async () => {
    let first = true;
    const calls = mockTimeline((params) => {
      if (params.get('cursor') === 'C1') {
        return new Response(
          JSON.stringify({
            type: 'https://docs.contrataflow.com.br/errors/validation_error',
            title: 'VALIDATION_ERROR',
            status: 422,
            detail: 'x',
            instance: '/x',
            code: 'VALIDATION_ERROR',
            correlationId: 'c-1',
            errors: [{ field: 'cursor', code: 'INVALID_FORMAT', message: 'x' }],
            violations: [],
          }),
          { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
        );
      }
      const page = first ? feedResponse(ENTRIES.slice(0, 2), 'C1') : feedResponse(ENTRIES);
      first = false;
      return page;
    });
    renderWithShell(<TimelineFeed processId={PROCESS_ID} />);
    await screen.findByText('Carlos Lima aprovou — Aprovação do TR');
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
    expect(
      await screen.findByText(
        'Não foi possível continuar a listagem. Role novamente desde o início.',
      ),
    ).toBeTruthy();
    await waitFor(() => {
      expect(calls.at(-1)?.get('cursor')).toBeNull();
    });
    expect(await screen.findByRole('heading', { level: 3, name: 'Ontem' })).toBeTruthy();
  });

  it('[Falha de banco] 503: mensagem da story e "Tentar novamente" com os filtros mantidos', async () => {
    let fail = true;
    const calls = mockTimeline(() =>
      fail ? problem(503, 'DEPENDENCY_UNAVAILABLE') : feedResponse(ENTRIES),
    );
    renderWithShell(<TimelineFeed processId={PROCESS_ID} />);
    expect(
      await screen.findByText(
        'Não foi possível carregar a timeline agora. Tente novamente em instantes.',
      ),
    ).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByRole('heading', { level: 3, name: 'Hoje' })).toBeTruthy();
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it('[Erro inesperado] 500 mostra o código de correlação', async () => {
    mockTimeline(() => problem(500, 'INTERNAL_ERROR', 'c-500'));
    renderWithShell(<TimelineFeed processId={PROCESS_ID} />);
    expect(await screen.findByText('Ocorreu um erro inesperado. Código: c-500.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copiar código' })).toBeTruthy();
  });

  it('[Permissão] 404 (processo deixou de ser visível) volta à lista de processos', async () => {
    mockTimeline(() => problem(404, 'PROCESS_NOT_FOUND'));
    renderWithShell(<TimelineFeed processId={PROCESS_ID} />);
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith('/processos');
    });
  });

  it('painel: "Linha do tempo" na aba Tramitação abre o feed (`?aba=timeline`); setas alternam as abas', async () => {
    mockTimeline();
    renderWithShell(<ProcessPanel processId={PROCESS_ID} />);
    const tab = await screen.findByRole('tab', { name: 'Tramitação' });
    expect(screen.getByRole('tab', { name: 'Visão geral' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    fireEvent.click(tab);
    expect(tab.getAttribute('aria-selected')).toBe('true');
    fireEvent.click(await screen.findByRole('button', { name: 'Linha do tempo' }));
    expect(nav.get()).toBe('aba=timeline');
    expect(await screen.findByRole('heading', { level: 3, name: 'Hoje' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Linha do tempo' }).getAttribute('aria-pressed'),
    ).toBe('true');
    // A linha do tempo é uma visão da aba "Tramitação": a aba segue selecionada.
    expect(screen.getByRole('tabpanel', { name: 'Tramitação' })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Tramitação' }), { key: 'ArrowLeft' });
    expect(screen.getByRole('tab', { name: /^Documentos/ }).getAttribute('aria-selected')).toBe(
      'true',
    );
    fireEvent.keyDown(screen.getByRole('tab', { name: /^Documentos/ }), { key: 'Home' });
    expect(screen.getByRole('tab', { name: 'Visão geral' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(nav.get()).toBe('');
    expect(await screen.findByRole('heading', { level: 2, name: 'Onde está' })).toBeTruthy();
  });
});
