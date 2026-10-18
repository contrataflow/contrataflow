// @vitest-environment jsdom
import { Toaster, clearToasts } from '@contrataflow/ui';
import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import {
  RESEARCH_ID,
  priceItem,
  priceResearchDto,
  priceResearchMeta,
  processItem,
  readRoutes,
  stubWithRoutes,
} from '@test/support/price-research-fixtures';
import type { Route } from '@test/support/price-research-fixtures';
import {
  ID,
  PROCESS_ID,
  callsTo,
  mockProcessApi,
  problemResponse,
} from '@test/support/process-fixtures';
import { jsonResponse, renderWithShell } from '@test/support/render';

import ProcessPriceResearchPage from './page';

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

const RESEARCH_URL = `/api/v1/price-research/${RESEARCH_ID}`;

/** Itens do processo (PRC-13) que correspondem aos três itens da pesquisa. */
const SAME_ITEMS = [
  processItem(1, '10.0000'),
  processItem(2, '10.0000'),
  processItem(3, '10.0000'),
];

const processItemsRoute =
  (items = SAME_ITEMS): Route =>
  (url, init) =>
    url === `/api/v1/processes/${PROCESS_ID}/items` && (init?.method ?? 'GET') === 'GET'
      ? jsonResponse({ data: items }, { headers: { ETag: '"4"' } })
      : undefined;

async function renderPage(...routes: Route[]) {
  const api = mockProcessApi({ permissions: ['PROCESS_VIEW'] });
  const fetchMock = stubWithRoutes(api, ...routes, processItemsRoute());
  renderWithShell(
    <>
      <Toaster />
      {await ProcessPriceResearchPage({
        params: Promise.resolve({ id: PROCESS_ID, researchId: RESEARCH_ID }),
      })}
    </>,
  );
  return fetchMock;
}

