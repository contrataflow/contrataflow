// @vitest-environment jsdom
import { Toaster, clearToasts } from '@contrataflow/ui';
import type { ComparativeMapDto, DocumentRenditionDto } from '@contrataflow/validation';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api/api-error';
import { seriousA11yViolations } from '@test/support/axe';
import { RESEARCH_ID, readRoutes, stubWithRoutes } from '@test/support/price-research-fixtures';
import type { Route } from '@test/support/price-research-fixtures';
import { ID, PROCESS_ID, mockProcessApi, problemResponse } from '@test/support/process-fixtures';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { describeExportError, nextGridPosition } from './comparative-map-model';
import ComparativeMapPage from '../../app/(app)/processos/[id]/pesquisa-precos/[researchId]/mapa/page';
import ProcessPriceResearchPage from '../../app/(app)/processos/[id]/pesquisa-precos/[researchId]/page';

/*
 * US-031 — SCR-010 (mapa comparativo): a matriz itens × fontes com preços, selos, estatísticas e
 * alertas (Sucesso), POL-09 em tela ("Sigiloso"), vazio sem fontes (FA-04), exportação XLSX pelo
 * PRS-22 (download, teto — FA-01 — e indisponibilidade com `correlationId`), PDF pelo DOC-20/22 com
 * a falha "Não foi possível gerar o PDF agora" sem bloquear o XLSX (FA-02), navegação por teclado
 * entre células e axe sem violações sérias.
 */

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => `/processos/${PROCESS_ID}/pesquisa-precos/${RESEARCH_ID}/mapa`,
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('../documents/renditions.api', async () => ({
  ...(await vi.importActual<Record<string, unknown>>('../documents/renditions.api')),
  RENDITION_POLL_MS: 60,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
  nav.push.mockReset();
});

const MAP_URL = `/api/v1/price-research/${RESEARCH_ID}/comparative-map`;
const EXPORT_URL = `${MAP_URL}/export?format=xlsx`;
const PREVIEW_URL = `/api/v1/documents/${RESEARCH_ID}/preview`;
const S = [ID(901), ID(902), ID(903), ID(904)];
const I = [ID(911), ID(912), ID(913)];

function item(n: number, extra: Partial<ComparativeMapDto['items'][number]> = {}) {
  return {
    id: I[n - 1] ?? ID(919),
    processItemId: ID(920 + n),
    sequence: n,
    lotNumber: null,
    description: ['Cimento CP II 50 kg', 'Areia média', 'Brita nº 1'][n - 1] ?? 'Item',
    unitLabel: 'SC',
    quantity: '100.0000',
    sortOrder: n,
    effectiveMethod: 'MEDIAN' as const,
    validQuotationsCount: 4,
    meanPrice: '153.7500',
    medianPrice: '107.5000',
    lowestPrice: '100.0000',
    highestPrice: '300.0000',
    stdDeviation: '97.6800',
    coefficientOfVariation: '63.5317',
    recommendedUnitPrice: '107.50',
    totalPrice: '10750.00',
    valuesMasked: false,
    alerts: [{ code: 'HAS_OUTLIERS' as const }],
    ...extra,
  };
}

function cell(
  row: number,
  column: number,
  unitPrice: string,
  extra: Partial<ComparativeMapDto['cells'][number]> = {},
) {
  return {
    priceItemId: I[row] ?? ID(919),
    priceSourceId: S[column] ?? ID(909),
    quotationId: ID(950 + row * 10 + column),
    unitPrice,
    unitPriceMasked: false,
    status: 'VALID' as const,
    exclusionReason: null,
    outlierFlag: 'NONE' as const,
    isExpired: false,
    ...extra,
  };
}

function comparativeMap(extra: Partial<ComparativeMapDto> = {}): ComparativeMapDto {
  return {
    priceResearchId: RESEARCH_ID,
    code: 'PP 0001/2026',
    title: 'Pesquisa de preços — 0012/2026',
    referenceDate: '2026-10-06',
    lastCalculatedAt: '2026-10-06T15:00:00.000Z',
    unitPriceDecimals: 2,
    totalEstimatedValue: '12345.60',
    masked: false,
    items: [
      item(1),
      item(2, { validQuotationsCount: 3, alerts: [] }),
      item(3, {
        validQuotationsCount: 0,
        effectiveMethod: null,
        meanPrice: null,
        medianPrice: null,
        lowestPrice: null,
        highestPrice: null,
        stdDeviation: null,
        coefficientOfVariation: null,
        recommendedUnitPrice: null,
        totalPrice: null,
        alerts: [{ code: 'NO_VALID_QUOTES' }],
      }),
    ],
    sources: S.map((id, index) => ({
      id,
      description: `Orçamento ${String(index + 1)}`,
      sourceType: { code: 'PESQUISA_DIRETA_FORNECEDOR', label: 'Pesquisa direta' },
      supplierName: 'Construtora XYZ',
      quoteDate: '2026-09-30',
      sortOrder: index + 1,
    })),
    cells: [
      cell(0, 0, '100.0000'),
      cell(0, 1, '110.0000', { isExpired: true }),
      cell(0, 2, '105.0000'),
      cell(0, 3, '300.0000', { outlierFlag: 'HIGH' }),
      cell(1, 0, '50.0000', { status: 'EXCLUDED', exclusionReason: 'INCONSISTENT' }),
      cell(1, 1, '52.0000'),
      cell(1, 3, '51.0000'),
    ],
    ...extra,
  };
}

function masked(map: ComparativeMapDto): ComparativeMapDto {
  return {
    ...map,
    masked: true,
    totalEstimatedValue: null,
    items: map.items.map((row) => ({
      ...row,
      meanPrice: null,
      medianPrice: null,
      lowestPrice: null,
      highestPrice: null,
      stdDeviation: null,
      coefficientOfVariation: null,
      recommendedUnitPrice: null,
      totalPrice: null,
      valuesMasked: true,
    })),
    cells: map.cells.map((entry) => ({ ...entry, unitPrice: null, unitPriceMasked: true })),
  };
}

function rendition(extra: Partial<DocumentRenditionDto> = {}): DocumentRenditionDto {
  return {
    id: ID(960),
    documentId: RESEARCH_ID,
    documentVersionId: null,
    draftRevision: 1,
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
    requestedAt: '2026-10-06T15:00:00.000Z',
    startedAt: null,
    readyAt: null,
    expiresAt: '2099-10-07T15:00:00.000Z',
    createdAt: '2026-10-06T15:00:00.000Z',
    updatedAt: '2026-10-06T15:00:00.000Z',
    ...extra,
  };
}

const mapRoute =
  (map: ComparativeMapDto | (() => Response)): Route =>
  (url, init) => {
    if ((init?.method ?? 'GET') !== 'GET' || url !== MAP_URL) return undefined;
    return typeof map === 'function' ? map() : jsonResponse({ data: map });
  };

const xlsxRoute =
  (respond: () => Response): Route =>
  (url) =>
    url === EXPORT_URL ? respond() : undefined;

const XLSX_FILE = () =>
  new Response(new Blob(['PK']), {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="mapa-comparativo-pp-0001-2026.xlsx"',
    },
  });

