// @vitest-environment jsdom
import { Toaster, clearToasts } from '@contrataflow/ui';
import type { AuditLogDto } from '@contrataflow/validation';
import { QueryClient } from '@tanstack/react-query';
import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { jsonResponse, problem, renderWithShell, requestUrl } from '@test/support/render';

import { AuditView } from './audit-view';

configure({ asyncUtilTimeout: 5_000 });

vi.setConfig({ testTimeout: 30_000 });

vi.mock('next/navigation', () => ({
  usePathname: () => '/auditoria',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

/** "Agora" fixo: 17/10/2026 12:00 UTC (09:00 em São Paulo). */
const NOW = new Date('2026-10-17T12:00:00.000Z');
const ANA = '0192a000-0000-7000-8000-0000000000a1';
const PROC = '0192a000-0000-7000-8000-0000000000f1';

function log(index: number, overrides: Partial<AuditLogDto> = {}): AuditLogDto {
  return {
    id: `0192d075-0000-7000-8000-${String(index).padStart(12, '0')}`,
    occurredAt: new Date(NOW.getTime() - index * 3_600_000).toISOString(),
    actorType: 'USER',
    actorUserId: ANA,
    actorName: 'Ana Souza',
    actorMembershipId: null,
    onBehalfOfUserId: null,
    action: 'process.create',
    category: 'DATA_CHANGE',
    result: 'SUCCESS',
    entityType: 'Process',
    entityId: PROC,
    processId: PROC,
    changes: [
      { path: 'contactCpf', old: '***.456.789-**', new: '***.654.321-**' },
      { path: 'notes', old: null, new: { hash: 'ab12cd34ef56ab12cd34', length: 800 } },
    ],
    metadata: { processCode: '0012/2026' },
    reasonCode: null,
    ip: '10.0.0.1',
    userAgent: 'Firefox',
    correlationId: 'corr-1',
    requestId: null,
    sessionIdHash: null,
    rowHash: 'f'.repeat(64),
    ...overrides,
  };
}

const L1 = log(1);
const L2 = log(2, {
  action: 'access.denied',
  category: 'ACCESS',
  result: 'DENIED',
  reasonCode: 'PROCESS_CREATE',
  changes: null,
});

interface MockOptions {
  readonly permissions?: readonly string[];
  readonly search?: (url: URL) => Response | Promise<Response>;
  readonly detail?: (id: string) => Response | Promise<Response>;
  readonly exportFile?: (url: URL) => Response | Promise<Response>;
}

function feed(items: AuditLogDto[], nextCursor: string | null = null) {
  return jsonResponse({ data: items, meta: { nextCursor, hasMore: nextCursor !== null } });
}

function mockApi(options: MockOptions = {}) {
  const permissions = options.permissions ?? ['AUDIT_VIEW', 'AUDIT_EXPORT'];
  const fetchMock = vi.fn<typeof fetch>((input) => {
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
    if (url.pathname === '/api/v1/audit/export') {
      return Promise.resolve(
        options.exportFile?.(url) ??
          new Response(
            `${String.fromCharCode(0xfeff)}id,action\r\n1,"a,b"\r\n2,"linha\r\nquebrada"\r\n`,
            {
              status: 200,
              headers: {
                'Content-Type': 'text/csv; charset=utf-8',
                'Content-Disposition': 'attachment; filename="auditoria-20261010-20261017.csv"',
              },
            },
          ),
      );
    }
    if (url.pathname === '/api/v1/audit') {
      return Promise.resolve(options.search?.(url) ?? feed([L1, L2]));
    }
    if (url.pathname.startsWith('/api/v1/audit/')) {
      const id = url.pathname.split('/').at(-1) ?? '';
      const found = [L1, L2].find((item) => item.id === id);
      return Promise.resolve(
        options.detail?.(id) ?? (found ? jsonResponse({ data: found }) : problem(404, 'NOT_FOUND')),
      );
    }
    return Promise.resolve(problem(404, 'NOT_FOUND'));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const urlsTo = (fetchMock: ReturnType<typeof mockApi>, pathname: string) =>
  fetchMock.mock.calls
    .map(([input]) => new URL(requestUrl(input), 'http://localhost'))
    .filter((url) => url.pathname === pathname);

/** Abre o painel lateral "Filtros" da barra (prd-5 · regra 2). */
async function openFilters() {
  fireEvent.click(screen.getByRole('button', { name: 'Filtros' }));
  return screen.findByRole('dialog', { name: 'Filtros da auditoria' });
}

async function renderRecords(options: { queryClient?: QueryClient } = {}) {
  const view = renderWithShell(
    <>
      <AuditView />
      <Toaster label="Notificações" closeLabel="Fechar" />
    </>,
    options,
  );
  await screen.findByRole('table', { name: 'Registros da trilha de auditoria' });
  return view;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearToasts();
  sessionStorage.clear();
});

describe('[Sucesso] pesquisar e ver o detalhe (SCR-037 · AUD-01/AUD-02)', () => {
  it('abre na aba "Registros" com o período padrão dos últimos 7 dias no fuso da instituição', async () => {
    const fetchMock = mockApi();
    await renderRecords();
    expect(screen.getByRole('tab', { name: 'Registros', selected: true })).toBeTruthy();
    // 09:00 de 17/10 em São Paulo; 7 dias antes. O período aparece no rodapé da tabela.
    expect(screen.getByText('· 10/10/2026 a 17/10/2026')).toBeTruthy();
    const [url] = urlsTo(fetchMock, '/api/v1/audit');
    expect(url?.searchParams.get('occurredFrom')).toBe('2026-10-10T12:00:00Z');
    expect(url?.searchParams.get('occurredTo')).toBe('2026-10-17T12:00:00Z');
    expect(url?.searchParams.get('limit')).toBe('50');
    const rows = within(screen.getByRole('table', { name: 'Registros da trilha de auditoria' }))
      .getAllByRole('row')
      .slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('Processo criado');
    expect(rows[0]?.textContent).toContain('Sucesso');
    expect(rows[1]?.textContent).toContain('Acesso negado');
    expect(rows[1]?.textContent).toContain('Negado');
    // No painel "Filtros", o mesmo período no seletor de datas.
    const panel = await openFilters();
    expect(within(panel).getByRole('button', { name: 'Período' }).textContent).toContain(
      '10/10/2026 a 17/10/2026',
    );
  });

  it('filtrar por ação envia a ação e o período; a lista mostra só o que a API devolveu', async () => {
    const fetchMock = mockApi({
      search: (url) =>
        url.searchParams.get('action') === 'process.create' ? feed([L1]) : feed([L1, L2]),
    });
    await renderRecords();
    const user = userEvent.setup();
    const panel = await openFilters();
    await user.click(within(panel).getByRole('combobox', { name: 'Ação' }));
    await user.click(await screen.findByRole('option', { name: 'Processo criado' }));
    await user.click(within(panel).getByRole('button', { name: 'Pesquisar' }));
    await waitFor(() => {
      expect(urlsTo(fetchMock, '/api/v1/audit').at(-1)?.searchParams.get('action')).toBe(
        'process.create',
      );
    });
    const table = screen.getByRole('table', { name: 'Registros da trilha de auditoria' });
    await waitFor(() => {
      expect(within(table).queryByText('Acesso negado')).toBeNull();
    });
    // O painel fecha e o filtro aplicado vira chip removível.
    expect(screen.queryByRole('dialog', { name: 'Filtros da auditoria' })).toBeNull();
    await user.click(
      screen.getByRole('button', { name: 'Remover o filtro Ação: Processo criado' }),
    );
    // Sem a ação, volta a consulta anterior (em cache): os dois registros reaparecem.
    expect(await within(table).findByText('Acesso negado')).toBeTruthy();
    expect(screen.queryByText('Ação: Processo criado')).toBeNull();
  });

  it('abrir um registro mostra o diff mascarado com "Antes"/"Depois" e permite filtrar pelo ator', async () => {
    const fetchMock = mockApi();
    await renderRecords();
    fireEvent.click(screen.getByRole('button', { name: /Ver detalhe: Processo criado/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Registro de auditoria' });
    const diff = await within(dialog).findByRole('table', {
      name: 'Alterações do registro (antes e depois)',
    });
    expect(within(diff).getByRole('columnheader', { name: 'Antes' })).toBeTruthy();
    expect(within(diff).getByRole('columnheader', { name: 'Depois' })).toBeTruthy();
    expect(diff.textContent).toContain('***.456.789-**');
    expect(diff.textContent).toContain('Conteúdo resumido: 800 caracteres (hash ab12cd34ef56…)');
    expect(within(dialog).getByText('f'.repeat(64))).toBeTruthy();
    expect(urlsTo(fetchMock, `/api/v1/audit/${L1.id}`)).toHaveLength(1);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Filtrar por este ator' }));
    await waitFor(() => {
      expect(urlsTo(fetchMock, '/api/v1/audit').at(-1)?.searchParams.get('actorUserId')).toBe(ANA);
    });
    expect(screen.getByText('Ator: Ana Souza')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Filtros, 1 filtro ativo' })).toBeTruthy();
  });

  it('FA-05: registro coalescido com o intervalo de salvamentos no metadata mostra o aviso', async () => {
    const draft = log(3, {
      action: 'document.draft_update',
      changes: null,
      metadata: {
        coalesce: {
          scope: 'JUSTIFICATION',
          firstSavedAt: '2026-10-17T10:00:00.000Z',
          lastSavedAt: '2026-10-17T10:09:00.000Z',
        },
      },
    });
    mockApi({ search: () => feed([draft]), detail: () => jsonResponse({ data: draft }) });
    await renderRecords();
    fireEvent.click(
      screen.getByRole('button', { name: /Ver detalhe: Rascunho do documento editado/ }),
    );
    expect(
      await screen.findByText(
        'Este registro resume múltiplas edições entre 17/10/2026, 07:00 e 17/10/2026, 07:09 salvamento.',
      ),
    ).toBeTruthy();
  });

  it('"Carregar mais" segue o cursor', async () => {
    const fetchMock = mockApi({
      search: (url) => (url.searchParams.get('cursor') === 'c2' ? feed([L2]) : feed([L1], 'c2')),
    });
    await renderRecords();
    fireEvent.click(screen.getByRole('button', { name: 'Carregar mais' }));
    expect(await screen.findByText('Acesso negado')).toBeTruthy();
    expect(urlsTo(fetchMock, '/api/v1/audit').at(-1)?.searchParams.get('cursor')).toBe('c2');
    expect(screen.getByText('2 registros carregados')).toBeTruthy();
  });
});

describe('[Validação] período (V-01/V-02)', () => {
  it('período acima de 90 dias: mensagem no campo e nada é pesquisado', async () => {
    const fetchMock = mockApi();
    await renderRecords();
    const before = urlsTo(fetchMock, '/api/v1/audit').length;
    const user = userEvent.setup();
    const panel = await openFilters();
    await user.click(within(panel).getByRole('button', { name: 'Período' }));
    const calendar = await screen.findByRole('dialog', { name: 'Escolher período' });
    for (let month = 0; month < 4; month += 1) {
      await user.click(within(calendar).getByRole('button', { name: 'Ir para o mês anterior' }));
    }
    await user.click(within(calendar).getByRole('button', { name: /, 1 de junho/ }));
    await user.keyboard('{Escape}');
    const period = within(panel).getByRole('button', { name: 'Período' });
    expect(period.textContent).toContain('01/06/2026 a 17/10/2026');
    await user.click(within(panel).getByRole('button', { name: 'Pesquisar' }));
    expect(await within(panel).findByText('Selecione um período de até 90 dias.')).toBeTruthy();
    expect(period.getAttribute('aria-invalid')).toBe('true');
    expect(urlsTo(fetchMock, '/api/v1/audit')).toHaveLength(before);
  });

  it('FA-01: nenhum registro → estado vazio com sugestão de ampliar o período', async () => {
    mockApi({ search: () => feed([]) });
    renderWithShell(<AuditView />);
    expect(
      await screen.findByText(
        'Nenhum registro de auditoria encontrado para os filtros selecionados.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Amplie o período ou remova filtros.')).toBeTruthy();
  });
});

describe('[Permissão] AUDIT_EXPORT (SCR-037)', () => {
  it('sem AUDIT_EXPORT o botão "Exportar" não aparece', async () => {
    mockApi({ permissions: ['AUDIT_VIEW'] });
    await renderRecords();
    expect(screen.queryByRole('button', { name: 'Exportar' })).toBeNull();
  });

  it('sem AUDIT_VIEW a tela não mostra as abas nem pesquisa', async () => {
    const fetchMock = mockApi({ permissions: ['PROCESS_CREATE'] });
    renderWithShell(<AuditView />);
    expect(await screen.findByText('Você não tem acesso a esta área')).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Registros' })).toBeNull();
    expect(urlsTo(fetchMock, '/api/v1/audit')).toHaveLength(0);
  });
});

describe('ExportDialog (AUD-03)', () => {
  const createObjectURL = vi.fn(() => 'blob:x');

  beforeEach(() => {
    // jsdom não implementa URL de objeto: o download real é coberto no E2E.
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
  });

  it('[Sucesso] exporta em CSV com os filtros aplicados e avisa a quantidade de registros', async () => {
    const fetchMock = mockApi();
    await renderRecords();
    fireEvent.click(screen.getByRole('button', { name: 'Exportar' }));
    const dialog = await screen.findByRole('dialog', { name: 'Exportar registros' });
    expect(
      within(dialog).getByRole('radio', { name: 'CSV (planilha)' }).getAttribute('aria-checked'),
    ).toBe('true');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Exportar' }));
    expect(await screen.findByText('Exportação concluída: 2 registros')).toBeTruthy();
    const [url] = urlsTo(fetchMock, '/api/v1/audit/export');
    expect(url?.searchParams.get('format')).toBe('csv');
    expect(url?.searchParams.get('occurredFrom')).toBe('2026-10-10T12:00:00Z');
    expect(url?.searchParams.get('cursor')).toBeNull();
    expect(createObjectURL).toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Exportar registros' })).toBeNull();
    });
  });

  it('NDJSON: conta uma linha por registro', async () => {
    const fetchMock = mockApi({
      exportFile: () =>
        new Response('{"id":"1"}\n{"id":"2"}\n{"id":"3"}\n', {
          status: 200,
          headers: { 'Content-Type': 'application/x-ndjson' },
        }),
    });
    await renderRecords();
    fireEvent.click(screen.getByRole('button', { name: 'Exportar' }));
    const dialog = await screen.findByRole('dialog', { name: 'Exportar registros' });
    fireEvent.click(
      within(dialog).getByRole('radio', { name: 'NDJSON (um registro JSON por linha)' }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Exportar' }));
    expect(await screen.findByText('Exportação concluída: 3 registros')).toBeTruthy();
    expect(urlsTo(fetchMock, '/api/v1/audit/export')[0]?.searchParams.get('format')).toBe('ndjson');
  });

  it('[Falha de integração] 422 EXPORT_TOO_LARGE: mensagem da API e sugestão de refinar', async () => {
    mockApi({
      exportFile: () =>
        new Response(
          JSON.stringify({
            type: 'https://docs.contrataflow.com.br/errors/export-too-large',
            title: 'Exportação acima do limite',
            status: 422,
            detail: 'Muitos registros para exportar (150.000). Refine o período ou os filtros.',
            instance: '/api/v1/audit/export',
            code: 'EXPORT_TOO_LARGE',
            correlationId: 'c-422',
            errors: [],
            violations: [],
          }),
          { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
        ),
    });
    await renderRecords();
    fireEvent.click(screen.getByRole('button', { name: 'Exportar' }));
    const dialog = await screen.findByRole('dialog', { name: 'Exportar registros' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Exportar' }));
    expect(
      await within(dialog).findByText(
        'Muitos registros para exportar (150.000). Refine o período ou os filtros.',
      ),
    ).toBeTruthy();
    expect(
      within(dialog).getByText('Reduza o período ou adicione filtros e tente novamente.'),
    ).toBeTruthy();
  });

  it('FA-04: MFA exigido na exportação → a pendência fica guardada e é repetida na volta do step-up', async () => {
    let exports = 0;
    const fetchMock = mockApi({
      exportFile: () => {
        exports += 1;
        return exports === 1
          ? problem(403, 'MFA_REQUIRED')
          : new Response('{"id":"1"}\n', { status: 200 });
      },
    });
    const first = await renderRecords();
    fireEvent.click(screen.getByRole('button', { name: 'Exportar' }));
    const dialog = await screen.findByRole('dialog', { name: 'Exportar registros' });
    fireEvent.click(
      within(dialog).getByRole('radio', { name: 'NDJSON (um registro JSON por linha)' }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Exportar' }));
    await waitFor(() => {
      expect(exports).toBe(1);
    });
    await waitFor(() => {
      expect(sessionStorage.getItem('cf.audit.pendingExport')).toContain('"format":"ndjson"');
    });
    first.unmount();

    // Volta do step-up: a tela monta de novo e repete a exportação sozinha.
    await renderRecords();
    expect(await screen.findByText('Exportação concluída: 1 registro')).toBeTruthy();
    expect(urlsTo(fetchMock, '/api/v1/audit/export').at(-1)?.searchParams.get('format')).toBe(
      'ndjson',
    );
    expect(sessionStorage.getItem('cf.audit.pendingExport')).toBeNull();
  });
});

describe('[Falha de banco] e [Tenant incorreto]', () => {
  it('503 na pesquisa: mensagem com o correlationId e "Tentar novamente"', async () => {
    let attempts = 0;
    mockApi({
      search: () => {
        attempts += 1;
        return attempts === 1 ? problem(503, 'DEPENDENCY_UNAVAILABLE', 'c-503') : feed([L1]);
      },
    });
    renderWithShell(<AuditView />, {
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    });
    expect(
      await screen.findByText(
        'Não foi possível consultar a auditoria agora. Tente novamente em instantes.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Código de suporte: c-503.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(
      await screen.findByRole('table', { name: 'Registros da trilha de auditoria' }),
    ).toBeTruthy();
  });

  it('detalhe de registro inexistente/de outro tenant (404): o painel fecha com o aviso', async () => {
    mockApi({ detail: () => problem(404, 'NOT_FOUND') });
    await renderRecords();
    fireEvent.click(screen.getByRole('button', { name: /Ver detalhe: Processo criado/ }));
    expect(await screen.findByText('Registro de auditoria não encontrado.')).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Registro de auditoria' })).toBeNull();
    });
  });
});

describe('abas e acessibilidade (SCR-037)', () => {
  it('troca para "Selos" por clique e volta por teclado (setas)', async () => {
    mockApi();
    await renderRecords();
    const user = userEvent.setup();
    const records = screen.getByRole('tab', { name: 'Registros' });
    await user.click(screen.getByRole('tab', { name: 'Selos' }));
    expect(screen.getByRole('tab', { name: 'Selos', selected: true })).toBeTruthy();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Registros', selected: true })).toBe(records);
    expect(document.activeElement).toBe(records);
  });

  it('sem violações sérias de acessibilidade na lista e no detalhe (axe)', async () => {
    mockApi();
    await renderRecords();
    expect(await seriousA11yViolations()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: /Ver detalhe: Processo criado/ }));
    await screen.findByRole('table', { name: 'Alterações do registro (antes e depois)' });
    expect(await seriousA11yViolations()).toEqual([]);
  });
});
