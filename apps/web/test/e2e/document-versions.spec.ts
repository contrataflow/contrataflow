// E2E do SCR-106 (US-066): Versões do documento — salvar uma versão manual, ver a lista atualizada,
// comparar com a anterior e ver o que mudou, com axe-core em cada estado e a largura de 360 px. A
// API é simulada (support/mock-api.mjs); hash RFC 8785, imutabilidade, concorrência, POL-09 e o
// isolamento por tenant são cobertos nos testes da API (módulo `document` e suíte tenant leak).
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/a11y';

const VERSIONS_PATH =
  '/processos/0192a000-0000-7000-8000-0000000d0c00/documentos/0192a000-0000-7000-8000-0000000d0c01/versoes';

// As versões da API simulada são globais: os passos desta jornada rodam em série.
test.describe.configure({ mode: 'serial' });

async function openVersions(page: Page): Promise<void> {
  await page.goto(`/api/auth/login?as=ana&returnTo=${encodeURIComponent(VERSIONS_PATH)}`);
  await expect(page).toHaveURL(new RegExp(`${VERSIONS_PATH}$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Versões do documento' })).toBeVisible();
}

test('salva uma versão, lista e compara com a anterior', async ({ page }) => {
  await openVersions(page);
  const list = page.getByRole('list', { name: 'Versões do documento' });
  await expect(list.getByText('Versão 1', { exact: true })).toBeVisible();
  await expect(list.getByText('Primeira redação do objeto')).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'lista com uma versão');

  await page.getByRole('button', { name: 'Salvar versão' }).click();
  const dialog = page.getByRole('dialog', { name: 'Salvar versão' });
  const summary = dialog.getByLabel('Resumo da alteração (opcional)');
  await summary.fill('x'.repeat(501));
  await dialog.getByRole('button', { name: 'Salvar versão' }).click();
  await expect(dialog.getByText('O resumo deve ter no máximo 500 caracteres.')).toBeVisible();
  await summary.fill('Ajuste na justificativa');
  await expectNoSeriousA11yViolations(page, 'diálogo Salvar versão');
  await dialog.getByRole('button', { name: 'Salvar versão' }).click();

  await expect(page.getByText('Versão 2 salva').first()).toBeAttached();
  await expect(dialog).toBeHidden();
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await expect(list.getByRole('listitem').first()).toContainText('Ajuste na justificativa');

  await list.getByRole('button', { name: 'Comparar com a anterior (versão 2)' }).click();
  const diff = page.getByRole('region', { name: 'Comparação' });
  await expect(diff.getByText('OBJETO')).toBeVisible();
  await expect(diff.locator('[data-change="CHANGED"]')).toHaveText('Alterado');
  await expect(diff.locator('[data-change="UNCHANGED"]').first()).toHaveText('Sem alteração');
  await diff.getByText('Ver texto completo').click();
  await expect(
    diff.getByText('Aquisição de papel A4 reciclado para as secretarias.'),
  ).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'comparação de versões');
});

test('no celular (360 px) a comparação empilha e continua acessível', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await openVersions(page);
  await page
    .getByRole('list', { name: 'Versões do documento' })
    .getByRole('button', { name: 'Comparar com a anterior (versão 2)' })
    .click();
  await expect(page.getByRole('region', { name: 'Comparação' }).getByText('OBJETO')).toBeVisible();
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(overflows).toBe(false);
  await expectNoSeriousA11yViolations(page, 'comparação de versões em 360 px');
});