describe('/processos/[id]/pesquisa-precos/[researchId] (SCR-009 · US-024)', () => {
  it('busca a pesquisa pelo id da rota (PRS-03) e mostra "não encontrada" no 404', async () => {
    const fetchMock = await renderPage((url) =>
      url === RESEARCH_URL ? problemResponse(404, 'NOT_FOUND') : undefined,
    );
    expect(await screen.findByText('Pesquisa de preços não encontrada.')).toBeTruthy();
    expect(callsTo(fetchMock, 'GET', RESEARCH_URL)).toHaveLength(1);
  });

  it('renderiza cabeçalho, parâmetros (snapshot com a nota), itens e alertas', async () => {
    const fetchMock = await renderPage(readRoutes({}));
    expect(await screen.findByRole('heading', { level: 1, name: 'PP 0001/2026' })).toBeTruthy();
    expect(screen.getByText('Rascunho')).toBeTruthy();
    expect(screen.getByText('Pesquisa de preços — 0012/2026')).toBeTruthy();

    const parameters = screen.getByRole('complementary');
    expect(within(parameters).getByRole('heading', { name: 'Parâmetros' })).toBeTruthy();
    expect(within(parameters).getByText('25 %')).toBeTruthy();
    expect(within(parameters).getByText('3')).toBeTruthy();
    expect(within(parameters).getByText('180 dias')).toBeTruthy();
    expect(within(parameters).getByText('70 % da mediana das demais cotações')).toBeTruthy();
    expect(
      within(parameters).getByText(
        'Definidos pelo órgão em 16/10/2026. Alterações posteriores nas configurações não afetam esta pesquisa.',
      ),
    ).toBeTruthy();

    const table = await screen.findByRole('table', { name: 'Itens da pesquisa de preços' });
    expect(within(table).getAllByText('Sem cotações válidas')).toHaveLength(3);
    expect(within(table).getAllByText('Abaixo do mínimo de cotações')).toHaveLength(3);
    expect(within(table).getByText('Item número 2')).toBeTruthy();
    expect(callsTo(fetchMock, 'GET', `${RESEARCH_URL}/items?page=1&pageSize=100`)).toHaveLength(1);
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('POL-09: valor recomendado mascarado aparece como "Sigiloso"', async () => {
    await renderPage(
      readRoutes({
        research: priceResearchDto({
          confidentiality: 'RESTRICTED',
          totalEstimatedValueMasked: true,
        }),
        items: [
          priceItem(1, { valuesMasked: true, recommendedUnitPriceMasked: true }),
          priceItem(2, { recommendedUnitPrice: '12.5000' }),
          priceItem(3),
        ],
      }),
    );
    const table = await screen.findByRole('table', { name: 'Itens da pesquisa de preços' });
    expect(within(table).getByText('Sigiloso')).toBeTruthy();
    expect(within(table).getByText(/12,50/)).toBeTruthy();
    // Total estimado e selo do cabeçalho também em texto.
    expect(screen.getAllByText('Sigiloso').length).toBeGreaterThanOrEqual(3);
  });

  it('FA-04: o banner de itens faltantes inclui os itens pelo PRS-06 e recarrega a pesquisa', async () => {
    const user = userEvent.setup();
    const added = [priceItem(4)];
    const fetchMock = await renderPage(
      (url, init) =>
        url === `${RESEARCH_URL}/items` && init?.method === 'POST'
          ? jsonResponse({ data: added }, { status: 201 })
          : undefined,
      readRoutes({}),
      processItemsRoute([...SAME_ITEMS, processItem(4, '5.0000')]),
    );
    expect(await screen.findByText('1 item do processo não está na pesquisa')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Incluir itens' }));
    await waitFor(() => {
      expect(callsTo(fetchMock, 'POST', `${RESEARCH_URL}/items`)).toHaveLength(1);
    });
    const [call] = callsTo(fetchMock, 'POST', `${RESEARCH_URL}/items`);
    expect(call?.body).toEqual({ items: [{ processItemId: ID(904), quantity: '5' }] });
    expect(await screen.findByText('1 item incluído na pesquisa')).toBeTruthy();
    // A versão da pesquisa mudou: refaz o PRS-03.
    await waitFor(() => {
      expect(callsTo(fetchMock, 'GET', RESEARCH_URL).length).toBeGreaterThanOrEqual(2);
    });
  });

  it('sem "Incluir itens" quando a pesquisa não aceita inclusão', async () => {
    await renderPage(
      readRoutes({ meta: priceResearchMeta({ allowedActions: ['UPDATE'] }) }),
      processItemsRoute([...SAME_ITEMS, processItem(4, '5.0000')]),
    );
    expect(await screen.findByText('1 item do processo não está na pesquisa')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Incluir itens' })).toBeNull();
  });

  it('FA-05: remover pede confirmação com as cotações a apagar e usa o If-Match do item', async () => {
    const user = userEvent.setup();
    const fetchMock = await renderPage(
      (url, init) =>
        url === `/api/v1/price-items/${ID(951)}` && init?.method === 'DELETE'
          ? new Response(null, { status: 204 })
          : undefined,
      readRoutes({
        items: [priceItem(1, { quotationsCount: 4, version: 3 }), priceItem(2), priceItem(3)],
      }),
    );
    await user.click(await screen.findByRole('button', { name: 'Remover o item 1' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remover o item 1?' });
    expect(
      within(dialog).getByText('O item 1 tem 4 cotações registradas. Elas serão apagadas.'),
    ).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Remover item' }));
    await waitFor(() => {
      expect(callsTo(fetchMock, 'DELETE', `/api/v1/price-items/${ID(951)}`)).toHaveLength(1);
    });
    const [call] = callsTo(fetchMock, 'DELETE', `/api/v1/price-items/${ID(951)}`);
    expect(call?.headers.get('If-Match')).toBe('"3"');
    expect(await screen.findByText('Item 1 removido da pesquisa')).toBeTruthy();
  });

  it('o último item não pode ser removido (RN-PRICE-11)', async () => {
    await renderPage(readRoutes({ items: [priceItem(1)] }));
    expect(await screen.findByText('A pesquisa precisa de ao menos um item.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Remover o item/ })).toBeNull();
  });

  it('remoção de item sem cotações usa a confirmação curta', async () => {
    const user = userEvent.setup();
    await renderPage(readRoutes({ items: [priceItem(1), priceItem(2)] }));
    await user.click(await screen.findByRole('button', { name: 'Remover o item 2' }));
    expect(await screen.findByText('O item 2 será removido da pesquisa de preços.')).toBeTruthy();
  });

  it('somente leitura sem ações: explica pelo lockReason e esconde data-base editável e remoção', async () => {
    await renderPage(
      readRoutes({ meta: priceResearchMeta({ allowedActions: [], lockReason: 'NOT_CUSTODIAN' }) }),
      processItemsRoute([...SAME_ITEMS, processItem(4, '5.0000')]),
    );
    expect(await screen.findByText('Esta pesquisa está em modo leitura.')).toBeTruthy();
    expect(screen.getByText('O processo não está com você')).toBeTruthy();
    expect(screen.queryByLabelText(/Data-base/)).toBeNull();
    expect(screen.getByText('16/10/2026')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Remover o item/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Incluir itens' })).toBeNull();
  });

  it.each([
    ['DOCUMENT_NOT_EDITABLE', 'A pesquisa está concluída. Reabra-a para alterar.'],
    ['CONFIDENTIAL_BUDGET', 'Orçamento sigiloso: somente leitura'],
    ['DOCUMENT_TYPE_NOT_ALLOWED_IN_STAGE', 'A etapa atual não permite pesquisa de preços'],
  ] as const)('somente leitura por %s mostra a explicação', async (lockReason, text) => {
    await renderPage(readRoutes({ meta: priceResearchMeta({ allowedActions: [], lockReason }) }));
    expect(await screen.findByText(text)).toBeTruthy();
  });

  it('FA-07: altera a data-base pelo PRS-04 com If-Match e avisa que as validades foram recalculadas', async () => {
    const user = userEvent.setup();
    const fetchMock = await renderPage(
      (url, init) =>
        url === RESEARCH_URL && init?.method === 'PATCH'
          ? jsonResponse(
              {
                data: priceResearchDto({ referenceDate: '2026-01-10', version: 2 }),
                meta: priceResearchMeta(),
              },
              { headers: { ETag: '"2"' } },
            )
          : undefined,
      readRoutes({}),
    );
    const date = await screen.findByLabelText(/Data-base/);
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Alterar data-base' }).disabled,
    ).toBe(true);
    fireEvent.change(date, { target: { value: '2026-01-10' } });
    await user.click(screen.getByRole('button', { name: 'Alterar data-base' }));
    await waitFor(() => {
      expect(callsTo(fetchMock, 'PATCH', RESEARCH_URL)).toHaveLength(1);
    });
    const [call] = callsTo(fetchMock, 'PATCH', RESEARCH_URL);
    expect(call?.body).toEqual({ referenceDate: '2026-01-10' });
    expect(call?.headers.get('If-Match')).toBe('"1"');
    expect(
      await screen.findByText('Data-base alterada para 10/01/2026; validades recalculadas'),
    ).toBeTruthy();
  });

  it('data-base futura não é enviada', async () => {
    await renderPage(readRoutes({}));
    const date = await screen.findByLabelText(/Data-base/);
    fireEvent.change(date, { target: { value: '2999-01-01' } });
    expect(await screen.findByText('A data-base não pode ser posterior a hoje.')).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Alterar data-base' }).disabled,
    ).toBe(true);
  });

  it('412 na data-base avisa que a pesquisa foi alterada por outra pessoa e recarrega', async () => {
    const user = userEvent.setup();
    const fetchMock = await renderPage(
      (url, init) =>
        url === RESEARCH_URL && init?.method === 'PATCH'
          ? problemResponse(412, 'VERSION_CONFLICT')
          : undefined,
      readRoutes({}),
    );
    const date = await screen.findByLabelText(/Data-base/);
    fireEvent.change(date, { target: { value: '2026-01-10' } });
    await user.click(screen.getByRole('button', { name: 'Alterar data-base' }));
    expect(
      await screen.findByText('A pesquisa foi alterada por outra pessoa. Recarregue.'),
    ).toBeTruthy();
    await waitFor(() => {
      expect(callsTo(fetchMock, 'GET', RESEARCH_URL).length).toBeGreaterThanOrEqual(2);
    });
  });

  it('aba Fontes: estado vazio com "Registrar fonte" indisponível', async () => {
    const user = userEvent.setup();
    await renderPage(readRoutes({}));
    await user.click(await screen.findByRole('tab', { name: 'Fontes' }));
    expect(await screen.findByText('Nenhuma fonte registrada ainda')).toBeTruthy();
    expect(
      screen.getByText('Registre as fontes consultadas e os preços de cada item'),
    ).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Registrar fonte' }).disabled,
    ).toBe(true);
    expect(screen.getByText('Disponível em breve')).toBeTruthy();
  });

  it('aba Documento: leva ao documento no visualizador genérico', async () => {
    const user = userEvent.setup();
    await renderPage(readRoutes({}));
    await user.click(await screen.findByRole('tab', { name: 'Documento' }));
    const link = await screen.findByRole('link', { name: 'Abrir documento' });
    expect(link.getAttribute('href')).toBe(`/processos/${PROCESS_ID}/documentos/${RESEARCH_ID}`);
  });

  it('erro de carga mostra "Tentar novamente" que repete o PRS-03', async () => {
    const user = userEvent.setup();
    let failing = true;
    const fetchMock = await renderPage((url, init) => {
      if (failing && url === RESEARCH_URL && (init?.method ?? 'GET') === 'GET') {
        return problemResponse(503, 'DEPENDENCY_UNAVAILABLE');
      }
      return undefined;
    }, readRoutes({}));
    expect(
      await screen.findByText('Não foi possível carregar a pesquisa de preços agora.'),
    ).toBeTruthy();
    failing = false;
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'PP 0001/2026' })).toBeTruthy();
    expect(callsTo(fetchMock, 'GET', RESEARCH_URL).length).toBeGreaterThanOrEqual(2);
  });
});
