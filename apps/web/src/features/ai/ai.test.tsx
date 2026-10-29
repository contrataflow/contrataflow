// @vitest-environment jsdom
import type { AiGenerationDto, AiGenerationListItemDto } from '@contrataflow/validation';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { ID, PROCESS_ID, problemResponse } from '@test/support/process-fixtures';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { AiAssistant, isAiTarget } from './ai-assistant';
import { previewText } from './ai-assistant-panel';
import { POLL_GIVE_UP_MS, nextPollInterval } from './ai-polling';

configure({ asyncUtilTimeout: 8000 });
vi.setConfig({ testTimeout: 30_000 });

/*
 * US-115 — SCR-117 (base): botão "Gerar rascunho com IA" só com AI_GENERATE, painel com aviso,
 * pedido (AI-01 → 202), acompanhamento por AI-02, proposta, descarte (AI-04), falha com "Tentar
 * novamente", geração ativa (409) e histórico (AI-03). O conteúdo específico de cada documento é
 * das US-117..121.
 */

const DOC = ID(700);
const GEN = ID(701);
const SUMMARY = 'Aquisição de 30 computadores para os laboratórios das escolas.';

function generation(extra: Partial<AiGenerationDto> = {}): AiGenerationDto {
  return {
    id: GEN,
    processId: PROCESS_ID,
    documentId: DOC,
    targetModule: 'DFD',
    kind: 'DRAFT',
    action: null,
    sectionKey: null,
    baseRevision: null,
    status: 'QUEUED',
    // A solicitante é a usuária da sessão (Ana): a proposta pronta abre a aplicação (US-117).
    requestedBy: { id: '0192a000-0000-7000-8000-0000000000a1', name: 'Ana Souza' },
    createdAt: '2026-10-16T12:00:00.000Z',
    startedAt: null,
    completedAt: null,
    expiresAt: null,
    provider: 'fake',
    model: null,
    promptKey: 'draft.dfd',
    promptVersion: '1.0.0',
    usage: { inputTokens: null, outputTokens: null, totalTokens: null },
    placeholdersCount: 0,
    groundingReplacements: 0,
    inputRefs: [],
    output: null,
    errorCode: null,
    appliedAt: null,
    appliedTargets: null,
    ...extra,
  };
}

const SUCCEEDED = generation({
  status: 'SUCCEEDED',
  model: 'fake-draft-1',
  completedAt: '2026-10-16T12:01:00.000Z',
  expiresAt: '2026-10-23T12:01:00.000Z',
  usage: { inputTokens: 900, outputTokens: 300, totalTokens: 1200 },
  output: {
    sections: [
      {
        sectionKey: 'NECESSIDADE',
        title: 'Descrição da necessidade',
        content: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'Os laboratórios precisam de ' },
                {
                  type: 'toConfirm',
                  attrs: { label: 'quantidade', category: 'QUANTITY', origin: 'AI' },
                },
              ],
            },
          ],
        },
        placeholdersCount: 1,
        groundingReplacements: 0,
      },
    ],
    warnings: [{ code: 'BUDGET_CONFIDENTIAL_VALUES_OMITTED' }],
  },
});

interface Api {
  permissions?: readonly string[];
  generations?: readonly AiGenerationDto[];
  request?: () => Response;
  history?: readonly AiGenerationListItemDto[];
  /** AI-05 (US-116): padrão = pode gerar. */
  availability?: { canGenerate: boolean; reasons: string[] };
}

