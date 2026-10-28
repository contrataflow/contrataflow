// E2E da aba "Registros" de SCR-037 (US-075): Ana (AUDIT_VIEW e AUDIT_EXPORT na Prefeitura A)
// filtra a trilha, abre o detalhe com o diff mascarado e exporta o CSV — o arquivo baixado traz o
// valor "=SOMA(...)" escapado com apóstrofo (RN-AUD-20). axe-core na lista e no detalhe; em 360 px a
// página não rola na horizontal. A API é simulada (support/mock-api.mjs); filtros, limites,
// isolamento por tenant e o escape real são cobertos nos testes da API.
import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/a11y';

async function openRecords(page: Page): Promise<void> {
  await page.goto(`/api/auth/login?as=ana&returnTo=${encodeURIComponent('/auditoria')}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Auditoria' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Registros', selected: true })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Registros da trilha de auditoria' })).toBeVisible();
}

test('filtrar → ver detalhe → exportar CSV com fórmulas neutralizadas', async ({ page }) => {
  await openRecords(page);
  const table = page.getByRole('table', { name: 'Registros da trilha de auditoria' });
  await expect(table.getByRole('row')).toHaveCount(4); // cabeçalho + 3 registros
  await expectNoSeriousA11yViolations(page, 'aba Registros');

  // Filtrar por ação.
  await page.getByLabel('Ação', { exact: true }).selectOption(['process.create']);
  await page.getByRole('button', { name: 'Pesquisar' }).click();
  await expect(table.getByRole('row')).toHaveCount(2);

  // Detalhe com o diff mascarado.
  await table.getByRole('button', { name: /Ver detalhe: Processo criado/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Registro de auditoria' });
  const diff = dialog.getByRole('table', { name: 'Alterações do registro (antes e depois)' });
  await expect(diff).toContainText('***.456.789-**');
  await expect(diff).toContainText('Conteúdo resumido: 800 caracteres');
  await expectNoSeriousA11yViolations(page, 'detalhe do registro');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // Exportar todos os registros do período em CSV.
  await page.getByRole('button', { name: 'Limpar filtros' }).click();
  await page.getByRole('button', { name: 'Pesquisar' }).click();
  await expect(table.getByRole('row')).toHaveCount(4);
  await page.getByRole('button', { name: 'Exportar' }).click();
  const exportDialog = page.getByRole('dialog', { name: 'Exportar registros' });
  await expect(exportDialog.getByRole('radio', { name: 'CSV (planilha)' })).toBeChecked();
  const downloadPromise = page.waitForEvent('download');
  await exportDialog.getByRole('button', { name: 'Exportar' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('auditoria.csv');
  const content = await readFile(await download.path(), 'utf8');
  expect(content).toContain(",'=SOMA(1;2),");
  expect(content).not.toMatch(/,=SOMA/);
  await expect(page.getByText('Exportação concluída: 3 registros', { exact: true })).toBeVisible();
});

test('em 360 px: a página não rola na horizontal e a tabela mostra data, ação e resultado', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await openRecords(page);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  const table = page.getByRole('table', { name: 'Registros da trilha de auditoria' });
  await expect(table.getByRole('columnheader', { name: 'Data/hora' })).toBeVisible();
  await expect(table.getByRole('columnheader', { name: 'Ação' })).toBeVisible();
  await expect(table.getByRole('columnheader', { name: 'Resultado' })).toBeVisible();
  await expect(table.getByRole('columnheader', { name: 'Ator' })).toBeHidden();
  await expectNoSeriousA11yViolations(page, 'aba Registros · 360 px');
});
