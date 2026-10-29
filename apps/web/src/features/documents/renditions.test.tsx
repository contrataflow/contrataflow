// @vitest-environment jsdom
import type {
  DocumentDto,
  DocumentRenditionDto,
  DocumentVersionSummaryDto,
} from '@contrataflow/validation';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { ID, PROCESS_ID, callsTo, problemResponse } from '@test/support/process-fixtures';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { DocumentVersionsView } from './document-versions-view';
import { DocumentView } from './document-view';
import { GeneratePdfButton } from './generate-pdf-button';
import type { PdfSource } from './generate-pdf-button';
import { startDownload } from './renditions.api';

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, refresh: vi.fn() }),
  usePathname: () => '/processos',
}));

// O *polling* real é de 2 s; nos testes encurta para não esperar (o valor em produção está em
// `renditions.api.ts`, e o teste de intervalo abaixo confere que ele é curto).
vi.mock('./renditions.api', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('./renditions.api')),
  RENDITION_POLL_MS: 60,
}));

/*
 * US-067 — PDFs dos documentos na SCR-105/106 (DOC-20..23): `GeneratePdfButton` com os quatro
 * estados (gerando, pronto, falha, expirada), *polling* que para ao chegar em `READY`, download por
 * DOC-23, "Tentar novamente", região `aria-live`, erros 404/409/429/503 e axe sem violações sérias.
 */

const DOC = ID(800);
const VERSION_ID = ID(801);
const R1 = ID(810);
const R2 = ID(811);
const API = '/api/v1';
const DETAIL = (id: string) => `${API}/document-renditions/${id}`;
const DOWNLOAD_URL = 'https://storage.example/pdf/rendicao.pdf?X-Amz-Signature=abc';
const HASH = 'ab12cd34ef56'.repeat(5).slice(0, 64);

function rendition(extra: Partial<DocumentRenditionDto> = {}): DocumentRenditionDto {
  return {
    id: R1,
    documentId: DOC,
    documentVersionId: null,
    draftRevision: 4,
    approvalId: null,
    kind: 'PREVIEW',
    status: 'PENDING',
    masked: false,
    sha256: null,
    sizeBytes: null,
    pageCount: null,
    errorCode: null,
    attempts: 0,
    requestedById: ID(1),
    requestedAt: '2026-10-17T12:00:00.000Z',
    startedAt: null,
    readyAt: null,
    expiresAt: '2099-10-18T12:00:00.000Z',
    createdAt: '2026-10-17T12:00:00.000Z',
    updatedAt: '2026-10-17T12:00:00.000Z',
    ...extra,
  };
}

const READY = rendition({
  status: 'READY',
  sha256: HASH,
  sizeBytes: 1536,
  pageCount: 3,
  readyAt: '2026-10-17T12:00:05.000Z',
});

/** Respostas em sequência; a última se repete. */
function sequence<T>(items: readonly T[]): () => T {
  let index = 0;
  return () => {
    const item = items[Math.min(index, items.length - 1)];
    index += 1;
    if (item === undefined) throw new Error('sequência vazia');
    return item;
  };
}

function rateLimited(seconds: number): Response {
  return new Response(
    JSON.stringify({
      type: 'https://docs.contrataflow.com.br/errors/rate-limited',
      title: 'RATE_LIMITED',
      status: 429,
      detail: 'RATE_LIMITED',
      instance: '/api/v1/x',
      code: 'RATE_LIMITED',
      correlationId: 'c-test',
      errors: [],
      violations: [],
    }),
    {
      status: 429,
      headers: { 'Content-Type': 'application/problem+json', 'Retry-After': String(seconds) },
    },
  );
}

interface Routes {
  /** DOC-20 (status 202). */
  readonly preview?: () => Response;
  /** DOC-21 (202 ou 200). */
  readonly version?: () => Response;
  /** DOC-22. */
  readonly detail?: () => Response;
  /** DOC-23. */
  readonly download?: () => Response;
  readonly document?: DocumentDto;
  readonly versions?: readonly DocumentVersionSummaryDto[];
}