async function renderPage(...routes: Route[]) {
  const api = mockProcessApi({ permissions: ['PROCESS_VIEW'] });
  const fetchMock = stubWithRoutes(api, ...routes, readRoutes({}));
  renderWithShell(
    <>
      <Toaster />
      {await ComparativeMapPage({
        params: Promise.resolve({ id: PROCESS_ID, researchId: RESEARCH_ID }),
      })}
    </>,
  );
  return { user: userEvent.setup(), fetchMock };
}

const grid = () =>
  screen.findByRole('grid', { name: 'Mapa comparativo de preços: itens por fonte' });

describe('SCR-010 — Mapa comparativo (US-031)', () => {
  it('[Sucesso] 3 itens em linha, 4 fontes em coluna, preços com selos e estatísticas/alertas por item', async () => {
    await renderPage(mapRoute(comparativeMap()));
    const table = await grid();
    const headers = within(table).getAllByRole('columnheader');
    expect(headers.slice(1, 5).map((header) => header.textContent)).toEqual([
      expect.stringContaining('Orçamento 1'),
      expect.stringContaining('Orçamento 2'),
      expect.stringContaining('Orçamento 3'),
      expect.stringContaining('Orçamento 4'),
    ]);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    const [first, second, third] = rows;
    if (!first || !second || !third) throw new Error('linhas ausentes');
    expect(within(first).getByRole('rowheader').textContent).toContain('1. Cimento CP II 50 kg');
    expect(first.textContent).toMatch(/R\$\s100,00/);
    expect(within(first).getByRole('button', { name: 'Acima da mediana' })).toBeTruthy();
    expect(within(first).getByRole('button', { name: 'Vencida' })).toBeTruthy();
    expect(first.textContent).toContain('63,53 %');
    expect(first.textContent).toContain('Mediana');
    expect(first.textContent).toMatch(/R\$\s10\.750,00/);
    expect(within(first).getByRole('list', { name: 'Alertas do item' }).textContent).toContain(
      'Valores atípicos',
    );
    expect(second.textContent).toContain('Desconsiderada: inconsistente');
    expect(within(second).getAllByText('Sem cotação').length).toBe(1);
    expect(third.textContent).toContain('Sem cotações válidas');
    expect(screen.getByText(/Calculado em 06\/10\/2026/)).toBeTruthy();
    expect(screen.getByText(/^R\$\s12\.345,60$/)).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Voltar à pesquisa de preços' }).getAttribute('href'),
    ).toBe(`/processos/${PROCESS_ID}/pesquisa-precos/${RESEARCH_ID}`);
  });

  it('[Permissão] POL-09: toda célula, estatística e o total como "Sigiloso"; selos continuam', async () => {
    await renderPage(mapRoute(masked(comparativeMap())));
    const table = await grid();
    expect(table.textContent).not.toMatch(/R\$/);
    // 7 células + 3 itens × 7 valores (média, mediana, menor, maior, CV, unitário, total).
    expect(within(table).getAllByText('Sigiloso')).toHaveLength(7 + 3 * 7);
    expect(within(table).getByRole('button', { name: 'Acima da mediana' })).toBeTruthy();
    expect(screen.getByText(/Orçamento sigiloso: os valores só são visíveis/)).toBeTruthy();
  });

  it('FA-04: sem fontes, a mensagem no lugar das colunas e os itens em linha', async () => {
    await renderPage(mapRoute(comparativeMap({ sources: [], cells: [] })));
    expect(await screen.findByText('Cadastre ao menos uma fonte para montar o mapa')).toBeTruthy();
    const table = await grid();
    expect(within(table).getAllByRole('row').slice(1)).toHaveLength(3);
  });

  it('[Sucesso] Exportar XLSX baixa o arquivo do PRS-22', async () => {
    const createObjectURL = vi.fn(() => 'blob:mapa');
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    const { user, fetchMock } = await renderPage(mapRoute(comparativeMap()), xlsxRoute(XLSX_FILE));
    await grid();
    await user.click(screen.getByRole('button', { name: 'Exportar XLSX' }));
    expect(await screen.findByText('Planilha do mapa comparativo baixada')).toBeTruthy();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some(([input]) => requestUrl(input) === EXPORT_URL)).toBe(true);
  });

  it('[Validação] FA-01: acima do teto sugere gerar o PDF ou reduzir o recorte', async () => {
    const { user } = await renderPage(
      mapRoute(comparativeMap()),
      xlsxRoute(() => problemResponse(422, 'EXPORT_TOO_LARGE')),
    );
    await grid();
    await user.click(screen.getByRole('button', { name: 'Exportar XLSX' }));
    expect(
      await screen.findByText(
        'Esta pesquisa tem mais itens/fontes do que o exportável de uma vez. Gere o PDF ou reduza o recorte.',
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Use "Gerar PDF" para esta pesquisa/)).toBeTruthy();
  });

  it('[Falha de banco] 503 mantém o mapa e oferece "Tentar novamente" com o código do erro', async () => {
    let attempts = 0;
    const { user } = await renderPage(
      mapRoute(comparativeMap()),
      xlsxRoute(() => {
        attempts += 1;
        return attempts === 1
          ? problemResponse(503, 'DEPENDENCY_UNAVAILABLE', { correlationId: 'corr-503' })
          : XLSX_FILE();
      }),
    );
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() }),
    );
    await grid();
    await user.click(screen.getByRole('button', { name: 'Exportar XLSX' }));
    expect(
      await screen.findByText('Não foi possível exportar agora. Tente novamente em instantes.'),
    ).toBeTruthy();
    expect(screen.getByText('Código do erro: corr-503')).toBeTruthy();
    expect(await grid()).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByText('Planilha do mapa comparativo baixada')).toBeTruthy();
  });

  it('[Falha de integração] PDF que falha mostra "Não foi possível gerar o PDF agora" e o XLSX segue disponível', async () => {
    const { user } = await renderPage(mapRoute(comparativeMap()), (url, init) => {
      if (url === PREVIEW_URL && init?.method === 'POST') {
        return jsonResponse({ data: rendition() }, { status: 202 });
      }
      if (url === `/api/v1/document-renditions/${ID(960)}`) {
        return jsonResponse({
          data: rendition({ status: 'FAILED', errorCode: 'RENDERER_UNAVAILABLE', attempts: 5 }),
        });
      }
      return undefined;
    });
    await grid();
    await user.click(screen.getByRole('button', { name: 'Gerar PDF' }));
    expect(await screen.findByText('Não foi possível gerar o PDF agora.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Tentar novamente' })).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Exportar XLSX' }).disabled).toBe(
      false,
    );
  });

  it('404: pesquisa não visível mostra a mensagem e o caminho de volta aos processos', async () => {
    await renderPage(mapRoute(() => problemResponse(404, 'PRICE_RESEARCH_NOT_FOUND')));
    expect(await screen.findByText('Pesquisa não encontrada.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Voltar aos processos' }).getAttribute('href')).toBe(
      '/processos',
    );
  });

  it('Acessibilidade: setas movem o foco entre células e axe sem violações sérias', async () => {
    const { user } = await renderPage(mapRoute(comparativeMap()));
    const table = await grid();
    const [corner] = within(table).getAllByRole('columnheader');
    corner?.focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement?.textContent).toContain('1. Cimento CP II 50 kg');
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement?.textContent).toMatch(/R\$\s100,00/);
    await user.keyboard('{End}');
    expect(document.activeElement?.textContent).toContain('Valores atípicos');
    await waitFor(async () => {
      expect(await seriousA11yViolations(document.body)).toEqual([]);
    });
  });
});

