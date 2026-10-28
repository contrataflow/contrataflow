// E2E do painel (US-076 · SCR-003 `/painel`): a Ana entra no painel (destino padrão pós-login), vê o
// resumo e os cartões, aplica o filtro de secretaria (refletido na URL), clica em "Atrasados" e
// chega à lista de processos já filtrada. axe-core na tela e o layout a 360 px. A API é simulada
// (support/mock-api.mjs); agregações, visibilidade, POL-09, cache e isolamento são cobertos nos
// testes da API.
import { expect, test } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/a11y';

const login = (returnTo = '/painel') =>
  `/api/auth/login?as=ana&returnTo=${encodeURIComponent(returnTo)}`;

test('abrir o painel, filtrar por secretaria e ir à lista filtrada pelo cartão', async ({
  page,
}) => {
  await page.goto(login());
  await expect(
    page.getByRole('heading', { level: 1, name: /^(Bom dia|Boa tarde|Boa noite), Ana$/ }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: /^Atrasados 3 / })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Processos por situação' })).toBeVisible();
  await expect(page.getByText('Valores sigilosos não somados')).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'painel');

  await page
    .getByRole('combobox', { name: 'Secretaria', exact: true })
    .selectOption({ label: 'Gabinete' });
  await expect(page).toHaveURL(/\/painel\?secretariatId=[0-9a-f-]{36}$/);
  const overdue = page.getByRole('link', { name: /^Atrasados 3 / });
  await expect(overdue).toHaveAttribute('href', /requestingSecretariatId=/);

  await overdue.click();
  await expect(page).toHaveURL(/\/processos\?.*overdue=true/);
  await expect(page).toHaveURL(/requestingSecretariatId=/);
});

test('o painel cabe em 360 px sem rolagem horizontal', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto(login());
  await expect(page.getByRole('heading', { level: 1, name: /, Ana$/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Atividade recente' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});
