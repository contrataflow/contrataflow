// @vitest-environment jsdom
import { SETTING_DEFINITIONS } from '@contrataflow/validation';
import type { AiUsageDto, SettingsMapDto } from '@contrataflow/validation';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SettingsView } from '@/features/settings/settings-view';
import { seriousA11yViolations } from '@test/support/axe';
import { chooseOption } from '@test/support/kit';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { parseLimit } from './ai-settings-section';
import { shiftMonth } from './ai-usage-card';

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/admin/configuracoes',
  useSearchParams: () => new URLSearchParams(),
}));

const LUCIA = '0192a116-0000-7000-8000-0000000000a6';

/** SET-01 com todas as chaves no padrão (IA desligada, sem termos) e versão 1. */
function catalog(overrides: SettingsMapDto = {}): SettingsMapDto {
  const entries = SETTING_DEFINITIONS.map(
    (definition) => [definition.key, { value: definition.defaultValue, version: 1 }] as const,
  );
  return { ...Object.fromEntries(entries), ...overrides };
}

const META = {
  aiTerms: { currentVersion: '2026-10', provider: 'fake', maxMonthlyTokens: 20_000_000 },
};

function usage(overrides: Partial<AiUsageDto> = {}): AiUsageDto {
  return {
    month: '2026-10',
    limitTokens: 2_000_000,
    usedTokens: 900_000,
    reservedTokens: 15_000,
    costUsd: '1.250000',
    generations: {
      total: 12,
      byStatus: {
        QUEUED: 1,
        RUNNING: 0,
        SUCCEEDED: 9,
        FAILED: 1,
        CANCELED: 1,
        APPLIED: 0,
        DISCARDED: 0,
        EXPIRED: 0,
      },
    },
    byDocumentType: [
      { targetModule: 'DFD', generations: 12, totalTokens: 900_000, costUsd: '1.250000' },
    ],
    byKind: [{ kind: 'DRAFT', action: null, generations: 12, totalTokens: 900_000 }],
    byUser: [{ userId: LUCIA, name: 'Lúcia Matos', generations: 12, totalTokens: 900_000 }],
    ...overrides,
  };
}

function problem(status: number, code: string, extra: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      type: `https://docs.contrataflow.com.br/errors/${code.toLowerCase()}`,
      title: code,
      status,
      detail: code,
      instance: '/api/v1/settings',
      code,
      correlationId: 'c-test',
      errors: [],
      violations: [],
      ...extra,
    }),
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

type Handler = (url: string, init?: RequestInit) => Response;

