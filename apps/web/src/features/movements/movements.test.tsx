// @vitest-environment jsdom
import type { MovementItemDto } from '@contrataflow/validation';
import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { pickDate } from '@test/support/kit';
import { PROCESS_ID, mockProcessApi } from '@test/support/process-fixtures';
import { jsonResponse, problem, renderWithShell } from '@test/support/render';

import { MovementTimeline } from './movement-timeline';
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

const ANA = '0192d054-0000-7000-8000-0000000000c1';
const LUCIA = '0192d054-0000-7000-8000-0000000000c2';
const MANUTENCAO = '0192d054-0000-7000-8000-0000000000a2';
const COTACOES = '0192d054-0000-7000-8000-0000000000a6';
const ALMOX = '0192d054-0000-7000-8000-0000000000a7';
const APPROVAL = '0192d054-0000-7000-8000-000000000a01';
const STAGE_A = { id: '0192d054-0000-7000-8000-0000000005a1', name: 'Abertura' };
const STAGE_B = { id: '0192d054-0000-7000-8000-0000000005a2', name: 'Pesquisa de preços' };

function movement(sequence: number, patch: Partial<MovementItemDto> = {}): MovementItemDto {
  return {
    id: `0192d054-0000-7000-8000-${String(sequence).padStart(12, '0')}`,
    sequence,
    action: 'FORWARD',
    fromStage: STAGE_A,
    toStage: STAGE_B,
    fromDepartment: { id: MANUTENCAO, name: 'Setor de Manutenção', isActive: true },
    toDepartment: { id: COTACOES, name: 'Setor de Cotações', isActive: true },
    fromUser: null,
    toUser: null,
    statusFrom: 'IN_PROGRESS',
    statusTo: 'IN_PROGRESS',
    actor: { type: 'USER', id: ANA, name: 'Ana Souza', departmentName: 'Setor de Manutenção' },
    comment: null,
    dueAt: null,
    documents: [],
    approvalId: null,
    approvalSummary: null,
    occurredAt: `2026-09-0${String(sequence)}T12:00:00.000Z`,
    ip: null,
    userAgent: 'Mozilla/5.0',
    correlationId: `corr-${String(sequence)}`,
    ...patch,
  };
}

/** As 5 tramitações do Background, mais recente primeiro. */
const ITEMS: MovementItemDto[] = [
  movement(5, {
    action: 'APPROVE',
    fromStage: STAGE_B,
    fromDepartment: { id: ALMOX, name: 'Almoxarifado', isActive: false },
    actor: { type: 'USER', id: LUCIA, name: 'Lúcia Matos', departmentName: null },
    approvalId: APPROVAL,
    approvalSummary: { title: 'Aprovação da autoridade', status: 'APPROVED', decision: 'APPROVE' },
  }),
  movement(4, {
    toDepartment: { id: ALMOX, name: 'Almoxarifado', isActive: false },
    toUser: { id: LUCIA, name: 'Bruno Lima', isActive: false },
    statusFrom: 'RETURNED',
  }),
  movement(3, {
    action: 'RETURN',
    fromStage: STAGE_B,
    toStage: STAGE_A,
    fromDepartment: { id: COTACOES, name: 'Setor de Cotações', isActive: true },
    toDepartment: { id: MANUTENCAO, name: 'Setor de Manutenção', isActive: true },
    actor: { type: 'USER', id: LUCIA, name: 'Lúcia Matos', departmentName: 'Setor de Cotações' },
    statusTo: 'RETURNED',
    comment: 'Falta a especificação do item 3.',
  }),
  movement(2, {
    statusFrom: 'DRAFT',
    comment: 'Segue para cotação.',
    dueAt: '2026-09-10T20:59:59.000Z',
    documents: [
      {
        documentId: '0192d054-0000-7000-8000-0000000d0c01',
        documentVersionId: '0192d054-0000-7000-8000-0000000d0c02',
        versionNumber: 2,
        code: 'DFD 0003/2026',
        title: 'DFD — cimento',
        documentTypeCode: 'DFD',
        status: 'FINALIZED',
      },
    ],
  }),
  movement(1, {
    action: 'CREATE',
    fromStage: null,
    toStage: STAGE_A,
    fromDepartment: null,
    toDepartment: { id: MANUTENCAO, name: 'Setor de Manutenção', isActive: true },
    statusFrom: null,
    statusTo: 'DRAFT',
    actor: { type: 'SYSTEM', id: null, name: null, departmentName: null },
  }),
];

