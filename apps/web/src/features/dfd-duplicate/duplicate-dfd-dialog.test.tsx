// @vitest-environment jsdom
import { Toaster, clearToasts } from '@contrataflow/ui';
import { configure, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeQueryClient } from '@/lib/query/query-client';
import { seriousA11yViolations } from '@test/support/axe';
import { ID, PROCESS_ID, bodyOf, problemResponse } from '@test/support/process-fixtures';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { DuplicateDfdButton, DuplicateDfdDialog } from './duplicate-dfd-dialog';

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

const nav = { push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn() };
vi.mock('next/navigation', () => ({
  useRouter: () => nav,
  usePathname: () => `/processos/${PROCESS_ID}/dfd/${ID(501)}`,
}));

beforeEach(() => {
  nav.push.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

const DFD = { id: ID(501), processId: PROCESS_ID, code: 'DFD 0005/2026' };
const POST_URL = `/api/v1/dfds/${ID(501)}/duplicate`;
const TARGET = ID(700);
const NEW_DFD = ID(800);

const created = (processId: string) =>
  jsonResponse(
    { data: { id: NEW_DFD, documentId: NEW_DFD, processId, code: 'DFD 0021/2026', version: 1 } },
    { status: 201, headers: { ETag: '"1"' } },
  );

const targetItem = (id: string, code: string, title: string, status = 'DRAFT') => ({
  id,
  code,
  title,
  status,
  currentStage: { key: 'ABERTURA', name: 'Abertura' },
});

interface Options {
  readonly permissions?: readonly string[];
  readonly duplicate?: (url: string, init?: RequestInit) => Response;
  readonly targets?: readonly ReturnType<typeof targetItem>[];
}

function mockApi(options: Options = {}) {
  const permissions = options.permissions ?? ['DFD_CREATE', 'PROCESS_CREATE'];
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    if (url.startsWith('/api/v1/me/permissions')) {
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
    if (method === 'POST' && url === POST_URL) {
      return Promise.resolve((options.duplicate ?? (() => created(TARGET)))(url, init));
    }
    if (method === 'GET' && url.startsWith('/api/v1/processes?')) {
      const items = options.targets ?? [];
      return Promise.resolve(
        jsonResponse({
          data: items,
          meta: { page: 1, pageSize: 10, totalItems: items.length, totalPages: 1 },
        }),
      );
    }
    return Promise.resolve(jsonResponse({ data: {} }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const noRetryClient = () => {
  const client = makeQueryClient();
  client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retry: false } });
  return client;
};

function renderDialog(options: Options = {}) {
  const api = mockApi(options);
  const onOpenChange = vi.fn();
  renderWithShell(
    <>
      <DuplicateDfdDialog dfd={DFD} open onOpenChange={onOpenChange} />
      <Toaster />
    </>,
    { queryClient: noRetryClient() },
  );
  return { api, onOpenChange };
}

const posts = (api: ReturnType<typeof mockApi>) =>
  api.mock.calls.filter(
    ([input, init]) => requestUrl(input) === POST_URL && init?.method === 'POST',
  );

describe('SCR-113 · Diálogo "Duplicar DFD" (US-018)', () => {
  it('[Sucesso] novo processo: envia o corpo com a chave de idempotência, mostra o toast e leva ao wizard do novo DFD', async () => {
    const user = userEvent.setup();
    const { api, onOpenChange } = renderDialog();

    const newProcess = await screen.findByRole('radio', { name: 'Novo processo' });
    await waitFor(() => {
      expect(newProcess.getAttribute('aria-checked')).toBe('true');
    });
    await user.click(screen.getByRole('button', { name: 'Duplicar' }));

    await waitFor(() => {
      expect(posts(api)).toHaveLength(1);
    });
    const [[, init]] = posts(api) as [[unknown, RequestInit]];
    expect(new Headers(init.headers).get('Idempotency-Key')).toBeTruthy();
    expect(bodyOf(init)).toEqual({ targetType: 'NEW_PROCESS' });
    expect(
      await screen.findByText('DFD DFD 0021/2026 criado a partir de DFD 0005/2026'),
    ).toBeTruthy();
    expect(nav.push).toHaveBeenCalledWith(`/processos/${TARGET}/dfd/${NEW_DFD}`);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('[Sucesso] processo existente: busca, escolhe e envia o targetProcessId', async () => {
    const user = userEvent.setup();
    const { api } = renderDialog({
      targets: [
        targetItem(TARGET, '0010/2026', 'Aquisição de merenda'),
        targetItem(PROCESS_ID, '0002/2025', 'O processo da origem'),
        targetItem(ID(701), '0011/2026', 'Processo suspenso', 'SUSPENDED'),
      ],
    });
    await user.click(await screen.findByRole('radio', { name: 'Processo existente' }));
    await user.type(screen.getByLabelText('Buscar processo'), 'merenda');

    const list = await screen.findByRole('list', { name: 'Processos encontrados' });
    // RN-DFD-73: nem o processo da origem nem o suspenso são oferecidos.
    expect(list.textContent).toContain('0010/2026 — Aquisição de merenda');
    expect(list.textContent).not.toContain('origem');
    expect(list.textContent).not.toContain('suspenso');
    await user.click(screen.getByRole('button', { name: /0010\/2026/ }));
    await user.click(screen.getByRole('button', { name: 'Duplicar' }));

    await waitFor(() => {
      expect(posts(api)).toHaveLength(1);
    });
    const [[, init]] = posts(api) as [[unknown, RequestInit]];
    expect(bodyOf(init)).toEqual({ targetType: 'EXISTING_PROCESS', targetProcessId: TARGET });
    await waitFor(() => {
      expect(nav.push).toHaveBeenCalledWith(`/processos/${TARGET}/dfd/${NEW_DFD}`);
    });
  });

  it('[Validação] processo existente sem escolha não chega à API', async () => {
    const user = userEvent.setup();
    const { api } = renderDialog();
    await user.click(await screen.findByRole('radio', { name: 'Processo existente' }));
    await user.click(screen.getByRole('button', { name: 'Duplicar' }));
    expect(await screen.findByText('Escolha o processo que receberá o DFD.')).toBeTruthy();
    expect(posts(api)).toHaveLength(0);
  });

  it('[Validação] 409 DOCUMENT_ALREADY_EXISTS mostra a mensagem e sugere abrir o DFD existente', async () => {
    const user = userEvent.setup();
    renderDialog({
      targets: [targetItem(TARGET, '0010/2026', 'Aquisição de merenda')],
      duplicate: () =>
        problemResponse(409, 'DOCUMENT_ALREADY_EXISTS', {
          extension: { meta: { code: 'DFD 0006/2026', existingDfdId: ID(900) } },
        }),
    });
    await user.click(await screen.findByRole('radio', { name: 'Processo existente' }));
    await user.type(screen.getByLabelText('Buscar processo'), 'merenda');
    await user.click(await screen.findByRole('button', { name: /0010\/2026/ }));
    await user.click(screen.getByRole('button', { name: 'Duplicar' }));

    expect(await screen.findByText('Este processo já possui o DFD 0006/2026.')).toBeTruthy();
    const open = screen.getByRole('link', { name: 'Abrir DFD' });
    expect(open.getAttribute('href')).toBe(`/processos/${TARGET}/dfd/${ID(900)}`);
    expect(nav.push).not.toHaveBeenCalled();
  });

  it('[Validação] 422 de etapa mostra "Este processo não aceita DFD na etapa atual."', async () => {
    const user = userEvent.setup();
    renderDialog({
      duplicate: () => problemResponse(422, 'DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE'),
    });
    await user.click(await screen.findByRole('button', { name: 'Duplicar' }));
    expect(await screen.findByText('Este processo não aceita DFD na etapa atual.')).toBeTruthy();
  });

  it('[Permissão] sem PROCESS_CREATE a opção "Novo processo" fica desabilitada e o padrão é o processo existente', async () => {
    renderDialog({ permissions: ['DFD_CREATE'] });
    const newProcess = await screen.findByRole('radio', { name: 'Novo processo' });
    await waitFor(() => {
      expect((newProcess as HTMLButtonElement).disabled).toBe(true);
    });
    expect(
      screen.getByRole('radio', { name: 'Processo existente' }).getAttribute('aria-checked'),
    ).toBe('true');
    expect(
      screen.getByText('Você não tem permissão para abrir processos neste órgão.'),
    ).toBeTruthy();
  });

  it('[Permissão] 403 da API mostra o motivo', async () => {
    const user = userEvent.setup();
    renderDialog({
      duplicate: () =>
        problemResponse(403, 'PERMISSION_DENIED', { detail: 'Você não pode duplicar o DFD.' }),
    });
    await user.click(await screen.findByRole('button', { name: 'Duplicar' }));
    expect(await screen.findByText('Você não pode duplicar o DFD.')).toBeTruthy();
  });

  it('[Falha de banco] 503 oferece "Tentar novamente" com a mesma chave de idempotência', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const { api } = renderDialog({
      duplicate: () => {
        calls += 1;
        return calls === 1 ? problemResponse(503, 'DEPENDENCY_UNAVAILABLE') : created(TARGET);
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Duplicar' }));
    await user.click(await screen.findByRole('button', { name: 'Tentar novamente' }));
    await waitFor(() => {
      expect(nav.push).toHaveBeenCalledWith(`/processos/${TARGET}/dfd/${NEW_DFD}`);
    });
    const keys = posts(api).map(([, init]) => new Headers(init?.headers).get('Idempotency-Key'));
    expect(keys.length).toBeGreaterThanOrEqual(2);
    expect(new Set(keys).size).toBe(1);
  });

  it('[Acessibilidade] sem violações sérias do axe', async () => {
    renderDialog();
    await screen.findByRole('radio', { name: 'Novo processo' });
    expect(await seriousA11yViolations()).toEqual([]);
  });
});

describe('Botão "Duplicar DFD"', () => {
  it('só aparece com DFD_CREATE (UI oculta sem permissão) e abre o diálogo', async () => {
    const user = userEvent.setup();
    mockApi({ permissions: ['DFD_CREATE', 'PROCESS_CREATE'] });
    renderWithShell(<DuplicateDfdButton dfd={DFD} />, { queryClient: noRetryClient() });
    await user.click(await screen.findByRole('button', { name: 'Duplicar DFD' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('sem DFD_CREATE nada é renderizado', async () => {
    mockApi({ permissions: ['PROCESS_VIEW'] });
    renderWithShell(<DuplicateDfdButton dfd={DFD} />, { queryClient: noRetryClient() });
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Duplicar DFD' })).toBeNull();
    });
  });
});
