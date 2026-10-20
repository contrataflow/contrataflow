// E2E do ETP (US-019 · SCR-006 e SCR-008): a partir do painel do processo, a planejadora abre o
// diálogo "Criar ETP", vê o cartão "Importar dados do DFD 0005/2026?" pré-marcado (objeto, itens e
// situação no PCA), cria o ETP e cai na SCR-008 com o foco no título; num processo que já tem o ETP,
// o painel oferece "Abrir ETP" no lugar de "Criar ETP" (FA-03). axe-core no diálogo e o diálogo
// legível em 360 px. A API é simulada (support/mock-api.mjs); a importação (seções, itens, PCA), a
// atomicidade, POL-02 e o isolamento por tenant são cobertos nos testes da API (módulo `etp` e suíte
// tenant leak).
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/a11y';

/** Processo 0027/2026 da API simulada: DFD 0005/2026 finalizado, sem ETP. */
const CREATE_PROCESS_PATH = '/processos/0192a000-0000-7000-8000-000000100027';
/** Processo 0028/2026: já tem o ETP 0002/2026 (FA-03). */
const EXISTING_PROCESS_PATH = '/processos/0192a000-0000-7000-8000-000000100028';
const ETP_PATH = /\/processos\/[0-9a-f-]{36}\/etp\/[0-9a-f-]{36}$/;

async function openProcess(page: Page, path: string, title: string): Promise<void> {
  await page.goto(`/api/auth/login?as=ana&returnTo=${encodeURIComponent(path)}`);
  await expect(page).toHaveURL(new RegExp(`${path}$`));
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
}

function hasHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
}

test('criar o ETP importando o DFD a partir do painel e abrir a SCR-008', async ({ page }) => {
  await openProcess(page, CREATE_PROCESS_PATH, 'Manutenção predial preventiva das escolas');

  await page.getByRole('button', { name: 'Criar ETP' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Criar Estudo Técnico Preliminar' });
  await expect(
    dialog.getByRole('heading', { name: 'Importar dados do DFD 0005/2026?' }),
  ).toBeVisible();
  await expect(
    dialog.getByText('Manutenção predial preventiva das escolas municipais'),
  ).toBeVisible();
  await expect(dialog.getByText('2 itens')).toBeVisible();
  await expect(dialog.getByText('Previsto no PCA')).toBeVisible();
  await expect(dialog.getByRole('checkbox', { name: 'Importar dados do DFD' })).toBeChecked();
  await expectNoSeriousA11yViolations(page, 'diálogo Criar ETP (cartão de importação)');

  await dialog.getByRole('button', { name: 'Criar ETP' }).click();

  await expect(page).toHaveURL(ETP_PATH);
  const heading = page.getByRole('heading', {
    level: 1,
    name: 'Estudo Técnico Preliminar — 0027/2026',
  });
  await expect(heading).toBeVisible();
  await expect(heading).toBeFocused();
  await expect(page.getByText('ETP 0001/2026').first()).toBeVisible();
});

test('FA-03: com ETP ativo o painel oferece "Abrir ETP" e não "Criar ETP"', async ({ page }) => {
  await openProcess(page, EXISTING_PROCESS_PATH, 'Reforma da quadra poliesportiva');
  const open = page.getByRole('link', { name: 'Abrir ETP 0002/2026' });
  await expect(open).toBeVisible();
  await expect(page.getByRole('button', { name: 'Criar ETP' })).toHaveCount(0);
  await open.click();
  await expect(page).toHaveURL(ETP_PATH);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Estudo Técnico Preliminar — 0028/2026' }),
  ).toBeVisible();
});

test('o diálogo "Criar ETP" é legível em 360 px', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await openProcess(page, CREATE_PROCESS_PATH, 'Manutenção predial preventiva das escolas');
  await page.getByRole('button', { name: 'Criar ETP' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Criar Estudo Técnico Preliminar' });
  await expect(dialog.getByRole('checkbox', { name: 'Importar dados do DFD' })).toBeVisible();
  expect(await hasHorizontalOverflow(page)).toBe(false);
});
