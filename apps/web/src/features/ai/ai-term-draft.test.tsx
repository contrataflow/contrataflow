// @vitest-environment jsdom
import type { AiGenerationDto } from '@contrataflow/validation';
import { configure, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { ID, PROCESS_ID, problemResponse } from '@test/support/process-fixtures';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { AiAssistant } from './ai-assistant';
import { TermAiRequestGuide, termAiConditionsSplit } from '../term/term-ai-request-guide';

configure({ asyncUtilTimeout: 8000 });
vi.setConfig({ testTimeout: 30_000 });

/*
 * US-120 — SCR-117 no editor do TR (SCR-012): o formulário lista as entradas previstas, as
 * condições do TR preenchidas e as ausentes (que virarão [a confirmar]) e o consumo estimado; o TR
 * não pede resumo da necessidade (vem do ETP); sem ETP, o 422 `AI_PREREQUISITE_MISSING` orienta
 * com o atalho para os documentos; a proposta mostra os avisos do TR (ETP em rascunho, sem
 * pesquisa, sem riscos) e as seções já preenchidas (importadas do ETP) vêm desmarcadas.
 */

const DOC = ID(820);
const GEN = ID(821);

const CONDITIONS = {
  contractDurationMonths: 12,
  executionDeadline: null,
  paymentTermDays: 30,
  productWarrantyMonths: null,
  contractGuaranteePercent: null,
  deliveryLocation: null,
  allowsSubcontracting: null,
  selectionCriterionId: null,
  awardType: null,
} as const;

const doc = (text: string) => ({
  type: 'doc' as const,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const SUCCEEDED: AiGenerationDto = {
  id: GEN,
  processId: PROCESS_ID,
  documentId: DOC,
  targetModule: 'TERM_OF_REFERENCE',
  kind: 'DRAFT',
  action: null,
  sectionKey: null,
  baseRevision: null,
  status: 'SUCCEEDED',
  requestedBy: { id: '0192a000-0000-7000-8000-0000000000a1', name: 'Ana Souza' },
  createdAt: '2026-10-20T12:00:00.000Z',
  startedAt: '2026-10-20T12:00:01.000Z',
  completedAt: '2026-10-20T12:01:00.000Z',
  expiresAt: '2026-10-27T12:01:00.000Z',
  provider: 'fake',
  model: 'fake-draft-1',
  promptKey: 'draft.tr',
  promptVersion: '1.0.0',
  usage: { inputTokens: 9000, outputTokens: 3000, totalTokens: 12000 },
  placeholdersCount: 1,
  groundingReplacements: 1,
  inputRefs: [],
  output: {
    sections: [
      {
        sectionKey: 'OBJECT',
        title: 'Definição do objeto',
        content: doc('Objeto sugerido pela IA.'),
        placeholdersCount: 0,
        groundingReplacements: 0,
      },
      {
        sectionKey: 'DELIVERY',
        title: 'Modelo de execução e entrega',
        content: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'toConfirm',
                  attrs: { label: 'local de entrega', category: 'DATA', origin: 'AI' },
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
      { code: 'USED_DRAFT_INPUTS', params: { input: 'ETP' } },
      { code: 'MISSING_PRICE_RESEARCH' },
      { code: 'MISSING_OPTIONAL_INPUT', params: { input: 'RISKS' } },
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
            permissions: ['AI_GENERATE', 'PROCESS_VIEW', 'TERM_UPDATE'].map((code) => ({
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
      // OBJECT importada do ETP (FILLED): vem desmarcada, com o aviso de substituição.
      return Promise.resolve(
        jsonResponse({
          data: {
            id: DOC,
            version: 4,
            draftContent: {
              sections: {
                OBJECT: {
                  state: 'FILLED',
                  content: doc('Objeto importado do ETP'),
                  justification: null,
                  revision: 2,
                  updatedAt: '2026-10-20T11:00:00.000Z',
                  updatedById: null,
                },
              },
            },
          },
        }),
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
    <AiAssistant
      processId={PROCESS_ID}
      documentId={DOC}
      targetModule="TERM_OF_REFERENCE"
      editable
      requestGuide={<TermAiRequestGuide term={CONDITIONS} />}
    />,
  );
  await user.click(await screen.findByRole('button', { name: 'Gerar rascunho com IA' }));
  return {
    user,
    panel: screen.getByRole('dialog', { name: 'Assistente de redação com IA' }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SCR-117 — rascunho do TR com IA (US-120)', () => {
  it('condições preenchidas × ausentes (RN-AI-44): vazias e texto em branco contam como ausentes', () => {
    expect(termAiConditionsSplit(CONDITIONS)).toEqual({
      filled: ['contractDurationMonths', 'paymentTermDays'],
      missing: [
        'executionDeadline',
        'productWarrantyMonths',
        'contractGuaranteePercent',
        'deliveryLocation',
        'allowsSubcontracting',
        'selectionCriterionId',
        'awardType',
      ],
    });
    expect(
      termAiConditionsSplit({ ...CONDITIONS, deliveryLocation: '  ', allowsSubcontracting: false })
        .filled,
    ).toEqual(['contractDurationMonths', 'paymentTermDays', 'allowsSubcontracting']);
  });

  it('lista entradas, condições preenchidas e ausentes e o consumo; sem resumo da necessidade', async () => {
    const fetchMock = mockAiApi();
    const { user, panel } = await openPanel();
    expect(within(panel).getByRole('heading', { name: 'O que a IA vai usar' })).toBeTruthy();
    expect(within(panel).getByText(/O ETP do processo: a versão aprovada/)).toBeTruthy();
    expect(within(panel).getByText(/especificações e os critérios de aceitação/)).toBeTruthy();
    const filled = within(panel).getByTestId('term-ai-filled');
    expect(within(filled).getByText('Vigência do contrato')).toBeTruthy();
    expect(within(filled).getByText('Prazo de pagamento')).toBeTruthy();
    const missing = within(panel).getByTestId('term-ai-missing');
    expect(within(missing).getByText('Local de entrega')).toBeTruthy();
    expect(within(missing).getByText('Critério de julgamento')).toBeTruthy();
    expect(
      within(panel).getByRole('heading', {
        name: 'Condições não informadas — sairão como [a confirmar]',
      }),
    ).toBeTruthy();
    expect(within(panel).getByText('Consumo estimado: até 40 mil tokens.')).toBeTruthy();
    expect(within(panel).queryByText('Descreva a necessidade em poucas linhas')).toBeNull();
    expect(await seriousA11yViolations()).toEqual([]);

    await user.click(within(panel).getByRole('button', { name: 'Gerar com IA' }));
    expect(posted(fetchMock)).toEqual([
      { targetModule: 'TERM_OF_REFERENCE', kind: 'DRAFT', documentId: DOC },
    ]);

    // A proposta pronta mostra os avisos do TR e a seção importada desmarcada.
    expect(await within(panel).findByText('Proposta pronta')).toBeTruthy();
    expect(within(panel).getByText('Foram usados documentos ainda em rascunho.')).toBeTruthy();
    expect(within(panel).getByText('A pesquisa de preços ainda não foi concluída.')).toBeTruthy();
    expect(within(panel).getByText(/ainda não tem riscos registrados/)).toBeTruthy();
    expect(within(panel).getByText(/\[a confirmar: local de entrega\]/)).toBeTruthy();
    const object = await within(panel).findByRole('checkbox', { name: /Definição do objeto/ });
    const delivery = within(panel).getByRole('checkbox', { name: /Modelo de execução e entrega/ });
    expect(object.getAttribute('aria-checked')).toBe('false');
    expect(delivery.getAttribute('aria-checked')).toBe('true');
  });

  it('sem ETP (FA-01): 422 AI_PREREQUISITE_MISSING orienta e oferece o atalho para os documentos', async () => {
    mockAiApi({
      request: () =>
        problemResponse(422, 'AI_PREREQUISITE_MISSING', {
          detail: 'Elabore o ETP antes de gerar o TR com IA.',
          extension: { meta: { missing: ['ETP'] } },
        }),
    });
    const { user, panel } = await openPanel();
    await user.click(within(panel).getByRole('button', { name: 'Gerar com IA' }));
    expect(
      await within(panel).findByText('Elabore o ETP antes de gerar o TR com IA.'),
    ).toBeTruthy();
    const link = within(panel).getByRole('link', { name: 'Ir para os documentos do processo' });
    expect(link.getAttribute('href')).toBe(`/processos/${PROCESS_ID}`);
  });
});
