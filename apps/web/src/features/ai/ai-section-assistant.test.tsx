// @vitest-environment jsdom
import { richTextPlainText } from '@contrataflow/validation';
import type { AiGenerationDto, DraftSection } from '@contrataflow/validation';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { ID, PROCESS_ID, problemResponse } from '@test/support/process-fixtures';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { AiSectionMenu } from './ai-section-assistant';
import type { AiSectionChange } from './ai-section-assistant';
import {
  canUndo,
  instructionProblem,
  sectionActionOptions,
  sectionPanelPhase,
  sectionSupportsAdjust,
} from './ai-section-model';
import type { AiSectionTarget } from './ai-section-model';

configure({ asyncUtilTimeout: 8000 });
vi.setConfig({ testTimeout: 30_000 });

/*
 * US-121 — `AiSectionMenu` + painel de ajuste (SCR-117) num editor de seção: menu oculto sem
 * `AI_GENERATE` ou sem narrativa (FA-03), "Reescrever"/"Resumir" desabilitados com o motivo em
 * seção curta (FA-01), AI-01 `SECTION`, comparação Atual × Sugerido com "[a confirmar]" destacado,
 * aviso de seção já revisada (FA-04), "Aplicar" (DOC-26 com `confirmReplaceFilled`, `If-Match` e
 * `Idempotency-Key`), "Desfazer" pelo DOC-05 enquanto a seção não muda (FA-06) e 410 com
 * "Gerar de novo" mantendo a orientação (FA-02).
 */

const ME = '0192a000-0000-7000-8000-0000000000a1';
const DOC = ID(900);
const GEN = ID(901);
const KEY = 'NEED_DESCRIPTION';
const TEXT =
  'A Secretaria de Educação precisa substituir os computadores obsoletos dos laboratórios das escolas.';

const SECTION: AiSectionTarget = {
  key: KEY,
  title: 'Descrição da necessidade',
  render: 'TEXT',
  allowNarrative: true,
};

const doc = (text: string) => ({
  type: 'doc' as const,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

function draft(text: string, revision: number, reviewed = false): DraftSection {
  return {
    state: 'FILLED',
    content: doc(text),
    justification: null,
    revision,
    updatedAt: '2026-10-19T11:00:00.000Z',
    updatedById: ME,
    ai: reviewed
      ? {
          generationId: ID(950),
          appliedAt: '2026-10-18T11:00:00.000Z',
          appliedById: ME,
          reviewedAt: '2026-10-18T12:00:00.000Z',
          reviewedById: ME,
        }
      : null,
  };
}

function generation(extra: Partial<AiGenerationDto> = {}): AiGenerationDto {
  return {
    id: GEN,
    processId: PROCESS_ID,
    documentId: DOC,
    targetModule: 'ETP',
    kind: 'SECTION',
    action: 'REWRITE',
    sectionKey: KEY,
    baseRevision: 3,
    status: 'SUCCEEDED',
    requestedBy: { id: ME, name: 'Ana Souza' },
    createdAt: '2026-10-19T12:00:00.000Z',
    startedAt: '2026-10-19T12:00:01.000Z',
    completedAt: '2026-10-19T12:00:10.000Z',
    expiresAt: '2026-10-26T12:00:10.000Z',
    provider: 'fake',
    model: 'fake-section-1',
    promptKey: 'section.rewrite',
    promptVersion: '1.0.0',
    usage: { inputTokens: 900, outputTokens: 120, totalTokens: 1020 },
    placeholdersCount: 1,
    groundingReplacements: 0,
    inputRefs: [],
    output: {
      sections: [
        {
          sectionKey: KEY,
          title: SECTION.title,
          content: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [
                  { type: 'text', text: 'Os laboratórios operam com computadores obsoletos. ' },
                  {
                    type: 'toConfirm',
                    attrs: { label: 'local de entrega', category: 'OTHER', origin: 'MODEL' },
                  },
                ],
              },
            ],
          },
          placeholdersCount: 1,
          groundingReplacements: 0,
        },
      ],
      warnings: [],
    },
    errorCode: null,
    appliedAt: null,
    appliedTargets: null,
    ...extra,
  };
}

interface Api {
  readonly permissions?: readonly string[];
  readonly reviewed?: boolean;
  readonly apply?: () => Response;
}