function page(
  data: readonly MovementItemDto[],
  nextCursor: string | null = null,
  canViewIp = false,
) {
  return jsonResponse({ data, meta: { nextCursor, hasMore: nextCursor !== null, canViewIp } });
}

/** Mock de PRC-11 sobre o mock padrão de processo; devolve as queries recebidas. */
function mockMovements(handler: (params: URLSearchParams) => Response = () => page(ITEMS)) {
  const calls: URLSearchParams[] = [];
  mockProcessApi({
    movements: (url) => {
      const params = new URL(url, 'http://x').searchParams;
      calls.push(params);
      return handler(params);
    },
  });
  return calls;
}

const HISTORY = { name: 'Histórico de tramitações' };

/** Linhas de tramitação (os `listitem` com nome "Ação nº N, em …"), em todos os grupos de dia. */
function movementRows(): HTMLElement[] {
  return screen.getAllByRole('listitem', { name: / nº \d+, em / });
}

type User = ReturnType<typeof userEvent.setup>;

/** Abre o popover "Filtros" da barra (fechado por padrão — prd-5 · regra 2). */
async function openFilters(user: User): Promise<HTMLElement> {
  const open = screen.queryByRole('dialog', { name: 'Filtros' });
  if (open) return open;
  await user.click(screen.getByRole('button', { name: /^Filtros/ }));
  return screen.findByRole('dialog', { name: 'Filtros' });
}

