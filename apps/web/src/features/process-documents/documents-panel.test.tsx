// @vitest-environment jsdom
import { Toaster, clearToasts } from '@contrataflow/ui';
import type {
  DocumentTypeDto,
  ProcessDocumentDto,
  ProcessDocumentsMeta,
} from '@contrataflow/validation';
import { act, configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeQueryClient } from '@/lib/query/query-client';
import { seriousA11yViolations } from '@test/support/axe';
import { ID, PROCESS_ID, mockProcessApi, problemResponse } from '@test/support/process-fixtures';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { DocumentsPanel } from './documents-panel';

/*
 * US-062 — SCR-006, aba "Documentos": os cenários do Gherkin do lado da tela (cartões por tipo, selo
 * "Em aprovação", menu "Criar documento", 404, 503 com "Tentar novamente", revalidação ao focar),
 * POL-09 no resumo, filtros locais (RN-DOC-20 · V-02), folha inferior no mobile e axe.
 */

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

// US-014: "Novo documento › DFD" cria pelo DFD-02 e navega para o SCR-007.
const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => `/processos/${PROCESS_ID}`,
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

const LIST = `/api/v1/processes/${PROCESS_ID}/documents`;

function docType(id: number, code: string, name: string, extra: Partial<DocumentTypeDto> = {}) {
  return {
    id: ID(id),
    code,
    name,
    description: null,
    kind: 'FREE_TEXT',
    systemModule: null,
    isSystem: true,
    isActive: true,
    allowMultiplePerProcess: true,
    numberingEnabled: true,
    numberingMask: null,
    nextNumberPreview: null,
    requiresApproval: false,
    approvalPolicy: null,
    defaultConfidentiality: 'INTERNAL',
    defaultTemplate: null,
    sortOrder: 100,
    editableFields: [],
    version: 1,
    ...extra,
  } satisfies DocumentTypeDto;
}

const ETP = docType(10, 'ETP', 'Estudo Técnico Preliminar', {
  kind: 'STRUCTURED',
  systemModule: 'ETP',
  allowMultiplePerProcess: false,
  sortOrder: 20,
});
const DESPACHO = docType(11, 'DESPACHO', 'Despacho', { sortOrder: 60 });
const OFICIO = docType(12, 'OFICIO', 'Ofício', { sortOrder: 70 });
const PRICE_RESEARCH = docType(13, 'PRICE_RESEARCH', 'Pesquisa de preços', {
  kind: 'STRUCTURED',
  systemModule: 'PRICE_RESEARCH',
  allowMultiplePerProcess: false,
  sortOrder: 40,
});
const TYPES = [ETP, DESPACHO, OFICIO];

function doc(
  id: number,
  type: DocumentTypeDto,
  extra: Partial<ProcessDocumentDto> = {},
): ProcessDocumentDto {
  return {
    id: ID(id),
    processId: PROCESS_ID,
    documentType: {
      id: type.id,
      code: type.code,
      name: type.name,
      kind: type.kind,
      systemModule: type.systemModule,
      requiresApproval: type.requiresApproval,
    },
    templateVersionId: null,
    number: null,
    year: null,
    code: null,
    title: `Documento ${type.code}`,
    status: 'DRAFT',
    confidentiality: 'INTERNAL',
    draftRevision: 1,
    currentVersionId: null,
    currentVersionNumber: null,
    approvedVersionId: null,
    pendingApprovalId: null,
    responsibleId: ID(1),
    responsibleName: 'Lúcia Matos',
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
    createdAt: '2026-10-17T12:00:00.000Z',
    updatedAt: '2026-10-17T13:30:00.000Z',
    createdById: ID(1),
    version: 1,
    summary: null,
    meta: { allowedActions: [] },
    ...extra,
  };
}

const META: ProcessDocumentsMeta = {
  currentStage: {
    key: 'ESTUDOS',
    name: 'Estudos preliminares',
    documentTypeCodes: ['ETP', 'DESPACHO', 'OFICIO'],
  },
  creatableTypeIds: [DESPACHO.id, OFICIO.id],
  pendingTypeIds: [],
};

