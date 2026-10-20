// @vitest-environment jsdom
import { Toaster, clearToasts } from '@contrataflow/ui';
import { PRICE_SOURCE_MESSAGES } from '@contrataflow/validation';
import type { PriceItemDto, PriceResearchMeta, PriceSourceDto } from '@contrataflow/validation';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import {
  DIRETA,
  RESEARCH_ID,
  SITIO,
  SOURCE_ID,
  SUPPLIER_ID,
  priceItem,
  priceResearchMeta,
  priceSourceDto,
  processItem,
  quotationDto,
  readRoutes,
  sourcesRoute,
  stubWithRoutes,
} from '@test/support/price-research-fixtures';
import type { Route } from '@test/support/price-research-fixtures';
import {
  PROCESS_ID,
  bodyOf,
  callsTo,
  mockProcessApi,
  problemResponse,
} from '@test/support/process-fixtures';
import { jsonResponse, renderWithShell } from '@test/support/render';

import ProcessPriceResearchPage from '../../app/(app)/processos/[id]/pesquisa-precos/[researchId]/page';
import { AttachmentsSection } from '../attachments/attachments-section';

/*
 * US-026 — aba "Fontes" da SCR-009: lista de fontes, formulário com campos por tipo (FA-06), grade de
 * preços com um único envio (PRS-13 com If-Match e Idempotency-Key), célula desconsiderada somente
 * leitura (FA-05), remoção com confirmação (FA-02), 412, somente leitura/POL-09 e a falha do anexo.
 * US-027 — desconsiderar (diálogo com motivo e justificativa, PRS-16) e restaurar (PRS-17) cotação.
 */

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => `/processos/${PROCESS_ID}/pesquisa-precos/${RESEARCH_ID}`,
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

const SOURCES_URL = `/api/v1/price-research/${RESEARCH_ID}/sources`;
const GRID_URL = `/api/v1/price-sources/${SOURCE_ID}/quotations`;

const processItemsRoute: Route = (url, init) =>
  url === `/api/v1/processes/${PROCESS_ID}/items` && (init?.method ?? 'GET') === 'GET'
    ? jsonResponse({
        data: [processItem(1, '10.0000'), processItem(2, '10.0000'), processItem(3, '10.0000')],
      })
    : undefined;

const supplierSearch: Route = (url) =>
  url.startsWith('/api/v1/suppliers?')
    ? jsonResponse({
        data: [
          {
            id: SUPPLIER_ID,
            documentType: 'CNPJ',
            documentNumber: '11.222.333/0001-81',
            legalName: 'Construtora XYZ Ltda.',
            tradeName: null,
            isActive: true,
          },
        ],
        meta: { page: 1, totalPages: 1, totalItems: 1 },
      })
    : undefined;