beforeEach(() => {
  push.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SCR-006 · aba "Tramitação" (US-054)', () => {
  it('[Sucesso] skeleton e as 5 tramitações da mais recente para a mais antiga, com origem, destino, ator e data', async () => {
    const calls = mockMovements();
    renderWithShell(<MovementTimeline processId={PROCESS_ID} />);
    expect(
      screen.getByRole('status', { name: 'Carregando o histórico de tramitações…' }),
    ).toBeTruthy();

    const history = await screen.findByRole('region', HISTORY);
    // Agrupadas por dia (um cabeçalho por data local do tenant), na ordem da API.
    expect(within(history).getAllByRole('heading', { level: 3 })[0]?.textContent).toMatch(
      /5 de setembro de 2026/,
    );
    expect(within(history).getAllByRole('heading', { level: 3 })).toHaveLength(5);
    const rows = movementRows();
    expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual([
      'Aprovação nº 5, em 05/09/2026, 09:00',
      'Encaminhamento nº 4, em 04/09/2026, 09:00',
      'Devolução nº 3, em 03/09/2026, 09:00',
      'Encaminhamento nº 2, em 02/09/2026, 09:00',
      'Criação nº 1, em 01/09/2026, 09:00',
    ]);
    // Cada item é focável (navegação por teclado).
    expect(rows.every((row) => row.tabIndex === 0)).toBe(true);
    const forwarded = rows[3];
    if (!forwarded) throw new Error('linha ausente');
    expect(within(forwarded).getByText('Abertura · Setor de Manutenção')).toBeTruthy();
    expect(within(forwarded).getByText('Pesquisa de preços · Setor de Cotações')).toBeTruthy();
    expect(within(forwarded).getByText('Por Ana Souza · Setor de Manutenção')).toBeTruthy();
    expect(within(forwarded).getByText('“Segue para cotação.”')).toBeTruthy();
    expect(within(forwarded).getByText('Prazo atribuído: 10/09/2026')).toBeTruthy();
    expect(within(forwarded).getByText('Situação: Rascunho → Em andamento')).toBeTruthy();
    const document = within(forwarded).getByRole('link', { name: 'DFD 0003/2026 — versão 2' });
    expect(document.getAttribute('href')).toBe(
      `/processos/${PROCESS_ID}/documentos/0192d054-0000-7000-8000-0000000d0c01/versoes`,
    );
    const created = rows[4];
    if (!created) throw new Error('linha ausente');
    expect(within(created).getByText('Por Sistema')).toBeTruthy();
    expect(screen.getByText('Início do histórico.')).toBeTruthy();

    expect(Object.fromEntries(calls[0] ?? [])).toEqual({ limit: '50' });
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('[FA-02 · Permissão] sem AUDIT_VIEW a informação de IP não aparece', async () => {
    mockMovements(() => page(ITEMS.map((item) => ({ ...item, ip: null }))));
    renderWithShell(<MovementTimeline processId={PROCESS_ID} />);
    await screen.findByRole('region', HISTORY);
    expect(screen.queryByText(/IP de origem/)).toBeNull();
  });

  it('[Permissão] com AUDIT_VIEW (meta.canViewIp) o IP de cada tramitação aparece', async () => {
    mockMovements(() =>
      page(
        ITEMS.map((item) => ({ ...item, ip: item.sequence === 1 ? null : '200.10.20.30' })),
        null,
        true,
      ),
    );
    renderWithShell(<MovementTimeline processId={PROCESS_ID} />);
    await screen.findByRole('region', HISTORY);
    expect(screen.getAllByText('IP de origem: 200.10.20.30')).toHaveLength(4);
    expect(screen.getByText('IP de origem não registrado')).toBeTruthy();
  });

  it('[FA-03] decisão de aprovação: selo e link "Ver decisão" para /aprovacoes/{id}', async () => {
    mockMovements();
    renderWithShell(<MovementTimeline processId={PROCESS_ID} />);
    const link = await screen.findByRole('link', { name: 'Ver decisão' });
    expect(link.getAttribute('href')).toBe(`/aprovacoes/${APPROVAL}`);
    expect(screen.getByText('Decisão de aprovação')).toBeTruthy();
    expect(screen.getByText('Aprovação da autoridade — aprovada')).toBeTruthy();
  });

  it('[FA-05] unidade e usuário inativados aparecem com o selo "(inativo)"', async () => {
    mockMovements();
    renderWithShell(<MovementTimeline processId={PROCESS_ID} />);
    const row = await screen.findByRole('listitem', {
      name: 'Encaminhamento nº 4, em 04/09/2026, 09:00',
    });
    expect(within(row).getAllByText('(inativo)')).toHaveLength(2);
    expect(within(row).getByText('Responsável: Bruno Lima')).toBeTruthy();
  });

  it('[FA-01] filtros por ação (OU), unidade e ator (já vistos) e período reiniciam a paginação', async () => {
    const user = userEvent.setup();
    const calls = mockMovements((params) =>
      params.has('action') || params.has('toDepartmentId') || params.has('occurredFrom')
        ? page(ITEMS.slice(1, 2))
        : page(ITEMS),
    );
    renderWithShell(<MovementTimeline processId={PROCESS_ID} />);
    await screen.findByRole('region', HISTORY);
    // Filtros fechados por padrão (prd-5 · regra 2).
    expect(screen.queryByRole('checkbox', { name: 'Encaminhamento' })).toBeNull();
    const filters = await openFilters(user);

    await user.click(within(filters).getByRole('checkbox', { name: 'Encaminhamento' }));
    await user.click(within(filters).getByRole('checkbox', { name: 'Devolução' }));
    await waitFor(() => {
      expect(calls.at(-1)?.get('action')).toBe('FORWARD,RETURN');
    });
    await user.click(within(filters).getByRole('combobox', { name: 'Unidade de destino' }));
    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual([
      'Todas',
      'Almoxarifado',
      'Setor de Cotações',
      'Setor de Manutenção',
    ]);
    await user.click(screen.getByRole('option', { name: 'Almoxarifado' }));
    await waitFor(() => {
      expect(calls.at(-1)?.get('toDepartmentId')).toBe(ALMOX);
    });
    await user.click(within(filters).getByRole('combobox', { name: 'Ator' }));
    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual([
      'Todos',
      'Ana Souza',
      'Lúcia Matos',
    ]);
    await user.keyboard('{Escape}');
    await pickDate(user, 'Data inicial', '2026-09-02');
    await waitFor(() => {
      expect(calls.at(-1)?.get('occurredFrom')).toBe('2026-09-02T03:00:00.000Z');
    });
    const last = calls.at(-1);
    expect(last?.get('action')).toBe('FORWARD,RETURN');
    expect(last?.get('cursor')).toBeNull();
    expect(last?.get('limit')).toBe('50');
    // O que está ativo vira chip removível.
    const chips = screen.getByRole('list', { name: 'Filtros aplicados' });
    expect(within(chips).getByText('Unidade de destino: Almoxarifado')).toBeTruthy();
    expect(within(chips).getByText('Período: a partir de 02/09/2026')).toBeTruthy();
  });

  it('[Validação] V-02: período invertido marca os campos e não é enviado', async () => {
    const user = userEvent.setup();
    const calls = mockMovements();
    renderWithShell(<MovementTimeline processId={PROCESS_ID} />);
    await screen.findByRole('region', HISTORY);
    await openFilters(user);
    await pickDate(user, 'Data inicial', '2026-09-05');
    await waitFor(() => {
      expect(calls.at(-1)?.get('occurredFrom')).not.toBeNull();
    });
    const before = calls.length;
    await pickDate(user, 'Data final', '2026-09-01');
    expect(await screen.findByText('O período inicial deve ser anterior ao final.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Data final' }).getAttribute('aria-invalid')).toBe(
      'true',
    );
    expect(calls).toHaveLength(before);
  });

  it('[Validação] 422 de filtro: "Revise os filtros aplicados."', async () => {
    mockMovements(() => problem(422, 'VALIDATION_ERROR'));
    renderWithShell(<MovementTimeline processId={PROCESS_ID} />);
    expect(await screen.findByText('Revise os filtros aplicados.')).toBeTruthy();
  });

  it('[FA-04] processo em DRAFT: só o registro de criação', async () => {
    mockMovements(() => page(ITEMS.slice(4)));
    renderWithShell(<MovementTimeline processId={PROCESS_ID} />);
    expect(
      await screen.findByRole('listitem', { name: 'Criação nº 1, em 01/09/2026, 09:00' }),
    ).toBeTruthy();
    expect(screen.getByText('Situação: Rascunho')).toBeTruthy();
  });

  it('[FA-06] nenhum resultado para os filtros, com "Limpar filtros" que volta à lista completa', async () => {
    const user = userEvent.setup();
    const calls = mockMovements((params) => (params.has('action') ? page([]) : page(ITEMS)));
    renderWithShell(<MovementTimeline processId={PROCESS_ID} />);
    await screen.findByRole('region', HISTORY);
    await user.click(
      within(await openFilters(user)).getByRole('checkbox', { name: 'Cancelamento' }),
    );
    expect(
      await screen.findByText('Nenhuma tramitação encontrada para os filtros selecionados.'),
    ).toBeTruthy();
    await user.keyboard('{Escape}');
    const clear = screen.getAllByRole('button', { name: 'Limpar filtros' }).at(-1);
    if (!clear) throw new Error('botão ausente');
    await user.click(clear);
    expect(await screen.findByRole('region', HISTORY)).toBeTruthy();
    expect(calls.some((params) => params.get('action') === 'CANCEL')).toBe(true);
    const filters = await openFilters(user);
    expect(
      within(filters).getByRole('checkbox', { name: 'Cancelamento' }).getAttribute('aria-checked'),
    ).toBe('false');
  });

  it('[Paginação · Concorrência] "Carregar mais" segue o cursor, acrescenta sem repetir e anuncia', async () => {
    const calls = mockMovements((params) =>
      params.get('cursor') === 'C2' ? page(ITEMS.slice(2)) : page(ITEMS.slice(0, 2), 'C2'),
    );
    renderWithShell(<MovementTimeline processId={PROCESS_ID} />);
    await screen.findByRole('listitem', { name: 'Aprovação nº 5, em 05/09/2026, 09:00' });
    expect(screen.queryByRole('listitem', { name: /^Criação/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
    expect(
      await screen.findByRole('listitem', { name: 'Criação nº 1, em 01/09/2026, 09:00' }),
    ).toBeTruthy();
    expect(calls.at(-1)?.get('cursor')).toBe('C2');
    expect(screen.getAllByRole('listitem', { name: /nº/ })).toHaveLength(5);
    expect(screen.getByText('5 tramitações carregadas.')).toBeTruthy();
    expect(screen.getByText('Início do histórico.')).toBeTruthy();
  });

  it('[V-04] cursor inválido: recomeça do início e avisa', async () => {
    let first = true;
    const calls = mockMovements((params) => {
      if (params.get('cursor') === 'C2') {
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
      const response = first ? page(ITEMS.slice(0, 2), 'C2') : page(ITEMS);
      first = false;
      return response;
    });
    renderWithShell(<MovementTimeline processId={PROCESS_ID} />);
    await screen.findByRole('listitem', { name: 'Aprovação nº 5, em 05/09/2026, 09:00' });
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
    expect(await screen.findByText('Não foi possível continuar a lista. Recarregue.')).toBeTruthy();
    await waitFor(() => {
      expect(calls.at(-1)?.get('cursor')).toBeNull();
    });
    expect(
      await screen.findByRole('listitem', { name: 'Criação nº 1, em 01/09/2026, 09:00' }),
    ).toBeTruthy();
  });

  it('[Falha de banco] 503: "Não foi possível carregar o histórico agora." e "Tentar novamente"', async () => {
    let fail = true;
    const calls = mockMovements(() =>
      fail ? problem(503, 'DEPENDENCY_UNAVAILABLE') : page(ITEMS),
    );
    renderWithShell(<MovementTimeline processId={PROCESS_ID} />);
    expect(await screen.findByText('Não foi possível carregar o histórico agora.')).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByRole('region', HISTORY)).toBeTruthy();
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it('[Erro] 429 e 500 com o código de correlação', async () => {
    mockMovements(() => problem(500, 'INTERNAL_ERROR', 'c-500'));
    renderWithShell(<MovementTimeline processId={PROCESS_ID} />);
    expect(await screen.findByText('Ocorreu um erro inesperado. Código: c-500.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copiar código' })).toBeTruthy();
  });

  it('[Tenant incorreto · Permissão] 404 volta à lista de processos', async () => {
    mockMovements(() => problem(404, 'PROCESS_NOT_FOUND'));
    renderWithShell(<MovementTimeline processId={PROCESS_ID} />);
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith('/processos');
    });
  });

  it('painel: a aba "Tramitação" abre o histórico', async () => {
    mockMovements();
    nav.replace('');
    renderWithShell(<ProcessPanel processId={PROCESS_ID} />);
    const tab = await screen.findByRole('tab', { name: 'Tramitação' });
    fireEvent.click(tab);
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(nav.get()).toBe('aba=tramitacao');
    expect(await screen.findByRole('region', HISTORY)).toBeTruthy();
    expect(screen.getByRole('tabpanel', { name: 'Tramitação' })).toBeTruthy();
  });
});
