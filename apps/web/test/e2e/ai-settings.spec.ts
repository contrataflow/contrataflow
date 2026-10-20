// E2E do SCR-041, seção "Inteligência artificial" (US-116): o administrador liga a IA aceitando os
// termos da versão vigente, ajusta os limites, acompanha o consumo do mês e desliga com
// confirmação — com axe-core na seção e no diálogo. A API é simulada (support/mock-api.mjs); a
// reserva de tokens, os limites no AI-01, os avisos de 80%/100% e o isolamento por tenant são
// cobertos nos testes da API (módulo `ai` e suíte tenant leak).
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/a11y';

// As configurações da API simulada são globais: os passos desta jornada rodam em série.
test.describe.configure({ mode: 'serial' });

async function openAiSection(page: Page): Promise<void> {
  await page.goto(`/api/auth/login?as=ana&returnTo=${encodeURIComponent('/admin/configuracoes')}`);
  await expect(page).toHaveURL(/\/admin\/configuracoes$/);
  await page.getByRole('tab', { name: 'Inteligência artificial' }).click();
  await expect(page.getByRole('switch', { name: 'Usar IA neste órgão' })).toBeVisible();
}

test('liga a IA aceitando os termos de uso; "Ativar" só com o aceite', async ({ page }) => {
  await openAiSection(page);
  const toggle = page.getByRole('switch', { name: 'Usar IA neste órgão' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByText('Os termos de uso ainda não foram aceitos.')).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'seção de IA');

  await toggle.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Termos de uso da inteligência artificial')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Ativar' })).toBeDisabled();
  await expectNoSeriousA11yViolations(page, 'termos de uso da IA');
  await dialog.getByLabel('Li e aceito os termos de uso da versão 2026-10').check();
  await dialog.getByRole('button', { name: 'Ativar' }).click();

  await expect(page.getByText('Configuração salva', { exact: true })).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText('Termos de uso aceitos: versão 2026-10.')).toBeVisible();
});

test('ajusta o limite diário e acompanha o consumo do mês', async ({ page }) => {
  await openAiSection(page);
  await expect(page.getByRole('progressbar', { name: /do limite usado/ })).toBeVisible();
  await expect(page.getByText('Custo estimado: US$ 0.050000')).toBeVisible();

  const daily = page.getByLabel('Pedidos por usuário por dia');
  await daily.fill('501');
  await expect(page.getByText('Informe de 1 a 500 pedidos por dia.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Salvar limites' })).toBeDisabled();
  await daily.fill('20');
  await page.getByRole('button', { name: 'Salvar limites' }).click();
  await expect(page.getByText('Configuração salva', { exact: true })).toBeVisible();

  await page.reload();
  await page.getByRole('tab', { name: 'Inteligência artificial' }).click();
  await expect(page.getByLabel('Pedidos por usuário por dia')).toHaveValue('20');
});

test('desliga a IA com confirmação', async ({ page }) => {
  await openAiSection(page);
  const toggle = page.getByRole('switch', { name: 'Usar IA neste órgão' });
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await toggle.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Desligar a IA neste órgão?')).toBeVisible();
  await dialog.getByRole('button', { name: 'Desligar' }).click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
});