const noRetryClient = () => {
  const client = makeQueryClient();
  client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retry: false } });
  return client;
};

function renderPanel(
  documents: (() => Response) | { items: ProcessDocumentDto[]; meta?: ProcessDocumentsMeta },
  types: readonly DocumentTypeDto[] = TYPES,
) {
  const api = mockProcessApi({
    documents:
      typeof documents === 'function'
        ? documents
        : () => jsonResponse({ data: documents.items, meta: documents.meta ?? META }),
    documentTypes: () => jsonResponse({ data: types }),
  });
  renderWithShell(
    <>
      <DocumentsPanel processId={PROCESS_ID} />
      <Toaster />
    </>,
    { queryClient: noRetryClient() },
  );
  return api;
}

const card = (name: string) => {
  const heading = screen.getByRole('heading', { name, level: 3 });
  const section = heading.closest('section');
  if (section === null) throw new Error(`Cartão ${name} não encontrado.`);
  return within(section);
};

const listCalls = (api: ReturnType<typeof mockProcessApi>) =>
  api.mock.calls.filter(([input]) => requestUrl(input).startsWith(LIST));

describe('SCR-006 · aba "Documentos" (US-062)', () => {
  it('[Sucesso] cartões por tipo com selo "Em aprovação"; o menu oferece Ofício e não ETP', async () => {
    const user = userEvent.setup();
    renderPanel({
      items: [
        doc(20, DESPACHO, { title: 'Despacho de encaminhamento', code: 'DES-0001/2026' }),
        doc(21, ETP, {
          title: 'Estudo Técnico Preliminar',
          status: 'IN_REVIEW',
          pendingApprovalId: ID(90),
        }),
      ],
    });
    const headings = await screen.findAllByRole('heading', { level: 3 });
    // RN-DOC-13: ordem por `sortOrder` do tipo.
    expect(headings.map((heading) => heading.textContent)).toEqual([
      'Estudo Técnico Preliminar',
      'Despacho',
    ]);
    expect(card('Estudo Técnico Preliminar').getByText('Em aprovação')).toBeTruthy();
    const despacho = card('Despacho');
    expect(despacho.getByText('Rascunho')).toBeTruthy();
    expect(despacho.getByText('DES-0001/2026')).toBeTruthy();
    expect(despacho.getByText(/Responsável: Lúcia Matos/)).toBeTruthy();
    expect(
      despacho.getByRole('link', { name: 'Despacho de encaminhamento' }).getAttribute('href'),
    ).toBe(`/processos/${PROCESS_ID}/documentos/${ID(20)}`);
    expect(
      card('Estudo Técnico Preliminar')
        .getByRole('link', { name: 'Estudo Técnico Preliminar' })
        .getAttribute('href'),
    ).toBe(`/processos/${PROCESS_ID}/etp/${ID(21)}`);

    await user.click(screen.getByRole('button', { name: 'Criar documento' }));
    const menu = await screen.findByRole('menu');
    const options = within(menu)
      .getAllByRole('menuitem')
      .map((item) => item.textContent);
    expect(options).toEqual(['Despacho', 'Ofício']);
    await user.click(within(menu).getByRole('menuitem', { name: 'Ofício' }));
    // US-063: o livre abre o diálogo de criação (título + responsável) rumo ao editor da SCR-105.
    const dialog = await screen.findByRole('dialog', { name: 'Novo documento: Ofício' });
    expect(within(dialog).getByRole('button', { name: 'Criar e redigir' })).toBeTruthy();
  });

  it('US-067 · repaginação: o cartão traz versão e o PDF — oficial da versão atual ou prévia do rascunho', async () => {
    renderPanel({
      items: [
        doc(20, DESPACHO, { title: 'Despacho de encaminhamento', code: 'DES-0001/2026' }),
        doc(21, ETP, {
          title: 'Estudo Técnico Preliminar',
          status: 'APPROVED',
          currentVersionId: ID(70),
          currentVersionNumber: 2,
        }),
      ],
    });
    const etp = await waitFor(() => card('Estudo Técnico Preliminar'));
    expect(etp.getByText('v2')).toBeTruthy();
    expect(etp.getByText('Aprovado')).toBeTruthy();
    expect(etp.getByRole('button', { name: /^Gerar PDF desta versão/ })).toBeTruthy();
    const despacho = card('Despacho');
    expect(despacho.getByText('Sem versão')).toBeTruthy();
    expect(despacho.getByRole('button', { name: 'Gerar prévia em PDF' })).toBeTruthy();
  });

  it('US-024: "Pesquisa de preços" no menu abre o diálogo de criação (PRS-02)', async () => {
    const user = userEvent.setup();
    renderPanel(
      {
        items: [],
        meta: {
          ...META,
          creatableTypeIds: [PRICE_RESEARCH.id],
          pendingTypeIds: [PRICE_RESEARCH.id],
        },
      },
      [...TYPES, PRICE_RESEARCH],
    );
    await user.click(await screen.findByRole('button', { name: 'Criar documento' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Pesquisa de preços' }));
    expect(await screen.findByRole('dialog', { name: 'Criar pesquisa de preços' })).toBeTruthy();
  });

  it('FA-01/FA-04: sem documentos → estado vazio e menu em destaque; singular da etapa "Não iniciado"', async () => {
    renderPanel({
      items: [],
      meta: { ...META, creatableTypeIds: [ETP.id, DESPACHO.id, OFICIO.id], pendingTypeIds: [] },
    });
    expect(await screen.findByText('Nenhum documento ainda.')).toBeTruthy();
    expect(screen.getByText('Comece criando um documento.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Criar documento' })).toBeTruthy();
  });

  it('FA-01: tipo singular pendente mostra "Não iniciado" com o botão de início quando criável', async () => {
    renderPanel({
      items: [doc(20, DESPACHO)],
      meta: { ...META, creatableTypeIds: [ETP.id, DESPACHO.id], pendingTypeIds: [ETP.id] },
    });
    const etp = await waitFor(() => card('Estudo Técnico Preliminar'));
    expect(etp.getByText('Não iniciado')).toBeTruthy();
    expect(etp.getByRole('button', { name: 'Iniciar Estudo Técnico Preliminar' })).toBeTruthy();
  });

  it('FA-03: resumo sigiloso mostra "Sigiloso" no valor; código, título e status continuam', async () => {
    renderPanel({
      items: [
        doc(21, ETP, {
          title: 'Estudo Técnico Preliminar',
          code: 'ETP-0001/2026',
          confidentiality: 'RESTRICTED',
          summary: { estimatedTotalValue: null, estimatedTotalValueMasked: true },
        }),
        doc(22, DESPACHO, { summary: { estimatedTotalValue: '1500.00' } }),
      ],
    });
    const etp = await waitFor(() => card('Estudo Técnico Preliminar'));
    expect(etp.getByText('Sigiloso')).toBeTruthy();
    expect(etp.getByText('ETP-0001/2026')).toBeTruthy();
    expect(etp.getByText('Rascunho')).toBeTruthy();
    expect(card('Despacho').getByText(/R\$\s1\.500,00/)).toBeTruthy();
  });

  it('[Validação] busca com 1 caractere é ignorada sem chamada à API; com 2 filtra a lista carregada', async () => {
    const user = userEvent.setup();
    const api = renderPanel({
      items: [
        doc(20, DESPACHO, { title: 'Despacho de abertura' }),
        doc(23, OFICIO, { title: 'Ofício à Saúde' }),
      ],
    });
    await screen.findByRole('heading', { name: 'Ofício', level: 3 });
    const calls = listCalls(api).length;
    const search = screen.getByRole('searchbox', { name: 'Buscar' });
    await user.type(search, 's');
    expect(screen.getByRole('heading', { name: 'Despacho', level: 3 })).toBeTruthy();
    await user.type(search, 'a');
    expect(screen.queryByRole('heading', { name: 'Despacho', level: 3 })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Ofício', level: 3 })).toBeTruthy();
    // RN-DOC-20: o filtro roda sobre a lista carregada.
    expect(listCalls(api)).toHaveLength(calls);

    await user.clear(search);
    await user.click(screen.getByRole('button', { name: 'Filtros' }));
    await user.click(screen.getByRole('combobox', { name: 'Status' }));
    await user.click(await screen.findByRole('option', { name: 'Cancelado' }));
    expect(screen.getByRole('button', { name: 'Remover o filtro Status: Cancelado' })).toBeTruthy();
    expect(await screen.findByText('Nenhum documento corresponde aos filtros.')).toBeTruthy();
  });

  it('[Permissão] / [Tenant incorreto] 404 PROCESS_NOT_FOUND → "Processo não encontrado." com volta à lista', async () => {
    renderPanel(() => problemResponse(404, 'PROCESS_NOT_FOUND'));
    expect(await screen.findByText('Processo não encontrado.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Voltar para Processos' }).getAttribute('href')).toBe(
      '/processos',
    );
  });

  it('[Duplicidade] ETP singular já existente não aparece no menu', async () => {
    const user = userEvent.setup();
    renderPanel({ items: [doc(21, ETP, { status: 'APPROVED' })] });
    await screen.findByRole('heading', { name: 'Estudo Técnico Preliminar', level: 3 });
    await user.click(screen.getByRole('button', { name: 'Criar documento' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: 'Estudo Técnico Preliminar' })).toBeNull();
  });

  it('[Concorrência] ao focar a janela a lista é revalidada e o ETP aparece "Aprovado"', async () => {
    let status: ProcessDocumentDto['status'] = 'IN_REVIEW';
    renderPanel(() =>
      jsonResponse({
        data: [
          doc(21, ETP, {
            title: 'Estudo Técnico Preliminar',
            status,
            pendingApprovalId: status === 'IN_REVIEW' ? ID(90) : null,
          }),
        ],
        meta: META,
      }),
    );
    const etp = await waitFor(() => card('Estudo Técnico Preliminar'));
    expect(etp.getByText('Em revisão')).toBeTruthy();
    status = 'APPROVED';
    await act(async () => {
      window.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new FocusEvent('focus'));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(card('Estudo Técnico Preliminar').getByText('Aprovado')).toBeTruthy();
    });
    expect(card('Estudo Técnico Preliminar').queryByText('Em aprovação')).toBeNull();
  });

  it('[Falha de banco] 503 → "Não foi possível carregar os documentos agora." e "Tentar novamente" recarrega', async () => {
    const user = userEvent.setup();
    let down = true;
    const api = renderPanel(() =>
      down
        ? problemResponse(503, 'DEPENDENCY_UNAVAILABLE')
        : jsonResponse({ data: [doc(20, DESPACHO)], meta: META }),
    );
    expect(await screen.findByText('Não foi possível carregar os documentos agora.')).toBeTruthy();
    down = false;
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByRole('heading', { name: 'Despacho', level: 3 })).toBeTruthy();
    expect(listCalls(api).length).toBeGreaterThanOrEqual(2);
  });

  it('Erro inesperado (500) mostra o código copiável', async () => {
    renderPanel(() => problemResponse(500, 'INTERNAL_ERROR'));
    expect(await screen.findByText('Ocorreu um erro inesperado.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copiar código' })).toBeTruthy();
  });

  it('Responsivo (< 768 px): o menu "Criar documento" abre como folha inferior', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    const user = userEvent.setup();
    renderPanel({ items: [doc(20, DESPACHO)] });
    await screen.findByRole('heading', { name: 'Despacho', level: 3 });
    await user.click(screen.getByRole('button', { name: 'Criar documento' }));
    const sheet = await screen.findByRole('dialog', {
      name: 'Tipos de documento que você pode criar',
    });
    expect(within(sheet).getByRole('button', { name: 'Ofício' })).toBeTruthy();
  });

  it('Acessibilidade: sem violações sérias do axe', async () => {
    renderPanel({
      items: [doc(20, DESPACHO), doc(21, ETP, { pendingApprovalId: ID(90) })],
      meta: { ...META, pendingTypeIds: [] },
    });
    await screen.findByRole('heading', { name: 'Despacho', level: 3 });
    expect(await seriousA11yViolations()).toEqual([]);
  });
});