function mockApi(routes: Routes = {}) {
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    if (method === 'POST' && url === `${API}/documents/${DOC}/preview`) {
      return Promise.resolve(
        routes.preview?.() ?? jsonResponse({ data: rendition() }, { status: 202 }),
      );
    }
    if (method === 'POST' && url === `${API}/document-versions/${VERSION_ID}/renditions`) {
      return Promise.resolve(
        routes.version?.() ??
          jsonResponse(
            { data: rendition({ kind: 'CONTENT', documentVersionId: VERSION_ID }) },
            { status: 202 },
          ),
      );
    }
    if (method === 'GET' && url.startsWith(`${API}/document-renditions/`)) {
      if (url.endsWith('/download')) {
        return Promise.resolve(
          routes.download?.() ??
            jsonResponse({ data: { url: DOWNLOAD_URL, expiresAt: '2026-10-17T12:05:00.000Z' } }),
        );
      }
      return Promise.resolve(routes.detail?.() ?? jsonResponse({ data: READY }));
    }
    if (method === 'GET' && url === `${API}/documents/${DOC}`) {
      return Promise.resolve(
        jsonResponse({
          data: routes.document ?? documentDto(),
          meta: { allowedActions: ['UPDATE'] },
        }),
      );
    }
    if (method === 'GET' && url.startsWith(`${API}/documents/${DOC}/versions`)) {
      const items = routes.versions ?? VERSIONS;
      return Promise.resolve(
        jsonResponse({
          data: items,
          meta: { page: 1, pageSize: 100, totalItems: items.length, totalPages: 1 },
        }),
      );
    }
    return Promise.resolve(problemResponse(404, 'NOT_FOUND'));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const PREVIEW: PdfSource = { kind: 'preview', documentId: DOC };
const VERSION: PdfSource = { kind: 'version', versionId: VERSION_ID, versionNumber: 3 };

function renderButton(source: PdfSource = PREVIEW) {
  const navigate = vi.fn();
  renderWithShell(<GeneratePdfButton source={source} navigate={navigate} />);
  return { navigate, user: userEvent.setup() };
}

afterEach(() => {
  vi.unstubAllGlobals();
  nav.push.mockClear();
});

describe('GeneratePdfButton · prévia (DOC-20/22/23)', () => {
  it('gera, mostra "Gerando PDF…" numa região aria-live, acompanha até READY e para de consultar (axe)', async () => {
    const fetchMock = mockApi({
      detail: sequence([
        jsonResponse({ data: rendition({ status: 'PROCESSING' }) }),
        jsonResponse({ data: READY }),
      ]),
    });
    const { user } = renderButton();
    expect(screen.queryByRole('status')?.textContent ?? '').toBe('');

    await user.click(screen.getByRole('button', { name: 'Gerar prévia em PDF' }));
    const [post] = callsTo(fetchMock, 'POST', `${API}/documents/${DOC}/preview`);
    expect(post?.init?.body ?? null).toBeNull();

    const region = screen.getByRole('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(await within(region).findByText('Gerando PDF…')).toBeTruthy();
    // Enquanto gera, não dá para pedir de novo.
    expect(
      screen.getByRole('button', { name: 'Gerar prévia em PDF' }).hasAttribute('disabled'),
    ).toBe(true);

    expect(await within(region).findByText('PDF pronto')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Baixar PDF' })).toBeTruthy();
    expect(screen.queryByText('Gerando PDF…')).toBeNull();

    // O polling parou: nenhuma consulta nova depois de READY.
    const polls = callsTo(fetchMock, 'GET', DETAIL(R1)).length;
    expect(polls).toBeGreaterThanOrEqual(2);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(callsTo(fetchMock, 'GET', DETAIL(R1))).toHaveLength(polls);

    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('PDF pronto: páginas, tamanho, hash SHA-256 abreviado e validade da prévia', async () => {
    mockApi();
    const { user } = renderButton();
    await user.click(screen.getByRole('button', { name: 'Gerar prévia em PDF' }));
    const panel = await screen.findByRole('region', { name: 'Resumo do PDF gerado' });
    expect(within(panel).getByText('3')).toBeTruthy();
    expect(within(panel).getByText('1,5 KB')).toBeTruthy();
    const hash = within(panel).getByText(HASH.slice(0, 12));
    expect(hash.getAttribute('title')).toBe(HASH);
    expect(within(panel).getByText('Válida até')).toBeTruthy();
    expect(within(panel).queryByText('Valores sigilosos ocultos neste PDF')).toBeNull();
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('PDF com valores sigilosos ocultos (masked) avisa na tela (POL-09)', async () => {
    mockApi({ detail: () => jsonResponse({ data: { ...READY, masked: true } }) });
    const { user } = renderButton();
    await user.click(screen.getByRole('button', { name: 'Gerar prévia em PDF' }));
    expect(await screen.findByText('Valores sigilosos ocultos neste PDF')).toBeTruthy();
  });

  it('"Baixar PDF" chama DOC-23 e navega até a URL pré-assinada', async () => {
    const fetchMock = mockApi();
    const { user, navigate } = renderButton();
    await user.click(screen.getByRole('button', { name: 'Gerar prévia em PDF' }));
    await user.click(await screen.findByRole('button', { name: 'Baixar PDF' }));
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith(DOWNLOAD_URL);
    });
    expect(callsTo(fetchMock, 'GET', `${DETAIL(R1)}/download`)).toHaveLength(1);
  });

  it('URL de download com esquema que não é http(s) é recusada', () => {
    expect(() => {
      startDownload('javascript:alert(1)');
    }).toThrow('esquema não permitido');
  });

  it('FAILED: mostra a mensagem da API de PDF e "Tentar novamente" faz um novo pedido', async () => {
    const fetchMock = mockApi({
      preview: sequence([
        jsonResponse({ data: rendition() }, { status: 202 }),
        jsonResponse({ data: rendition({ id: R2 }) }, { status: 202 }),
      ]),
      detail: sequence([
        jsonResponse({
          data: rendition({ status: 'FAILED', errorCode: 'RENDER_FAILED', attempts: 3 }),
        }),
        jsonResponse({ data: { ...READY, id: R2 } }),
      ]),
    });
    const { user } = renderButton();
    await user.click(screen.getByRole('button', { name: 'Gerar prévia em PDF' }));

    const region = screen.getByRole('status');
    expect(await within(region).findByText('Falha ao gerar')).toBeTruthy();
    expect(
      within(region).getByText('Não foi possível gerar o PDF. A equipe foi notificada.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Baixar PDF' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByRole('button', { name: 'Baixar PDF' })).toBeTruthy();
    expect(callsTo(fetchMock, 'POST', `${API}/documents/${DOC}/preview`)).toHaveLength(2);
    expect(screen.queryByText('Falha ao gerar')).toBeNull();
  });

  it('EXPIRED: desabilita o download, avisa e oferece gerar uma nova prévia', async () => {
    const fetchMock = mockApi({
      detail: () => jsonResponse({ data: rendition({ status: 'EXPIRED' }) }),
    });
    const { user } = renderButton();
    await user.click(screen.getByRole('button', { name: 'Gerar prévia em PDF' }));

    const region = screen.getByRole('status');
    expect(await within(region).findByText('Prévia expirada')).toBeTruthy();
    expect(within(region).getByText('Esta prévia expirou. Gere novamente.')).toBeTruthy();
    const expired = screen.getByRole('button', { name: 'Prévia expirada — gere novamente' });
    expect(expired.hasAttribute('disabled')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Baixar PDF' })).toBeNull();
    expect(await seriousA11yViolations()).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Gerar nova prévia' }));
    await waitFor(() => {
      expect(callsTo(fetchMock, 'POST', `${API}/documents/${DOC}/preview`)).toHaveLength(2);
    });
  });

  it('READY com expiresAt no passado conta como prévia expirada', async () => {
    mockApi({
      detail: () => jsonResponse({ data: { ...READY, expiresAt: '2020-01-01T00:00:00.000Z' } }),
    });
    const { user } = renderButton();
    await user.click(screen.getByRole('button', { name: 'Gerar prévia em PDF' }));
    expect(
      (
        await screen.findByRole('button', { name: 'Prévia expirada — gere novamente' })
      ).hasAttribute('disabled'),
    ).toBe(true);
    expect(screen.queryByRole('button', { name: 'Baixar PDF' })).toBeNull();
  });

  it('409 no download de uma prévia: vira "Prévia expirada" e nada é baixado', async () => {
    mockApi({
      download: () =>
        problemResponse(409, 'RENDITION_NOT_READY', {
          detail: 'Esta prévia expirou. Gere novamente.',
        }),
    });
    const { navigate, user } = renderButton();
    await user.click(screen.getByRole('button', { name: 'Gerar prévia em PDF' }));
    await user.click(await screen.findByRole('button', { name: 'Baixar PDF' }));
    expect(
      await screen.findByRole('button', { name: 'Prévia expirada — gere novamente' }),
    ).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('GeneratePdfButton · versão (DOC-21)', () => {
  it('envia { kind: "CONTENT" } e usa o nome acessível com a versão', async () => {
    const fetchMock = mockApi({
      detail: () =>
        jsonResponse({
          data: { ...READY, kind: 'CONTENT', documentVersionId: VERSION_ID, expiresAt: null },
        }),
    });
    const { user } = renderButton(VERSION);
    await user.click(screen.getByRole('button', { name: /Gerar PDF desta versão.*versão 3/ }));
    const [post] = callsTo(fetchMock, 'POST', `${API}/document-versions/${VERSION_ID}/renditions`);
    expect(post?.body).toEqual({ kind: 'CONTENT' });
    expect(await screen.findByRole('button', { name: /Baixar PDF.*versão 3/ })).toBeTruthy();
    // PDF oficial pronto: não há "validade" nem novo pedido.
    expect(screen.queryByText('Válida até')).toBeNull();
    expect(screen.queryByRole('button', { name: /Gerar PDF desta versão/ })).toBeNull();
  });

  it('200 (rendition já existia): mostra o PDF pronto sem esperar', async () => {
    const fetchMock = mockApi({
      version: () =>
        jsonResponse(
          {
            data: { ...READY, kind: 'CONTENT', documentVersionId: VERSION_ID, expiresAt: null },
          },
          { status: 200 },
        ),
    });
    const { user } = renderButton(VERSION);
    await user.click(screen.getByRole('button', { name: /Gerar PDF desta versão/ }));
    expect(await screen.findByText('PDF pronto')).toBeTruthy();
    expect(callsTo(fetchMock, 'GET', DETAIL(R1))).toHaveLength(0);
  });

  it('409 no download de PDF oficial mostra o detail da API e volta a consultar', async () => {
    const fetchMock = mockApi({
      detail: () =>
        jsonResponse({
          data: { ...READY, kind: 'CONTENT', documentVersionId: VERSION_ID, expiresAt: null },
        }),
      download: () =>
        problemResponse(409, 'RENDITION_NOT_READY', {
          detail: 'O PDF ainda está sendo gerado. Aguarde.',
        }),
    });
    const { user } = renderButton(VERSION);
    await user.click(screen.getByRole('button', { name: /Gerar PDF desta versão/ }));
    await user.click(await screen.findByRole('button', { name: /Baixar PDF/ }));
    expect(await screen.findByText('O PDF ainda está sendo gerado. Aguarde.')).toBeTruthy();
    await waitFor(() => {
      expect(callsTo(fetchMock, 'GET', DETAIL(R1)).length).toBeGreaterThanOrEqual(1);
    });
  });
});

describe('GeneratePdfButton · erros', () => {
  it('404: "Documento ou versão não encontrados."', async () => {
    mockApi({ preview: () => problemResponse(404, 'NOT_FOUND') });
    const { user } = renderButton();
    await user.click(screen.getByRole('button', { name: 'Gerar prévia em PDF' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Documento ou versão não encontrados.',
    );
  });

  it('429: mostra a mensagem e respeita o Retry-After antes de aceitar novo pedido', async () => {
    mockApi({ preview: () => rateLimited(1) });
    const { user } = renderButton();
    await user.click(screen.getByRole('button', { name: 'Gerar prévia em PDF' }));
    expect(
      await screen.findByText('Muitas solicitações de PDF. Aguarde alguns segundos.'),
    ).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Gerar prévia em PDF' });
    expect(button.hasAttribute('disabled')).toBe(true);
    await waitFor(() => {
      expect(button.hasAttribute('disabled')).toBe(false);
    });
  });

  it('503: "Não foi possível processar sua solicitação agora." com "Tentar novamente" que repete o pedido', async () => {
    const fetchMock = mockApi({
      preview: sequence([
        problemResponse(503, 'DEPENDENCY_UNAVAILABLE'),
        jsonResponse({ data: rendition() }, { status: 202 }),
      ]),
    });
    const { user } = renderButton();
    await user.click(screen.getByRole('button', { name: 'Gerar prévia em PDF' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Não foi possível processar sua solicitação agora.');
    expect(await seriousA11yViolations()).toEqual([]);
    await user.click(within(alert).getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByRole('button', { name: 'Baixar PDF' })).toBeTruthy();
    expect(callsTo(fetchMock, 'POST', `${API}/documents/${DOC}/preview`)).toHaveLength(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('403 no download: mostra o motivo da API', async () => {
    mockApi({
      download: () =>
        problemResponse(403, 'PERMISSION_DENIED', {
          detail: 'Este PDF contém valores sigilosos que você não pode ver.',
        }),
    });
    const { user } = renderButton();
    await user.click(screen.getByRole('button', { name: 'Gerar prévia em PDF' }));
    await user.click(await screen.findByRole('button', { name: 'Baixar PDF' }));
    expect(
      await screen.findByText('Este PDF contém valores sigilosos que você não pode ver.'),
    ).toBeTruthy();
  });

  it('falha ao consultar o status (DOC-22): alerta com "Tentar novamente" que consulta de novo', async () => {
    mockApi({
      detail: sequence([
        problemResponse(503, 'DEPENDENCY_UNAVAILABLE'),
        problemResponse(503, 'DEPENDENCY_UNAVAILABLE'),
        problemResponse(503, 'DEPENDENCY_UNAVAILABLE'),
        jsonResponse({ data: READY }),
      ]),
    });
    const { user } = renderButton();
    await user.click(screen.getByRole('button', { name: 'Gerar prévia em PDF' }));
    // O TanStack Query repete o 503 duas vezes antes de entregar o erro à tela.
    const alert = await screen.findByRole('alert', {}, { timeout: 10_000 });
    expect(alert.textContent).toContain('Não foi possível processar sua solicitação agora.');
    await user.click(within(alert).getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByRole('button', { name: 'Baixar PDF' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

// --- Integração nas telas -----------------------------------------------------------------------

function documentDto(extra: Partial<DocumentDto> = {}): DocumentDto {
  return {
    id: DOC,
    processId: PROCESS_ID,
    documentType: {
      id: ID(820),
      code: 'ETP',
      name: 'Estudo Técnico Preliminar',
      kind: 'STRUCTURED',
      systemModule: 'ETP',
      requiresApproval: true,
    },
    templateVersionId: null,
    number: 3,
    year: 2026,
    code: 'ETP 0003/2026',
    title: 'ETP da aquisição de cimento',
    status: 'DRAFT',
    confidentiality: 'INTERNAL',
    draftContent: { sections: {} },
    draftRevision: 2,
    currentVersionId: VERSION_ID,
    currentVersionNumber: 1,
    approvedVersionId: null,
    pendingApprovalId: null,
    responsibleId: ID(1),
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
    createdAt: '2026-10-16T12:00:00.000Z',
    updatedAt: '2026-10-16T12:30:00.000Z',
    createdById: ID(1),
    version: 5,
    ...extra,
  };
}

const UPLOADED = documentDto({
  documentType: {
    id: ID(821),
    code: 'EXT',
    name: 'Documento externo',
    kind: 'UPLOADED',
    systemModule: null,
    requiresApproval: false,
  },
});

function summary(id: string, versionNumber: number): DocumentVersionSummaryDto {
  return {
    id,
    documentId: DOC,
    processId: PROCESS_ID,
    versionNumber,
    reason: 'MANUAL',
    statusAtCreation: 'DRAFT',
    contentHash: String(versionNumber).repeat(64).slice(0, 64),
    attachmentId: null,
    templateVersionId: null,
    changeSummary: null,
    createdById: ID(1),
    createdByName: 'Lúcia Matos',
    createdAt: '2026-10-17T13:00:00.000Z',
  };
}

const VERSIONS = [summary(ID(803), 2), summary(VERSION_ID, 1)] as const;

describe('SCR-105 · Gerar prévia em PDF', () => {
  it('documento estruturado mostra o botão e o pedido usa DOC-20', async () => {
    const fetchMock = mockApi();
    renderWithShell(<DocumentView processId={PROCESS_ID} documentId={DOC} />);
    await screen.findByRole('heading', { level: 1, name: 'ETP da aquisição de cimento' });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Gerar prévia em PDF' }));
    await screen.findByRole('button', { name: 'Baixar PDF' });
    expect(callsTo(fetchMock, 'POST', `${API}/documents/${DOC}/preview`)).toHaveLength(1);
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('documento externo (UPLOADED) não oferece PDF', async () => {
    mockApi({ document: UPLOADED });
    renderWithShell(<DocumentView processId={PROCESS_ID} documentId={DOC} />);
    await screen.findByRole('heading', { level: 1, name: 'ETP da aquisição de cimento' });
    expect(screen.queryByRole('button', { name: /Gerar prévia em PDF/ })).toBeNull();
  });
});

function itemAt(items: readonly HTMLElement[], index: number): HTMLElement {
  const item = items[index];
  if (!item) throw new Error(`item ${String(index)} ausente`);
  return item;
}

describe('SCR-106 · Gerar PDF desta versão', () => {
  it('um botão por versão; gerar uma versão não afeta as outras (axe)', async () => {
    const fetchMock = mockApi({
      detail: () =>
        jsonResponse({
          data: { ...READY, kind: 'CONTENT', documentVersionId: VERSION_ID, expiresAt: null },
        }),
    });
    renderWithShell(<DocumentVersionsView processId={PROCESS_ID} documentId={DOC} />);
    const table = await screen.findByRole('table', { name: 'Versões do documento' });
    const items = within(table).getAllByRole('row').slice(1);
    expect(items).toHaveLength(2);
    expect(
      within(itemAt(items, 0)).getByRole('button', { name: /Gerar PDF.*versão 2/ }),
    ).toBeTruthy();

    const user = userEvent.setup();
    await user.click(within(itemAt(items, 1)).getByRole('button', { name: /Gerar PDF.*versão 1/ }));
    expect(await within(itemAt(items, 1)).findByText('PDF pronto')).toBeTruthy();
    expect(within(itemAt(items, 0)).queryByText('PDF pronto')).toBeNull();
    expect(
      callsTo(fetchMock, 'POST', `${API}/document-versions/${VERSION_ID}/renditions`),
    ).toHaveLength(1);
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('documento externo (UPLOADED): sem "Gerar PDF desta versão"', async () => {
    mockApi({ document: UPLOADED });
    renderWithShell(<DocumentVersionsView processId={PROCESS_ID} documentId={DOC} />);
    await screen.findByRole('table', { name: 'Versões do documento' });
    expect(screen.queryByRole('button', { name: /Gerar PDF/ })).toBeNull();
  });
});
