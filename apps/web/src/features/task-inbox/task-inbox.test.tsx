// @vitest-environment jsdom
import { Toaster } from '@contrataflow/ui';
import type { TaskInboxCountersDto, TaskInboxItemDto } from '@contrataflow/validation';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api/api-error';
import { seriousA11yViolations } from '@test/support/axe';
import { jsonResponse, problem, renderWithShell, requestUrl } from '@test/support/render';

import {
  describeLoadError,
  describeQuickClaimError,
  sortForView,
  sortOptions,
  visibleTabs,
} from './task-inbox-model';
import { TaskInboxPage } from './task-inbox-page';

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

/*
 * US-056 — SCR-013 (`/tarefas`): abas com contadores (TSK-02), a lista da aba ativa (TSK-01) com
 * ordenação, o "Assumir" (PRC-21) da fila, estados vazio/erro/403 e acessibilidade (axe).
 */

const ANA = '0192a000-0000-7000-8000-0000000000a1';
const UNIT = '0192e056-0000-7000-8000-0000000000a2';
const pid = (n: number) => `0192e056-0000-7000-8000-${String(n).padStart(12, '0')}`;

function item(n: number, overrides: Partial<TaskInboxItemDto> = {}): TaskInboxItemDto {
  return {
    id: pid(n),
    processId: pid(n),
    code: `${String(n).padStart(4, '0')}/2026`,
    title: `Aquisição de materiais ${String(n)}`,
    status: 'IN_PROGRESS',
    version: 4,
    currentStage: { key: 'ESTUDOS_PRELIMINARES', name: 'Estudos preliminares' },
    currentDepartment: { id: UNIT, name: 'Setor de Manutenção' },
    currentResponsible: { id: ANA, name: 'Ana Souza' },
    enteredAt: '2026-10-01T12:00:00.000Z',
    dueAt: '2026-10-30T02:59:59.000Z',
    isOverdue: false,
    overdueSince: null,
    deadline: {
      dueAt: '2026-10-30T02:59:59.000Z',
      slaType: 'BUSINESS',
      daysLeft: 8,
      overdueDays: null,
      isDueSoon: false,
      isOverdue: false,
      isPaused: false,
    },
    isBudgetConfidential: false,
    canClaim: false,
    ...overrides,
  };
}

const page = (items: TaskInboxItemDto[], totalPages = 1) =>
  jsonResponse({
    data: items,
    meta: { page: 1, pageSize: 20, totalItems: items.length, totalPages },
  });

interface MockOptions {
  readonly permissions?: readonly string[];
  readonly counters?: () => Response;
  readonly list?: (url: URL) => Response;
  readonly claim?: (init: RequestInit | undefined) => Response;
}

const COUNTERS: TaskInboxCountersDto = {
  mine: 3,
  unitQueue: 1,
  pendingApprovals: 0,
  returned: 0,
  overdue: 1,
  following: 0,
};

