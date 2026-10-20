// E2E da aba "Timeline" de SCR-006 (US-060): processo criado pelo wizard, aba "Timeline" com
// agrupamento por dia ("Hoje"/"Ontem" como <h3>), filtro por grupo, scroll infinito até o início da
// timeline, axe-core e viewport de 360 px (filtros colapsáveis, sem rolagem horizontal). A API é
// simulada (support/mock-api.mjs — 60 eventos); SQL, POL-09, RLS e cursor sob concorrência são
// cobertos nos testes da API.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/a11y';
import { createProcessViaWizard } from './support/process-wizard';

const TITLE = 'Contratação de serviços de jardinagem do parque central';

async function createProcess(page: Page): Promise<void> {
  await createProcessViaWizard(page, {
    title: TITLE,
    object: 'Serviços contínuos de jardinagem e paisagismo do parque central.',
  });
}

test('aba "Timeline": dias agrupados, filtro por grupo e scroll infinito até o início', async ({
  page,
}) => {
  await createProcess(page);
  await page.getByRole('tab', { name: 'Timeline' }).click();

  const feed = page.getByRole('region', { name: 'Eventos do processo' });
  await expect(page.getByRole('heading', { level: 3, name: 'Hoje' })).toBeVisible();
  await expect(page.getByText('Ana Souza abriu o processo', { exact: false })).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'aba Timeline');

  // Scroll infinito: 50 por página; rolar até o fim carrega o restante (60 no total).
  await expect(feed.getByRole('listitem')).toHaveCount(50);
  await page.getByText('Carregar mais').scrollIntoViewIfNeeded();
  await expect(feed.getByRole('listitem')).toHaveCount(60);
  await expect(page.getByText('Início da timeline.')).toBeVisible();
  await expect(page.getByRole('heading', { level: 3, name: 'Ontem' })).toBeVisible();

  // Filtro por grupo reinicia a paginação só com aprovações.
  await page.getByRole('checkbox', { name: 'Aprovações' }).check();
  await expect(feed.getByRole('listitem')).toHaveCount(19);
  for (const text of await feed.getByRole('listitem').allTextContents()) {
    expect(text).toContain('aprovou');
  }
  await page.getByRole('button', { name: 'Limpar filtros' }).click();
  await expect(page.getByRole('checkbox', { name: 'Aprovações' })).not.toBeChecked();
  await expect(feed.getByText('encaminhou para', { exact: false }).first()).toBeVisible();
});

test('em 360 px: filtros colapsáveis e sem rolagem horizontal', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await createProcess(page);
  await page.getByRole('tab', { name: 'Timeline' }).click();
  await expect(page.getByRole('heading', { level: 3, name: 'Hoje' })).toBeVisible();

  await expect(page.getByRole('checkbox', { name: 'Aprovações' })).toBeHidden();
  await page.getByRole('button', { name: 'Filtros', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Aprovações' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await expectNoSeriousA11yViolations(page, 'aba Timeline · 360 px');
});