function mockApi(api: Api = {}) {
  let section = draft(TEXT, 3, api.reviewed);
  let status: AiGenerationDto['status'] = 'SUCCEEDED';
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    if (url.startsWith('/api/v1/me/permissions')) {
      return Promise.resolve(
        jsonResponse({
          data: {
            permissions: (api.permissions ?? ['AI_GENERATE', 'PROCESS_VIEW', 'ETP_UPDATE']).map(
              (code) => ({ code, scopes: [{ type: 'TENANT', includeSubtree: false }] }),
            ),
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
        jsonResponse({ data: generation({ status: 'QUEUED', output: null }) }, { status: 202 }),
      );
    }
    if (method === 'GET' && url === `/api/v1/ai-generations/${GEN}`) {
      return Promise.resolve(jsonResponse({ data: generation({ status }) }));
    }
    if (method === 'POST' && url === `/api/v1/ai-generations/${GEN}/discard`) {
      status = 'DISCARDED';
      return Promise.resolve(jsonResponse({ data: generation({ status }) }));
    }
    if (method === 'GET' && url === `/api/v1/documents/${DOC}`) {
      return Promise.resolve(
        jsonResponse({
          data: { id: DOC, version: 9, draftContent: { sections: { [KEY]: section } } },
          meta: { allowedActions: ['UPDATE'] },
        }),
      );
    }
    if (method === 'POST' && url === `/api/v1/documents/${DOC}/ai-apply`) {
      if (api.apply) return Promise.resolve(api.apply());
      status = 'APPLIED';
      section = { ...draft(richTextPlainText(generation().output?.sections[0]?.content), 4) };
      section = {
        ...section,
        content: generation().output?.sections[0]?.content as DraftSection['content'],
      };
      return Promise.resolve(
        jsonResponse({
          data: {
            document: { id: DOC, version: 10, draftContent: { sections: { [KEY]: section } } },
            appliedSectionKeys: [KEY],
            versionCreated: null,
          },
        }),
      );
    }
    if (method === 'PUT' && url === `/api/v1/documents/${DOC}/sections/${KEY}`) {
      return Promise.resolve(
        jsonResponse({
          data: {
            sectionKey: KEY,
            state: 'FILLED',
            revision: 5,
            updatedAt: '2026-10-19T12:05:00.000Z',
            updatedBy: null,
            draftRevision: 12,
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

const callsTo = (fetchMock: ReturnType<typeof mockApi>, method: string, suffix: string) =>
  fetchMock.mock.calls
    .filter(
      ([input, init]) => (init?.method ?? 'GET') === method && requestUrl(input).endsWith(suffix),
    )
    .map(([, init]) => ({
      body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
        string,
        unknown
      >,
      headers: new Headers(init?.headers),
    }));

/** O editor mínimo: guarda o texto e adota a seção que o painel gravou. */
function Editor({
  initial = TEXT,
  onChange,
  section = SECTION,
}: {
  readonly initial?: string;
  readonly onChange?: (change: AiSectionChange) => void;
  readonly section?: AiSectionTarget;
}) {
  const [text, setText] = useState(initial);
  return (
    <div>
      <label>
        Texto
        <textarea
          value={text}
          onChange={(event) => {
            setText(event.target.value);
          }}
        />
      </label>
      <AiSectionMenu
        processId={PROCESS_ID}
        documentId={DOC}
        targetModule="ETP"
        section={section}
        state={text.trim() === '' ? 'EMPTY' : 'FILLED'}
        text={text}
        editable
        onSectionChanged={(change) => {
          onChange?.(change);
          setText(change.content ? richTextPlainText(change.content) : '');
        }}
      />
    </div>
  );
}

async function openPanel(user: ReturnType<typeof userEvent.setup>, action: RegExp) {
  await user.click(await screen.findByRole('button', { name: /Ajustar a seção/ }));
  await user.click(await screen.findByRole('menuitem', { name: action }));
  return screen.findByRole('dialog', { name: /Ajustar seção/ });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('regras de tela do ajuste de seção (US-121)', () => {
  it('ações por elegibilidade da seção (FA-01/FA-03) e orientação até 500 caracteres', () => {
    expect(
      sectionActionOptions(SECTION, 'FILLED', 'curto').map((option) => option.problem),
    ).toEqual(['AI_SECTION_EMPTY', null, 'AI_SECTION_EMPTY']);
    expect(sectionSupportsAdjust(SECTION, 'EMPTY', '')).toBe(true);
    expect(
      sectionSupportsAdjust(
        { ...SECTION, render: 'RISK_MATRIX', allowNarrative: false },
        'EMPTY',
        '',
      ),
    ).toBe(false);
    expect(sectionSupportsAdjust(SECTION, 'NOT_APPLICABLE', TEXT)).toBe(false);
    expect(instructionProblem('x'.repeat(500))).toBeNull();
    expect(instructionProblem('x'.repeat(501))).toBe('TOO_LONG');
  });

  it('fase do painel pela geração e "Desfazer" só com o texto aplicado no editor', () => {
    expect(sectionPanelPhase(undefined)).toBe('generating');
    expect(sectionPanelPhase(generation({ status: 'RUNNING' }))).toBe('generating');
    expect(sectionPanelPhase(generation())).toBe('ready');
    expect(sectionPanelPhase(generation({ status: 'FAILED', output: null }))).toBe('failed');
    expect(sectionPanelPhase(generation({ status: 'EXPIRED' }))).toBe('expired');
    expect(sectionPanelPhase(generation({ status: 'DISCARDED' }))).toBe('closed');
    expect(canUndo({ text: 'Aplicado.\r\n' }, ' Aplicado.')).toBe(true);
    expect(canUndo({ text: 'Aplicado.' }, 'Aplicado e editado.')).toBe(false);
    expect(canUndo(null, 'Aplicado.')).toBe(false);
  });
});

describe('AiSectionMenu + painel (US-121 · SCR-117)', () => {
  it('sem AI_GENERATE o menu não aparece; sem narrativa também não (FA-03)', async () => {
    const fetchMock = mockApi({ permissions: ['PROCESS_VIEW', 'ETP_UPDATE'] });
    renderWithShell(<Editor />);
    await waitFor(() => {
      expect(callsTo(fetchMock, 'GET', '/me/permissions').length).toBeGreaterThan(0);
    });
    expect(screen.queryByRole('button', { name: /Ajustar a seção/ })).toBeNull();
  });

  it('seção curta: "Reescrever" e "Resumir" desabilitados com o motivo; "Completar" disponível; acessível', async () => {
    const user = userEvent.setup();
    mockApi();
    renderWithShell(<Editor initial="Texto com vinte." />);
    await user.click(await screen.findByRole('button', { name: /Ajustar a seção/ }));
    const menu = await screen.findByRole('menu');
    const item = (name: RegExp) => within(menu).getByRole('menuitem', { name });
    expect(item(/^Reescrever/).getAttribute('aria-disabled')).toBe('true');
    expect(item(/^Resumir/).getAttribute('aria-disabled')).toBe('true');
    expect(item(/^Completar/).getAttribute('aria-disabled')).toBeNull();
    expect(within(menu).getAllByText(/ao menos 50 caracteres/)).toHaveLength(2);
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('reescreve, compara, aplica (DOC-26) e desfaz pelo DOC-05', async () => {
    const user = userEvent.setup();
    const fetchMock = mockApi({ reviewed: true });
    const onChange = vi.fn();
    renderWithShell(<Editor onChange={onChange} />);
    const panel = await openPanel(user, /^Reescrever/);
    expect(within(panel).getByText(/Consumo estimado: 6\.000 tokens/)).toBeTruthy();
    await user.type(within(panel).getByLabelText(/Orientação/), 'Use parágrafos curtos.');
    expect(within(panel).getByText('22 de 500 caracteres')).toBeTruthy();
    await user.click(within(panel).getByRole('button', { name: 'Gerar sugestão' }));

    await waitFor(() => {
      expect(callsTo(fetchMock, 'POST', '/ai-generations')).toHaveLength(1);
    });
    const [requestCall] = callsTo(fetchMock, 'POST', '/ai-generations');
    expect(requestCall?.body).toEqual({
      targetModule: 'ETP',
      documentId: DOC,
      kind: 'SECTION',
      action: 'REWRITE',
      sectionKey: KEY,
      instruction: 'Use parágrafos curtos.',
    });
    expect(requestCall?.headers.get('Idempotency-Key')).toBeTruthy();

    await within(panel).findByText('Atual × Sugerido');
    expect(within(panel).getByText('1 [a confirmar] destacado')).toBeTruthy();
    expect(within(panel).getAllByText('[a confirmar: local de entrega]')[0]?.tagName).toBe('MARK');
    // FA-04: a seção já revisada volta a exigir revisão.
    expect(within(panel).getByText(/precisará ser revisada novamente/)).toBeTruthy();
    expect(await seriousA11yViolations()).toEqual([]);

    await user.click(within(panel).getByRole('button', { name: 'Aplicar' }));
    await waitFor(() => {
      expect(callsTo(fetchMock, 'POST', '/ai-apply')).toHaveLength(1);
    });
    const [applyCall] = callsTo(fetchMock, 'POST', '/ai-apply');
    expect(applyCall?.body).toEqual({
      generationId: GEN,
      sectionKeys: [KEY],
      confirmReplaceFilled: true,
    });
    expect(applyCall?.headers.get('If-Match')).toBe('"9"');
    expect(applyCall?.headers.get('Idempotency-Key')).toBeTruthy();
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ key: KEY, revision: 4 }));
    expect(screen.getByLabelText<HTMLTextAreaElement>('Texto').value).toContain(
      '[a confirmar: local de entrega]',
    );

    const undo = await within(panel).findByRole('button', { name: 'Desfazer' });
    await waitFor(() => {
      expect(document.activeElement).toBe(undo);
    });
    await user.click(undo);
    await waitFor(() => {
      expect(callsTo(fetchMock, 'PUT', `/sections/${KEY}`)).toHaveLength(1);
    });
    const [undoCall] = callsTo(fetchMock, 'PUT', `/sections/${KEY}`);
    expect(undoCall?.headers.get('If-Match')).toBe('"s4"');
    expect(undoCall?.body).toMatchObject({ content: doc(TEXT), notApplicable: false });
    expect(screen.getByLabelText<HTMLTextAreaElement>('Texto').value).toBe(TEXT);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 5 }));
    expect(await within(panel).findByText(/Texto anterior restaurado/)).toBeTruthy();
  });

  it('"Desfazer" some quando a seção é editada depois da aplicação (FA-06)', async () => {
    const user = userEvent.setup();
    mockApi();
    renderWithShell(<Editor />);
    const panel = await openPanel(user, /^Reescrever/);
    await user.click(within(panel).getByRole('button', { name: 'Gerar sugestão' }));
    const applyButton = await within(panel).findByRole('button', { name: 'Aplicar' });
    // Seção sem revisão anterior: sem o aviso de "revisar novamente" (FA-04).
    expect(within(panel).queryByText(/precisará ser revisada novamente/)).toBeNull();
    await user.click(applyButton);
    await within(panel).findByRole('button', { name: 'Desfazer' });
    await user.type(screen.getByLabelText('Texto'), ' Editado.');
    expect(within(panel).queryByRole('button', { name: 'Desfazer' })).toBeNull();
  });

  it('410 AI_SUGGESTION_STALE: descarta a sugestão e "Gerar de novo" mantém ação e orientação (FA-02)', async () => {
    const user = userEvent.setup();
    const fetchMock = mockApi({
      apply: () =>
        problemResponse(410, 'AI_SUGGESTION_STALE', {
          detail: 'A seção mudou desde o pedido. Gere o ajuste novamente.',
        }),
    });
    renderWithShell(<Editor />);
    const panel = await openPanel(user, /^Reescrever/);
    await user.type(within(panel).getByLabelText(/Orientação/), 'Mais formal.');
    await user.click(within(panel).getByRole('button', { name: 'Gerar sugestão' }));
    await user.click(await within(panel).findByRole('button', { name: 'Aplicar' }));
    expect(await within(panel).findByText(/A seção mudou desde o pedido/)).toBeTruthy();
    await waitFor(() => {
      expect(callsTo(fetchMock, 'POST', '/discard')).toHaveLength(1);
    });
    await user.click(within(panel).getByRole('button', { name: 'Gerar de novo' }));
    expect(within(panel).getByLabelText<HTMLTextAreaElement>(/Orientação/).value).toBe(
      'Mais formal.',
    );
    expect(
      within(panel)
        .getByRole('radio', { name: /Reescrever/ })
        .getAttribute('aria-checked'),
    ).toBe('true');
  });
});