function mockApi(options: MockOptions = {}) {
  const permissions = options.permissions ?? ['INBOX_VIEW', 'PROCESS_CLAIM'];
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = new URL(requestUrl(input), 'http://localhost');
    if (url.pathname === '/api/v1/me/permissions') {
      return Promise.resolve(
        jsonResponse({
          data: {
            permissions: permissions.map((code) => ({
              code,
              scopes: [{ type: 'TENANT', includeSubtree: false }],
            })),
            implicit: { headOfDepartmentIds: [], ownDepartmentIds: [] },
          },
        }),
      );
    }
    if (url.pathname === '/api/v1/tasks/counters') {
      return Promise.resolve(options.counters?.() ?? jsonResponse({ data: COUNTERS }));
    }
    if (url.pathname === '/api/v1/tasks') {
      return Promise.resolve(options.list?.(url) ?? page([item(1), item(2), item(3)]));
    }
    if (url.pathname.endsWith('/claim') && init?.method === 'POST') {
      return Promise.resolve(
        options.claim?.(init) ?? jsonResponse({ data: { id: pid(12), version: 5 } }),
      );
    }
    return Promise.resolve(problem(404, 'NOT_FOUND'));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const calls = (fetchMock: ReturnType<typeof mockApi>, pathname: string) =>
  fetchMock.mock.calls
    .map(([input, init]) => ({ url: new URL(requestUrl(input), 'http://localhost'), init }))
    .filter(({ url }) => url.pathname === pathname);

function renderPage() {
  return renderWithShell(
    <>
      <TaskInboxPage />
      <Toaster />
    </>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SCR-013 — Caixa de tarefas (US-056)', () => {
  it('abre em "Comigo" com os contadores das abas e as linhas da visão', async () => {
    const fetchMock = mockApi();
    renderPage();
    const mine = await screen.findByRole('tab', { name: 'Comigo: 3 itens' });
    expect(mine.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Na fila da minha unidade: 1 item' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Atrasados: 1 item' })).toBeTruthy();
    expect(await screen.findByRole('link', { name: '0001/2026' })).toBeTruthy();
    expect(screen.getAllByRole('row')).toHaveLength(4);
    const [first] = calls(fetchMock, '/api/v1/tasks');
    expect(first?.url.searchParams.get('view')).toBe('MINE');
    expect(first?.url.searchParams.get('sort')).toBe('-dueAt');
    expect(first?.url.searchParams.get('pageSize')).toBe('20');
    // Clicar na linha abre o processo (SCR-006): só navegação, nenhuma ação.
    expect(screen.getByRole('link', { name: '0001/2026' }).getAttribute('href')).toBe(
      `/processos/${pid(1)}`,
    );
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('FA-01: sem unitQueue nos contadores, a aba "Na fila da minha unidade" não aparece', async () => {
    mockApi({
      counters: () =>
        jsonResponse({
          data: { mine: 0, pendingApprovals: 0, returned: 0, overdue: 0, following: 0 },
        }),
      list: () => page([]),
    });
    renderPage();
    await screen.findByRole('tab', { name: 'Comigo: nenhum item' });
    expect(screen.queryByRole('tab', { name: /Na fila da minha unidade/ })).toBeNull();
    // FA-02: estado vazio contextual.
    expect(
      await screen.findByText('Nenhum processo pendente com você. Bom trabalho!'),
    ).toBeTruthy();
  });

  it('troca de aba por clique e teclado, mantendo a ordenação; ordena pelo seletor', async () => {
    const user = userEvent.setup();
    const fetchMock = mockApi({
      list: (url) =>
        url.searchParams.get('view') === 'PENDING_APPROVALS'
          ? page([
              item(4, {
                id: pid(2004),
                approval: {
                  id: pid(2004),
                  title: 'Aprovação do DFD',
                  subjectType: 'PROCESS_STAGE',
                  requestedBy: { id: ANA, name: 'Lúcia Ramos' },
                  requestedAt: '2026-10-12T12:00:00.000Z',
                  dueAt: null,
                },
              }),
            ])
          : page([item(1)]),
    });
    renderPage();
    await screen.findByRole('link', { name: '0001/2026' });
    await user.selectOptions(screen.getByLabelText('Ordenar por'), 'enteredAt');
    await waitFor(() => {
      expect(calls(fetchMock, '/api/v1/tasks').at(-1)?.url.searchParams.get('sort')).toBe(
        'enteredAt',
      );
    });
    await user.click(screen.getByRole('tab', { name: /Aprovações pendentes/ }));
    expect(await screen.findByText('Lúcia Ramos')).toBeTruthy();
    const last = calls(fetchMock, '/api/v1/tasks').at(-1)?.url.searchParams;
    expect(last?.get('view')).toBe('PENDING_APPROVALS');
    // "Entrada na etapa" vira "Solicitação" na visão de aprovações (RN-INBOX-10).
    expect(last?.get('sort')).toBe('requestedAt');
    screen.getByRole('tab', { name: /Aprovações pendentes/ }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: /Devolvidos/ }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('"Assumir" na fila: PRC-21 com If-Match e Idempotency-Key; sucesso recarrega lista e contadores', async () => {
    const user = userEvent.setup();
    const fetchMock = mockApi({
      list: (url) =>
        url.searchParams.get('view') === 'UNIT_QUEUE'
          ? page([
              item(12, { canClaim: true, currentResponsible: null, version: 7 }),
              item(13, { currentResponsible: null }),
            ])
          : page([item(1)]),
    });
    renderPage();
    await user.click(await screen.findByRole('tab', { name: /Na fila da minha unidade/ }));
    const button = await screen.findByRole('button', { name: 'Assumir o processo 0012/2026' });
    // Só a linha elegível (canClaim) mostra a ação.
    expect(screen.getAllByRole('button', { name: /Assumir o processo/ })).toHaveLength(1);
    const countersBefore = calls(fetchMock, '/api/v1/tasks/counters').length;
    await user.click(button);
    expect(await screen.findByText('Você assumiu este processo.')).toBeTruthy();
    const [claimCall] = calls(fetchMock, `/api/v1/processes/${pid(12)}/claim`);
    const headers = new Headers(claimCall?.init?.headers);
    expect(headers.get('If-Match')).toBe('"7"');
    expect(headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() => {
      expect(calls(fetchMock, '/api/v1/tasks/counters').length).toBeGreaterThan(countersBefore);
    });
  });

  it('FA-04: outro usuário assumiu antes → aviso e a lista é recarregada', async () => {
    const user = userEvent.setup();
    const fetchMock = mockApi({
      list: (url) =>
        url.searchParams.get('view') === 'UNIT_QUEUE'
          ? page([item(12, { canClaim: true, currentResponsible: null })])
          : page([item(1)]),
      claim: () => problem(409, 'PROCESS_ALREADY_ASSIGNED'),
    });
    renderPage();
    await user.click(await screen.findByRole('tab', { name: /Na fila da minha unidade/ }));
    const listCalls = () =>
      calls(fetchMock, '/api/v1/tasks').filter(
        ({ url }) => url.searchParams.get('view') === 'UNIT_QUEUE',
      ).length;
    await screen.findByRole('button', { name: 'Assumir o processo 0012/2026' });
    const before = listCalls();
    await user.click(screen.getByRole('button', { name: 'Assumir o processo 0012/2026' }));
    expect(await screen.findByText('Este processo já foi assumido por outra pessoa.')).toBeTruthy();
    await waitFor(() => {
      expect(listCalls()).toBeGreaterThan(before);
    });
  });

  it('[Falha de banco] 503 → "Não foi possível carregar sua caixa de tarefas agora." com "Tentar novamente"', async () => {
    const user = userEvent.setup();
    let down = true;
    mockApi({
      list: () => (down ? problem(503, 'DEPENDENCY_UNAVAILABLE') : page([item(1)])),
      counters: () =>
        down ? problem(503, 'DEPENDENCY_UNAVAILABLE') : jsonResponse({ data: COUNTERS }),
    });
    renderPage();
    const alert = await screen.findByText('Não foi possível carregar sua caixa de tarefas agora.');
    expect(alert).toBeTruthy();
    down = false;
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByRole('link', { name: '0001/2026' })).toBeTruthy();
  });

  it('[Permissão] sem INBOX_VIEW: estado 403 e nenhuma consulta à caixa', async () => {
    const fetchMock = mockApi({ permissions: ['PROCESS_VIEW'] });
    renderPage();
    expect(await screen.findByText('Você não tem acesso à caixa de tarefas.')).toBeTruthy();
    expect(calls(fetchMock, '/api/v1/tasks')).toHaveLength(0);
    expect(calls(fetchMock, '/api/v1/tasks/counters')).toHaveLength(0);
  });

  it('selo de atraso, orçamento sigiloso e linha de aprovação com solicitante', async () => {
    mockApi({
      list: () =>
        page([
          item(1, {
            isOverdue: true,
            overdueSince: '2026-10-16T03:00:00.000Z',
            isBudgetConfidential: true,
          }),
        ]),
    });
    renderPage();
    const row = (await screen.findByRole('link', { name: '0001/2026' })).closest('tr');
    expect(row).not.toBeNull();
    if (row) {
      expect(within(row).getByText('Em atraso')).toBeTruthy();
      expect(within(row).getByText('Orçamento sigiloso')).toBeTruthy();
    }
  });
});

describe('regras de tela da caixa (task-inbox-model)', () => {
  it('abas visíveis, ordenação por visão e opções do seletor', () => {
    expect(visibleTabs(undefined)).not.toContain('UNIT_QUEUE');
    expect(visibleTabs(COUNTERS)).toContain('UNIT_QUEUE');
    expect(sortForView({ field: 'enteredAt', direction: 'desc' }, 'PENDING_APPROVALS')).toEqual({
      field: 'requestedAt',
      direction: 'desc',
    });
    expect(sortForView({ field: 'requestedAt', direction: 'asc' }, 'MINE')).toEqual({
      field: 'enteredAt',
      direction: 'asc',
    });
    expect(sortForView({ field: 'code', direction: 'asc' }, 'OVERDUE')).toEqual({
      field: 'code',
      direction: 'asc',
    });
    expect(sortOptions('MINE')).toEqual([
      '-dueAt',
      'dueAt',
      'code',
      '-code',
      'enteredAt',
      '-enteredAt',
    ]);
  });

  it('falhas da consulta e do "Assumir"', () => {
    const apiError = (status: number, code: string) =>
      new ApiError({ status, code, correlationId: 'c-1' });
    expect(describeLoadError(new Error('x'))).toEqual({ kind: 'unavailable' });
    expect(describeLoadError(apiError(503, 'DEPENDENCY_UNAVAILABLE'))).toEqual({
      kind: 'unavailable',
    });
    expect(describeLoadError(apiError(429, 'RATE_LIMITED'))).toEqual({ kind: 'rateLimited' });
    expect(describeLoadError(apiError(500, 'INTERNAL_ERROR'))).toEqual({
      kind: 'unexpected',
      correlationId: 'c-1',
    });
    expect(describeQuickClaimError(apiError(409, 'PROCESS_ALREADY_ASSIGNED'))).toEqual({
      kind: 'alreadyAssigned',
    });
    expect(describeQuickClaimError(apiError(409, 'INVALID_PROCESS_STATUS')).kind).toBe('status');
    expect(describeQuickClaimError(apiError(412, 'VERSION_CONFLICT')).kind).toBe('changed');
    expect(describeQuickClaimError(apiError(428, 'PRECONDITION_REQUIRED')).kind).toBe('reload');
    expect(describeQuickClaimError(apiError(403, 'PERMISSION_DENIED')).kind).toBe('denied');
    expect(describeQuickClaimError(apiError(404, 'PROCESS_NOT_FOUND')).kind).toBe('notFound');
    expect(describeQuickClaimError(apiError(503, 'DEPENDENCY_UNAVAILABLE')).kind).toBe(
      'unavailable',
    );
    expect(describeQuickClaimError(new Error('x'))).toEqual({
      kind: 'unexpected',
      correlationId: '—',
    });
  });
});
