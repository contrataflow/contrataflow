// @vitest-environment jsdom
import { Toaster, clearToasts } from '@contrataflow/ui';
import type { QuotationImportPreview } from '@contrataflow/validation';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import {
  DIRETA,
  RESEARCH_ID,
  SITIO,
  SOURCE_ID,
  priceResearchMeta,
  priceSourceDto,
  readRoutes,
  sourcesRoute,
  stubWithRoutes,
} from '@test/support/price-research-fixtures';
import type { Route } from '@test/support/price-research-fixtures';
import {
  PROCESS_ID,
  callsTo,
  mockProcessApi,
  problemResponse,
} from '@test/support/process-fixtures';
import { jsonResponse, renderWithShell } from '@test/support/render';

import ProcessPriceResearchPage from '../../app/(app)/processos/[id]/pesquisa-precos/[researchId]/page';

/*
 * US-028 — diálogo "Importar planilha" da aba "Fontes" (SCR-009): baixar o modelo (PRS-24), enviar a
 * planilha (PRS-18, multipart) e revisar a prévia com erros por linha/célula, aplicar (PRS-19 com o
 * token e a mesma Idempotency-Key no "Tentar novamente"); FA-01 (arquivo recusado no seletor e pela
 * API), FA-03 (prévia expirada volta ao envio), FA-04 (nenhuma célula válida), FA-06 (somente
 * leitura oculta a ação) e acessibilidade (axe) do diálogo.
 */

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => `/processos/${PROCESS_ID}/pesquisa-precos/${RESEARCH_ID}`,
  useSearchParams: () => new URLSearchParams(),
}));

