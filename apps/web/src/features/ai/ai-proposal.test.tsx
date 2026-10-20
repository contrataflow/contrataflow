// @vitest-environment jsdom
import type { AiGenerationDto, DocumentDto, DraftSection } from '@contrataflow/validation';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { ID, PROCESS_ID, problemResponse } from '@test/support/process-fixtures';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { AiAssistant } from './ai-assistant';
import { defaultSelection, replacesText } from './ai-proposal-section-list';

configure({ asyncUtilTimeout: 8000 });
vi.setConfig({ testTimeout: 30_000 });

/*
 * US-117 — SCR-117 sobre o DFD: proposta pronta com `AiProposalSectionList` (vazias marcadas,
 * preenchidas desmarcadas com o aviso), comparação Atual × Sugerido, confirmação ao substituir,
 * DOC-26 (`If-Match` + `Idempotency-Key`), 412 recarregando e mantendo a seleção (FA-05), "Selecione
 * ao menos uma seção" (FA-09) e a proposta de outra pessoa somente leitura (FA-06).
 */

const ME = '0192a000-0000-7000-8000-0000000000a1';
const DOC = ID(800);
const GEN = ID(801);

const doc = (text: string) => ({
  type: 'doc' as const,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

function section(key: string, title: string, text: string, placeholders = 0) {
  return {
    sectionKey: key,
    title,
    content: doc(text),
    placeholdersCount: placeholders,
    groundingReplacements: 0,
  };
}

function proposal(extra: Partial<AiGenerationDto> = {}): AiGenerationDto {
  return {
    id: GEN,
    processId: PROCESS_ID,
    documentId: DOC,
    targetModule: 'DFD',
    kind: 'DRAFT',
    action: null,
    sectionKey: null,
    baseRevision: null,
    status: 'SUCCEEDED',
    requestedBy: { id: ME, name: 'Ana Souza' },
    createdAt: '2026-10-18T12:00:00.000Z',
    startedAt: '2026-10-18T12:00:01.000Z',
    completedAt: '2026-10-18T12:01:00.000Z',
    expiresAt: '2026-10-25T12:01:00.000Z',
    provider: 'fake',
    model: 'fake-draft-1',
    promptKey: 'draft.dfd',
    promptVersion: '1.0.0',
    usage: { inputTokens: 900, outputTokens: 300, totalTokens: 1200 },
    placeholdersCount: 1,
    groundingReplacements: 0,
    inputRefs: [],
    output: {
      sections: [
        section('JUSTIFICATION', 'Justificativa da necessidade', 'Justificativa sugerida.', 1),
        section('EXPECTED_RESULTS', 'Resultados esperados', 'Resultados sugeridos.'),
        section('NOTES', 'Observações', 'Observações sugeridas.'),
      ],
      warnings: [{ code: 'MISSING_OPTIONAL_INPUT', params: { input: 'EXPECTED_DATE' } }],
    },
    errorCode: null,
    appliedAt: null,
    appliedTargets: null,
    ...extra,
  };
}

function draft(state: DraftSection['state'], text: string | null, revision = 2): DraftSection {
  return {
    state,
    content: text === null ? null : doc(text),
    justification: state === 'NOT_APPLICABLE' ? 'Sem dependências com outras demandas.' : null,
    revision,
    updatedAt: '2026-10-18T11:00:00.000Z',
    updatedById: ME,
  };
}

function documentDto(
  sections: Record<string, DraftSection>,
  version = 6,
): Pick<DocumentDto, 'id' | 'version' | 'draftContent'> {
  return { id: DOC, version, draftContent: { sections } };
}

interface Api {
  readonly generation?: AiGenerationDto;
  /** Respostas sucessivas de DOC-03 (a última se repete). */
  readonly documents?: readonly ReturnType<typeof documentDto>[];
  readonly apply?: () => Response;
}

function mockApi(api: Api = {}) {
  const documents = [...(api.documents ?? [documentDto({})])];
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    if (url.startsWith('/api/v1/me/permissions')) {
      return Promise.resolve(
        jsonResponse({
          data: {
            permissions: ['AI_GENERATE', 'PROCESS_VIEW', 'DFD_UPDATE'].map((code) => ({
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
    if (method === 'GET' && url === `/api/v1/ai-generations/${GEN}`) {
      return Promise.resolve(jsonResponse({ data: api.generation ?? proposal() }));
    }
    if (method === 'GET' && url === `/api/v1/documents/${DOC}`) {
      const current = documents.length > 1 ? documents.shift() : documents[0];
      return Promise.resolve(jsonResponse({ data: current, meta: { allowedActions: ['UPDATE'] } }));
    }
    if (method === 'POST' && url === `/api/v1/documents/${DOC}/ai-apply`) {
      if (api.apply) return Promise.resolve(api.apply());
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        sectionKeys: string[];
      };
      return Promise.resolve(
        jsonResponse({
          data: {
            document: documentDto(
              Object.fromEntries(
                body.sectionKeys.map((key) => [key, draft('FILLED', 'Aplicado', 3)]),
              ),
              7,
            ),
            appliedSectionKeys: body.sectionKeys,
            versionCreated: null,
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

const applyCalls = (fetchMock: ReturnType<typeof mockApi>) =>
  fetchMock.mock.calls
    .filter(([input, init]) => init?.method === 'POST' && requestUrl(input).endsWith('/ai-apply'))
    .map(([, init]) => ({
      body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
        string,
        unknown
      >,
      headers: new Headers(init?.headers),
    }));

async function openProposal(onApplied = vi.fn()) {
  renderWithShell(
    <AiAssistant
      processId={PROCESS_ID}
      documentId={DOC}
      targetModule="DFD"
      editable
      initialGenerationId={GEN}
      onApplied={onApplied}
    />,
  );
  const panel = await screen.findByRole('complementary', {
    name: 'Assistente de redação com IA',
  });
  await within(panel).findByRole('group', { name: 'Escolha as seções a aplicar' });
  return { panel, onApplied };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SCR-117 — aplicar a proposta do DFD (US-117)', () => {
  it('marcação padrão: vazias marcadas; preenchida e "não se aplica" desmarcadas com o aviso; acessível', async () => {
    mockApi({
      documents: [
        documentDto({
          EXPECTED_RESULTS: draft('FILLED', 'Texto de Rita'),
          NOTES: draft('NOT_APPLICABLE', null),
        }),
      ],
    });
    const { panel } = await openProposal();
    const checkbox = (name: RegExp) =>
      within(panel).getByRole<HTMLInputElement>('checkbox', { name });
    expect(checkbox(/Justificativa da necessidade/).checked).toBe(true);
    expect(checkbox(/Resultados esperados/).checked).toBe(false);
    expect(checkbox(/Observações/).checked).toBe(false);
    expect(within(panel).getAllByText(/Substituirá o texto atual/)).toHaveLength(2);
    expect(within(panel).getByText('1 [a confirmar]')).toBeTruthy();
    expect(within(panel).getByText(/O DFD não tem data prevista/)).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'Aplicar 1 seção' })).toBeTruthy();
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('aplica as vazias (DOC-26 com If-Match e Idempotency-Key) e avisa para revisar', async () => {
    const user = userEvent.setup();
    const fetchMock = mockApi();
    const { panel, onApplied } = await openProposal();
    await user.click(within(panel).getByRole('button', { name: 'Aplicar 3 seções' }));
    await waitFor(() => {
      expect(applyCalls(fetchMock)).toHaveLength(1);
    });
    const [call] = applyCalls(fetchMock);
    expect(call?.body).toEqual({
      generationId: GEN,
      sectionKeys: ['JUSTIFICATION', 'EXPECTED_RESULTS', 'NOTES'],
      confirmReplaceFilled: false,
    });
    expect(call?.headers.get('If-Match')).toBe('"6"');
    expect(call?.headers.get('Idempotency-Key')).toMatch(/[0-9a-f-]{36}/);
    expect(
      await within(panel).findByText('Conteúdo aplicado: 3 seções. Revise antes de concluir.'),
    ).toBeTruthy();
    expect(onApplied).toHaveBeenCalledWith(expect.objectContaining({ version: 7 }));
  });

  it('substituir seção preenchida pede confirmação (versão antes; não marcadas se perdem) e envia confirmReplaceFilled', async () => {
    const user = userEvent.setup();
    const fetchMock = mockApi({
      documents: [documentDto({ JUSTIFICATION: draft('FILLED', 'Texto de Rita') })],
    });
    const { panel } = await openProposal();
    await user.click(within(panel).getByRole('checkbox', { name: /Justificativa da necessidade/ }));
    await user.click(within(panel).getByRole('button', { name: 'Aplicar 3 seções' }));
    const dialog = within(panel).getByRole('alertdialog', {
      name: '1 seção preenchida será substituída',
    });
    expect(within(dialog).getByText(/guardamos uma versão do documento/)).toBeTruthy();
    expect(within(dialog).getByText(/não poderão ser aplicadas depois/)).toBeTruthy();
    expect(applyCalls(fetchMock)).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Confirmar e aplicar' }));
    await waitFor(() => {
      expect(applyCalls(fetchMock)[0]?.body).toMatchObject({ confirmReplaceFilled: true });
    });
  });

  it('nada marcado: "Aplicar" desabilitado com "Selecione ao menos uma seção." (FA-09)', async () => {
    const user = userEvent.setup();
    mockApi();
    const { panel } = await openProposal();
    for (const name of [/Justificativa/, /Resultados/, /Observações/]) {
      await user.click(within(panel).getByRole('checkbox', { name }));
    }
    const apply = within(panel).getByRole<HTMLButtonElement>('button', { name: 'Aplicar seleção' });
    expect(apply.disabled).toBe(true);
    expect(within(panel).getByText('Selecione ao menos uma seção.')).toBeTruthy();
  });

  it('"Comparar" mostra Atual × Sugerido com rótulos', async () => {
    const user = userEvent.setup();
    mockApi({ documents: [documentDto({ JUSTIFICATION: draft('FILLED', 'Texto de Rita') })] });
    const { panel } = await openProposal();
    const [compare] = within(panel).getAllByRole('button', { name: 'Comparar' });
    if (compare === undefined) throw new Error('botão ausente');
    await user.click(compare);
    expect(within(panel).getByRole('region', { name: 'Atual' })).toBeTruthy();
    expect(within(panel).getByRole('region', { name: 'Sugerido' })).toBeTruthy();
    expect(within(panel).getByText('Texto de Rita')).toBeTruthy();
  });

  it('DFD alterado (412): recarrega o documento, mantém a seleção e pede para aplicar de novo (FA-05)', async () => {
    const user = userEvent.setup();
    const fetchMock = mockApi({
      documents: [documentDto({}, 6), documentDto({}, 7)],
      apply: () => problemResponse(412, 'VERSION_CONFLICT'),
    });
    const { panel } = await openProposal();
    await user.click(within(panel).getByRole('checkbox', { name: /Observações/ }));
    await user.click(within(panel).getByRole('button', { name: 'Aplicar 2 seções' }));
    expect(await within(panel).findByText(/O DFD foi alterado/)).toBeTruthy();
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(([input]) => requestUrl(input) === `/api/v1/documents/${DOC}`)
          .length,
      ).toBeGreaterThanOrEqual(2);
    });
    expect(
      within(panel).getByRole<HTMLInputElement>('checkbox', { name: /Observações/ }).checked,
    ).toBe(false);
    expect(within(panel).getByRole('button', { name: 'Aplicar 2 seções' })).toBeTruthy();
  });

  it('proposta de outra pessoa: somente leitura, sem aplicar nem descartar (FA-06)', async () => {
    mockApi({ generation: proposal({ requestedBy: { id: ID(9), name: 'Carla Dias' } }) });
    renderWithShell(
      <AiAssistant
        processId={PROCESS_ID}
        documentId={DOC}
        targetModule="DFD"
        editable
        initialGenerationId={GEN}
      />,
    );
    const panel = await screen.findByRole('complementary');
    expect(
      await within(panel).findByText(/Proposta de outra pessoa: somente leitura/),
    ).toBeTruthy();
    expect(within(panel).queryByRole('checkbox')).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Descartar' })).toBeNull();
    expect(within(panel).getByText('Justificativa sugerida.')).toBeTruthy();
  });
});

describe('regras puras da aplicação', () => {
  it('substitui texto só em FILLED/NOT_APPLICABLE; marcação padrão = vazias e ausentes', () => {
    expect(replacesText(undefined)).toBe(false);
    expect(replacesText(draft('EMPTY', null))).toBe(false);
    expect(replacesText(draft('FILLED', 'x'))).toBe(true);
    expect(replacesText(draft('NOT_APPLICABLE', null))).toBe(true);
    const selection = defaultSelection(proposal(), {
      ...documentDto({ NOTES: draft('FILLED', 'x') }),
    } as DocumentDto);
    expect([...selection]).toEqual(['JUSTIFICATION', 'EXPECTED_RESULTS']);
  });
});
