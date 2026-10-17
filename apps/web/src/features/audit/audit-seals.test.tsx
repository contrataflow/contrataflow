// @vitest-environment jsdom
import { AUDIT_SEAL_MESSAGES } from '@contrataflow/validation';
import type { AuditSealDto, AuditSealVerification } from '@contrataflow/validation';
import { QueryClient } from '@tanstack/react-query';
import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MainNav } from '@/components/shell/main-nav';
import { seriousA11yViolations } from '@test/support/axe';
import { jsonResponse, problem, renderWithShell, requestUrl } from '@test/support/render';

import { AuditView } from './audit-view';

configure({ asyncUtilTimeout: 5_000 });

vi.setConfig({ testTimeout: 30_000 });

vi.mock('next/navigation', () => ({
  usePathname: () => '/auditoria',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const field = (label: string) => screen.getByLabelText<HTMLInputElement>(label);

const hex = (char: string) => char.repeat(64);

function seal(hour: number, recordCount = 10): AuditSealDto {
  const start = new Date(Date.UTC(2026, 9, 15, hour));
  return {
    id: `0192a000-0000-7000-8000-0000000074${String(hour).padStart(2, '0')}`,
    periodStart: start.toISOString(),
    periodEnd: new Date(start.getTime() + 3_600_000).toISOString(),
    recordCount,
    digest: hex('a'),
    chainHash: hex('b'),
    sealedAt: new Date(start.getTime() + 3_900_000).toISOString(),
  };
}

// 08:00, 09:00 e 10:00 em São Paulo (UTC−3).
const S1 = seal(11, 12);
const S2 = seal(12, 7);
const S3 = seal(13, 3);

const verificationOf = (
  results: AuditSealVerification['results'],
  brokenAtPeriodStart: string | null = null,
): AuditSealVerification => ({ brokenAtPeriodStart, results });

const resultOf = (
  item: AuditSealDto,
  extra: { status?: 'VALID' | 'INVALID'; brokenAt?: 'digest' | 'chain' } = {},
) => ({
  periodStart: item.periodStart,
  periodEnd: item.periodEnd,
  recordCount: item.recordCount,
  status: extra.status ?? ('VALID' as const),
  ...(extra.brokenAt ? { brokenAt: extra.brokenAt } : {}),
});

interface MockOptions {
  readonly permissions?: readonly string[];
  readonly seals?: (url: URL) => Response | Promise<Response>;
  readonly verify?: (body: Record<string, string>) => Response | Promise<Response>;
}

function page(items: AuditSealDto[], meta: Record<string, unknown> = {}) {
  return jsonResponse({
    data: items,
    meta: { page: 1, pageSize: 20, totalItems: items.length, totalPages: 1, ...meta },
  });
}

function mockApi(options: MockOptions = {}) {
  const permissions = options.permissions ?? ['AUDIT_VIEW'];
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
    if (url.pathname === '/api/v1/audit/seals/verify') {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
        string,
        string
      >;
      return Promise.resolve(options.verify?.(body) ?? jsonResponse({ data: verificationOf([]) }));
    }
    if (url.pathname === '/api/v1/audit/seals') {
      return Promise.resolve(options.seals?.(url) ?? page([S1, S2, S3]));
    }
    return Promise.resolve(problem(404, 'NOT_FOUND'));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const callsTo = (fetchMock: ReturnType<typeof mockApi>, pathname: string) =>
  fetchMock.mock.calls.filter(
    ([input]) => new URL(requestUrl(input), 'http://localhost').pathname === pathname,
  );

const validationProblem = (message: string) =>
  new Response(
    JSON.stringify({
      type: 'https://docs.contrataflow.com.br/errors/validation-error',
      title: 'VALIDATION_ERROR',
      status: 422,
      detail: 'VALIDATION_ERROR',
      instance: '/api/v1/audit/seals/verify',
      code: 'VALIDATION_ERROR',
      correlationId: 'c-422',
      errors: [{ field: 'periodEnd', code: 'OUT_OF_RANGE', message }],
      violations: [],
    }),
    { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
  );

async function renderTab() {
  const view = renderWithShell(<AuditView defaultTab="seals" />);
  await screen.findByRole('table', { name: 'Selos de integridade da trilha de auditoria' });
  return view;
}

/** Marca os selos e preenche o intervalo: 08:00 a 11:00 (horário da instituição). */
async function selectAllSeals() {
  for (const checkbox of screen.getAllByRole('checkbox')) fireEvent.click(checkbox);
  await waitFor(() => {
    expect(field('Início do período').value).toBe('2026-10-15T08:00');
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[Permissão] acesso por AUDIT_VIEW (SCR-037)', () => {
  it('sem a permissão a aba "Selos" não aparece e nenhum selo é pedido', async () => {
    const fetchMock = mockApi({ permissions: ['PROCESS_CREATE'] });
    renderWithShell(<AuditView defaultTab="seals" />);
    expect(await screen.findByText('Você não tem acesso a esta área')).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Selos' })).toBeNull();
    expect(callsTo(fetchMock, '/api/v1/audit/seals')).toHaveLength(0);
  });

  it('com a permissão, a aba "Selos" mostra a lista', async () => {
    mockApi();
    await renderTab();
    expect(screen.getByRole('heading', { level: 1, name: 'Auditoria' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Selos', selected: true })).toBeTruthy();
  });

  it('o menu lateral só mostra "Auditoria" a quem tem AUDIT_VIEW', async () => {
    mockApi({ permissions: ['PROCESS_CREATE'] });
    const withoutPermission = renderWithShell(<MainNav />);
    expect(await screen.findByRole('link', { name: 'Processos' })).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: 'Auditoria' })).toBeNull();
    });
    withoutPermission.unmount();

    mockApi({ permissions: ['AUDIT_VIEW'] });
    renderWithShell(<MainNav />);
    expect((await screen.findByRole('link', { name: 'Auditoria' })).getAttribute('href')).toBe(
      '/auditoria',
    );
  });
});

describe('SealList (AUD-04)', () => {
  it('mostra skeleton ao carregar e depois período no fuso da instituição, registros e "Não verificado"', async () => {
    mockApi();
    renderWithShell(<AuditView defaultTab="seals" />);
    expect(await screen.findByText('Carregando os selos…')).toBeTruthy();
    const table = await screen.findByRole('table', {
      name: 'Selos de integridade da trilha de auditoria',
    });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    // 11:00Z = 08:00 em São Paulo.
    expect(rows[0]?.textContent).toMatch(/15\/10\/2026.*08:00.*15\/10\/2026.*09:00/);
    expect(rows[0]?.textContent).toContain('12');
    for (const row of rows) expect(row.textContent).toContain('Não verificado');
  });

  it('a tabela de selos rola na horizontal em telas estreitas', async () => {
    mockApi();
    await renderTab();
    const table = screen.getByRole('table', {
      name: 'Selos de integridade da trilha de auditoria',
    });
    expect(table.parentElement?.classList.contains('overflow-x-auto')).toBe(true);
  });

  it('estado vazio', async () => {
    mockApi({ seals: () => page([]) });
    renderWithShell(<AuditView defaultTab="seals" />);
    expect(await screen.findByText('Nenhum selo gerado ainda para este período')).toBeTruthy();
  });

  it('erro de carregamento com "Tentar novamente"', async () => {
    let attempts = 0;
    mockApi({
      seals: () => {
        attempts += 1;
        return attempts === 1 ? problem(500, 'INTERNAL_ERROR') : page([S1]);
      },
    });
    renderWithShell(<AuditView defaultTab="seals" />, {
      queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    });
    expect(await screen.findByText('Não foi possível carregar os selos agora.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(
      await screen.findByRole('table', { name: 'Selos de integridade da trilha de auditoria' }),
    ).toBeTruthy();
  });

  it('pagina por página (page/pageSize)', async () => {
    const fetchMock = mockApi({
      seals: (url) =>
        url.searchParams.get('page') === '2'
          ? page([S3], { page: 2, totalItems: 21, totalPages: 2 })
          : page([S1, S2], { totalItems: 21, totalPages: 2 }),
    });
    await renderTab();
    expect(screen.getByText('Página 1 de 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Próxima' }));
    expect(await screen.findByText('Página 2 de 2')).toBeTruthy();
    const urls = callsTo(fetchMock, '/api/v1/audit/seals').map(
      ([input]) => new URL(requestUrl(input), 'http://localhost'),
    );
    expect(urls.at(-1)?.searchParams.get('page')).toBe('2');
    expect(urls.at(-1)?.searchParams.get('pageSize')).toBe('20');
  });

  it('selecionar selos preenche o intervalo (menor início, maior fim)', async () => {
    mockApi();
    await renderTab();
    fireEvent.click(screen.getByRole('checkbox', { name: /08:00 a / }));
    fireEvent.click(screen.getByRole('checkbox', { name: /10:00 a / }));
    await waitFor(() => {
      expect(field('Início do período').value).toBe('2026-10-15T08:00');
    });
    expect(field('Fim do período').value).toBe('2026-10-15T11:00');
    expect(screen.getByText('2 selos selecionados')).toBeTruthy();
  });
});

describe('SealVerificationPanel e SealVerificationResult (AUD-05)', () => {
  it('verificar intervalo íntegro: corpo em ISO UTC, status "Íntegro" no resultado e na lista, foco no resultado', async () => {
    const fetchMock = mockApi({
      verify: () =>
        jsonResponse({ data: verificationOf([resultOf(S1), resultOf(S2), resultOf(S3)]) }),
    });
    await renderTab();
    await selectAllSeals();
    fireEvent.click(screen.getByRole('button', { name: 'Verificar integridade' }));

    const heading = await screen.findByRole('heading', { name: 'Resultado da verificação' });
    expect(await screen.findByText('Todos os 3 selos do intervalo estão íntegros.')).toBeTruthy();
    expect(document.activeElement).toBe(heading);
    expect(
      JSON.parse(callsTo(fetchMock, '/api/v1/audit/seals/verify')[0]?.[1]?.body as string),
    ).toEqual({ periodStart: '2026-10-15T11:00:00Z', periodEnd: '2026-10-15T14:00:00Z' });

    const result = screen.getByRole('table', { name: 'Resultado da verificação por selo' });
    expect(within(result).getAllByText('Íntegro')).toHaveLength(3);
    // A lista também passa a mostrar o status dos selos cobertos.
    const list = screen.getByRole('table', { name: 'Selos de integridade da trilha de auditoria' });
    expect(within(list).getAllByText('Íntegro')).toHaveLength(3);
    expect(within(list).queryByText('Não verificado')).toBeNull();
  });

  it('resultado INVALID: texto "Quebrado", detalhe por tipo de quebra e cadeia comprometida', async () => {
    mockApi({
      verify: () =>
        jsonResponse({
          data: verificationOf(
            [
              resultOf(S1),
              resultOf(S2, { status: 'INVALID', brokenAt: 'digest' }),
              resultOf(S3, { status: 'INVALID', brokenAt: 'chain' }),
            ],
            S2.periodStart,
          ),
        }),
    });
    await renderTab();
    await selectAllSeals();
    fireEvent.click(screen.getByRole('button', { name: 'Verificar integridade' }));

    expect(
      await screen.findByText(/Cadeia comprometida a partir de .*15\/10\/2026.*09:00/),
    ).toBeTruthy();
    expect(screen.getByText('2 selos do intervalo estão quebrados.')).toBeTruthy();
    const result = screen.getByRole('table', { name: 'Resultado da verificação por selo' });
    expect(within(result).getAllByText('Quebrado')).toHaveLength(2);
    expect(
      within(result).getByText('Registro do período alterado, removido ou inserido'),
    ).toBeTruthy();
    expect(within(result).getByText('Selo anterior alterado ou ausente')).toBeTruthy();

    const list = screen.getByRole('table', { name: 'Selos de integridade da trilha de auditoria' });
    expect(within(list).getAllByText('Quebrado')).toHaveLength(2);
    expect(within(list).getAllByText('Íntegro')).toHaveLength(1);
  });

  it('V-02: fim anterior ao início é barrado no front, com a mensagem compartilhada, sem chamar a API', async () => {
    const fetchMock = mockApi();
    await renderTab();
    fireEvent.change(screen.getByLabelText('Início do período'), {
      target: { value: '2026-10-15T10:00' },
    });
    fireEvent.change(screen.getByLabelText('Fim do período'), {
      target: { value: '2026-10-15T09:00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Verificar integridade' }));
    expect(await screen.findByText(AUDIT_SEAL_MESSAGES.periodRange)).toBeTruthy();
    expect(field('Fim do período').getAttribute('aria-invalid')).toBe('true');
    expect(callsTo(fetchMock, '/api/v1/audit/seals/verify')).toHaveLength(0);
  });

  it('campos vazios pedem a data e a hora', async () => {
    const fetchMock = mockApi();
    await renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'Verificar integridade' }));
    expect(await screen.findAllByText('Informe a data e a hora.')).toHaveLength(2);
    expect(callsTo(fetchMock, '/api/v1/audit/seals/verify')).toHaveLength(0);
  });

  it('FA-04: 422 mostra a mensagem da API no campo do fim e some ao editar o intervalo', async () => {
    const message = AUDIT_SEAL_MESSAGES.tooManyPeriods(720);
    mockApi({ verify: () => validationProblem(message) });
    await renderTab();
    await selectAllSeals();
    fireEvent.click(screen.getByRole('button', { name: 'Verificar integridade' }));
    expect(await screen.findByText(message)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Fim do período'), {
      target: { value: '2026-10-15T10:00' },
    });
    await waitFor(() => {
      expect(screen.queryByText(message)).toBeNull();
    });
  });

  it('404: "Selo não encontrado." com volta à lista (recarrega os selos)', async () => {
    const fetchMock = mockApi({ verify: () => problem(404, 'NOT_FOUND') });
    await renderTab();
    await selectAllSeals();
    fireEvent.click(screen.getByRole('button', { name: 'Verificar integridade' }));
    expect(await screen.findByText(AUDIT_SEAL_MESSAGES.notFound)).toBeTruthy();
    const before = callsTo(fetchMock, '/api/v1/audit/seals').length;
    fireEvent.click(screen.getByRole('button', { name: 'Voltar à lista' }));
    await waitFor(() => {
      expect(callsTo(fetchMock, '/api/v1/audit/seals').length).toBeGreaterThan(before);
    });
    expect(screen.queryByText(AUDIT_SEAL_MESSAGES.notFound)).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Selos gerados' }));
  });

  it('503: mensagem de indisponibilidade com código de suporte e "Tentar novamente"', async () => {
    let attempts = 0;
    const fetchMock = mockApi({
      verify: () => {
        attempts += 1;
        return attempts === 1
          ? problem(503, 'DEPENDENCY_UNAVAILABLE', 'c-503')
          : jsonResponse({ data: verificationOf([resultOf(S1)]) });
      },
    });
    await renderTab();
    await selectAllSeals();
    fireEvent.click(screen.getByRole('button', { name: 'Verificar integridade' }));
    expect(await screen.findByText(AUDIT_SEAL_MESSAGES.unavailable)).toBeTruthy();
    expect(screen.getByText('Código de suporte: c-503.')).toBeTruthy();
    const alert = screen.getByText(AUDIT_SEAL_MESSAGES.unavailable).closest('[role="alert"]');
    fireEvent.click(within(alert as HTMLElement).getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByText('O selo do intervalo está íntegro.')).toBeTruthy();
    expect(callsTo(fetchMock, '/api/v1/audit/seals/verify')).toHaveLength(2);
  });

  it('403 MFA_REQUIRED: pede a confirmação da identidade (step-up) e retoma em /auditoria', async () => {
    mockApi({ verify: () => problem(403, 'MFA_REQUIRED') });
    await renderTab();
    await selectAllSeals();
    fireEvent.click(screen.getByRole('button', { name: 'Verificar integridade' }));
    const link = await screen.findByRole('link', { name: 'Confirmar identidade' });
    expect(link.getAttribute('href')).toBe('/api/auth/step-up?returnTo=%2Fauditoria');
  });

  it('carregamento próprio durante a verificação: botão desabilitado e aviso de espera', async () => {
    let release: (response: Response) => void = () => undefined;
    mockApi({
      verify: () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    });
    await renderTab();
    await selectAllSeals();
    fireEvent.click(screen.getByRole('button', { name: 'Verificar integridade' }));
    expect(await screen.findByText(/Verificando a integridade dos selos/)).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Verificando…' }).disabled).toBe(
      true,
    );
    release(jsonResponse({ data: verificationOf([resultOf(S1)]) }));
    expect(
      await screen.findByRole('table', { name: 'Resultado da verificação por selo' }),
    ).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Verificar integridade' }).disabled,
    ).toBe(false);
  });
});

describe('[Acessibilidade] aba "Selos"', () => {
  it('sem violações sérias (axe) na lista, no painel e no resultado', async () => {
    mockApi({
      verify: () =>
        jsonResponse({
          data: verificationOf(
            [resultOf(S1), resultOf(S2, { status: 'INVALID', brokenAt: 'digest' })],
            S2.periodStart,
          ),
        }),
    });
    await renderTab();
    expect(await seriousA11yViolations()).toEqual([]);
    await selectAllSeals();
    fireEvent.click(screen.getByRole('button', { name: 'Verificar integridade' }));
    await screen.findByRole('table', { name: 'Resultado da verificação por selo' });
    expect(await seriousA11yViolations()).toEqual([]);
  });
});
