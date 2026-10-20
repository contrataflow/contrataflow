// @vitest-environment jsdom
import type {
  DocumentDto,
  DocumentMeta,
  DocumentPresenceEditorDto,
  DocumentTemplateMetaDto,
} from '@contrataflow/validation';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isPollingRequest } from '@/lib/session/polling';
import { onSessionSignal } from '@/lib/session/session-signals';
import { seriousA11yViolations } from '@test/support/axe';
import { ID, PROCESS_ID, bodyOf, mockProcessApi } from '@test/support/process-fixtures';
import {
  IntlProvider,
  jsonResponse,
  problem,
  renderWithShell,
  requestUrl,
} from '@test/support/render';

import { FreeTextEditor } from './free-text-editor';
import { initialsOf, PresenceIndicator } from './presence-indicator';
import { useDocumentPresence } from './use-document-presence';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/processos',
}));

/*
 * US-070 — indicador de edição concorrente na SCR-105 com a API simulada: heartbeat do DOC-24 com a
 * seção ativa ao abrir e a cada 20 s (só em foco), indicador com nome + seção e destaque na mesma
 * seção (FA-01), sem heartbeat para quem só visualiza (FA-02), indicador oculto com o Redis fora do
 * ar (200 com `editors: []` — FA-03) ou na recusa (409/404 → para de enviar), 422
 * `SECTION_NOT_IN_TEMPLATE` silencioso, DOC-25 ao fechar o editor, sondagem de escrita sem banner
 * de indisponibilidade, e acessibilidade (axe).
 */

const ANA = '0192a000-0000-7000-8000-0000000000a1';
const BRUNO = '0192a000-0000-7000-8000-0000000000b7';
const CARLA = '0192a000-0000-7000-8000-0000000000c7';
const DOC_ID = ID(970);
const AT = '2026-10-19T17:31:00.000Z';
const PRESENCE_URL = `/api/v1/documents/${DOC_ID}/presence`;

const TEMPLATE: DocumentTemplateMetaDto = {
  versionId: ID(971),
  versionNumber: 1,
  sections: [
    {
      key: 'JUSTIFICATIVA',
      title: 'Justificativa',
      order: 1,
      requirement: 'REQUIRED',
      helpText: null,
      legalBasis: null,
      minChars: null,
      maxChars: 50_000,
    },
    {
      key: 'REQUISITOS',
      title: 'Requisitos',
      order: 2,
      requirement: 'OPTIONAL',
      helpText: null,
      legalBasis: null,
      minChars: null,
      maxChars: 50_000,
    },
  ],
};

const emptySection = {
  state: 'EMPTY' as const,
  content: null,
  justification: null,
  revision: 1,
  updatedAt: AT,
  updatedById: ANA,
};

function documentDto(): DocumentDto {
  return {
    id: DOC_ID,
    processId: PROCESS_ID,
    documentType: {
      id: ID(972),
      code: 'DESPACHO',
      name: 'Despacho',
      kind: 'FREE_TEXT',
      systemModule: null,
      requiresApproval: false,
    },
    templateVersionId: TEMPLATE.versionId,
    number: 3,
    year: 2026,
    code: 'DESP 0003/2026',
    title: 'Despacho de apoio ao ETP',
    status: 'DRAFT',
    confidentiality: 'INTERNAL',
    draftContent: { sections: { JUSTIFICATIVA: emptySection, REQUISITOS: emptySection } },
    draftRevision: 1,
    currentVersionId: null,
    currentVersionNumber: null,
    approvedVersionId: null,
    pendingApprovalId: null,
    responsibleId: ANA,
    submittedAt: null,
    submittedById: null,
    finalizedAt: null,
    finalizedById: null,
    approvedAt: null,
    returnedAt: null,
    rejectedAt: null,
    reopenedAt: null,
    reopenedById: null,
    reopenReason: null,
    canceledAt: null,
    canceledById: null,
    cancellationReason: null,
    sourceDocumentId: null,
    createdAt: AT,
    updatedAt: AT,
    createdById: ANA,
    version: 1,
  };
}

const EDITABLE: DocumentMeta = { allowedActions: ['UPDATE'], template: TEMPLATE };
const READ_ONLY: DocumentMeta = { allowedActions: [], template: TEMPLATE };

const editor = (
  userId: string,
  name: string | null,
  sectionKey: string | null,
): DocumentPresenceEditorDto => ({ userId, name, sectionKey, since: AT });

type PresenceReply = () => Response | Promise<Response>;