const createObjectURL = vi.fn(() => 'blob:modelo');
beforeEach(() => {
  Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

const PREVIEW_URL = `/api/v1/price-research/${RESEARCH_ID}/import-preview`;
const APPLY_URL = `/api/v1/price-research/${RESEARCH_ID}/import`;
const TEMPLATE_URL = `/api/v1/price-research/${RESEARCH_ID}/import-template`;
const TOKEN = '0192d028-0000-7000-8000-000000000999';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function previewDto(extra: Partial<QuotationImportPreview> = {}): QuotationImportPreview {
  return {
    previewToken: TOKEN,
    expiresAt: '2026-10-06T15:15:00.000Z',
    fileName: 'cotacoes.xlsx',
    columns: [{ column: 'D', header: 'Orçamento Construtora XYZ', priceSourceId: SOURCE_ID }],
    rows: [
      {
        row: 2,
        sequence: 1,
        priceItemId: null,
        valid: 2,
        errors: 1,
        empty: 0,
        warnings: 0,
        issues: [
          {
            severity: 'ERROR',
            code: 'INVALID_DECIMAL',
            row: 2,
            column: 'D',
            header: 'Orçamento Construtora XYZ',
            priceSourceId: SOURCE_ID,
            message: "Linha 2, fonte 'Orçamento Construtora XYZ': preço inválido.",
          },
        ],
      },
    ],
    columnIssues: [
      {
        severity: 'WARNING',
        code: 'REFERENCE_NOT_FOUND',
        row: null,
        column: 'E',
        header: 'Observações',
        priceSourceId: null,
        message:
          "Coluna 'Observações': fonte não encontrada nesta pesquisa. A coluna foi ignorada.",
      },
    ],
    summary: { total: 3, valid: 2, errors: 1, empty: 0, warnings: 0, rows: 1 },
    ...extra,
  };
}

const route =
  (method: string, url: string, respond: (init?: RequestInit) => Response): Route =>
  (target, init) =>
    target === url && (init?.method ?? 'GET') === method ? respond(init) : undefined;

async function renderImport(
  options: { routes?: Route[]; readOnly?: boolean; noSources?: boolean } = {},
) {
  const api = mockProcessApi({
    permissions: ['PROCESS_VIEW', 'PRICE_RESEARCH_UPDATE', 'ATTACHMENT_UPLOAD', 'SUPPLIER_VIEW'],
    catalogs: { PRICE_SOURCE_TYPE: [DIRETA, SITIO] },
  });
  const fetchMock = stubWithRoutes(
    api,
    ...(options.routes ?? []),
    sourcesRoute(options.noSources === true ? [] : [priceSourceDto()]),
    readRoutes(
      options.readOnly === true
        ? { meta: priceResearchMeta({ allowedActions: [], lockReason: 'DOCUMENT_NOT_EDITABLE' }) }
        : {},
    ),
  );
  renderWithShell(
    <>
      <Toaster />
      {await ProcessPriceResearchPage({
        params: Promise.resolve({ id: PROCESS_ID, researchId: RESEARCH_ID }),
      })}
    </>,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole('tab', { name: 'Fontes' }));
  return { fetchMock, user };
}

const xlsxFile = (name = 'cotacoes.xlsx') => new File(['PK'], name, { type: XLSX });

async function openAndSend(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Importar planilha' }));
  const dialog = await screen.findByRole('dialog');
  await user.upload(within(dialog).getByLabelText(/Planilha \(\.xlsx\)/), xlsxFile());
  await user.click(within(dialog).getByRole('button', { name: 'Enviar planilha' }));
  return dialog;
}

describe('Importar planilha (US-028 · SCR-009)', () => {
  it('fluxo principal: prévia com resumo e problemas por linha/coluna; aplicar envia o token com Idempotency-Key e conclui com toast', async () => {
    let applied = false;
    const { fetchMock, user } = await renderImport({
      routes: [
        route('POST', PREVIEW_URL, () => jsonResponse({ data: previewDto() })),
        route('POST', APPLY_URL, () => {
          applied = true;
          return jsonResponse({ data: { appliedCount: 2, skippedCount: 1 } });
        }),
      ],
    });
    const dialog = await openAndSend(user);

    expect(await within(dialog).findByText('Prévia da importação')).toBeTruthy();
    const summary = within(dialog).getByText(/células válidas para aplicar/);
    expect(summary.getAttribute('aria-live')).toBe('polite');
    expect(summary.textContent).toBe(
      '2 células válidas para aplicar, 1 com erro, nenhuma vazia e nenhum aviso.',
    );
    const issues = within(dialog).getByRole('region', {
      name: 'Problemas encontrados na planilha',
    });
    expect(
      within(issues)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      "AvisoColuna 'Observações': fonte não encontrada nesta pesquisa. A coluna foi ignorada.",
      "ErroLinha 2, fonte 'Orçamento Construtora XYZ': preço inválido.",
    ]);
    expect(await seriousA11yViolations(dialog)).toEqual([]);

    const [upload] = callsTo(fetchMock, 'POST', PREVIEW_URL);
    const sent = upload?.init?.body;
    expect(sent).toBeInstanceOf(FormData);
    expect((sent as FormData).get('file')).toBeInstanceOf(File);
    expect(upload?.headers.get('Content-Type')).toBeNull();

    await user.click(within(dialog).getByRole('button', { name: 'Aplicar importação' }));
    expect(await screen.findByText('Importação concluída: 2 preços atualizados')).toBeTruthy();
    expect(applied).toBe(true);
    const [call] = callsTo(fetchMock, 'POST', APPLY_URL);
    expect(call?.body).toEqual({ previewToken: TOKEN });
    expect(call?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('FA-04: nenhuma célula válida → "Aplicar importação" desabilitado com a orientação', async () => {
    const { user } = await renderImport({
      routes: [
        route('POST', PREVIEW_URL, () =>
          jsonResponse({
            data: previewDto({
              summary: { total: 1, valid: 0, errors: 1, empty: 0, warnings: 0, rows: 1 },
            }),
          }),
        ),
      ],
    });
    const dialog = await openAndSend(user);
    expect(
      await within(dialog).findByText(
        'Nenhuma célula válida para importar. Corrija a planilha e envie-a novamente.',
      ),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Aplicar importação' })
        .disabled,
    ).toBe(true);
  });

  it('FA-03: prévia expirada (410) volta ao envio com a mensagem; 503 mantém a prévia e "Tentar novamente" reenvia a mesma chave', async () => {
    let attempts = 0;
    const { fetchMock, user } = await renderImport({
      routes: [
        route('POST', PREVIEW_URL, () => jsonResponse({ data: previewDto() })),
        route('POST', APPLY_URL, () => {
          attempts += 1;
          return attempts === 1
            ? problemResponse(503, 'DEPENDENCY_UNAVAILABLE', { correlationId: 'c-503' })
            : problemResponse(410, 'IMPORT_PREVIEW_EXPIRED');
        }),
      ],
    });
    const dialog = await openAndSend(user);
    await user.click(await within(dialog).findByRole('button', { name: 'Aplicar importação' }));
    expect(
      await within(dialog).findByText(
        'Não foi possível concluir agora. Tente novamente em instantes.',
      ),
    ).toBeTruthy();
    expect(within(dialog).getByText('Prévia da importação')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Tentar novamente' }));
    expect(
      await within(dialog).findByText('A prévia expirou. Envie a planilha novamente.'),
    ).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Enviar planilha' })).toBeTruthy();
    const keys = callsTo(fetchMock, 'POST', APPLY_URL).map((call) =>
      call.headers.get('Idempotency-Key'),
    );
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('FA-01: arquivo que não é .xlsx é recusado no seletor (sem chamada); recusa da API volta ao envio', async () => {
    const { fetchMock, user } = await renderImport({
      routes: [
        route('POST', PREVIEW_URL, () =>
          problemResponse(413, 'FILE_TOO_LARGE', {
            detail: 'O arquivo excede o tamanho máximo permitido.',
          }),
        ),
      ],
    });
    await user.click(await screen.findByRole('button', { name: 'Importar planilha' }));
    const dialog = await screen.findByRole('dialog');
    const input = within(dialog).getByLabelText(/Planilha \(\.xlsx\)/);
    // Sem o filtro do `accept` (como arrastar um .csv): a conferência local recusa.
    await userEvent
      .setup({ applyAccept: false })
      .upload(input, new File(['a;b'], 'cotacoes.csv', { type: 'text/csv' }));
    await user.click(within(dialog).getByRole('button', { name: 'Enviar planilha' }));
    expect(await within(dialog).findByText('Envie um arquivo .xlsx.')).toBeTruthy();
    expect(callsTo(fetchMock, 'POST', PREVIEW_URL)).toHaveLength(0);

    await user.upload(input, xlsxFile());
    await user.click(within(dialog).getByRole('button', { name: 'Enviar planilha' }));
    expect(
      await within(dialog).findByText('O arquivo excede o tamanho máximo permitido.'),
    ).toBeTruthy();
  });

  it('"Baixar modelo" chama o PRS-24 e salva o arquivo do Content-Disposition', async () => {
    const { fetchMock, user } = await renderImport({
      routes: [
        route(
          'GET',
          TEMPLATE_URL,
          () =>
            new Response(new Blob(['PK']), {
              status: 200,
              headers: {
                'Content-Type': XLSX,
                'Content-Disposition': 'attachment; filename="cotacoes-pp-0001-2026.xlsx"',
              },
            }),
        ),
      ],
    });
    await user.click(await screen.findByRole('button', { name: 'Importar planilha' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Baixar modelo' }));
    await waitFor(() => {
      expect(createObjectURL).toHaveBeenCalled();
    });
    expect(callsTo(fetchMock, 'GET', TEMPLATE_URL)).toHaveLength(1);
  });

  it('FA-06: somente leitura ou sem fontes → "Importar planilha" oculto; documento bloqueado na aplicação fecha o diálogo com aviso', async () => {
    await renderImport({ readOnly: true });
    expect(await screen.findByText('Orçamento Construtora XYZ')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Importar planilha' })).toBeNull();
  });

  it('sem fontes cadastradas o botão não aparece', async () => {
    await renderImport({ noSources: true });
    expect(await screen.findByText('Nenhuma fonte registrada ainda')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Importar planilha' })).toBeNull();
  });

  it('FA-06 na aplicação: 409 DOCUMENT_NOT_EDITABLE fecha o diálogo e avisa na aba', async () => {
    const { user } = await renderImport({
      routes: [
        route('POST', PREVIEW_URL, () => jsonResponse({ data: previewDto() })),
        route('POST', APPLY_URL, () => problemResponse(409, 'DOCUMENT_NOT_EDITABLE')),
      ],
    });
    const dialog = await openAndSend(user);
    await user.click(await within(dialog).findByRole('button', { name: 'Aplicar importação' }));
    expect(
      await screen.findByText('Esta pesquisa de preços não pode mais ser editada.'),
    ).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });
});
