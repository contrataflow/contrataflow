// @vitest-environment jsdom
import { Toaster, clearToasts } from '@contrataflow/ui';
import type { PriceItemDto, PriceResearchMeta, PriceSourceDto } from '@contrataflow/validation';
import { configure, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import {
  RESEARCH_ID,
  priceItem,
  priceResearchMeta,
  priceSourceDto,
  quotationDto,
  readRoutes,
  sourcesRoute,
  stubWithRoutes,
} from '@test/support/price-research-fixtures';
import { PROCESS_ID, mockProcessApi } from '@test/support/process-fixtures';
import { renderWithShell } from '@test/support/render';

import ProcessPriceResearchPage from '../../app/(app)/processos/[id]/pesquisa-precos/[researchId]/page';

/*
 * US-030 — selos da SCR-009: `AlertBadgeList` com todos os alertas do item (FA-04, sem
 * priorização), "Sem alertas" (estado vazio), `OutlierBadge`/`ExpiredBadge` na grade de preços com
 * tooltip que abre pelo teclado, contagem de destoantes no cartão da fonte, POL-09 sem percentuais
 * (FA-05) e axe sem violações sérias.
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

async function renderPage(
  options: {
    items?: readonly PriceItemDto[];
    sources?: readonly PriceSourceDto[];
    actions?: PriceResearchMeta['allowedActions'];
  } = {},
) {
  const api = mockProcessApi({ permissions: ['PROCESS_VIEW', 'PRICE_RESEARCH_UPDATE'] });
  stubWithRoutes(
    api,
    sourcesRoute(options.sources ?? []),
    readRoutes({
      ...(options.items === undefined ? {} : { items: options.items }),
      ...(options.actions === undefined
        ? {}
        : { meta: priceResearchMeta({ allowedActions: options.actions }) }),
    }),
  );
  renderWithShell(
    <>
      <Toaster />
      {await ProcessPriceResearchPage({
        params: Promise.resolve({ id: PROCESS_ID, researchId: RESEARCH_ID }),
      })}
    </>,
  );
  return { user: userEvent.setup() };
}

describe('Selos de alertas e destaques (US-030)', () => {
  it('FA-04: lista todos os alertas do item, com texto e motivo acessível; item sem alertas mostra "Sem alertas"', async () => {
    const { user } = await renderPage({
      items: [
        priceItem(1, {
          validQuotationsCount: 2,
          alerts: [
            { code: 'BELOW_MINIMUM_QUOTES' },
            { code: 'HIGH_CV' },
            { code: 'HAS_OUTLIERS' },
            { code: 'EXPIRED_QUOTES' },
          ],
        }),
        priceItem(2, { validQuotationsCount: 3, alerts: [] }),
        priceItem(3),
      ],
    });
    const table = await screen.findByRole('table', { name: 'Itens da pesquisa de preços' });
    const [first] = within(table).getAllByRole('list', { name: 'Alertas do item' });
    if (!first) throw new Error('lista de alertas ausente');
    expect(
      within(first)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      expect.stringContaining('Abaixo do mínimo de cotações'),
      expect.stringContaining('Preços muito dispersos'),
      expect.stringContaining('Valores atípicos'),
      expect.stringContaining('Cotações vencidas'),
    ]);
    expect(within(table).getByText('Sem alertas')).toBeTruthy();
    expect(within(table).getByText('Sem cotações válidas')).toBeTruthy();

    // Tooltip acessível pelo teclado: o selo é focável e descrito pelo motivo.
    const badge = within(first).getByText('Valores atípicos');
    await user.click(document.body);
    badge.focus();
    expect(badge).toHaveProperty('tabIndex', 0);
    const tooltip = document.getElementById(badge.getAttribute('aria-describedby') ?? '');
    expect(tooltip?.getAttribute('role')).toBe('tooltip');
    expect(tooltip?.textContent).toContain('nada foi excluído automaticamente');
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('grade de preços: selos "Abaixo da mediana"/"Acima da mediana" e "Vencida" com o limiar do snapshot; cartão conta as destoantes', async () => {
    const { user } = await renderPage({
      items: [priceItem(1), priceItem(2), priceItem(3)],
      sources: [
        priceSourceDto({
          quotations: [
            quotationDto(1, { unitPrice: '40.0000', outlierFlag: 'LOW' }),
            quotationDto(2, { unitPrice: '500.0000', outlierFlag: 'HIGH', isExpired: true }),
            quotationDto(3, { unitPrice: '100.0000' }),
          ],
        }),
      ],
    });
    await user.click(await screen.findByRole('tab', { name: 'Fontes' }));
    const list = await screen.findByRole('list', { name: 'Fontes registradas' });
    expect(within(list).getByText(/1 cotação vencida · 2 cotações destoantes/)).toBeTruthy();
    await user.click(within(list).getByRole('button', { name: 'Lançar preços' }));
    const grid = await screen.findByRole('table', {
      name: 'Preços da fonte Orçamento Construtora XYZ',
    });
    const low = within(grid).getByText('Abaixo da mediana');
    expect(
      document.getElementById(low.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toContain('abaixo de 70% da mediana das demais cotações válidas');
    const high = within(grid).getByText('Acima da mediana');
    expect(
      document.getElementById(high.getAttribute('aria-describedby') ?? '')?.textContent,
    ).toContain('acima de 130% da mediana');
    expect(within(grid).getAllByText('Vencida')).toHaveLength(1);
    // Nenhum selo para a cotação dentro da faixa; nada é desconsiderado automaticamente.
    expect(within(grid).getAllByText(/da mediana$/)).toHaveLength(2);
    expect(within(grid).queryByText('Desconsiderada')).toBeNull();
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('FA-05/POL-09: o selo de destaque continua visível, sem percentuais', async () => {
    const { user } = await renderPage({
      actions: [],
      sources: [
        priceSourceDto({
          quotations: [
            quotationDto(1, { unitPrice: null, unitPriceMasked: true, outlierFlag: 'HIGH' }),
          ],
        }),
      ],
    });
    await user.click(await screen.findByRole('tab', { name: 'Fontes' }));
    const list = await screen.findByRole('list', { name: 'Fontes registradas' });
    await user.click(within(list).getByRole('button', { name: 'Lançar preços' }));
    const grid = await screen.findByRole('table', {
      name: 'Preços da fonte Orçamento Construtora XYZ',
    });
    expect(within(grid).getByText('Sigiloso')).toBeTruthy();
    const badge = within(grid).getByText('Acima da mediana');
    const tooltip = document.getElementById(badge.getAttribute('aria-describedby') ?? '');
    expect(tooltip?.textContent).toContain('valores sigilosos');
    expect(tooltip?.textContent).not.toMatch(/\d/);
  });
});
