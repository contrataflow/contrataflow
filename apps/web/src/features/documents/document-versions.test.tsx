// @vitest-environment jsdom
import { Toaster, clearToasts } from '@contrataflow/ui';
import type {
  DocumentAction,
  DocumentDto,
  DocumentVersionComparisonDto,
  DocumentVersionSummaryDto,
} from '@contrataflow/validation';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { chooseOption } from '@test/support/kit';
import { ID, PROCESS_ID, callsTo, problemResponse } from '@test/support/process-fixtures';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { DocumentVersionsView } from './document-versions-view';
import { DocumentView } from './document-view';

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/processos',
}));

/*
 * US-066 — "Salvar versão" sobre a SCR-105 (DOC-16) e a SCR-106 (DOC-15/18): lista com "Comparar
 * com a anterior", seletor de duas versões (V-05), diferenças com indicador em texto, valor
 * sigiloso mascarado (FA-03), lista vazia, erro ao comparar e axe sem violações sérias.
 */

const DOC = ID(700);
const DOC_URL = `/api/v1/documents/${DOC}`;
const V1 = ID(701);
const V2 = ID(702);
const V3 = ID(703);

function documentDto(extra: Partial<DocumentDto> = {}): DocumentDto {
  return {
    id: DOC,
    processId: PROCESS_ID,
    documentType: {
      id: ID(710),
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
    currentVersionId: V3,
    currentVersionNumber: 3,
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

function summary(
  id: string,
  versionNumber: number,
  extra: Partial<DocumentVersionSummaryDto> = {},
) {
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
    ...extra,
  } satisfies DocumentVersionSummaryDto;
}

const VERSIONS = [
  summary(V3, 3, { changeSummary: 'Ajuste na justificativa' }),
  summary(V2, 2, { reason: 'SUBMISSION', statusAtCreation: 'IN_REVIEW' }),
  summary(V1, 1),
] as const;

function comparison(
  from: DocumentVersionSummaryDto,
  to: DocumentVersionSummaryDto,
): DocumentVersionComparisonDto {
  return {
    documentId: DOC,
    kind: 'STRUCTURED',
    from,
    to,
    header: [
      { field: 'document.title', changeType: 'UNCHANGED', from: 'ETP', to: 'ETP' },
      { field: 'objective', changeType: 'CHANGED', from: 'Pavimentar', to: 'Pavimentar ruas' },
      { field: 'estimatedValue', changeType: 'MASKED', from: null, to: null },
    ],
    sections: [
      {
        sectionKey: 'JUSTIFICATIVA',
        changeType: 'CHANGED',
        from: { state: 'NOT_APPLICABLE', text: '', justification: 'Sem justificativa.' },
        to: { state: 'FILLED', text: 'Necessidade de pavimentação.', justification: null },
      },
    ],
    collections: [
      {
        collection: 'items',
        itemId: 'i2',
        changeType: 'ADDED',
        changedFields: [],
        maskedFields: [],
        from: null,
        to: { description: 'Areia', quantity: '3' },
      },
    ],
  };
}

interface Routes {
  readonly versions?: () => Response;
  readonly compare?: (url: string) => Response;
  readonly save?: (init?: RequestInit) => Response;
  readonly allowed?: readonly DocumentAction[];
  readonly document?: DocumentDto;
}

function mockApi(routes: Routes = {}) {
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url === DOC_URL) {
      return Promise.resolve(
        jsonResponse({
          data: routes.document ?? documentDto(),
          meta: { allowedActions: routes.allowed ?? ['UPDATE', 'SUBMIT'] },
        }),
      );
    }
    if (method === 'GET' && url.startsWith(`${DOC_URL}/versions/compare`)) {
      if (routes.compare) return Promise.resolve(routes.compare(url));
      const params = new URL(url, 'http://x').searchParams;
      const from = VERSIONS.find((item) => item.id === params.get('from')) ?? VERSIONS[1];
      const to = VERSIONS.find((item) => item.id === params.get('to')) ?? VERSIONS[0];
      return Promise.resolve(jsonResponse({ data: comparison(from, to) }));
    }
    if (method === 'GET' && url.startsWith(`${DOC_URL}/versions`)) {
      return Promise.resolve(
        routes.versions
          ? routes.versions()
          : jsonResponse({
              data: VERSIONS,
              meta: { page: 1, pageSize: 100, totalItems: 3, totalPages: 1 },
            }),
      );
    }
    if (method === 'POST' && url === `${DOC_URL}/versions`) {
      return Promise.resolve(
        routes.save
          ? routes.save(init)
          : jsonResponse(
              { data: { ...summary(ID(704), 4), kind: 'STRUCTURED', content: null } },
              { status: 201 },
            ),
      );
    }
    return Promise.resolve(problemResponse(404, 'NOT_FOUND'));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderVersions() {
  return renderWithShell(
    <>
      <DocumentVersionsView processId={PROCESS_ID} documentId={DOC} />
      <Toaster label="Notificações" closeLabel="Fechar" />
    </>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

describe('SCR-105 · Salvar versão (DOC-16)', () => {
  async function openDocument(routes: Routes = {}) {
    const fetchMock = mockApi(routes);
    renderWithShell(
      <>
        <DocumentView processId={PROCESS_ID} documentId={DOC} />
        <Toaster label="Notificações" closeLabel="Fechar" />
      </>,
    );
    await screen.findByRole('heading', { level: 1, name: 'ETP da aquisição de cimento' });
    return fetchMock;
  }

  it('salva com resumo, Idempotency-Key, toast "Versão 4 salva" e link para as versões', async () => {
    const fetchMock = await openDocument();
    expect(screen.getByRole('link', { name: 'Ver versões' }).getAttribute('href')).toBe(
      `/processos/${PROCESS_ID}/documentos/${DOC}/versoes`,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Salvar versão' }));
    const dialog = await screen.findByRole('dialog', { name: 'Salvar versão' });
    await user.type(
      within(dialog).getByLabelText('Resumo da alteração (opcional)'),
      'Ajuste na justificativa',
    );
    expect(within(dialog).getByText('23 de 500 caracteres')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Salvar versão' }));

    expect(await screen.findByText('Versão 4 salva')).toBeTruthy();
    const [call] = callsTo(fetchMock, 'POST', `${DOC_URL}/versions`);
    expect(call?.body).toEqual({ changeSummary: 'Ajuste na justificativa' });
    expect(call?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(call?.headers.get('If-Match')).toBeNull();
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('resumo acima de 500 caracteres: mensagem no campo e nada é enviado (V-03)', async () => {
    const fetchMock = await openDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Salvar versão' }));
    const dialog = await screen.findByRole('dialog', { name: 'Salvar versão' });
    const field = within(dialog).getByLabelText('Resumo da alteração (opcional)');
    await user.click(field);
    await user.paste('x'.repeat(600));
    await user.click(within(dialog).getByRole('button', { name: 'Salvar versão' }));
    expect(within(dialog).getByText('O resumo deve ter no máximo 500 caracteres.')).toBeTruthy();
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(callsTo(fetchMock, 'POST', `${DOC_URL}/versions`)).toEqual([]);
  });

  it('banco fora do ar: alerta "Tentar novamente" no diálogo; a nova tentativa salva', async () => {
    let attempts = 0;
    await openDocument({
      save: () => {
        attempts += 1;
        // A mutação já repete o 503 sozinha (3 vezes): o alerta aparece quando todas falham.
        return attempts <= 4
          ? problemResponse(503, 'DEPENDENCY_UNAVAILABLE')
          : jsonResponse(
              { data: { ...summary(ID(704), 4), kind: 'STRUCTURED', content: null } },
              { status: 201 },
            );
      },
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Salvar versão' }));
    const dialog = await screen.findByRole('dialog', { name: 'Salvar versão' });
    await user.click(within(dialog).getByRole('button', { name: 'Salvar versão' }));
    const retry = await within(dialog).findByRole(
      'button',
      { name: 'Tentar novamente' },
      { timeout: 15_000 },
    );
    await user.click(retry);
    expect(await screen.findByText('Versão 4 salva')).toBeTruthy();
  });

  it('documento não editável (409): toast com o motivo e o diálogo fecha', async () => {
    await openDocument({
      save: () =>
        problemResponse(409, 'DOCUMENT_NOT_EDITABLE', {
          detail: 'Esta versão só pode ser salva enquanto o documento está em edição.',
        }),
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Salvar versão' }));
    const dialog = await screen.findByRole('dialog', { name: 'Salvar versão' });
    await user.click(within(dialog).getByRole('button', { name: 'Salvar versão' }));
    expect(
      await screen.findByText('Esta versão só pode ser salva enquanto o documento está em edição.'),
    ).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('sem UPDATE em allowedActions ou documento externo: o botão não aparece (FA-02)', async () => {
    await openDocument({ allowed: ['SUBMIT'] });
    expect(screen.queryByRole('button', { name: 'Salvar versão' })).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe('SCR-106 · Versões e comparação (DOC-15/18)', () => {
  it('lista desc com motivo, autor, resumo ou "Sem resumo informado" e o prefixo do hash (axe)', async () => {
    mockApi();
    renderVersions();
    const table = await screen.findByRole('table', { name: 'Versões do documento' });
    const items = within(table).getAllByRole('row').slice(1);
    const item = (index: number) => {
      const found = items[index];
      if (!found) throw new Error(`item ${String(index)} ausente`);
      return found;
    };
    expect(items.map((item) => within(item).getByText(/^Versão \d$/).textContent)).toEqual([
      'Versão 3',
      'Versão 2',
      'Versão 1',
    ]);
    expect(within(item(0)).getByText('Ajuste na justificativa')).toBeTruthy();
    expect(within(item(1)).getByText('Submissão')).toBeTruthy();
    expect(within(item(1)).getByText('Sem resumo informado')).toBeTruthy();
    expect(within(item(0)).getByText('333333333333')).toBeTruthy();
    // A primeira versão não tem anterior.
    expect(within(item(2)).queryByRole('button', { name: /Comparar com a anterior/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Salvar versão' })).toBeTruthy();
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('"Comparar com a anterior" mostra cabeçalho, seções e coleções com indicadores em texto; sigiloso = MASKED (axe)', async () => {
    const fetchMock = mockApi();
    renderVersions();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: /Comparar com a anterior.*versão 3/ }),
    );
    expect(await screen.findByRole('heading', { name: 'Cabeçalho' })).toBeTruthy();
    expect(
      callsTo(fetchMock, 'GET', `${DOC_URL}/versions/compare?from=${V2}&to=${V3}`),
    ).toHaveLength(1);

    const header = screen.getByRole('table', { name: 'Cabeçalho' });
    const objective = within(header).getByRole('row', { name: /objective/ });
    expect(within(objective).getByText('Alterado')).toBeTruthy();
    expect(within(objective).getByText('Pavimentar ruas')).toBeTruthy();
    const masked = within(header).getByRole('row', { name: /estimatedValue/ });
    expect(within(masked).getAllByText(/Valor sigiloso/).length).toBeGreaterThanOrEqual(1);
    expect(within(header).getByRole('row', { name: /Título/ })).toBeTruthy();

    expect(screen.getByText('JUSTIFICATIVA')).toBeTruthy();
    await user.click(screen.getByText('Ver texto completo'));
    expect(screen.getByText('Necessidade de pavimentação.')).toBeTruthy();
    expect(screen.getByText('Justificativa: Sem justificativa.')).toBeTruthy();
    expect(screen.getByText('Adicionado')).toBeTruthy();
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('seletor: versões iguais → "Escolha duas versões diferentes para comparar." sem chamar a API (V-05)', async () => {
    const fetchMock = mockApi();
    renderVersions();
    const user = userEvent.setup();
    const picker = await screen.findByRole('form', { name: 'Comparar duas versões' });
    await chooseOption(user, 'Versão de origem', /^Versão 1 —/, picker);
    await chooseOption(user, 'Versão de destino', /^Versão 1 —/, picker);
    await user.click(within(picker).getByRole('button', { name: 'Comparar' }));
    expect(within(picker).getByRole('alert').textContent).toBe(
      'Escolha duas versões diferentes para comparar.',
    );
    expect(fetchMock.mock.calls.some(([input]) => requestUrl(input).includes('compare'))).toBe(
      false,
    );

    await chooseOption(user, 'Versão de destino', /^Versão 3 —/, picker);
    await user.click(within(picker).getByRole('button', { name: 'Comparar' }));
    await waitFor(() => {
      expect(
        callsTo(fetchMock, 'GET', `${DOC_URL}/versions/compare?from=${V1}&to=${V3}`),
      ).toHaveLength(1);
    });
  });

  it('lista vazia: "Nenhuma versão salva ainda"', async () => {
    mockApi({
      versions: () =>
        jsonResponse({ data: [], meta: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 } }),
    });
    renderVersions();
    expect(await screen.findByText('Nenhuma versão salva ainda')).toBeTruthy();
  });

  it('erro ao comparar: mensagem e "Recarregar"', async () => {
    let calls = 0;
    mockApi({
      compare: () => {
        calls += 1;
        return calls === 1
          ? problemResponse(422, 'VALIDATION_ERROR', {
              errors: [
                {
                  field: 'to',
                  code: 'REFERENCE_NOT_FOUND',
                  message: 'Selecione duas versões deste mesmo documento.',
                },
              ],
            })
          : jsonResponse({ data: comparison(VERSIONS[1], VERSIONS[0]) });
      },
    });
    renderVersions();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: /Comparar com a anterior.*versão 3/ }),
    );
    expect(await screen.findByText('Selecione duas versões deste mesmo documento.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Recarregar' }));
    expect(await screen.findByRole('heading', { name: 'Cabeçalho' })).toBeTruthy();
  });

  it('documento inexistente ou de outro tenant: "Documento ou versão não encontrados."', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(() => Promise.resolve(problemResponse(404, 'NOT_FOUND'))),
    );
    renderVersions();
    expect(await screen.findByText('Documento ou versão não encontrados.')).toBeTruthy();
  });
});
