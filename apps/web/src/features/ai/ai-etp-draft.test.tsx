// @vitest-environment jsdom
import type { AiGenerationDto } from '@contrataflow/validation';
import { configure, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { ID, PROCESS_ID, problemResponse } from '@test/support/process-fixtures';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { AiAssistant } from './ai-assistant';

configure({ asyncUtilTimeout: 8000 });
vi.setConfig({ testTimeout: 30_000 });

/*
 * US-118 — SCR-117 no editor do ETP (SCR-008): o formulário lista as entradas previstas, as
 * decisões que continuam com a pessoa e o consumo estimado; o resumo é opcional; sem DFD, o 422
 * `AI_PREREQUISITE_MISSING` orienta com o atalho para os documentos; a proposta mostra os avisos do
 * ETP (`USED_DRAFT_INPUTS`, `MISSING_PRICE_RESEARCH`, itens e alternativas ausentes).
 */

const DOC = ID(800);
const GEN = ID(801);

const SUCCEEDED: AiGenerationDto = {
  id: GEN,
  processId: PROCESS_ID,
  documentId: DOC,
  targetModule: 'ETP',
  kind: 'DRAFT',
  action: null,
  sectionKey: null,
  baseRevision: null,
  status: 'SUCCEEDED',
  requestedBy: { id: '0192a000-0000-7000-8000-0000000000a1', name: 'Ana Souza' },
  createdAt: '2026-10-19T12:00:00.000Z',
  startedAt: '2026-10-19T12:00:01.000Z',
  completedAt: '2026-10-19T12:01:00.000Z',
  expiresAt: '2026-10-26T12:01:00.000Z',
  provider: 'fake',
  model: 'fake-draft-1',
  promptKey: 'draft.etp',
  promptVersion: '1.0.0',
  usage: { inputTokens: 9000, outputTokens: 3000, totalTokens: 12000 },
  placeholdersCount: 1,
  groundingReplacements: 0,
  inputRefs: [],
  output: {
    sections: [
      {
        sectionKey: 'CONCLUSION',
        title: 'Posicionamento conclusivo',
        content: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'toConfirm',
                  attrs: {
                    label: 'conclusão sobre a viabilidade',
                    category: 'DECISION',
                    origin: 'AI',
                  },
                },
              ],
            },
          ],
        },
        placeholdersCount: 1,
        groundingReplacements: 0,
      },
    ],
    warnings: [
      { code: 'USED_DRAFT_INPUTS', params: { input: 'DFD' } },
      { code: 'MISSING_PRICE_RESEARCH' },
      { code: 'MISSING_OPTIONAL_INPUT', params: { input: 'ETP_ITEMS' } },
      { code: 'MISSING_OPTIONAL_INPUT', params: { input: 'ALTERNATIVES' } },
    ],
  },
  errorCode: null,
  appliedAt: null,
  appliedTargets: null,
};

