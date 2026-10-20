// @vitest-environment jsdom
import { Toaster, clearToasts } from '@contrataflow/ui';
import { configure, screen, waitFor, within } from '@testing-library/react';
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
  PROCESS_ID,
  callsTo,
  mockProcessApi,
  problemResponse,
} from '@test/support/process-fixtures';
import { jsonResponse, renderWithShell } from '@test/support/render';

import ProcessPriceResearchPage from '../../app/(app)/processos/[id]/pesquisa-precos/[researchId]/page';

/*
 * US-032 — concluir a pesquisa na SCR-009: botão "Concluir pesquisa" só com `COMPLETE`, diálogo de
 * confirmação (resumo, aviso de alertas — FA-03 — e pendências previstas), PRS-23 com `If-Match` e
 * `Idempotency-Key`, toast com o valor, selo "Concluída", `IncompleteItemsList` do 422 com foco e
 * links aos itens (FA-01), 503 com "Tentar novamente" e a justificativa de cotações insuficientes
 * (PRS-07 — FA-02).
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

const RESEARCH_URL = `/api/v1/price-research/${RESEARCH_ID}`;
const COMPLETE_URL = `${RESEARCH_URL}/complete`;
const JUSTIFICATION = 'Mercado restrito na região.';

const item1 = priceItem(1, {
  validQuotationsCount: 3,
  recommendedUnitPrice: '100.0000',
  totalPrice: '5000.00',
  effectiveMethod: 'MEAN',
  alerts: [],
});
const item2 = priceItem(2, {
  validQuotationsCount: 3,
  recommendedUnitPrice: '40.0000',
  totalPrice: '4000.00',
  effectiveMethod: 'MEAN',
  alerts: [{ code: 'HIGH_CV' }],
});
const research = priceResearchDto({
  itemsCount: 2,
  itemsWithAlertsCount: 1,
  totalEstimatedValue: '9000.00',
  version: 7,
});
const META = priceResearchMeta({
  allowedActions: ['UPDATE', 'ADD_ITEMS', 'REMOVE_ITEMS', 'COMPLETE'],
});

const processItemsRoute: Route = (url, init) =>
  url === `/api/v1/processes/${PROCESS_ID}/items` && (init?.method ?? 'GET') === 'GET'
    ? jsonResponse({ data: [processItem(1, '50.0000'), processItem(2, '100.0000')] })
    : undefined;

async function renderPage(...routes: Route[]) {
  const api = mockProcessApi({
    permissions: ['PROCESS_VIEW', 'PRICE_RESEARCH_UPDATE', 'PRICE_RESEARCH_COMPLETE'],
  });
  const fetchMock = stubWithRoutes(api, ...routes, processItemsRoute);
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

const completedRoute =
  (response: () => Response): Route =>
  (url, init) =>
    url === COMPLETE_URL && init?.method === 'POST' ? response() : undefined;

describe('Concluir pesquisa (SCR-009 · US-032)', () => {
  it('sem COMPLETE em allowedActions o botão não aparece', async () => {
    await renderPage(readRoutes({ research, items: [item1, item2] }));
    expect(await screen.findByRole('heading', { level: 1, name: 'PP 0001/2026' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Concluir pesquisa' })).toBeNull();
  });

  it('confirma: PRS-23 com If-Match e Idempotency-Key, toast com o valor e o selo "Concluída"', async () => {
    const user = userEvent.setup();
    let done = false;
    const completed = priceResearchDto({
      ...research,
      status: 'FINALIZED',
      completedAt: '2026-10-17T13:00:00.000Z',
      version: 8,
    });
    const fetchMock = await renderPage(
      completedRoute(() => {
        done = true;
        return jsonResponse(
          {
            data: {
              ...completed,
              document: { status: 'FINALIZED', currentVersionId: RESEARCH_ID },
            },
            meta: priceResearchMeta({ allowedActions: [], lockReason: 'DOCUMENT_NOT_EDITABLE' }),
          },
          { headers: { ETag: '"8"' } },
        );
      }),
      (url, init) =>
        done && url === RESEARCH_URL && (init?.method ?? 'GET') === 'GET'
          ? jsonResponse(
              {
                data: completed,
                meta: priceResearchMeta({
                  allowedActions: [],
                  lockReason: 'DOCUMENT_NOT_EDITABLE',
                }),
              },
              { headers: { ETag: '"8"' } },
            )
          : undefined,
      readRoutes({ research, meta: META, items: [item1, item2] }),
    );
    await user.click(await screen.findByRole('button', { name: 'Concluir pesquisa' }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText('Esta pesquisa será concluída com 1 item com alerta.'),
    ).toBeTruthy();
    expect(within(dialog).getByText(/9\.000,00/)).toBeTruthy();
    expect(await seriousA11yViolations()).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Concluir pesquisa' }));

    expect(
      await screen.findByText(
        /Pesquisa de preços concluída — valor estimado atualizado para R\$\s9\.000,00/,
      ),
    ).toBeTruthy();
    const [call] = callsTo(fetchMock, 'POST', COMPLETE_URL);
    expect(call?.headers.get('If-Match')).toBe('"7"');
    expect(call?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(call?.body).toEqual({});
    expect(await screen.findByText('Concluída')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Concluir pesquisa' })).toBeNull();
  });

  it('FA-01: 422 PRICE_RESEARCH_INCOMPLETE lista os itens com foco e o link abre a justificativa', async () => {
    const user = userEvent.setup();
    const below = priceItem(2, {
      validQuotationsCount: 1,
      recommendedUnitPrice: '40.0000',
      totalPrice: '4000.00',
      effectiveMethod: 'MEAN',
      alerts: [{ code: 'BELOW_MINIMUM_QUOTES' }],
    });
    const message =
      'O item "Item 2" tem menos cotações que o mínimo exigido. Informe a justificativa.';
    await renderPage(
      completedRoute(() =>
        problemResponse(422, 'PRICE_RESEARCH_INCOMPLETE', {
          extension: {
            violations: [
              {
                code: 'PRICE_ITEM_BELOW_MINIMUM_UNJUSTIFIED',
                severity: 'BLOCKING',
                message,
                ruleId: 'RN-PRICE-58',
                sectionKey: null,
                field: 'belowMinimumJustification',
                itemId: below.id,
                params: { sequence: 2 },
              },
            ],
          },
        }),
      ),
      readRoutes({ research, meta: META, items: [item1, below] }),
    );
    await user.click(await screen.findByRole('button', { name: 'Concluir pesquisa' }));
    const dialog = await screen.findByRole('dialog');
    // A prévia já mostra a pendência; a API confirma.
    expect(within(dialog).getByText(message)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Concluir pesquisa' }));

    const heading = await screen.findByRole('heading', {
      name: 'Não foi possível concluir: há itens pendentes',
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(heading);
    });
    await user.click(screen.getByRole('button', { name: 'Ir para o item 2' }));
    const field = await screen.findByLabelText('Justificativa de cotações insuficientes');
    await waitFor(() => {
      expect(document.activeElement).toBe(field);
    });
  });

  it('503: o diálogo continua aberto com "Tentar novamente" e o código do erro', async () => {
    const user = userEvent.setup();
    await renderPage(
      completedRoute(() =>
        problemResponse(503, 'DEPENDENCY_UNAVAILABLE', { correlationId: 'corr-32' }),
      ),
      readRoutes({ research, meta: META, items: [item1, item2] }),
    );
    await user.click(await screen.findByRole('button', { name: 'Concluir pesquisa' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Concluir pesquisa' }));
    expect(
      await within(dialog).findByText(
        'Não foi possível concluir agora. Tente novamente em instantes.',
      ),
    ).toBeTruthy();
    expect(within(dialog).getByText(/corr-32/)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Tentar novamente' })).toBeTruthy();
  });

  it('412: fecha o diálogo e pede para recarregar', async () => {
    const user = userEvent.setup();
    await renderPage(
      completedRoute(() => problemResponse(412, 'VERSION_CONFLICT')),
      readRoutes({ research, meta: META, items: [item1, item2] }),
    );
    await user.click(await screen.findByRole('button', { name: 'Concluir pesquisa' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Concluir pesquisa' }),
    );
    expect(
      await screen.findByText(
        'Esta pesquisa foi alterada por outra pessoa. Recarregue para revisar.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('FA-02: a justificativa do item abaixo do mínimo é gravada pelo PRS-07 com o If-Match do item', async () => {
    const user = userEvent.setup();
    const below = priceItem(2, {
      validQuotationsCount: 1,
      recommendedUnitPrice: '40.0000',
      totalPrice: '4000.00',
      effectiveMethod: 'MEAN',
      alerts: [{ code: 'BELOW_MINIMUM_QUOTES' }],
      version: 5,
    });
    const fetchMock = await renderPage(
      (url, init) =>
        url === `/api/v1/price-items/${below.id}` && init?.method === 'PATCH'
          ? jsonResponse({
              data: { ...below, belowMinimumJustification: JUSTIFICATION, version: 6 },
            })
          : undefined,
      readRoutes({ research, meta: META, items: [item1, below] }),
    );
    await user.click(await screen.findByRole('button', { name: 'Ver o cálculo do item 2' }));
    const field = await screen.findByLabelText('Justificativa de cotações insuficientes');
    await user.type(field, 'curta');
    await user.click(screen.getByRole('button', { name: 'Salvar justificativa' }));
    expect(
      await screen.findByText('Informe a justificativa com ao menos 20 caracteres.'),
    ).toBeTruthy();
    expect(callsTo(fetchMock, 'PATCH', `/api/v1/price-items/${below.id}`)).toEqual([]);
    await user.clear(field);
    await user.type(field, JUSTIFICATION);
    await user.click(screen.getByRole('button', { name: 'Salvar justificativa' }));
    expect(await screen.findByText('Justificativa do item 2 salva')).toBeTruthy();
    const [call] = callsTo(fetchMock, 'PATCH', `/api/v1/price-items/${below.id}`);
    expect(call?.headers.get('If-Match')).toBe('"5"');
    expect(call?.body).toEqual({ belowMinimumJustification: JUSTIFICATION });
  });
});