function mockApi(presence: PresenceReply = () => jsonResponse({ data: { editors: [] } })) {
  const base = mockProcessApi({ permissions: ['PROCESS_VIEW'] });
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    if (url === PRESENCE_URL && init?.method === 'PUT') return Promise.resolve(presence());
    if (url === PRESENCE_URL && init?.method === 'DELETE') {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return base(input, init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

type FetchMock = ReturnType<typeof mockApi>;
const heartbeats = (fetchMock: FetchMock) =>
  fetchMock.mock.calls.filter(
    ([input, init]) => requestUrl(input) === PRESENCE_URL && init?.method === 'PUT',
  );
const leaves = (fetchMock: FetchMock) =>
  fetchMock.mock.calls.filter(
    ([input, init]) => requestUrl(input) === PRESENCE_URL && init?.method === 'DELETE',
  );

const renderEditor = (meta: DocumentMeta = EDITABLE) =>
  renderWithShell(<FreeTextEditor document={documentDto()} meta={meta} template={TEMPLATE} />);

beforeEach(() => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('SCR-105 — indicador de edição concorrente (US-070)', () => {
  it('[Sucesso] ao abrir, envia o heartbeat com a seção ativa e mostra quem edita a mesma seção', async () => {
    const fetchMock = mockApi(() =>
      jsonResponse({ data: { editors: [editor(BRUNO, 'Bruno Lima', 'JUSTIFICATIVA')] } }),
    );
    renderEditor();

    expect(await screen.findByText('Bruno Lima está editando esta seção agora')).toBeTruthy();
    const [first] = heartbeats(fetchMock);
    expect(bodyOf(first?.[1])).toEqual({ sectionKey: 'JUSTIFICATIVA' });
    expect(new Headers(first?.[1]?.headers).get('X-CF-Request')).toBe('1');
    expect(new Headers(first?.[1]?.headers).get('If-Match')).toBeNull();
    const indicator = screen.getByRole('region', {
      name: 'Outras pessoas editando este documento',
    });
    expect(indicator.textContent).toContain('Bruno Lima está editando a seção Justificativa');
    expect(await seriousA11yViolations(indicator)).toEqual([]);
  });

  it('[Sucesso] trocar de seção: o próximo heartbeat (20 s) leva a nova seção; o destaque segue a seção do usuário', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = mockApi(() =>
      jsonResponse({ data: { editors: [editor(BRUNO, 'Bruno Lima', 'JUSTIFICATIVA')] } }),
    );
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    renderEditor();
    expect(await screen.findByText('Bruno Lima está editando esta seção agora')).toBeTruthy();

    const [nav] = screen.getAllByRole('navigation', { name: 'Seções do documento' }).slice(-1);
    await user.click((nav ?? document.body).querySelectorAll('button')[1] ?? document.body);
    // Bruno segue em outra seção: some o aviso, fica a presença.
    await waitFor(() => {
      expect(screen.queryByText('Bruno Lima está editando esta seção agora')).toBeNull();
    });
    expect(heartbeats(fetchMock)).toHaveLength(1);
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    await waitFor(() => {
      expect(heartbeats(fetchMock)).toHaveLength(2);
    });
    expect(bodyOf(heartbeats(fetchMock)[1]?.[1])).toEqual({ sectionKey: 'REQUISITOS' });
  });

  it('[Sucesso] FA-01: várias pessoas na mesma seção reforçam o aviso', async () => {
    mockApi(() =>
      jsonResponse({
        data: {
          editors: [
            editor(BRUNO, 'Bruno Lima', 'JUSTIFICATIVA'),
            editor(CARLA, null, 'JUSTIFICATIVA'),
          ],
        },
      }),
    );
    renderEditor();
    expect(await screen.findByText('2 pessoas editando esta seção agora')).toBeTruthy();
    // Nome ausente: "Outra pessoa".
    expect(
      screen.getAllByText(/Outra pessoa está editando a seção Justificativa/).length,
    ).toBeGreaterThan(0);
  });

  it('[Permissão] FA-02: quem só visualiza não envia heartbeat nem vê indicador', async () => {
    const fetchMock = mockApi();
    renderEditor(READ_ONLY);
    expect(await screen.findByRole('heading', { name: 'Conteúdo do documento' })).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(heartbeats(fetchMock)).toHaveLength(0);
    expect(screen.queryByTestId('presence-indicator')).toBeNull();
  });

  it('[Falha de banco] FA-03: Redis fora do ar (200 com editors vazio) → indicador oculto, edição normal', async () => {
    const fetchMock = mockApi();
    renderEditor();
    await waitFor(() => {
      expect(heartbeats(fetchMock)).toHaveLength(1);
    });
    expect(screen.queryByTestId('presence-indicator')).toBeNull();
    expect(
      screen.getByLabelText<HTMLTextAreaElement>(/Texto da seção Justificativa/).readOnly,
    ).toBe(false);
  });

  it('[Permissão] 409 DOCUMENT_NOT_EDITABLE → para de enviar e oculta o indicador', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = mockApi(() => problem(409, 'DOCUMENT_NOT_EDITABLE'));
    renderEditor();
    await waitFor(() => {
      expect(heartbeats(fetchMock)).toHaveLength(1);
    });
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(heartbeats(fetchMock)).toHaveLength(1);
    expect(screen.queryByTestId('presence-indicator')).toBeNull();
  });

  it('[Validação] 422 SECTION_NOT_IN_TEMPLATE é silencioso e o heartbeat continua', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = mockApi(() => problem(422, 'SECTION_NOT_IN_TEMPLATE'));
    renderEditor();
    await waitFor(() => {
      expect(heartbeats(fetchMock)).toHaveLength(1);
    });
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    await waitFor(() => {
      expect(heartbeats(fetchMock)).toHaveLength(2);
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('[Falha de integração] fechar o editor envia o DOC-25 (keepalive) uma vez', async () => {
    const fetchMock = mockApi();
    const view = renderEditor();
    await waitFor(() => {
      expect(heartbeats(fetchMock)).toHaveLength(1);
    });
    view.unmount();
    expect(leaves(fetchMock)).toHaveLength(1);
    expect(leaves(fetchMock)[0]?.[1]).toMatchObject({ method: 'DELETE', keepalive: true });
  });
});

describe('useDocumentPresence — foco e sondagem', () => {
  it('só envia com o editor em foco: pausa no blur e retoma (com heartbeat imediato) no foco', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = mockApi();
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <IntlProvider>{children}</IntlProvider>
    );
    renderHook(
      () => useDocumentPresence({ documentId: DOC_ID, sectionKey: 'JUSTIFICATIVA', enabled: true }),
      { wrapper },
    );
    await act(() => vi.advanceTimersByTimeAsync(40_000));
    expect(heartbeats(fetchMock)).toHaveLength(0);

    focus.mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => {
      expect(heartbeats(fetchMock)).toHaveLength(1);
    });
    focus.mockReturnValue(false);
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(heartbeats(fetchMock)).toHaveLength(1);
  });

  it('heartbeat é sondagem: não renova a ociosidade nem abre o banner de indisponibilidade na falha de rede', async () => {
    expect(isPollingRequest('PUT', `/documents/${DOC_ID}/presence`)).toBe(true);
    expect(isPollingRequest('DELETE', `/documents/${DOC_ID}/presence`)).toBe(false);
    expect(isPollingRequest('PUT', `/documents/${DOC_ID}/sections/JUSTIFICATIVA`)).toBe(false);

    const signals: string[] = [];
    const unsubscribe = onSessionSignal((signal) => signals.push(signal.type));
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    renderHook(() =>
      useDocumentPresence({ documentId: DOC_ID, sectionKey: 'JUSTIFICATIVA', enabled: true }),
    );
    await waitFor(() => {
      expect(vi.mocked(fetch)).toHaveBeenCalled();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    unsubscribe();
    expect(signals).not.toContain('unavailable');
    expect(signals).not.toContain('activity');
  });
});

describe('PresenceIndicator', () => {
  it('iniciais e resumo para telas pequenas', () => {
    expect(initialsOf('Bruno Carvalho Lima')).toBe('BL');
    expect(initialsOf('ana')).toBe('A');
    render(
      <IntlProvider>
        <PresenceIndicator
          editors={[editor(BRUNO, 'Bruno Lima', 'REQUISITOS'), editor(CARLA, 'Carla Dias', null)]}
          currentSectionKey="JUSTIFICATIVA"
          sectionTitle={(key) => (key === 'REQUISITOS' ? 'Requisitos' : key)}
        />
      </IntlProvider>,
    );
    expect(screen.getByText('2 pessoas editando')).toBeTruthy();
    expect(
      screen.getByTitle(
        'Bruno Lima está editando a seção Requisitos; Carla Dias está com o documento aberto para edição',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('status')?.textContent).toBe('');
  });

  it('sem outros editores, não renderiza nada', () => {
    const { container } = render(
      <IntlProvider>
        <PresenceIndicator editors={[]} currentSectionKey="X" sectionTitle={(key) => key} />
      </IntlProvider>,
    );
    expect(container.innerHTML).toBe('');
  });
});
