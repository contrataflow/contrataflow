// @vitest-environment jsdom
import { Toaster, clearToasts } from '@contrataflow/ui';
import type { RiskDto, RiskListMetaDto, RiskScaleSnapshot } from '@contrataflow/validation';
import { buildRiskMatrix } from '@contrataflow/validation';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeQueryClient } from '@/lib/query/query-client';
import { seriousA11yViolations } from '@test/support/axe';
import {
  ID,
  PROCESS_ID,
  callsTo,
  catalogItem,
  mockProcessApi,
  problemResponse,
} from '@test/support/process-fixtures';
import { jsonResponse, renderWithShell } from '@test/support/render';

import { RiskMatrixPanel } from './risk-matrix-panel';
import { RisksScreen } from './risks-screen';

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

const push = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => `/processos/${PROCESS_ID}/riscos`,
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
  push.mockClear();
});

const MATRIX_URL = `/api/v1/processes/${PROCESS_ID}/risk-matrix`;
const MAP_URL = `/api/v1/processes/${PROCESS_ID}/risk-map`;
const DOC_ID = ID(777);
const CATEGORY = catalogItem(241, 'RISK_CATEGORY', 'MERCADO', 'Risco de mercado');
const SCALE: RiskScaleSnapshot['scale'] = {
  max: 5,
  probabilityLabels: ['Muito baixa', 'Baixa', 'Média', 'Alta', 'Muito alta'],
  impactLabels: ['Insignificante', 'Baixo', 'Médio', 'Alto', 'Crítico'],
};
const THRESHOLDS = [
  { level: 'LOW', minScore: 1, maxScore: 4 },
  { level: 'MEDIUM', minScore: 5, maxScore: 9 },
  { level: 'HIGH', minScore: 10, maxScore: 16 },
  { level: 'EXTREME', minScore: 17, maxScore: 25 },
] as const;
const CURRENT = { scale: SCALE, levelThresholds: [...THRESHOLDS] };

function risk(sequence: number, probability: number, impact: number, title: string): RiskDto {
  const score = probability * impact;
  return {
    id: ID(900 + sequence),
    processId: PROCESS_ID,
    code: `R0${String(sequence)}`,
    title,
    description: null,
    categoryId: CATEGORY.id,
    category: { id: CATEGORY.id, code: CATEGORY.code, label: CATEGORY.label },
    phase: 'PLANNING',
    cause: 'Mercado local com poucos fornecedores',
    consequence: 'Licitação deserta',
    probability,
    impact,
    score,
    level: score >= 10 ? 'HIGH' : 'LOW',
    scaleSnapshot: CURRENT,
    ownerId: null,
    owner: null,
    ownerDepartmentId: null,
    ownerDepartment: null,
    residualProbability: null,
    residualImpact: null,
    residualScore: null,
    residualLevel: null,
    status: 'OPEN',
    sortOrder: sequence - 1,
    treatments: [],
    version: 1,
  };
}

const R01 = risk(1, 4, 4, 'Fornecedores insuficientes');
const R02 = risk(2, 1, 1, 'Atraso na entrega');
const R03 = risk(3, 3, 4, 'Impugnação do edital');

type Route = (url: string, init?: RequestInit) => Response | undefined;

const noRetryClient = () => {
  const client = makeQueryClient();
  client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retry: false } });
  return client;
};

function setup(
  options: {
    risks?: readonly RiskDto[];
    meta?: Partial<RiskListMetaDto>;
    riskMap?: Route;
  } = {},
) {
  const risks = options.risks ?? [R01, R02];
  return mockProcessApi({
    permissions: ['PROCESS_VIEW'],
    catalogs: { RISK_CATEGORY: [CATEGORY] },
    risks: () =>
      jsonResponse({
        data: risks,
        meta: {
          scale: SCALE,
          levelThresholds: [...THRESHOLDS],
          riskMap: null,
          canManage: true,
          lockReason: null,
          ...options.meta,
        },
      }),
    riskMap: (url, init) => {
      const handled = options.riskMap?.(url, init);
      if (handled) return handled;
      if (url.startsWith(MATRIX_URL)) {
        const status = new URL(url, 'http://local').searchParams.get('status');
        const filtered = status === null ? risks : risks.filter((item) => item.status === status);
        return jsonResponse({ data: buildRiskMatrix(filtered, CURRENT) });
      }
      return problemResponse(404, 'NOT_FOUND');
    },
    participants: () => jsonResponse({ data: [], meta: {} }),
  });
}

