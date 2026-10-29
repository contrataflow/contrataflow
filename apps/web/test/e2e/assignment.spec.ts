// E2E da atribuição de responsável (US-050 · SCR-115 sobre SCR-006): a gestora atribui o processo
// que está na fila da unidade (motivo opcional), reatribui a outra pessoa da equipe com o motivo
// obrigatório e devolve o processo à fila. axe-core no diálogo e o diálogo em tela cheia a 360 px.
// A API é simulada (support/mock-api.mjs); POL-05, elegibilidade, concorrência e outro tenant são
// cobertos nos testes da API.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/a11y';
import { refetchOf } from './support/refetch';

/** POST de atribuição (PRC-22) e a releitura do processo, de onde o diálogo tira o If-Match. */
const ASSIGNED = {
  mutation: /^\/api\/v1\/processes\/[0-9a-f-]{36}\/assign$/,
  refetch: /^\/api\/v1\/processes\/[0-9a-f-]{36}$/,
};

// A atribuição da API simulada é global: os passos desta jornada rodam em série.
test.describe.configure({ mode: 'serial' });

/** Processo 0094/2026 da API simulada (`listProcessId(94)`, na fila da unidade). */
const PROCESS_PATH = '/processos/0192a000-0000-7000-8000-000000100094';

async function openAssignDialog(page: Page) {
  await page.goto(`/api/auth/login?as=ana&returnTo=${encodeURIComponent(PROCESS_PATH)}`);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Aquisição de material de expediente' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Mais ações do processo' }).click();
  await page.getByRole('menuitem', { name: 'Atribuir responsável' }).click();
}

test('atribuir da fila, reatribuir com motivo e devolver à fila da unidade', async ({ page }) => {
  // 1. Primeira atribuição a partir da fila: motivo opcional.
  await openAssignDialog(page);
  const first = page.getByRole('dialog', { name: 'Atribuir responsável' });
  await expect(first.getByLabel('Novo responsável')).toBeFocused();
  await expectNoSeriousA11yViolations(page, 'diálogo Atribuir responsável');
  await first.getByRole('combobox', { name: 'Novo responsável' }).click();
  await page.getByRole('option', { name: 'Juliana Prado' }).click();
  let processRefetched = refetchOf(page, ASSIGNED);
  await first.getByRole('button', { name: 'Atribuir' }).click();
  await expect(first).toBeHidden();
  await expect(
    page.getByText('Processo atribuído a Juliana Prado.', { exact: true }),
  ).toBeVisible();
  await processRefetched;

  // 2. Reatribuição: motivo obrigatório (V-02 no front) e a pessoa atual fora da lista.
  await page.getByRole('button', { name: 'Mais ações do processo' }).click();
  await page.getByRole('menuitem', { name: 'Atribuir responsável' }).click();
  const second = page.getByRole('dialog', { name: 'Reatribuir responsável' });
  await second.getByRole('combobox', { name: 'Novo responsável' }).click();
  await expect(page.getByRole('option', { name: 'Juliana Prado' })).toHaveCount(0);
  await page.getByRole('option', { name: 'Tiago Reis' }).click();
  await second.getByRole('button', { name: 'Atribuir' }).click();
  await expect(second.getByText('Informe o motivo da troca de responsável.')).toBeVisible();
  await second.getByLabel('Motivo').fill('Juliana está de férias');
  processRefetched = refetchOf(page, ASSIGNED);
  await second.getByRole('button', { name: 'Atribuir' }).click();
  await expect(second).toBeHidden();
  await expect(page.getByText('Processo atribuído a Tiago Reis.', { exact: true })).toBeVisible();
  await processRefetched;

  // 3. Remover o responsável: o processo volta para a fila da unidade.
  await page.getByRole('button', { name: 'Mais ações do processo' }).click();
  await page.getByRole('menuitem', { name: 'Atribuir responsável' }).click();
  const third = page.getByRole('dialog', { name: 'Reatribuir responsável' });
  await third.getByRole('combobox', { name: 'Novo responsável' }).click();
  await page.getByRole('option', { name: 'Deixar na fila da unidade' }).click();
  await third.getByLabel('Motivo').fill('Redistribuir na equipe');
  await third.getByRole('button', { name: 'Atribuir' }).click();
  await expect(third).toBeHidden();
  await expect(
    page.getByText('Processo devolvido para a fila da unidade.', { exact: true }),
  ).toBeVisible();
});

test('em 360 px: o diálogo de atribuição ocupa a tela, sem rolagem horizontal', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await openAssignDialog(page);
  const dialog = page.getByRole('dialog', { name: /responsável$/ });
  await expect(dialog.getByLabel('Novo responsável')).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(359);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});
