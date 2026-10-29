// @vitest-environment jsdom
import { Toaster } from '@contrataflow/ui';
import type { BulkResultResponse, TaskInboxItemDto } from '@contrataflow/validation';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api/api-error';
import { seriousA11yViolations } from '@test/support/axe';
import { jsonResponse, problem, renderWithShell, requestUrl } from '@test/support/render';

import {
  EMPTY_SELECTION,
  canSubmit,
  describeBulkError,
  isFull,
  sharedDepartmentOf,
  summarizeBulk,
  togglePage,
  toggleSelection,
  validateBulkAssign,
} from './task-bulk-model';
import type { BulkSelectedItem } from './task-bulk-model';
import { TaskInboxPage } from './task-inbox-page';

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

/*
 * US-058 — ações em lote na fila da unidade (SCR-013/SCR-115): seleção múltipla, "Assumir
 * selecionados" (TSK-03) com confirmação, "Atribuir selecionados" (TSK-04) com responsável e motivo,
 * resumo por item (sucesso parcial e FA-02), "Cancelar seleção" (FA-05), 503 com "Tentar novamente",
 * permissões e acessibilidade (axe).
 */

const UNIT = '0192e058-0000-7000-8000-0000000000a2';
const OTHER_UNIT = '0192e058-0000-7000-8000-0000000000a3';
const FERNANDA = '0192e058-0000-7000-8000-0000000000f1';
const pid = (n: number) => `0192e058-0000-7000-8000-${String(n).padStart(12, '0')}`;

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
    currentResponsible: null,
    enteredAt: '2026-10-01T12:00:00.000Z',
    dueAt: null,
    isOverdue: false,
    overdueSince: null,
    deadline: {
      dueAt: null,
      slaType: 'BUSINESS',
      daysLeft: null,
      overdueDays: null,
      isDueSoon: false,
      isOverdue: false,
      isPaused: false,
    },
    isBudgetConfidential: false,
    canClaim: true,
    ...overrides,
  };
}

const page = (items: TaskInboxItemDto[]) =>
  jsonResponse({
    data: items,
    meta: { page: 1, pageSize: 20, totalItems: items.length, totalPages: 1 },
  });

const bulkResponse = (data: BulkResultResponse['data']) =>
  jsonResponse({
    data,
    meta: {
      successCount: data.filter((entry) => entry.ok).length,
      errorCount: data.filter((entry) => !entry.ok).length,
    },
  });

const ok = (n: number) => ({
  processId: pid(n),
  ok: true,
  process: { id: pid(n), code: null, version: 5, currentResponsible: null },
});

