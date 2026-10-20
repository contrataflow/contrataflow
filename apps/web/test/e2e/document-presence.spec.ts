// E2E do indicador de edição concorrente (US-070 · SCR-105): duas sessões (Ana e Lúcia) abrem o
// mesmo ofício; quem chega vê quem já estava no primeiro heartbeat, e quem já estava vê quem chegou
// em até 20 s (um ciclo) — com o destaque "está editando esta seção agora". Ao fechar a aba de
// Lúcia, Ana deixa de vê-la (DOC-25 de saída ou, no pior caso, TTL de 60 s + um ciclo). axe-core
// com o indicador visível. A API é simulada (support/mock-api.mjs); Redis, TTL real, POL-02 e o
// isolamento por tenant são cobertos nos testes da API (módulo `document` e suíte tenant leak).
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/a11y';

/** Processo 0036/2026 da API simulada: o Ofício (livre) no menu "Criar documento". */
const PROCESS_PATH = '/processos/0192a000-0000-7000-8000-000000100036';
const DOCUMENT_PATH = /\/processos\/[0-9a-f-]{36}\/documentos\/[0-9a-f-]{36}$/;
const SAME_SECTION = (name: string) => `${name} está editando esta seção agora`;

test.describe.configure({ mode: 'serial' });

async function createOficio(page: Page, title: string): Promise<string> {
  const path = `${PROCESS_PATH}?aba=documentos`;
  await page.goto(`/api/auth/login?as=ana&returnTo=${encodeURIComponent(path)}`);
  await page.getByRole('button', { name: 'Criar documento' }).first().click();
  await page.getByRole('menuitem', { name: 'Ofício' }).click();
  const dialog = page.getByRole('dialog', { name: 'Novo documento: Ofício' });
  await dialog.getByLabel('Título').fill(title);
  await dialog.getByRole('button', { name: 'Criar e redigir' }).click();
  await expect(page).toHaveURL(DOCUMENT_PATH);
  return new URL(page.url()).pathname;
}

test('duas sessões no mesmo documento se veem em até 20 s; ao fechar a aba, o editor some', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const anaContext = await browser.newContext();
  const luciaContext = await browser.newContext();
  try {
    const ana = await anaContext.newPage();
    const documentPath = await createOficio(ana, 'Ofício com duas redatoras');
    await expect(ana.getByLabel('Texto da seção Conteúdo do ofício')).toBeVisible();

    const lucia = await luciaContext.newPage();
    await lucia.goto(`/api/auth/login?as=lucia&returnTo=${encodeURIComponent(documentPath)}`);
    await expect(lucia.getByLabel('Texto da seção Conteúdo do ofício')).toBeVisible();

    // Lúcia chega e já vê Ana no primeiro heartbeat; Ana vê Lúcia no próximo ciclo (≤ 20 s).
    await expect(lucia.getByText(SAME_SECTION('Ana Souza'))).toBeVisible({ timeout: 10_000 });
    // O heartbeat só bate com a aba em foco (US-070): a Ana volta para a frente, como quem
    // retoma a própria janela, e o próximo batimento já traz a Lúcia.
    await ana.bringToFront();
    await expect(ana.getByText(SAME_SECTION('Lúcia Matos'))).toBeVisible({ timeout: 25_000 });
    const indicator = ana.getByRole('region', { name: 'Outras pessoas editando este documento' });
    await expect(indicator).toContainText('Lúcia Matos');
    await expect(indicator).toContainText('Conteúdo do ofício');
    await expectNoSeriousA11yViolations(ana, 'editor com o indicador de presença');

    // A edição continua normal com o indicador visível (RN-DOC-94: só informativo).
    await ana.getByLabel('Texto da seção Conteúdo do ofício').fill('Texto da Ana.');
    await expect(ana.getByText(/^Salvo às \d{2}:\d{2}$/)).toBeVisible();

    await lucia.close();
    await expect(indicator).toBeHidden({ timeout: 85_000 });
  } finally {
    await anaContext.close();
    await luciaContext.close();
  }
});
