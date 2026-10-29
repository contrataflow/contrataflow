// E2E da lista de aprovações (US-057 · SCR-014 `/aprovacoes`, modelo de lista do prd-5): a Ana abre
// as pendentes da sua cobertura, filtra por tipo no popover, troca a situação pelas abas, ordena e
// abre a aprovação (SCR-015). axe-core na tela e a
// lista em cartões a 360 px. A API é simulada (support/mock-api.mjs); a cobertura POL-03, os
// filtros no SQL e o isolamento por tenant são cobertos nos testes da API.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/a11y';

const login = (returnTo = '/aprovacoes') =>
  `/api/auth/login?as=ana&returnTo=${encodeURIComponent(returnTo)}`;

const openLinks = (page: Page) => page.getByRole('link', { name: /^Abrir Aprovação do DFD/ });

test('filtrar, ordenar e abrir a aprovação para decidir', async ({ page }) => {
  await page.goto(login());
  await expect(page.getByRole('heading', { level: 1, name: 'Aprovações' })).toBeVisible();
  await expect(openLinks(page)).toHaveCount(2);
  await expect(page.getByText(/^Em atraso/)).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Pendentes: 2 aprovações' })).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'lista de aprovações');

  // Ordenação por código: mais antigo primeiro.
  await page.getByRole('combobox', { name: 'Ordenar por' }).click();
  await page.getByRole('option', { name: 'Código (mais antigo primeiro)' }).click();
  await expect(openLinks(page).first()).toHaveAccessibleName(
    'Abrir Aprovação do DFD do processo 0003/2026',
  );

  // Tipo sem resultado (filtros no popover) → "Limpar filtros".
  await page.getByRole('button', { name: 'Filtros' }).click();
  await page.getByRole('combobox', { name: 'Tipo de assunto' }).click();
  await page.getByRole('option', { name: 'Documento avulso' }).click();
  await page.keyboard.press('Escape');
  await expect(
    page.getByText('Nenhuma aprovação encontrada para os filtros selecionados.'),
  ).toBeVisible();
  await page.getByRole('tabpanel').getByRole('button', { name: 'Limpar filtros' }).click();
  await expect(openLinks(page)).toHaveCount(2);

  // Situação nas abas: as aprovadas.
  await page.getByRole('tab', { name: /Aprovadas/ }).click();
  await expect(openLinks(page)).toHaveCount(1);
  await page.getByRole('tab', { name: /Pendentes/ }).click();
  await expect(openLinks(page)).toHaveCount(2);

  // A linha leva ao SCR-015, onde a decisão é tomada.
  await page.getByRole('link', { name: 'Abrir Aprovação do DFD do processo 0007/2026' }).click();
  await expect(page).toHaveURL(/\/aprovacoes\/0192e057-0000-7000-8000-000000000001$/);
});

test('em 360 px: as linhas viram cartões, sem rolagem horizontal', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto(login());
  await expect(openLinks(page)).toHaveCount(2);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});