interface MockOptions {
  readonly permissions?: readonly string[];
  readonly headOf?: readonly string[];
  readonly items?: TaskInboxItemDto[];
  readonly bulk?: (path: string, init: RequestInit | undefined) => Response;
}

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
            implicit: { headOfDepartmentIds: options.headOf ?? [], ownDepartmentIds: [] },
          },
        }),
      );
    }
    if (url.pathname === '/api/v1/tasks/counters') {
      return Promise.resolve(
        jsonResponse({
          data: {
            mine: 0,
            unitQueue: 3,
            pendingApprovals: 0,
            returned: 0,
            overdue: 0,
            following: 0,
          },
        }),
      );
    }
    if (url.pathname === '/api/v1/tasks') {
      return Promise.resolve(page(options.items ?? [item(1), item(2), item(3)]));
    }
    if (url.pathname === '/api/v1/users/lookup') {
      return Promise.resolve(
        jsonResponse({ data: [{ id: FERNANDA, name: 'Fernanda Lima', email: 'f@a.test' }] }),
      );
    }
    if (url.pathname.startsWith('/api/v1/tasks/bulk-') && init?.method === 'POST') {
      return Promise.resolve(
        options.bulk?.(url.pathname, init) ?? bulkResponse([ok(1), ok(2), ok(3)]),
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

const bodyOf = (init: RequestInit | undefined) =>
  JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as unknown;

async function openQueue(user: ReturnType<typeof userEvent.setup>) {
  renderWithShell(
    <>
      <TaskInboxPage />
      <Toaster />
    </>,
  );
  await user.click(await screen.findByRole('tab', { name: /Na fila da minha unidade/ }));
  await screen.findByText('0001/2026');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SCR-013 — Ações em lote na fila da unidade (US-058)', () => {
  it('[Sucesso parcial] seleciona, confirma "Assumir selecionados" e mostra o resumo por item', async () => {
    const user = userEvent.setup();
    const fetchMock = mockApi({
      bulk: () =>
        bulkResponse([
          ok(1),
          {
            processId: pid(2),
            ok: false,
            code: 'PROCESS_ALREADY_ASSIGNED',
            message: 'Este processo já foi assumido por Fábio Nunes.',
          },
        ]),
    });
    await openQueue(user);

    await user.click(screen.getByRole('checkbox', { name: 'Selecionar o processo 0001/2026' }));
    const bar = screen.getByRole('region', { name: 'Ações em lote' });
    expect(within(bar).getByText('1 selecionado')).toBeTruthy();
    expect(within(bar).getByText('Selecione ao menos 2 processos.')).toBeTruthy();
    expect(
      within(bar).getByRole<HTMLButtonElement>('button', { name: 'Assumir selecionados' }).disabled,
    ).toBe(true);
    // Sem PROCESS_ASSIGN nem chefia: só "Assumir".
    expect(within(bar).queryByRole('button', { name: 'Atribuir selecionados' })).toBeNull();

    await user.click(screen.getByRole('checkbox', { name: 'Selecionar o processo 0002/2026' }));
    expect(within(bar).getByText('2 selecionados')).toBeTruthy();
    expect(await seriousA11yViolations()).toEqual([]);
    await user.click(within(bar).getByRole('button', { name: 'Assumir selecionados' }));
    const dialog = await screen.findByRole('dialog', { name: 'Assumir 2 processos?' });
    const before = calls(fetchMock, '/api/v1/tasks').length;
    await user.click(within(dialog).getByRole('button', { name: 'Assumir' }));

    expect(
      await screen.findByText('1 de 2 processos assumidos. 1 não pôde ser assumido.'),
    ).toBeTruthy();
    const [post] = calls(fetchMock, '/api/v1/tasks/bulk-claim');
    expect(bodyOf(post?.init)).toEqual({ processIds: [pid(1), pid(2)] });
    expect(new Headers(post?.init?.headers).get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    await user.click(screen.getByText('Ver o erro'));
    expect(screen.getByText('0002/2026 — já havia sido assumido por outra pessoa.')).toBeTruthy();
    // Lista e contadores recarregados; o item que falhou continua selecionado.
    await waitFor(() => {
      expect(calls(fetchMock, '/api/v1/tasks').length).toBeGreaterThan(before);
    });
    expect(within(bar).getByText('1 selecionado')).toBeTruthy();
  });

  it('FA-02: todos os itens falham → "Nenhum processo pôde ser processado."', async () => {
    const user = userEvent.setup();
    mockApi({
      bulk: () =>
        bulkResponse([
          { processId: pid(1), ok: false, code: 'REFERENCE_NOT_FOUND', message: 'x' },
          { processId: pid(2), ok: false, code: 'INVALID_PROCESS_STATUS', message: 'Etapa.' },
        ]),
    });
    await openQueue(user);
    await user.click(
      screen.getByRole('checkbox', { name: 'Selecionar todos os processos desta página' }),
    );
    expect(screen.getByText('3 selecionados')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Assumir selecionados' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Assumir' }),
    );
    expect(await screen.findByText('Nenhum processo pôde ser processado.')).toBeTruthy();
    await user.click(screen.getByText('Ver os 2 erros'));
    expect(screen.getByText('0001/2026 — não pôde ser processado.')).toBeTruthy();
    expect(screen.getByText('0002/2026 — Etapa.')).toBeTruthy();
  });

  it('FA-05: "Cancelar seleção" some com a barra sem chamar a API', async () => {
    const user = userEvent.setup();
    const fetchMock = mockApi();
    await openQueue(user);
    await user.click(screen.getByRole('checkbox', { name: 'Selecionar o processo 0001/2026' }));
    await user.click(screen.getByRole('button', { name: 'Cancelar seleção' }));
    expect(screen.queryByRole('region', { name: 'Ações em lote' })).toBeNull();
    expect(
      screen
        .getByRole('checkbox', { name: 'Selecionar o processo 0001/2026' })
        .getAttribute('aria-checked'),
    ).toBe('false');
    expect(calls(fetchMock, '/api/v1/tasks/bulk-claim')).toEqual([]);
  });

  it('Atribuir em lote (chefia): responsável e motivo obrigatórios; TSK-04 com o mesmo responsável', async () => {
    const user = userEvent.setup();
    const fetchMock = mockApi({ permissions: ['INBOX_VIEW'], headOf: [UNIT] });
    await openQueue(user);
    await user.click(screen.getByRole('checkbox', { name: 'Selecionar o processo 0001/2026' }));
    await user.click(screen.getByRole('checkbox', { name: 'Selecionar o processo 0003/2026' }));
    // Sem PROCESS_CLAIM: só "Atribuir".
    expect(screen.queryByRole('button', { name: 'Assumir selecionados' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Atribuir selecionados' }));
    const dialog = await screen.findByRole('dialog', { name: 'Atribuir 2 processos a' });
    await user.click(within(dialog).getByRole('button', { name: 'Atribuir' }));
    expect(within(dialog).getAllByText('Selecione o responsável e informe o motivo.')).toHaveLength(
      2,
    );
    expect(calls(fetchMock, '/api/v1/tasks/bulk-assign')).toEqual([]);

    await user.click(within(dialog).getByRole('combobox', { name: /Responsável/ }));
    await user.click(await screen.findByRole('option', { name: 'Fernanda Lima' }));
    await user.type(within(dialog).getByRole('textbox', { name: /Motivo/ }), 'Mutirão de triagem');
    expect(await seriousA11yViolations()).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Atribuir' }));

    expect(await screen.findByText('3 processos atribuídos.')).toBeTruthy();
    const [post] = calls(fetchMock, '/api/v1/tasks/bulk-assign');
    expect(bodyOf(post?.init)).toEqual({
      processIds: [pid(1), pid(3)],
      assigneeId: FERNANDA,
      reason: 'Mutirão de triagem',
    });
    const [lookup] = calls(fetchMock, '/api/v1/users/lookup');
    expect(lookup?.url.searchParams.get('departmentId')).toBe(UNIT);
    // Os bem-sucedidos saem da seleção: a barra some.
    expect(screen.queryByRole('region', { name: 'Ações em lote' })).toBeNull();
  });

  it('Atribuir em lote com processos de unidades diferentes: avisa e não envia', async () => {
    const user = userEvent.setup();
    mockApi({
      permissions: ['INBOX_VIEW', 'PROCESS_ASSIGN'],
      items: [item(1), item(2, { currentDepartment: { id: OTHER_UNIT, name: 'Compras' } })],
    });
    await openQueue(user);
    await user.click(
      screen.getByRole('checkbox', { name: 'Selecionar todos os processos desta página' }),
    );
    await user.click(screen.getByRole('button', { name: 'Atribuir selecionados' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/unidades diferentes/)).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Atribuir' })).toBeNull();
  });

  it('[Falha de banco] 503 → "Não foi possível concluir a ação agora." com "Tentar novamente"', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const fetchMock = mockApi({
      bulk: () => {
        attempts += 1;
        return attempts === 1
          ? problem(503, 'DEPENDENCY_UNAVAILABLE')
          : bulkResponse([ok(1), ok(2)]);
      },
    });
    await openQueue(user);
    await user.click(screen.getByRole('checkbox', { name: 'Selecionar o processo 0001/2026' }));
    await user.click(screen.getByRole('checkbox', { name: 'Selecionar o processo 0002/2026' }));
    await user.click(screen.getByRole('button', { name: 'Assumir selecionados' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Assumir' }),
    );
    expect(await screen.findByText('Não foi possível concluir a ação agora.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByText('2 processos assumidos.')).toBeTruthy();
    expect(calls(fetchMock, '/api/v1/tasks/bulk-claim')).toHaveLength(2);
  });

  it('[Permissão] sem PROCESS_CLAIM nem PROCESS_ASSIGN nem chefia: nenhuma caixa de seleção', async () => {
    const user = userEvent.setup();
    mockApi({ permissions: ['INBOX_VIEW'] });
    await openQueue(user);
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('linha com responsável não é selecionável', async () => {
    const user = userEvent.setup();
    mockApi({
      items: [item(1), item(2, { currentResponsible: { id: FERNANDA, name: 'Fernanda Lima' } })],
    });
    await openQueue(user);
    expect(screen.getByRole('checkbox', { name: 'Selecionar o processo 0001/2026' })).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: 'Selecionar o processo 0002/2026' })).toBeNull();
  });
});

describe('regras de tela do lote (task-bulk-model)', () => {
  const selected = (n: number, departmentId = UNIT): BulkSelectedItem => ({
    processId: pid(n),
    code: `${String(n).padStart(4, '0')}/2026`,
    title: `Processo ${String(n)}`,
    departmentId,
  });

  it('FA-01: até 50 por vez; o 51º não entra', () => {
    let selection = EMPTY_SELECTION;
    for (let n = 1; n <= 51; n += 1) selection = toggleSelection(selection, selected(n));
    expect(selection.size).toBe(50);
    expect(isFull(selection)).toBe(true);
    expect(selection.has(pid(51))).toBe(false);
    // Desmarcar continua possível no teto.
    expect(toggleSelection(selection, selected(1)).size).toBe(49);
    expect(canSubmit(selection)).toBe(true);
    expect(canSubmit(toggleSelection(EMPTY_SELECTION, selected(1)))).toBe(false);
  });

  it('"Selecionar todos da página" respeita o teto e desmarca a página inteira', () => {
    const items = Array.from({ length: 20 }, (_, index) => selected(index + 1));
    let selection = EMPTY_SELECTION;
    for (let n = 100; n < 140; n += 1) selection = toggleSelection(selection, selected(n));
    expect(togglePage(selection, items).size).toBe(50);
    const pageOnly = togglePage(EMPTY_SELECTION, items);
    expect(pageOnly.size).toBe(20);
    expect(togglePage(pageOnly, items).size).toBe(0);
  });

  it('unidade comum da seleção e validação do diálogo', () => {
    const one = togglePage(EMPTY_SELECTION, [selected(1), selected(2)]);
    expect(sharedDepartmentOf(one)).toBe(UNIT);
    expect(sharedDepartmentOf(toggleSelection(one, selected(3, OTHER_UNIT)))).toBeNull();
    expect(sharedDepartmentOf(EMPTY_SELECTION)).toBeNull();
    expect(validateBulkAssign({ assigneeId: '', reason: '' })).toEqual({
      assignee: 'Selecione o responsável e informe o motivo.',
      reason: 'Selecione o responsável e informe o motivo.',
    });
    expect(validateBulkAssign({ assigneeId: FERNANDA, reason: 'curto' })).toEqual({
      reason: 'O motivo deve ter ao menos 10 caracteres.',
    });
    expect(validateBulkAssign({ assigneeId: FERNANDA, reason: 'x'.repeat(2001) })).toEqual({
      reason: 'O motivo pode ter até 2.000 caracteres.',
    });
    expect(validateBulkAssign({ assigneeId: FERNANDA, reason: 'Mutirão de triagem' })).toEqual({});
  });

  it('resumo: sucesso, parcial e falha total; rótulo pelo código ou título', () => {
    const selection = togglePage(EMPTY_SELECTION, [selected(1), { ...selected(2), code: null }]);
    const partial = summarizeBulk(
      {
        data: [
          { processId: pid(1), ok: true },
          { processId: pid(2), ok: false, code: 'PROCESS_ALREADY_ASSIGNED', message: 'm' },
        ],
        meta: { successCount: 1, errorCount: 1 },
      },
      selection,
    );
    expect(partial).toMatchObject({
      kind: 'partial',
      succeeded: [pid(1)],
      problems: [{ label: 'Processo 2', code: 'PROCESS_ALREADY_ASSIGNED' }],
    });
    expect(
      summarizeBulk({ data: [], meta: { successCount: 0, errorCount: 2 } }, selection).kind,
    ).toBe('failure');
    expect(
      summarizeBulk({ data: [], meta: { successCount: 2, errorCount: 0 } }, selection).kind,
    ).toBe('success');
  });

  it('recusas do lote inteiro', () => {
    const error = (status: number, code: string, errors: ApiError['errors'] = []) =>
      new ApiError({ status, code, detail: code, errors });
    expect(describeBulkError(error(403, 'PERMISSION_DENIED'))).toEqual({ kind: 'denied' });
    expect(describeBulkError(error(422, 'IDEMPOTENCY_KEY_REUSED'))).toEqual({ kind: 'reused' });
    expect(describeBulkError(error(409, 'IDEMPOTENCY_IN_PROGRESS'))).toEqual({
      kind: 'inProgress',
    });
    expect(
      describeBulkError(
        error(422, 'VALIDATION_ERROR', [{ field: 'processIds', code: 'TOO_LONG', message: 'x' }]),
      ),
    ).toEqual({ kind: 'tooLong' });
    expect(
      describeBulkError(
        error(422, 'VALIDATION_ERROR', [{ field: 'processIds', code: 'TOO_SHORT', message: 'x' }]),
      ),
    ).toEqual({ kind: 'tooShort' });
    expect(
      describeBulkError(
        error(422, 'VALIDATION_ERROR', [{ field: 'reason', code: 'REQUIRED', message: 'Motivo.' }]),
      ),
    ).toEqual({ kind: 'field', message: 'Motivo.' });
    expect(describeBulkError(error(503, 'DEPENDENCY_UNAVAILABLE'))).toEqual({
      kind: 'unavailable',
    });
    expect(describeBulkError(error(500, 'INTERNAL_ERROR')).kind).toBe('unexpected');
    expect(describeBulkError(new Error('x'))).toEqual({ kind: 'unexpected', correlationId: '—' });
  });
});