/** API simulada: AI-02 devolve a sequência de estados (o último se repete). */
function mockAiApi(api: Api = {}) {
  const states = [...(api.generations ?? [SUCCEEDED])];
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    if (url.startsWith('/api/v1/me/permissions')) {
      return Promise.resolve(
        jsonResponse({
          data: {
            permissions: (api.permissions ?? ['AI_GENERATE', 'PROCESS_VIEW']).map((code) => ({
              code,
              scopes: [{ type: 'TENANT', includeSubtree: false }],
            })),
            implicit: { headOfDepartmentIds: [], ownDepartmentIds: [] },
          },
        }),
      );
    }
    if (method === 'GET' && url.startsWith('/api/v1/ai/availability')) {
      const { canGenerate, reasons } = api.availability ?? { canGenerate: true, reasons: [] };
      return Promise.resolve(
        jsonResponse({
          data: {
            enabled: !reasons.includes('AI_DISABLED'),
            providerAvailable: true,
            canGenerate,
            reasons,
            monthly: { percentUsed: 10 },
            userDaily: { used: 1, limit: 40 },
          },
        }),
      );
    }
    if (method === 'POST' && url === `/api/v1/processes/${PROCESS_ID}/ai-generations`) {
      return Promise.resolve(
        api.request
          ? api.request()
          : jsonResponse({ data: generation(), meta: { pollAfterMs: 2000 } }, { status: 202 }),
      );
    }
    if (method === 'GET' && url === `/api/v1/ai-generations/${GEN}`) {
      const current = states.length > 1 ? states.shift() : states[0];
      return Promise.resolve(jsonResponse({ data: current }));
    }
    if (method === 'POST' && url === `/api/v1/ai-generations/${GEN}/discard`) {
      const discarded = { ...(states[0] ?? SUCCEEDED), status: 'DISCARDED' as const };
      states.splice(0, states.length, discarded);
      return Promise.resolve(jsonResponse({ data: discarded }));
    }
    if (method === 'GET' && url === `/api/v1/documents/${DOC}`) {
      // DOC-03 do DFD sem seções preenchidas (comparação da US-117).
      return Promise.resolve(
        jsonResponse({ data: { id: DOC, version: 6, draftContent: { sections: {} } } }),
      );
    }
    if (method === 'GET' && url.startsWith(`/api/v1/processes/${PROCESS_ID}/ai-generations`)) {
      return Promise.resolve(
        jsonResponse({ data: api.history ?? [], meta: { nextCursor: null, hasMore: false } }),
      );
    }
    return Promise.resolve(jsonResponse({}, { status: 404 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const posted = (fetchMock: ReturnType<typeof mockAiApi>) =>
  fetchMock.mock.calls
    .filter(
      ([input, init]) =>
        (init?.method ?? 'GET') === 'POST' && requestUrl(input).endsWith('/ai-generations'),
    )
    .map(
      ([, init]) =>
        JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>,
    );

function renderAssistant(props: Partial<Parameters<typeof AiAssistant>[0]> = {}) {
  return renderWithShell(
    <AiAssistant processId={PROCESS_ID} documentId={DOC} targetModule="DFD" editable {...props} />,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SCR-117 — assistente de redação com IA (US-115)', () => {
  it('sem AI_GENERATE o botão não aparece; documento não editável também oculta', async () => {
    const fetchMock = mockAiApi({ permissions: ['PROCESS_VIEW'] });
    renderAssistant();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(screen.queryByRole('button', { name: 'Gerar rascunho com IA' })).toBeNull();
  });

  it.each([
    ['AI_USER_DAILY_LIMIT_REACHED', 'Limite diário de pedidos atingido; volta amanhã.'],
    ['AI_DISABLED', 'A IA está desligada neste órgão.'],
    [
      'AI_USAGE_LIMIT_REACHED',
      'O limite mensal de uso de IA foi atingido. Fale com o administrador do órgão.',
    ],
  ])('US-116: AI-05 com %s desabilita o botão com a explicação', async (reason, message) => {
    mockAiApi({ availability: { canGenerate: false, reasons: [reason] } });
    renderAssistant();
    const button = await screen.findByRole<HTMLButtonElement>('button', {
      name: 'Gerar rascunho com IA',
    });
    await waitFor(() => {
      expect(button.disabled).toBe(true);
    });
    const hint = document.getElementById(button.getAttribute('aria-describedby') ?? '');
    expect(hint?.textContent).toBe(message);
  });

  it('pede o rascunho (AI-01), acompanha (AI-02), mostra a proposta e descarta (AI-04)', async () => {
    const user = userEvent.setup();
    const fetchMock = mockAiApi({ generations: [generation({ status: 'RUNNING' }), SUCCEEDED] });
    renderAssistant();
    await user.click(await screen.findByRole('button', { name: 'Gerar rascunho com IA' }));

    const panel = screen.getByRole('dialog', { name: 'Assistente de redação com IA' });
    expect(document.activeElement).toBe(within(panel).getByRole('heading', { level: 2 }));
    expect(within(panel).getByText(/Conteúdo gerado por IA pode conter erros/)).toBeTruthy();
    expect(await seriousA11yViolations()).toEqual([]);

    const summary = within(panel).getByRole('textbox', { name: /Descreva a necessidade/ });
    await user.type(summary, 'curto');
    await user.click(within(panel).getByRole('button', { name: 'Gerar com IA' }));
    expect(
      within(panel).getByText('Descreva a necessidade com 20 a 2.000 caracteres.'),
    ).toBeTruthy();
    expect(posted(fetchMock)).toHaveLength(0);

    await user.clear(summary);
    await user.type(summary, SUMMARY);
    await user.click(within(panel).getByRole('button', { name: 'Gerar com IA' }));
    expect(posted(fetchMock)).toEqual([
      { targetModule: 'DFD', kind: 'DRAFT', documentId: DOC, needSummary: SUMMARY },
    ]);
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(new Headers(post?.[1]?.headers).get('Idempotency-Key')).toMatch(/[0-9a-f-]{36}/);

    expect(await within(panel).findByText('Gerando… você pode continuar editando')).toBeTruthy();
    expect(await within(panel).findByText('Proposta pronta', {}, { timeout: 12_000 })).toBeTruthy();
    // A lista de seções carrega o documento (DOC-03) para a marcação padrão e a comparação.
    expect(await within(panel).findByText('Descrição da necessidade')).toBeTruthy();
    expect(within(panel).getByText('1 [a confirmar]')).toBeTruthy();
    expect(within(panel).getByText(/\[a confirmar: quantidade\]/)).toBeTruthy();
    expect(
      within(panel).getByText('Os valores do orçamento sigiloso não foram enviados à IA.'),
    ).toBeTruthy();
    expect(await seriousA11yViolations()).toEqual([]);

    await user.click(within(panel).getByRole('button', { name: 'Descartar' }));
    expect(await within(panel).findAllByText('Proposta descartada.')).not.toHaveLength(0);

    await user.click(within(panel).getByRole('button', { name: 'Fechar o assistente' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Gerar rascunho com IA' }),
    );
  });

  it('falha na geração: motivo e "Tentar novamente" volta ao formulário', async () => {
    const user = userEvent.setup();
    mockAiApi({ generations: [generation({ status: 'FAILED', errorCode: 'TIMEOUT' })] });
    renderAssistant({ initialGenerationId: GEN });
    const panel = await screen.findByRole('dialog');
    expect(await within(panel).findByText('Não foi possível gerar agora')).toBeTruthy();
    expect(within(panel).getByText('A IA demorou demais para responder.')).toBeTruthy();
    await user.click(within(panel).getByRole('button', { name: 'Tentar novamente' }));
    expect(within(panel).getByRole('textbox', { name: /Descreva a necessidade/ })).toBeTruthy();
  });

  it('geração ativa no alvo (409): abre o acompanhamento dela; provedor fora (503): explica', async () => {
    const user = userEvent.setup();
    mockAiApi({
      generations: [generation({ status: 'RUNNING' })],
      request: () =>
        problemResponse(409, 'AI_GENERATION_IN_PROGRESS', {
          extension: { meta: { generationId: GEN } },
        }),
    });
    renderAssistant();
    await user.click(await screen.findByRole('button', { name: 'Gerar rascunho com IA' }));
    const panel = screen.getByRole('dialog');
    await user.type(
      within(panel).getByRole('textbox', { name: /Descreva a necessidade/ }),
      SUMMARY,
    );
    await user.click(within(panel).getByRole('button', { name: 'Gerar com IA' }));
    expect(await within(panel).findByText(/Já existe uma geração em andamento/)).toBeTruthy();
    expect(await within(panel).findByText('Gerando… você pode continuar editando')).toBeTruthy();
  });

  it('?ia= abre o painel na proposta; histórico (AI-03) em cartões e estado vazio', async () => {
    const user = userEvent.setup();
    const { id: _id, output: _output, ...item } = SUCCEEDED;
    mockAiApi({
      permissions: ['PROCESS_VIEW'],
      history: [{ ...item, id: GEN }],
    });
    renderAssistant({ editable: false, initialGenerationId: GEN });
    const panel = await screen.findByRole('dialog');
    expect(await within(panel).findByText('Proposta pronta')).toBeTruthy();
    // Sem AI_GENERATE: sem a aba "Gerar".
    expect(within(panel).queryByRole('tab', { name: 'Gerar' })).toBeNull();
    await user.click(within(panel).getByRole('tab', { name: 'Histórico de IA' }));
    const list = await within(panel).findByRole('list', { name: 'Histórico de IA' });
    expect(within(list).getByText('Rascunho completo')).toBeTruthy();
    expect(within(list).getByText('Pronta')).toBeTruthy();
    expect(within(list).getByText(/1.200 tokens/)).toBeTruthy();
    expect(within(list).getByText(/Por Ana Souza/)).toBeTruthy();
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('histórico vazio', async () => {
    const user = userEvent.setup();
    mockAiApi({ history: [] });
    renderAssistant();
    await user.click(await screen.findByRole('button', { name: 'Gerar rascunho com IA' }));
    await user.click(screen.getByRole('tab', { name: 'Histórico de IA' }));
    expect(await screen.findByText('Nenhuma geração neste processo')).toBeTruthy();
  });
});

describe('regras puras do painel', () => {
  it('consulta a cada 2 s recuando até 5 s; para no estado final ou após 3 min', () => {
    expect([0, 1, 2, 3, 4, 9].map((polls) => nextPollInterval('RUNNING', polls, 0))).toEqual([
      2_000, 3_000, 4_000, 5_000, 5_000, 5_000,
    ]);
    expect(nextPollInterval(undefined, 0, 0)).toBe(2_000);
    expect(nextPollInterval('SUCCEEDED', 0, 0)).toBe(false);
    expect(nextPollInterval('QUEUED', 3, POLL_GIVE_UP_MS)).toBe(false);
  });

  it('alvos da IA e prévia do TipTap com [a confirmar]', () => {
    expect(['DFD', 'ETP', 'RISK_MAP', 'TERM_OF_REFERENCE'].every(isAiTarget)).toBe(true);
    expect(isAiTarget('PRICE_RESEARCH')).toBe(false);
    expect(isAiTarget(null)).toBe(false);
    expect(
      previewText({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'A ' },
              { type: 'toConfirm', attrs: { label: 'prazo' } },
            ],
          },
          { type: 'paragraph', content: [{ type: 'text', text: 'B' }] },
        ],
      }),
    ).toBe('A [a confirmar: prazo]\nB');
  });
});