async function renderSources(
  options: {
    sources?: readonly PriceSourceDto[] | (() => readonly PriceSourceDto[]);
    routes?: Route[];
    readOnly?: boolean;
    /** `meta.allowedActions` da pesquisa (padrão: as de edição, sem `EXCLUDE_QUOTATION`). */
    actions?: PriceResearchMeta['allowedActions'];
    items?: readonly PriceItemDto[];
  } = {},
) {
  const api = mockProcessApi({
    permissions: ['PROCESS_VIEW', 'PRICE_RESEARCH_UPDATE', 'ATTACHMENT_UPLOAD', 'SUPPLIER_VIEW'],
    catalogs: { PRICE_SOURCE_TYPE: [DIRETA, SITIO] },
  });
  const fetchMock = stubWithRoutes(
    api,
    ...(options.routes ?? []),
    sourcesRoute(options.sources ?? []),
    readRoutes({
      ...(options.readOnly === true
        ? { meta: priceResearchMeta({ allowedActions: [], lockReason: 'DOCUMENT_NOT_EDITABLE' }) }
        : options.actions === undefined
          ? {}
          : { meta: priceResearchMeta({ allowedActions: options.actions }) }),
      ...(options.items === undefined ? {} : { items: options.items }),
    }),
    processItemsRoute,
    supplierSearch,
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

describe('Aba "Fontes" da SCR-009 (US-026)', () => {
  it('estado vazio com "Nova fonte" (PRS-09 com todas as páginas)', async () => {
    const empty = await renderSources();
    expect(await screen.findByText('Nenhuma fonte registrada ainda')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Nova fonte' })).toBeTruthy();
    expect(callsTo(empty.fetchMock, 'GET', `${SOURCES_URL}?page=1&pageSize=100`)).toHaveLength(1);
  });

  it('lista as fontes e lança preços pela grade: PRS-13 com If-Match da fonte, Idempotency-Key e só as linhas preenchidas', async () => {
    let saved = false;
    const { fetchMock, user } = await renderSources({
      sources: () => [
        priceSourceDto(
          saved
            ? {
                version: 2,
                quotations: [quotationDto(1), quotationDto(2, { unitPrice: '80.0000' })],
              }
            : { quotations: [quotationDto(3, { isExpired: true })] },
        ),
      ],
      routes: [
        (url, init) => {
          if (url !== GRID_URL || init?.method !== 'PUT') return undefined;
          saved = true;
          return jsonResponse({ data: [] }, { headers: { ETag: '"2"' } });
        },
      ],
    });
    const list = await screen.findByRole('list', { name: 'Fontes registradas' });
    expect(within(list).getByText('Orçamento Construtora XYZ')).toBeTruthy();
    expect(within(list).getByText('Fornecedor: Construtora XYZ Ltda.')).toBeTruthy();
    expect(within(list).getByText('Data: 30/09/2026')).toBeTruthy();
    expect(within(list).getByText(/1 preço lançado · 1 cotação vencida/)).toBeTruthy();

    await user.click(within(list).getByRole('button', { name: 'Lançar preços' }));
    const grid = await screen.findByRole('table', {
      name: 'Preços da fonte Orçamento Construtora XYZ',
    });
    expect(within(grid).getByText('Vencida')).toBeTruthy();
    expect(
      screen.getByText('Este tipo de fonte exige o anexo do orçamento. Envie-o abaixo.'),
    ).toBeTruthy();
    await user.type(
      within(grid).getByRole('textbox', { name: 'Preço unitário do item 1' }),
      '150,00',
    );
    await user.type(
      within(grid).getByRole('textbox', { name: 'Marca/modelo do item 1' }),
      'Votoran',
    );
    await user.type(within(grid).getByRole('textbox', { name: 'Preço unitário do item 2' }), '80');
    await user.click(screen.getByRole('button', { name: 'Salvar preços' }));

    expect(await screen.findByText('Preços salvos')).toBeTruthy();
    const [call] = callsTo(fetchMock, 'PUT', GRID_URL);
    expect(call?.headers.get('If-Match')).toBe('"1"');
    expect(call?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(bodyOf(call?.init)).toEqual({
      items: [
        { priceItemId: priceItem(1).id, unitPrice: '150.00', brandModel: 'Votoran' },
        { priceItemId: priceItem(2).id, unitPrice: '80', brandModel: null },
      ],
    });
    await waitFor(() => {
      expect(
        callsTo(fetchMock, 'GET', `${SOURCES_URL}?page=1&pageSize=100`).length,
      ).toBeGreaterThanOrEqual(2);
    });
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('preço zero marca a célula e nada é enviado (V-06); 412 avisa que a fonte mudou', async () => {
    const { fetchMock, user } = await renderSources({
      sources: [priceSourceDto()],
      routes: [
        (url, init) =>
          url === GRID_URL && init?.method === 'PUT'
            ? problemResponse(412, 'VERSION_CONFLICT')
            : undefined,
      ],
    });
    await user.click(await screen.findByRole('button', { name: 'Lançar preços' }));
    const price = await screen.findByRole('textbox', { name: 'Preço unitário do item 1' });
    await user.type(price, '0');
    await user.click(screen.getByRole('button', { name: 'Salvar preços' }));
    expect(await screen.findByText(PRICE_SOURCE_MESSAGES.unitPriceInvalid)).toBeTruthy();
    expect(price.getAttribute('aria-invalid')).toBe('true');
    expect(callsTo(fetchMock, 'PUT', GRID_URL)).toHaveLength(0);

    await user.clear(price);
    await user.type(price, '10');
    await user.click(screen.getByRole('button', { name: 'Salvar preços' }));
    expect(await screen.findByText(PRICE_SOURCE_MESSAGES.versionConflict)).toBeTruthy();
  });

  it('FA-05: célula desconsiderada fica somente leitura com o motivo; FA-03: uma célula gravada vai pelo PRS-14', async () => {
    const { fetchMock, user } = await renderSources({
      sources: [
        priceSourceDto({
          quotations: [
            quotationDto(1, { version: 3 }),
            quotationDto(2, {
              status: 'EXCLUDED',
              exclusionReason: 'EXCESSIVE',
              unitPrice: '999.0000',
            }),
          ],
        }),
      ],
      routes: [
        (url, init) =>
          url === `/api/v1/quotations/${quotationDto(1).id}` && init?.method === 'PATCH'
            ? jsonResponse({ data: quotationDto(1, { unitPrice: '149.9000', version: 4 }) })
            : undefined,
      ],
    });
    await user.click(await screen.findByRole('button', { name: 'Lançar preços' }));
    const grid = await screen.findByRole('table');
    expect(within(grid).queryByRole('textbox', { name: 'Preço unitário do item 2' })).toBeNull();
    expect(within(grid).getByText('Desconsiderada').getAttribute('title')).toBe(
      'Cotação desconsiderada (excessivo). Restaure-a para editar o preço.',
    );
    const price = within(grid).getByRole('textbox', { name: 'Preço unitário do item 1' });
    expect((price as HTMLInputElement).value).toBe('150,00');
    await user.clear(price);
    await user.type(price, '149,90');
    await user.click(screen.getByRole('button', { name: 'Salvar preços' }));
    await screen.findByText('Preços salvos');
    const [patch] = callsTo(fetchMock, 'PATCH', `/api/v1/quotations/${quotationDto(1).id}`);
    expect(patch?.headers.get('If-Match')).toBe('"3"');
    expect(bodyOf(patch?.init)).toEqual({ unitPrice: '149.90', brandModel: null });
    expect(callsTo(fetchMock, 'PUT', GRID_URL)).toHaveLength(0);
  });

  it('FA-06: o tipo decide os obrigatórios; sem fornecedor o envio é impedido; com tudo, PRS-10 e a grade abre', async () => {
    const created = priceSourceDto({ id: SOURCE_ID });
    let createdOnce = false;
    const { fetchMock, user } = await renderSources({
      sources: () => (createdOnce ? [created] : []),
      routes: [
        (url, init) => {
          if (url !== SOURCES_URL || init?.method !== 'POST') return undefined;
          createdOnce = true;
          return jsonResponse({ data: created }, { status: 201, headers: { ETag: '"1"' } });
        },
      ],
    });
    await user.click(await screen.findByRole('button', { name: 'Nova fonte' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nova fonte de pesquisa' });
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: /Tipo de fonte/ }),
      DIRETA.id,
    );
    expect(
      within(dialog).getByText(
        'Campos exigidos para "Pesquisa direta com fornecedor": fornecedor, data do orçamento/documento, anexo, justificativa da escolha do fornecedor.',
      ),
    ).toBeTruthy();
    await user.type(
      within(dialog).getByRole('textbox', { name: /Descrição/ }),
      'Orçamento Construtora XYZ',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Salvar fonte' }));
    expect(await within(dialog).findByText('Selecione o fornecedor')).toBeTruthy();
    expect(callsTo(fetchMock, 'POST', SOURCES_URL)).toHaveLength(0);

    await user.type(within(dialog).getByRole('searchbox', { name: /Fornecedor/ }), 'Constru');
    await user.click(await within(dialog).findByRole('button', { name: /Construtora XYZ Ltda\./ }));
    await user.type(within(dialog).getByLabelText(/Data do orçamento/), '2026-09-30');
    await user.type(
      within(dialog).getByRole('textbox', { name: /Justificativa da escolha/ }),
      'Fornecedor do ramo com atuação na região.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Salvar fonte' }));
    expect(await screen.findByText('Fonte registrada')).toBeTruthy();
    const [post] = callsTo(fetchMock, 'POST', SOURCES_URL);
    expect(post?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(bodyOf(post?.init)).toMatchObject({
      sourceTypeId: DIRETA.id,
      description: 'Orçamento Construtora XYZ',
      supplierId: SUPPLIER_ID,
      quoteDate: '2026-09-30',
      supplierChoiceJustification: 'Fornecedor do ramo com atuação na região.',
      url: null,
    });
    // Fluxo principal 6: a grade da fonte criada abre em seguida.
    expect(
      await screen.findByRole('table', { name: 'Preços da fonte Orçamento Construtora XYZ' }),
    ).toBeTruthy();
  });

  it('erros por campo da API voltam ao formulário (QUOTATION_REQUIRED_FIELDS)', async () => {
    const { user } = await renderSources({
      routes: [
        (url, init) =>
          url === SOURCES_URL && init?.method === 'POST'
            ? problemResponse(422, 'QUOTATION_REQUIRED_FIELDS', {
                errors: [
                  {
                    field: 'url',
                    code: 'CONDITIONAL_REQUIRED',
                    message: 'Campo obrigatório para este tipo de fonte.',
                  },
                ],
              })
            : undefined,
      ],
    });
    await user.click(await screen.findByRole('button', { name: 'Nova fonte' }));
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: /Tipo de fonte/ }),
      SITIO.id,
    );
    await user.type(within(dialog).getByRole('textbox', { name: /Descrição/ }), 'Painel de Preços');
    await user.type(
      within(dialog).getByRole('textbox', { name: /URL/ }),
      'https://paineldeprecos.planejamento.gov.br',
    );
    await user.type(within(dialog).getByLabelText(/Data\/hora de acesso/), '2026-09-12T14:32');
    await user.click(within(dialog).getByRole('button', { name: 'Salvar fonte' }));
    expect(
      await within(dialog).findByText('Campo obrigatório para este tipo de fonte.'),
    ).toBeTruthy();
  });

  it('FA-02: remover pede confirmação com as cotações a perder e usa o If-Match da fonte', async () => {
    const { fetchMock, user } = await renderSources({
      sources: [priceSourceDto({ version: 4, quotations: [quotationDto(1), quotationDto(2)] })],
      routes: [
        (url, init) =>
          url === `/api/v1/price-sources/${SOURCE_ID}` && init?.method === 'DELETE'
            ? new Response(null, { status: 204 })
            : undefined,
      ],
    });
    await user.click(await screen.findByRole('button', { name: 'Remover' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(
        '2 preços lançados nesta fonte serão perdidos. Esta ação não pode ser desfeita.',
      ),
    ).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Remover fonte' }));
    expect(await screen.findByText('Fonte removida')).toBeTruthy();
    expect(
      callsTo(fetchMock, 'DELETE', `/api/v1/price-sources/${SOURCE_ID}`)[0]?.headers.get(
        'If-Match',
      ),
    ).toBe('"4"');
  });

  it('FA-08/POL-09: somente leitura sem ações — sem "Nova fonte" nem edição; preço mascarado como "Sigiloso"', async () => {
    const { user } = await renderSources({
      readOnly: true,
      sources: [
        priceSourceDto({
          quotations: [quotationDto(1, { unitPrice: null, unitPriceMasked: true })],
        }),
      ],
    });
    await screen.findByRole('list', { name: 'Fontes registradas' });
    expect(screen.queryByRole('button', { name: 'Nova fonte' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Editar' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Lançar preços' }));
    const grid = await screen.findByRole('table');
    expect(within(grid).getByText('Sigiloso')).toBeTruthy();
    expect(within(grid).queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Salvar preços' })).toBeNull();
  });
});

const EXCLUDE_ACTIONS: PriceResearchMeta['allowedActions'] = [
  'UPDATE',
  'ADD_ITEMS',
  'REMOVE_ITEMS',
  'EXCLUDE_QUOTATION',
];
const quotationUrl = (n: number, action: 'exclude' | 'restore') =>
  `/api/v1/quotations/${quotationDto(n).id}/${action}`;
const JUSTIFICATION = 'Preço muito acima das demais cotações do mesmo item';

describe('Desconsiderar e restaurar cotação (US-027)', () => {
  it('fluxo principal 1–4: o diálogo pede motivo e justificativa; PRS-16 com If-Match da cotação; a grade recarrega', async () => {
    let excluded = false;
    const { fetchMock, user } = await renderSources({
      actions: EXCLUDE_ACTIONS,
      items: [priceItem(1, { validQuotationsCount: 2 }), priceItem(2), priceItem(3)],
      sources: () => [
        priceSourceDto({
          version: excluded ? 3 : 2,
          quotations: [
            excluded
              ? quotationDto(1, {
                  status: 'EXCLUDED',
                  exclusionReason: 'INCONSISTENT',
                  exclusionJustification: JUSTIFICATION,
                  version: 3,
                })
              : quotationDto(1, { version: 2 }),
            quotationDto(2),
          ],
        }),
      ],
      routes: [
        (url, init) => {
          if (url !== quotationUrl(1, 'exclude') || init?.method !== 'POST') return undefined;
          excluded = true;
          return jsonResponse({ data: quotationDto(1, { status: 'EXCLUDED', version: 3 }) });
        },
      ],
    });
    await user.click(await screen.findByRole('button', { name: 'Lançar preços' }));
    await user.click(await screen.findByRole('button', { name: 'Desconsiderar preço do item 1' }));
    const dialog = await screen.findByRole('dialog', { name: 'Desconsiderar o preço do item 1' });
    // O foco vai para o campo "Motivo" e a acessibilidade do diálogo é verificada.
    expect(document.activeElement).toBe(within(dialog).getByRole('combobox', { name: /Motivo/ }));
    expect(within(dialog).queryByText('Este item ficará sem cotação válida.')).toBeNull();
    expect(await seriousA11yViolations()).toEqual([]);

    // V-01/V-02: nada é enviado e os erros são anunciados.
    await user.click(within(dialog).getByRole('button', { name: 'Desconsiderar' }));
    expect(await within(dialog).findByText('Selecione o motivo.')).toBeTruthy();
    expect(
      within(dialog).getByText('A justificativa deve ter no mínimo 20 caracteres.'),
    ).toBeTruthy();
    expect(callsTo(fetchMock, 'POST', quotationUrl(1, 'exclude'))).toHaveLength(0);
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: /Motivo/ }),
      'INCONSISTENT',
    );
    await user.type(within(dialog).getByRole('textbox', { name: /Justificativa/ }), 'Preço alto');
    await user.click(within(dialog).getByRole('button', { name: 'Desconsiderar' }));
    expect(
      await within(dialog).findByText('A justificativa deve ter no mínimo 20 caracteres.'),
    ).toBeTruthy();
    expect(callsTo(fetchMock, 'POST', quotationUrl(1, 'exclude'))).toHaveLength(0);

    await user.clear(within(dialog).getByRole('textbox', { name: /Justificativa/ }));
    await user.type(within(dialog).getByRole('textbox', { name: /Justificativa/ }), JUSTIFICATION);
    await user.click(within(dialog).getByRole('button', { name: 'Desconsiderar' }));
    expect(await screen.findByText('Preço desconsiderado')).toBeTruthy();
    const [call] = callsTo(fetchMock, 'POST', quotationUrl(1, 'exclude'));
    expect(call?.headers.get('If-Match')).toBe('"2"');
    expect(bodyOf(call?.init)).toEqual({
      exclusionReason: 'INCONSISTENT',
      exclusionJustification: JUSTIFICATION,
    });
    // Fluxo 4: a célula fica esmaecida com o motivo em dica e o botão "Restaurar".
    const grid = await screen.findByRole('table');
    expect(await within(grid).findByText('Desconsiderada')).toBeTruthy();
    expect(within(grid).getByText('Desconsiderada').getAttribute('title')).toBe(
      'Cotação desconsiderada (inconsistente). Restaure-a para editar o preço.',
    );
    expect(within(grid).getByRole('button', { name: 'Restaurar preço do item 1' })).toBeTruthy();
    expect(
      within(grid).queryByRole('button', { name: 'Desconsiderar preço do item 1' }),
    ).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('FA-01: a última cotação válida do item avisa antes de confirmar, sem bloquear', async () => {
    const { user } = await renderSources({
      actions: EXCLUDE_ACTIONS,
      items: [priceItem(1, { validQuotationsCount: 1 }), priceItem(2, { validQuotationsCount: 2 })],
      sources: [priceSourceDto({ quotations: [quotationDto(1), quotationDto(2)] })],
    });
    await user.click(await screen.findByRole('button', { name: 'Lançar preços' }));
    await user.click(await screen.findByRole('button', { name: 'Desconsiderar preço do item 2' }));
    const second = await screen.findByRole('dialog');
    expect(within(second).queryByText('Este item ficará sem cotação válida.')).toBeNull();
    await user.click(within(second).getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await user.click(await screen.findByRole('button', { name: 'Desconsiderar preço do item 1' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Este item ficará sem cotação válida.')).toBeTruthy();
    expect(
      within(dialog).getByRole('button', { name: 'Desconsiderar' }).hasAttribute('disabled'),
    ).toBe(false);
  });

  it('fluxo principal 5: "Restaurar" envia PRS-17 com If-Match da cotação e recarrega; FA-02: só em cotação desconsiderada', async () => {
    let restored = false;
    const excludedQuotation = quotationDto(1, {
      status: 'EXCLUDED',
      exclusionReason: 'EXCESSIVE',
      exclusionJustification: JUSTIFICATION,
      version: 3,
    });
    const { fetchMock, user } = await renderSources({
      actions: EXCLUDE_ACTIONS,
      sources: () => [
        priceSourceDto({
          quotations: [restored ? quotationDto(1, { version: 4 }) : excludedQuotation],
        }),
      ],
      routes: [
        (url, init) => {
          if (url !== quotationUrl(1, 'restore') || init?.method !== 'POST') return undefined;
          restored = true;
          return jsonResponse({ data: quotationDto(1, { version: 4 }) });
        },
      ],
    });
    await user.click(await screen.findByRole('button', { name: 'Lançar preços' }));
    const grid = await screen.findByRole('table');
    expect(
      within(grid).queryByRole('button', { name: 'Desconsiderar preço do item 1' }),
    ).toBeNull();
    await user.click(within(grid).getByRole('button', { name: 'Restaurar preço do item 1' }));
    expect(await screen.findByText('Preço restaurado')).toBeTruthy();
    const [call] = callsTo(fetchMock, 'POST', quotationUrl(1, 'restore'));
    expect(call?.headers.get('If-Match')).toBe('"3"');
    expect(call?.init?.body ?? null).toBeNull();
    await waitFor(() => {
      expect(within(screen.getByRole('table')).queryByText('Desconsiderada')).toBeNull();
    });
    const refreshed = screen.getByRole('table');
    expect(
      within(refreshed).getByRole('button', { name: 'Desconsiderar preço do item 1' }),
    ).toBeTruthy();
    expect(
      within(refreshed).queryByRole('button', { name: 'Restaurar preço do item 1' }),
    ).toBeNull();
  });

  it('sem EXCLUDE_QUOTATION os botões ficam ocultos (FA-03: pesquisa não editável também)', async () => {
    const { user } = await renderSources({
      sources: [
        priceSourceDto({
          quotations: [
            quotationDto(1),
            quotationDto(2, { status: 'EXCLUDED', exclusionReason: 'OTHER' }),
          ],
        }),
      ],
    });
    await user.click(await screen.findByRole('button', { name: 'Lançar preços' }));
    const grid = await screen.findByRole('table');
    expect(within(grid).queryByRole('button', { name: /Desconsiderar preço/ })).toBeNull();
    expect(within(grid).queryByRole('button', { name: /Restaurar preço/ })).toBeNull();
  });

  it('INVALID_STATE (409) fecha o diálogo, mostra o estado atual e recarrega; 503 mantém o diálogo com os dados', async () => {
    let attempt = 0;
    const { user } = await renderSources({
      actions: EXCLUDE_ACTIONS,
      sources: [priceSourceDto({ quotations: [quotationDto(1)] })],
      routes: [
        (url, init) => {
          if (url !== quotationUrl(1, 'exclude') || init?.method !== 'POST') return undefined;
          attempt += 1;
          return attempt === 1
            ? problemResponse(503, 'DEPENDENCY_UNAVAILABLE')
            : problemResponse(409, 'INVALID_STATE', {
                detail: 'Esta cotação já está desconsiderada.',
              });
        },
      ],
    });
    await user.click(await screen.findByRole('button', { name: 'Lançar preços' }));
    await user.click(await screen.findByRole('button', { name: 'Desconsiderar preço do item 1' }));
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: /Motivo/ }), 'EXCESSIVE');
    await user.type(within(dialog).getByRole('textbox', { name: /Justificativa/ }), JUSTIFICATION);
    await user.click(within(dialog).getByRole('button', { name: 'Desconsiderar' }));
    expect(
      await within(dialog).findByText(
        'Não foi possível concluir agora. Tente novamente em instantes.',
      ),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole<HTMLTextAreaElement>('textbox', { name: /Justificativa/ }).value,
    ).toBe(JUSTIFICATION);

    await user.click(within(dialog).getByRole('button', { name: 'Desconsiderar' }));
    expect(await screen.findByText('Esta cotação já está desconsiderada.')).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('erro de campo da API (422 TOO_SHORT) volta ao diálogo aberto', async () => {
    const { user } = await renderSources({
      actions: EXCLUDE_ACTIONS,
      sources: [priceSourceDto({ quotations: [quotationDto(1)] })],
      routes: [
        (url, init) =>
          url === quotationUrl(1, 'exclude') && init?.method === 'POST'
            ? problemResponse(422, 'VALIDATION_ERROR', {
                errors: [
                  {
                    field: 'exclusionJustification',
                    code: 'TOO_SHORT',
                    message: 'A justificativa deve ter no mínimo 20 caracteres.',
                  },
                ],
              })
            : undefined,
      ],
    });
    await user.click(await screen.findByRole('button', { name: 'Lançar preços' }));
    await user.click(await screen.findByRole('button', { name: 'Desconsiderar preço do item 1' }));
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: /Motivo/ }), 'OTHER');
    await user.type(within(dialog).getByRole('textbox', { name: /Justificativa/ }), JUSTIFICATION);
    await user.click(within(dialog).getByRole('button', { name: 'Desconsiderar' }));
    expect(
      await within(dialog).findByText('A justificativa deve ter no mínimo 20 caracteres.'),
    ).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});

describe('Anexo da fonte (US-026 · Falha de integração)', () => {
  it('upload que falha mostra "Não foi possível enviar o anexo agora. Tente novamente."', async () => {
    const api = mockProcessApi({ permissions: ['ATTACHMENT_UPLOAD'] });
    stubWithRoutes(api, (url, init) =>
      url === '/api/v1/attachments' && init?.method === 'POST'
        ? problemResponse(503, 'DEPENDENCY_UNAVAILABLE')
        : undefined,
    );
    const user = userEvent.setup();
    const { container } = renderWithShell(
      <AttachmentsSection
        targetType="PRICE_SOURCE"
        targetId={SOURCE_ID}
        action="UPDATE"
        allowedActions={['UPDATE']}
        failedMessage={PRICE_SOURCE_MESSAGES.attachmentFailed}
      />,
    );
    await screen.findByRole('button', { name: 'Anexar arquivo' });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error('input de arquivo ausente');
    await user.upload(input, new File(['%PDF-1.7'], 'orcamento.pdf', { type: 'application/pdf' }));
    expect(
      await screen.findByText('Não foi possível enviar o anexo agora. Tente novamente.'),
    ).toBeTruthy();
  });
});
