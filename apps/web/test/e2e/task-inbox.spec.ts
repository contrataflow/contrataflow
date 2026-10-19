// E2E da caixa de tarefas (US-056 · SCR-013 `/tarefas`): a Ana abre a caixa em "Comigo", troca de
// aba, ordena, assume o processo da fila da unidade (PRC-21) e vê o contador das duas abas mudar.
// axe-core na tela e a lista em cartões a 360 px. A API é simulada (support/mock-api.mjs); visões,
// contadores, RLS, concorrência e reenvio idempotente são cobertos nos testes da API.
import { expect, test } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/a11y';

// O "Assumir" da API simulada é global: os passos desta jornada rodam em série.
test.describe.configure({ mode: 'serial' });

const login = (returnTo = '/tarefas') =>
  `/api/auth/login?as=ana&returnTo=${encodeURIComponent(returnTo)}`;

test('trocar de aba, ordenar e assumir da fila atualizando os contadores', async ({ page }) => {
  await page.goto(login());
  await expect(page.getByRole('heading', { level: 1, name: 'Caixa de tarefas' })).toBeVisible();
  const mine = page.getByRole('tab', { name: 'Comigo: 2 itens' });
  await expect(mine).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('link', { name: '0002/2026' })).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'caixa de tarefas');

  // Ordenação: código, mais antigo primeiro.
  await page.getByLabel('Ordenar por').selectOption('code');
  await expect(
    page
      .getByRole('link')
      .filter({ hasText: /\/2026$/ })
      .first(),
  ).toHaveText('0001/2026');

  // Aprovações pendentes: solicitante na linha.
  await page.getByRole('tab', { name: /Aprovações pendentes/ }).click();
  await expect(page.getByText('Bruno Lima')).toBeVisible();

  // Fila da unidade: "Assumir" move o processo para "Comigo".
  await page.getByRole('tab', { name: 'Na fila da minha unidade: 1 item' }).click();
  await page.getByRole('button', { name: 'Assumir o processo 0012/2026' }).click();
  await expect(page.getByText('Você assumiu este processo.')).toBeVisible();
  await expect(page.getByText('Nenhum processo aguardando na fila da sua unidade.')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Comigo: 3 itens' })).toBeVisible();
  await expect(
    page.getByRole('tab', { name: 'Na fila da minha unidade: nenhum item' }),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'Comigo: 3 itens' }).click();
  await expect(page.getByRole('link', { name: '0012/2026' })).toBeVisible();
});

test('em 360 px: as linhas viram cartões, sem rolagem horizontal', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto(login());
  await expect(page.getByRole('link', { name: '0001/2026' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});