async function renderPanel(options: Parameters<typeof setup>[0] = {}) {
  const user = userEvent.setup();
  const api = setup(options);
  const onGoToRisk = vi.fn();
  renderWithShell(
    <>
      <RiskMatrixPanel processId={PROCESS_ID} onGoToRisk={onGoToRisk} />
      <Toaster />
    </>,
    { queryClient: noRetryClient() },
  );
  const grid = await screen.findByRole('table', {
    name: 'Matriz de riscos: probabilidade nas linhas e impacto nas colunas',
  });
  return { api, user, grid, onGoToRisk };
}

describe('SCR-011 · aba "Matriz" (US-035)', () => {
  it('[Sucesso] grade de calor: R01 em 4×4 (Alto) e R02 em 1×1 (Baixo), com aria-label por célula', async () => {
    const { grid } = await renderPanel();
    const high = within(grid).getByRole('group', {
      name: 'Probabilidade Alta (4), impacto Alto (4): 1 risco (R01), nível Alto',
    });
    expect(within(high).getByText('Fornecedores insuficientes')).toBeTruthy();
    expect(
      within(grid).getByRole('group', {
        name: 'Probabilidade Muito baixa (1), impacto Insignificante (1): 1 risco (R02), nível Baixo',
      }),
    ).toBeTruthy();
    expect(within(grid).getAllByRole('group')).toHaveLength(25);
    expect(within(grid).getAllByRole('rowheader')).toHaveLength(5);
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('[Sucesso] filtro por situação recarrega a matriz pelo RSK-09 sem trocar de tela', async () => {
    const { api, user, grid } = await renderPanel({
      risks: [R01, { ...R02, status: 'IN_TREATMENT' }],
    });
    await user.selectOptions(screen.getByLabelText('Situação'), 'IN_TREATMENT');
    await waitFor(() => {
      expect(callsTo(api, 'GET', `${MATRIX_URL}?status=IN_TREATMENT`)).toHaveLength(1);
    });
    await waitFor(() => {
      expect(within(grid).queryByText('Fornecedores insuficientes')).toBeNull();
    });
    expect(within(grid).getByText('Atraso na entrega')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Limpar filtros' }));
    expect(await within(grid).findByText('Fornecedores insuficientes')).toBeTruthy();
  });

  it('[Sucesso] Emitir Mapa de Riscos: POST com Idempotency-Key e navegação para o documento', async () => {
    const { api, user } = await renderPanel({
      riskMap: (url, init) =>
        url === MAP_URL && init?.method === 'POST'
          ? jsonResponse(
              {
                data: { id: DOC_ID, code: 'MR 0001/2026', status: 'DRAFT', version: 1 },
                meta: { allowedActions: ['FINALIZE'] },
              },
              { status: 201 },
            )
          : undefined,
    });
    await user.click(screen.getByRole('button', { name: 'Emitir Mapa de Riscos' }));
    await waitFor(() => {
      expect(push).toHaveBeenCalledWith(`/processos/${PROCESS_ID}/documentos/${DOC_ID}`);
    });
    const [call] = callsTo(api, 'POST', MAP_URL);
    expect(call?.headers.get('Idempotency-Key')).toBeTruthy();
    expect(call?.body).toEqual({});
    expect(await screen.findByText('Mapa de Riscos MR 0001/2026 emitido.')).toBeTruthy();
  });

  it('[Duplicidade] 409 DOCUMENT_ALREADY_EXISTS: oferece abrir o Mapa de Riscos existente', async () => {
    const { user } = await renderPanel({
      riskMap: (url, init) =>
        url === MAP_URL && init?.method === 'POST'
          ? problemResponse(409, 'DOCUMENT_ALREADY_EXISTS', {
              extension: { meta: { existingDocumentId: DOC_ID } },
            })
          : undefined,
    });
    await user.click(screen.getByRole('button', { name: 'Emitir Mapa de Riscos' }));
    expect(await screen.findByText('Já existe um Mapa de Riscos para este processo.')).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Abrir o Mapa de Riscos existente' }).getAttribute('href'),
    ).toBe(`/processos/${PROCESS_ID}/documentos/${DOC_ID}`);
    expect(push).not.toHaveBeenCalled();
  });

  it('[Falha de banco] 503: mensagem para tentar de novo e a mesma chave no reenvio', async () => {
    const { api, user } = await renderPanel({
      riskMap: (url, init) =>
        url === MAP_URL && init?.method === 'POST'
          ? problemResponse(503, 'DEPENDENCY_UNAVAILABLE')
          : undefined,
    });
    await user.click(screen.getByRole('button', { name: 'Emitir Mapa de Riscos' }));
    expect(
      await screen.findByText('Não foi possível concluir agora. Tente novamente em instantes.'),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Emitir Mapa de Riscos' }));
    await waitFor(() => {
      expect(callsTo(api, 'POST', MAP_URL).length).toBeGreaterThanOrEqual(2);
    });
    const keys = callsTo(api, 'POST', MAP_URL).map((call) => call.headers.get('Idempotency-Key'));
    expect(new Set(keys).size).toBe(1);
  });

  it('[Estado] vazio (FA-02): orientação e "Emitir" desabilitado', async () => {
    setup({ risks: [] });
    renderWithShell(<RiskMatrixPanel processId={PROCESS_ID} onGoToRisk={vi.fn()} />, {
      queryClient: noRetryClient(),
    });
    expect(
      await screen.findByText(
        'Nenhum risco registrado. Volte para a lista de riscos e registre o primeiro.',
      ),
    ).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Emitir Mapa de Riscos' });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(
      screen.getByText('Registre ao menos um risco para emitir o Mapa de Riscos.'),
    ).toBeTruthy();
  });

  it('[Permissão] sem RISK_MANAGE: a matriz aparece e "Emitir" não é exibido', async () => {
    await renderPanel({ meta: { canManage: false, lockReason: 'PERMISSION_DENIED' } });
    expect(screen.queryByRole('button', { name: 'Emitir Mapa de Riscos' })).toBeNull();
  });

  it('[Sucesso] mapa concluído: aviso "Mapa de Riscos concluído" com o link; a matriz segue em leitura', async () => {
    const { grid } = await renderPanel({
      meta: {
        riskMap: { id: DOC_ID, code: 'MR 0001/2026', status: 'FINALIZED' },
        canManage: false,
        lockReason: 'DOCUMENT_NOT_EDITABLE',
      },
    });
    expect(screen.getByText('Mapa de Riscos concluído')).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: 'Abrir o Mapa de Riscos MR 0001/2026' })
        .getAttribute('href'),
    ).toBe(`/processos/${PROCESS_ID}/documentos/${DOC_ID}`);
    expect(within(grid).getByText('Fornecedores insuficientes')).toBeTruthy();
  });

  it('[Validação] mapa em rascunho: pendência RISK_TREATMENT_REQUIRED_FOR_LEVEL com atalho para o risco', async () => {
    const { user, onGoToRisk } = await renderPanel({
      risks: [R01, R02, R03],
      meta: { riskMap: { id: DOC_ID, code: 'MR 0001/2026', status: 'DRAFT' } },
      riskMap: (url) =>
        url === `/api/v1/documents/${DOC_ID}/validation`
          ? jsonResponse({
              data: {
                sections: [],
                violations: [
                  {
                    code: 'RISK_TREATMENT_REQUIRED_FOR_LEVEL',
                    severity: 'BLOCKING',
                    message: 'O risco R03 precisa de ao menos uma ação de tratamento.',
                    ruleId: 'RN-RISK-21',
                    sectionKey: null,
                    field: 'treatments',
                    itemId: R03.id,
                    params: { code: 'R03', level: 'HIGH' },
                  },
                ],
              },
            })
          : undefined,
    });
    const pending = await screen.findByRole('list', { name: 'Pendências do Mapa de Riscos' });
    expect(
      within(pending).getByText('O risco R03 precisa de ao menos uma ação de tratamento.'),
    ).toBeTruthy();
    await user.click(
      within(pending).getByRole('button', { name: 'Ir para o risco R03 e criar o tratamento' }),
    );
    expect(onGoToRisk).toHaveBeenCalledWith(R03.id);
    expect(screen.getByRole('link', { name: 'Abrir o Mapa de Riscos MR 0001/2026' })).toBeTruthy();
  });
});

describe('SCR-011 · abas "Lista de riscos" e "Matriz"', () => {
  it('a matriz leva à lista com o risco aberto e focado', async () => {
    const user = userEvent.setup();
    setup();
    renderWithShell(<RisksScreen processId={PROCESS_ID} />, { queryClient: noRetryClient() });
    await user.click(await screen.findByRole('tab', { name: 'Matriz' }));
    expect(screen.getByRole('tab', { name: 'Matriz' }).getAttribute('aria-selected')).toBe('true');
    await user.click(
      await screen.findByRole('button', {
        name: 'Abrir o risco R01 — Fornecedores insuficientes na lista',
      }),
    );
    expect(screen.getByRole('tab', { name: 'Lista de riscos' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    const toggle = await screen.findByRole('button', { name: 'Ocultar detalhes R01' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await waitFor(() => {
      expect(document.activeElement?.id).toBe(`risk-row-${R01.id}`);
    });

    // Setas trocam de aba (WAI-ARIA).
    screen.getByRole('tab', { name: 'Lista de riscos' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Matriz' }).getAttribute('aria-selected')).toBe('true');
  });
});