describe('SCR-009 → SCR-010', () => {
  it('"Ver mapa comparativo" leva à rota do mapa da pesquisa', async () => {
    const api = mockProcessApi({ permissions: ['PROCESS_VIEW'] });
    stubWithRoutes(api, readRoutes({}), (url) =>
      url.startsWith(`/api/v1/price-research/${RESEARCH_ID}/sources`)
        ? jsonResponse({ data: [], meta: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 } })
        : undefined,
    );
    renderWithShell(
      await ProcessPriceResearchPage({
        params: Promise.resolve({ id: PROCESS_ID, researchId: RESEARCH_ID }),
      }),
    );
    const link = await screen.findByRole('link', { name: 'Ver mapa comparativo' });
    expect(link.getAttribute('href')).toBe(
      `/processos/${PROCESS_ID}/pesquisa-precos/${RESEARCH_ID}/mapa`,
    );
  });
});

describe('Regras da SCR-010 (comparative-map-model)', () => {
  it('nextGridPosition: setas com limites, Home/End e Ctrl+Home/End', () => {
    const size = { rows: 4, columns: 6 };
    expect(nextGridPosition({ row: 0, column: 0 }, { key: 'ArrowUp' }, size)).toEqual({
      row: 0,
      column: 0,
    });
    expect(nextGridPosition({ row: 3, column: 5 }, { key: 'ArrowDown' }, size)).toEqual({
      row: 3,
      column: 5,
    });
    expect(nextGridPosition({ row: 1, column: 1 }, { key: 'ArrowRight' }, size)).toEqual({
      row: 1,
      column: 2,
    });
    expect(nextGridPosition({ row: 1, column: 1 }, { key: 'ArrowLeft' }, size)).toEqual({
      row: 1,
      column: 0,
    });
    expect(nextGridPosition({ row: 2, column: 3 }, { key: 'Home' }, size)).toEqual({
      row: 2,
      column: 0,
    });
    expect(nextGridPosition({ row: 2, column: 3 }, { key: 'End' }, size)).toEqual({
      row: 2,
      column: 5,
    });
    expect(nextGridPosition({ row: 2, column: 3 }, { key: 'Home', ctrlKey: true }, size)).toEqual({
      row: 0,
      column: 0,
    });
    expect(nextGridPosition({ row: 2, column: 3 }, { key: 'End', metaKey: true }, size)).toEqual({
      row: 3,
      column: 5,
    });
    expect(nextGridPosition({ row: 2, column: 3 }, { key: 'a' }, size)).toBeNull();
  });

  it('describeExportError: teto, 404, indisponível e erro desconhecido', () => {
    const apiError = (status: number, code: string) =>
      new ApiError({ status, code, correlationId: 'c' });
    expect(describeExportError(apiError(422, 'EXPORT_TOO_LARGE')).kind).toBe('tooLarge');
    expect(describeExportError(apiError(404, 'PRICE_RESEARCH_NOT_FOUND')).kind).toBe('notFound');
    expect(describeExportError(apiError(503, 'DEPENDENCY_UNAVAILABLE'))).toMatchObject({
      kind: 'retry',
      correlationId: 'c',
    });
    expect(describeExportError(new Error('rede'))).toMatchObject({
      kind: 'retry',
      correlationId: null,
    });
  });
});