function mockApi(
  routes: { settings?: SettingsMapDto; patch?: Handler; usage?: (url: string) => Response } = {},
) {
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    if (url.startsWith('/api/v1/me/permissions')) {
      return Promise.resolve(
        jsonResponse({ data: { permissions: [{ code: 'SETTINGS_MANAGE', scopes: [] }] } }),
      );
    }
    if (method === 'GET' && url === '/api/v1/settings') {
      return Promise.resolve(jsonResponse({ data: routes.settings ?? catalog(), meta: META }));
    }
    if (method === 'GET' && url.startsWith('/api/v1/ai/usage')) {
      return Promise.resolve((routes.usage ?? (() => jsonResponse({ data: usage() })))(url));
    }
    if (method === 'PATCH' && url === '/api/v1/settings') {
      return Promise.resolve((routes.patch ?? (() => problem(500, 'INTERNAL_ERROR')))(url, init));
    }
    return Promise.resolve(problem(404, 'NOT_FOUND'));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const bodyOf = (init?: RequestInit): Record<string, unknown> =>
  JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;

const patches = (api: ReturnType<typeof mockApi>) =>
  api.mock.calls.filter(([, init]) => init?.method === 'PATCH').map(([, init]) => bodyOf(init));

async function openAiGroup() {
  await userEvent.click(await screen.findByRole('button', { name: 'Inteligência artificial' }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SCR-041 · seção "Inteligência artificial" (US-116)', () => {
  it('[Sucesso] ligar abre os termos; "Ativar" só com o aceite; envia ai.enabled + versão vigente', async () => {
    const api = mockApi({
      patch: () =>
        jsonResponse({
          data: {
            'ai.enabled': { value: true, version: 2 },
            'ai.termsAcceptedVersion': { value: '2026-10', version: 2 },
          },
        }),
    });
    const { container } = renderWithShell(<SettingsView />);
    await openAiGroup();

    const toggle = await screen.findByRole('switch', { name: 'Usar IA neste órgão' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('Os termos de uso ainda não foram aceitos.')).toBeTruthy();
    expect(await seriousA11yViolations(container)).toEqual([]);

    await userEvent.click(toggle);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Termos de uso da inteligência artificial')).toBeTruthy();
    const activate = within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Ativar' });
    expect(activate.disabled).toBe(true);
    expect(await seriousA11yViolations(dialog)).toEqual([]);
    await userEvent.click(
      within(dialog).getByRole('checkbox', {
        name: 'Li e aceito os termos de uso da versão 2026-10',
      }),
    );
    await userEvent.click(activate);

    await waitFor(() => {
      expect(patches(api)).toEqual([
        {
          values: { 'ai.enabled': true, 'ai.termsAcceptedVersion': '2026-10' },
          expectedVersions: { 'ai.enabled': 1, 'ai.termsAcceptedVersion': 1 },
        },
      ]);
    });
    await waitFor(() => {
      expect(
        screen.getByRole('switch', { name: 'Usar IA neste órgão' }).getAttribute('aria-checked'),
      ).toBe('true');
    });
  });

  it('[Validação] 422 AI_TERMS_NOT_ACCEPTED reabre o diálogo com a mensagem', async () => {
    mockApi({ patch: () => problem(422, 'AI_TERMS_NOT_ACCEPTED') });
    renderWithShell(<SettingsView />);
    await openAiGroup();
    await userEvent.click(await screen.findByRole('switch', { name: 'Usar IA neste órgão' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('checkbox'));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Ativar' }));
    expect(
      await within(await screen.findByRole('dialog')).findByText(
        'Aceite os termos de uso da versão atual para ativar a IA.',
      ),
    ).toBeTruthy();
  });

  it('[Validação] limites fora da faixa marcam o campo; abaixo do consumo avisa antes de salvar', async () => {
    const api = mockApi({
      patch: () =>
        jsonResponse({ data: { 'ai.monthlyTokenLimit': { value: 800_000, version: 2 } } }),
    });
    renderWithShell(<SettingsView />);
    await openAiGroup();

    const monthly = await screen.findByLabelText<HTMLInputElement>('Limite mensal de tokens');
    const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Salvar limites' });
    await userEvent.clear(monthly);
    await userEvent.type(monthly, '49999');
    expect(
      await screen.findByText(/Informe um limite entre 50.000 e 20.000.000 tokens./),
    ).toBeTruthy();
    expect(save.disabled).toBe(true);

    const daily = screen.getByLabelText<HTMLInputElement>('Pedidos por usuário por dia');
    await userEvent.clear(daily);
    await userEvent.type(daily, '501');
    expect(screen.getByText('Informe de 1 a 500 pedidos por dia.')).toBeTruthy();
    await userEvent.clear(daily);
    await userEvent.type(daily, '40');

    await userEvent.clear(monthly);
    await userEvent.type(monthly, '800000');
    expect(await screen.findByText(/O novo limite é menor que o consumo deste mês/)).toBeTruthy();
    await userEvent.click(save);
    await waitFor(() => {
      expect(patches(api)).toEqual([
        {
          values: { 'ai.monthlyTokenLimit': 800_000 },
          expectedVersions: { 'ai.monthlyTokenLimit': 1 },
        },
      ]);
    });
  });

  it('[Sucesso] desligar pede confirmação; nova versão dos termos e provedor indisponível avisam', async () => {
    const api = mockApi({
      settings: catalog({
        'ai.enabled': { value: true, version: 3 },
        'ai.termsAcceptedVersion': { value: '2025-01', version: 2 },
      }),
      patch: () => jsonResponse({ data: { 'ai.enabled': { value: false, version: 4 } } }),
    });
    renderWithShell(<SettingsView />);
    await openAiGroup();
    expect(await screen.findByText('Nova versão dos termos de uso')).toBeTruthy();

    await userEvent.click(screen.getByRole('switch', { name: 'Usar IA neste órgão' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Desligar a IA neste órgão?')).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Desligar' }));
    await waitFor(() => {
      expect(patches(api)).toEqual([
        { values: { 'ai.enabled': false }, expectedVersions: { 'ai.enabled': 3 } },
      ]);
    });
  });

  it('[Concorrência] 412 mostra o aviso de recarregar', async () => {
    mockApi({
      settings: catalog({
        'ai.enabled': { value: false, version: 1 },
        'ai.termsAcceptedVersion': { value: '2026-10', version: 1 },
      }),
      patch: () => problem(412, 'VERSION_CONFLICT'),
    });
    renderWithShell(<SettingsView />);
    await openAiGroup();
    // Termos vigentes já aceitos: liga direto, sem diálogo.
    await userEvent.click(await screen.findByRole('switch', { name: 'Usar IA neste órgão' }));
    expect(
      await screen.findByText('A configuração foi alterada por outra pessoa. Recarregue.'),
    ).toBeTruthy();
  });

  it('AiUsageCard: barra com percentual em texto, custo, divisões, mês e estados vazio/erro', async () => {
    let calls = 0;
    const api = mockApi({
      usage: (url) => {
        calls += 1;
        if (url.includes('month=2026-09')) {
          return jsonResponse({
            data: usage({
              month: '2026-09',
              usedTokens: 0,
              reservedTokens: 0,
              costUsd: '0.000000',
              generations: { total: 0, byStatus: usage().generations.byStatus },
              byDocumentType: [],
              byKind: [],
              byUser: [],
            }),
          });
        }
        if (url.includes('month=2026-08')) return problem(403, 'MFA_REQUIRED');
        return jsonResponse({ data: usage() });
      },
    });
    renderWithShell(<SettingsView />);
    await openAiGroup();

    const bar = await screen.findByRole('progressbar', { name: '45% do limite usado' });
    expect(bar.getAttribute('aria-valuenow')).toBe('45');
    expect(screen.getByText('Custo estimado: US$ 1.250000')).toBeTruthy();
    expect(screen.getAllByText('Lúcia Matos').length).toBeGreaterThan(0);
    expect(
      screen.getByRole('link', { name: 'Ver na auditoria as ações de IA' }).getAttribute('href'),
    ).toBe('/auditoria?action=ai.*');

    const user = userEvent.setup();
    await chooseOption(user, 'Mês', '2026-09');
    expect(await screen.findByText('Nenhuma geração neste mês.')).toBeTruthy();
    await chooseOption(user, 'Mês', '2026-08');
    expect(await screen.findByText('Não foi possível carregar o consumo.')).toBeTruthy();
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(api).toHaveBeenCalled();
  });
});

describe('regras puras da seção de IA', () => {
  it('limite digitado aceita separador de milhar; meses do seletor', () => {
    expect(parseLimit('2.000.000')).toBe(2_000_000);
    expect(parseLimit('50 000')).toBe(50_000);
    expect(parseLimit('abc')).toBeNull();
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-10', -11)).toBe('2025-11');
  });
});