function mockAiApi(options: { request?: () => Response } = {}) {
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    if (url.startsWith('/api/v1/me/permissions')) {
      return Promise.resolve(
        jsonResponse({
          data: {
            permissions: ['AI_GENERATE', 'PROCESS_VIEW', 'ETP_UPDATE'].map((code) => ({
              code,
              scopes: [{ type: 'TENANT', includeSubtree: false }],
            })),
            implicit: { headOfDepartmentIds: [], ownDepartmentIds: [] },
          },
        }),
      );
    }
    if (method === 'GET' && url.startsWith('/api/v1/ai/availability')) {
      return Promise.resolve(
        jsonResponse({
          data: {
            enabled: true,
            providerAvailable: true,
            canGenerate: true,
            reasons: [],
            monthly: { percentUsed: 10 },
            userDaily: { used: 1, limit: 40 },
          },
        }),
      );
    }
    if (method === 'POST' && url === `/api/v1/processes/${PROCESS_ID}/ai-generations`) {
      return Promise.resolve(
        options.request
          ? options.request()
          : jsonResponse({ data: SUCCEEDED, meta: { pollAfterMs: 2000 } }, { status: 202 }),
      );
    }
    if (method === 'GET' && url === `/api/v1/ai-generations/${GEN}`) {
      return Promise.resolve(jsonResponse({ data: SUCCEEDED }));
    }
    if (method === 'GET' && url === `/api/v1/documents/${DOC}`) {
      return Promise.resolve(
        jsonResponse({ data: { id: DOC, version: 4, draftContent: { sections: {} } } }),
      );
    }
    if (method === 'GET' && url.startsWith(`/api/v1/processes/${PROCESS_ID}/ai-generations`)) {
      return Promise.resolve(
        jsonResponse({ data: [], meta: { nextCursor: null, hasMore: false } }),
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

async function openPanel() {
  const user = userEvent.setup();
  renderWithShell(
    <AiAssistant processId={PROCESS_ID} documentId={DOC} targetModule="ETP" editable />,
  );
  await user.click(await screen.findByRole('button', { name: 'Gerar rascunho com IA' }));
  return {
    user,
    panel: screen.getByRole('complementary', { name: 'Assistente de redação com IA' }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SCR-117 — rascunho do ETP com IA (US-118)', () => {
  it('lista entradas, decisões que ficam com a pessoa e o consumo; o resumo é opcional', async () => {
    const fetchMock = mockAiApi();
    const { user, panel } = await openPanel();
    expect(within(panel).getByRole('heading', { name: 'O que a IA vai usar' })).toBeTruthy();
    expect(within(panel).getByText(/a versão aprovada; sem ela, a finalizada/)).toBeTruthy();
    expect(within(panel).getByText(/o valor estimado vem só dela/)).toBeTruthy();
    expect(
      within(panel).getByRole('heading', { name: 'Decisões que continuam com você' }),
    ).toBeTruthy();
    expect(within(panel).getByText('A solução escolhida entre as alternativas.')).toBeTruthy();
    expect(within(panel).getByText('Consumo estimado: até 40 mil tokens.')).toBeTruthy();
    expect(await seriousA11yViolations()).toEqual([]);

    await user.click(within(panel).getByRole('button', { name: 'Gerar com IA' }));
    expect(posted(fetchMock)).toEqual([{ targetModule: 'ETP', kind: 'DRAFT', documentId: DOC }]);

    // A proposta pronta mostra os avisos do ETP.
    expect(await within(panel).findByText('Proposta pronta')).toBeTruthy();
    expect(within(panel).getByText('Foram usados documentos ainda em rascunho.')).toBeTruthy();
    expect(within(panel).getByText('A pesquisa de preços ainda não foi concluída.')).toBeTruthy();
    expect(
      within(panel).getByText(
        'O ETP ainda não tem itens; as quantidades saíram como [a confirmar].',
      ),
    ).toBeTruthy();
    expect(within(panel).getByText(/Nenhuma alternativa cadastrada no ETP/)).toBeTruthy();
    expect(within(panel).getByText(/\[a confirmar: conclusão sobre a viabilidade\]/)).toBeTruthy();
  });

  it('sem DFD (FA-01): 422 AI_PREREQUISITE_MISSING orienta e oferece o atalho para os documentos', async () => {
    mockAiApi({
      request: () =>
        problemResponse(422, 'AI_PREREQUISITE_MISSING', {
          detail: 'Elabore o DFD antes de gerar o ETP com IA.',
          extension: { meta: { missing: ['DFD'] } },
        }),
    });
    const { user, panel } = await openPanel();
    await user.click(within(panel).getByRole('button', { name: 'Gerar com IA' }));
    expect(
      await within(panel).findByText('Elabore o DFD antes de gerar o ETP com IA.'),
    ).toBeTruthy();
    const link = within(panel).getByRole('link', { name: 'Ir para os documentos do processo' });
    expect(link.getAttribute('href')).toBe(`/processos/${PROCESS_ID}`);
  });
});
