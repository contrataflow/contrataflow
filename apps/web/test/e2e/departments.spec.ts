// E2E do SCR-032 (US-102): Administração › Estrutura › Secretarias — montar uma árvore de 3 níveis,
// mover por arrastar, desativar e tentar excluir unidade em uso, com axe-core nos estados. A API é
// simulada (support/mock-api.mjs); regras, ciclo, concorrência e isolamento por tenant são cobertos
// nos testes da API (módulo `organization` e suíte tenant leak).
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/a11y';

// A árvore da API simulada é global: os passos desta jornada rodam em série.
test.describe.configure({ mode: 'serial' });

async function openTab(page: Page): Promise<void> {
  await page.goto(`/api/auth/login?as=ana&returnTo=${encodeURIComponent('/admin/estrutura')}`);
  await expect(page).toHaveURL(/\/admin\/estrutura$/);
  await page.getByRole('tab', { name: 'Secretarias' }).click();
  await expect(page.getByRole('tree', { name: /Estrutura de/ })).toBeVisible();
}

async function createUnit(
  page: Page,
  options: { name: string; type: string; parent?: string },
): Promise<void> {
  if (options.parent) {
    await page.getByRole('button', { name: `Ações de ${options.parent}` }).click();
    await page.getByRole('button', { name: 'Nova subunidade' }).click();
  } else {
    await page.getByRole('button', { name: 'Nova unidade' }).click();
  }
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Tipo *').selectOption(options.type);
  await dialog.getByLabel('Nome *').fill(options.name);
  await dialog.getByRole('button', { name: 'Salvar' }).click();
  await expect(page.getByText(`Unidade ${options.name} criada.`, { exact: true })).toBeVisible();
  await expect(dialog).toBeHidden();
}

const item = (page: Page, name: string) =>
  page.getByRole('treeitem').filter({ hasText: name }).first();

test('monta uma árvore de 3 níveis sem violações de acessibilidade', async ({ page }) => {
  await openTab(page);
  await expectNoSeriousA11yViolations(page, 'árvore inicial');
  await createUnit(page, { name: 'Secretaria de Obras', type: 'SECRETARIAT' });
  await createUnit(page, {
    name: 'Departamento de Projetos',
    type: 'DEPARTMENT',
    parent: 'Secretaria de Obras',
  });
  await createUnit(page, {
    name: 'Setor de Topografia',
    type: 'SECTOR',
    parent: 'Departamento de Projetos',
  });
  await expect(item(page, 'Setor de Topografia')).toHaveAttribute('aria-level', '3');
  await expectNoSeriousA11yViolations(page, 'árvore com 3 níveis');
});

test('move uma unidade arrastando para outra secretaria', async ({ page }) => {
  await openTab(page);
  await item(page, 'Setor de Topografia').dragTo(item(page, 'Gabinete'));
  await expect(
    page.getByText('Unidade Setor de Topografia movida.', { exact: true }),
  ).toBeVisible();
  await expect(item(page, 'Setor de Topografia')).toHaveAttribute('aria-level', '2');
});

test('desativa uma unidade e não consegue excluir a que está em uso', async ({ page }) => {
  await openTab(page);
  await page.getByRole('button', { name: 'Ações de Departamento de Projetos' }).click();
  await page.getByRole('button', { name: 'Desativar' }).click();
  const confirm = page.getByRole('dialog', { name: 'Desativar Departamento de Projetos?' });
  await confirm.getByRole('button', { name: 'Desativar' }).click();
  await expect(
    page.getByText('Unidade Departamento de Projetos desativada.', { exact: true }),
  ).toBeVisible();
  await expect(item(page, 'Departamento de Projetos')).toContainText('Inativa');

  await page.getByRole('button', { name: 'Ações de Gabinete' }).click();
  await page.getByRole('button', { name: 'Excluir' }).click();
  const dialog = page.getByRole('dialog', { name: 'Excluir Gabinete?' });
  await dialog.getByRole('button', { name: 'Excluir' }).click();
  await expect(
    dialog.getByText('Esta unidade está em uso. Desative-a em vez de excluir.'),
  ).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Desativar' })).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'exclusão bloqueada');
});
