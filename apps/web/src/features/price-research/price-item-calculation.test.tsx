// @vitest-environment jsdom
import { Toaster, clearToasts } from '@contrataflow/ui';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import {
  RESEARCH_ID,
  priceItem,
  priceResearchMeta,
  processItem,
  readRoutes,
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

/*
 * US-029 — cálculo por item na SCR-009: `PriceItemStatsCard` (estatísticas, "Valor recomendado",
 * "Sem cotações válidas", `aria-live`), `MethodSelect` + `ManualPriceFieldset` (PRS-07 com If-Match,
 * V-01 na tela), "Recalcular agora" (PRS-20, 503 com toast), parâmetros editáveis (PRS-04 · FA-03) e
 * a tela somente leitura sem `UPDATE`.
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

const ITEMS_URL = `/api/v1/price-research/${RESEARCH_ID}/items`;
const JUSTIFICATION = 'Valor de ata vigente do consórcio regional';

const calculated = priceItem(1, {
  validQuotationsCount: 3,
  quotationsCount: 3,
  meanPrice: '100.0000',
  medianPrice: '100.0000',
  lowestPrice: '90.0000',
  highestPrice: '110.0000',
  stdDeviation: '10.0000',
  coefficientOfVariation: '10.0000',
  effectiveMethod: 'MEAN',
  recommendedUnitPrice: '100.0000',
  totalPrice: '1000.00',
  alerts: [],
  version: 4,
});

const processItemsRoute: Route = (url, init) =>
  url === `/api/v1/processes/${PROCESS_ID}/items` && (init?.method ?? 'GET') === 'GET'
    ? jsonResponse({ data: [processItem(1, '10.0000'), processItem(2, '10.0000')] })
    : undefined;

async function renderPage(
  options: {
    routes?: Route[];
    readOnly?: boolean;
    items?: () => ReturnType<typeof priceItem>[];
  } = {},
) {
  const api = mockProcessApi({ permissions: ['PROCESS_VIEW', 'PRICE_RESEARCH_UPDATE'] });
  const items = options.items ?? (() => [calculated, priceItem(2)]);
  const fetchMock = stubWithRoutes(
    api,
    ...(options.routes ?? []),
    (url, init) =>
      url.startsWith(ITEMS_URL) && (init?.method ?? 'GET') === 'GET'
        ? jsonResponse({
            data: items(),
            meta: { page: 1, pageSize: 100, totalItems: items().length, totalPages: 1 },
          })
        : undefined,
    readRoutes(
      options.readOnly === true
        ? { meta: priceResearchMeta({ allowedActions: [], lockReason: 'PERMISSION_DENIED' }) }
        : {},
    ),
    processItemsRoute,
  );
  renderWithShell(
    <>
      <Toaster />
      {await ProcessPriceResearchPage({
        params: Promise.resolve({ id: PROCESS_ID, researchId: RESEARCH_ID }),
      })}
    </>,
  );
  return { fetchMock, user: userEvent.setup() };
}

async function openCalculation(user: ReturnType<typeof userEvent.setup>, number = 1) {
  await user.click(
    await screen.findByRole('button', { name: `Ver o cálculo do item ${String(number)}` }),
  );
  return screen.findByRole('region', { name: `Cálculo do item ${String(number)}` });
}

describe('Cálculo por item da SCR-009 (US-029)', () => {
  it('mostra as estatísticas, o valor recomendado e o método automático, anunciados por aria-live', async () => {
    const { user } = await renderPage();
    const region = await openCalculation(user);
    expect(within(region).getByText('Média', { selector: 'dt' })).toBeTruthy();
    expect(within(region).getAllByText('R$ 100,0000').length).toBeGreaterThanOrEqual(2);
    expect(within(region).getByText('10,00 %')).toBeTruthy();
    expect(within(region).getByText('R$ 100,00')).toBeTruthy();
    expect(within(region).getByText('R$ 1.000,00')).toBeTruthy();
    expect(within(region).getByText('Método aplicado: Média')).toBeTruthy();
    expect(within(region).getByText('Automático')).toBeTruthy();
    expect(region.querySelector('[aria-live="polite"]')).not.toBeNull();
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('FA-05: item sem cotação válida mostra "Sem cotações válidas"', async () => {
    const { user } = await renderPage();
    const region = await openCalculation(user, 2);
    expect(within(region).getByText('Sem cotações válidas')).toBeTruthy();
  });

  it('FA-01: valor manual exige justificativa na tela (V-01) e envia PRS-07 com If-Match do item', async () => {
    let saved = false;
    const { fetchMock, user } = await renderPage({
      items: () => [
        saved
          ? {
              ...calculated,
              methodOverride: 'MANUAL',
              effectiveMethod: 'MANUAL',
              manualUnitPrice: '95.5000',
              manualJustification: JUSTIFICATION,
              recommendedUnitPrice: '95.5000',
              totalPrice: '955.00',
              version: 5,
            }
          : calculated,
        priceItem(2),
      ],
      routes: [
        (url, init) => {
          if (url !== `/api/v1/price-items/${calculated.id}` || init?.method !== 'PATCH') {
            return undefined;
          }
          saved = true;
          return jsonResponse({ data: calculated }, { headers: { ETag: '"5"' } });
        },
      ],
    });
    const region = await openCalculation(user);
    await user.selectOptions(within(region).getByLabelText('Método do item'), 'MANUAL');
    await user.type(within(region).getByRole('textbox', { name: 'Valor manual (R$)' }), '95,50');
    await user.click(within(region).getByRole('button', { name: 'Salvar método' }));
    expect(
      await within(region).findByText(
        'Informe o valor manual e a justificativa (mín. 20 caracteres).',
      ),
    ).toBeTruthy();
    expect(callsTo(fetchMock, 'PATCH', `/api/v1/price-items/${calculated.id}`)).toHaveLength(0);

    await user.type(
      within(region).getByRole('textbox', { name: 'Justificativa do valor manual' }),
      JUSTIFICATION,
    );
    await user.click(within(region).getByRole('button', { name: 'Salvar método' }));
    expect(await screen.findByText('Método do item 1 salvo')).toBeTruthy();
    const [call] = callsTo(fetchMock, 'PATCH', `/api/v1/price-items/${calculated.id}`);
    expect(call?.headers.get('If-Match')).toBe('"4"');
    expect(bodyOf(call?.init)).toEqual({
      methodOverride: 'MANUAL',
      manualUnitPrice: '95.50',
      manualJustification: JUSTIFICATION,
    });
    // A consulta dos itens é invalidada: o card passa a mostrar o selo "Valor manual".
    const updated = await screen.findByRole('region', { name: 'Cálculo do item 1' });
    expect(await within(updated).findByText(`Justificativa: ${JUSTIFICATION}`)).toBeTruthy();
    expect(within(updated).getAllByText('Valor manual').length).toBeGreaterThan(0);
  });

  it('FA-04: "Recalcular agora" chama o PRS-20; 503 mantém os valores e avisa', async () => {
    let down = false;
    const { fetchMock, user } = await renderPage({
      routes: [
        (url, init) => {
          if (
            url !== `/api/v1/price-research/${RESEARCH_ID}/recalculate` ||
            init?.method !== 'POST'
          )
            return undefined;
          return down
            ? problemResponse(503, 'DEPENDENCY_UNAVAILABLE')
            : jsonResponse({
                data: {
                  itemsCount: 2,
                  itemsWithAlertsCount: 1,
                  lastCalculatedAt: '2026-10-16T12:00:00.000Z',
                },
              });
        },
      ],
    });
    await user.click(await screen.findByRole('button', { name: 'Recalcular agora' }));
    expect(await screen.findByText('Estatísticas recalculadas')).toBeTruthy();
    expect(
      callsTo(fetchMock, 'POST', `/api/v1/price-research/${RESEARCH_ID}/recalculate`),
    ).toHaveLength(1);

    down = true;
    await user.click(screen.getByRole('button', { name: 'Recalcular agora' }));
    expect(
      await screen.findByText('Não foi possível calcular agora. Tente novamente em instantes.'),
    ).toBeTruthy();
    const region = await openCalculation(user);
    expect(within(region).getByText('R$ 100,00')).toBeTruthy();
  });

  it('FA-03: editar os parâmetros envia só o que mudou no PRS-04 com If-Match da pesquisa', async () => {
    const { fetchMock, user } = await renderPage({
      routes: [
        (url, init) =>
          url === `/api/v1/price-research/${RESEARCH_ID}` && init?.method === 'PATCH'
            ? problemResponse(412, 'VERSION_CONFLICT')
            : undefined,
      ],
    });
    await user.click(await screen.findByRole('button', { name: 'Editar parâmetros' }));
    await user.selectOptions(screen.getByLabelText('Método padrão'), 'MEDIAN');
    await user.click(screen.getByRole('button', { name: 'Salvar e recalcular' }));
    await waitFor(() => {
      expect(callsTo(fetchMock, 'PATCH', `/api/v1/price-research/${RESEARCH_ID}`)).toHaveLength(1);
    });
    const [call] = callsTo(fetchMock, 'PATCH', `/api/v1/price-research/${RESEARCH_ID}`);
    expect(call?.headers.get('If-Match')).toBe('"1"');
    expect(bodyOf(call?.init)).toEqual({ defaultMethod: 'MEDIAN' });
  });

  it('sem UPDATE: estatísticas visíveis, sem método, sem "Recalcular agora" nem edição de parâmetros', async () => {
    const { user } = await renderPage({ readOnly: true });
    const region = await openCalculation(user);
    expect(within(region).getByText('R$ 100,00')).toBeTruthy();
    expect(within(region).queryByLabelText('Método do item')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Recalcular agora' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Editar parâmetros' })).toBeNull();
  });
});
