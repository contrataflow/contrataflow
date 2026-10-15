// E2E do SCR-109 (US-104): Administração › Catálogos — criar, editar, desativar e reordenar itens
// (inclusive pelo teclado), com axe-core em cada estado. A API é simulada (support/mock-api.mjs);
// validação de metadata por tipo, unicidade do código, concorrência e isolamento por tenant são
// cobertos nos testes da API (módulo `catalog` e suíte tenant leak).
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/a11y';

// Os itens da API simulada são globais: os passos desta jornada rodam em série.
test.describe.configure({ mode: 'serial' });

async function openScreen(page: Page): Promise<void> {
  await page.goto(`/api/auth/login?as=ana&returnTo=${encodeURIComponent('/admin/catalogos')}`);
  await expect(page).toHaveURL(/\/admin\/catalogos$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Catálogos' })).toBeVisible();
  await page.getByRole('tab', { name: 'Modalidades' }).click();
  await expect(page.getByRole('table', { name: 'Itens do catálogo Modalidades' })).toBeVisible();
}

test('lista as modalidades com o selo "Padrão do sistema", sem violações de acessibilidade', async ({
  page,
}) => {
  await openScreen(page);
  const pregao = page.getByRole('row', { name: /Pregão/ });
  await expect(pregao.getByText('Padrão do sistema')).toBeVisible();
  await expect(pregao.getByText('Ativo')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Catálogos' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByRole('button', { name: /excluir/i })).toHaveCount(0);
  await expectNoSeriousA11yViolations(page, 'catálogos');
});

test('cria um item com os campos específicos da modalidade e o vê na lista', async ({ page }) => {
  await openScreen(page);
  await page.getByRole('button', { name: 'Novo item' }).click();
  const dialog = page.getByRole('dialog', { name: 'Novo item — Modalidades' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Código *')).toBeFocused();
  await dialog.getByLabel('Código *').fill('REGISTRO_PRECOS');
  await dialog.getByLabel('Rótulo *').fill('Registro de preços');
  await dialog.getByLabel('Base legal *').fill('Lei 14.133/2021, art. 82');
  await expectNoSeriousA11yViolations(page, 'novo item');
  await dialog.getByRole('button', { name: 'Salvar' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('row', { name: /Registro de preços/ })).toBeVisible();
});

test('código fora do padrão: erro inline e nada é criado', async ({ page }) => {
  await openScreen(page);
  await page.getByRole('button', { name: 'Novo item' }).click();
  const dialog = page.getByRole('dialog', { name: 'Novo item — Modalidades' });
  await dialog.getByLabel('Código *').fill('servico novo');
  await dialog.getByLabel('Rótulo *').fill('Serviço novo');
  await dialog.getByLabel('Base legal *').fill('art. 1');
  await dialog.getByRole('button', { name: 'Salvar' }).click();
  await expect(
    dialog.getByText(
      'Use letras maiúsculas, números e sublinhado, sem repetir um código existente.',
    ),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(page.getByRole('row', { name: /Serviço novo/ })).toHaveCount(0);
});

test('edita o rótulo de um item de sistema com o código bloqueado', async ({ page }) => {
  await openScreen(page);
  await page.getByRole('button', { name: 'Editar Concorrência' }).click();
  const dialog = page.getByRole('dialog', { name: 'Editar Concorrência' });
  await expect(dialog.getByLabel('Código *')).toHaveAttribute('readonly', '');
  await dialog.getByLabel('Rótulo *').fill('Concorrência eletrônica');
  await dialog.getByRole('button', { name: 'Salvar' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('row', { name: /Concorrência eletrônica/ })).toBeVisible();
});

test('desativa um item com o aviso de que registros existentes não são afetados e o reativa', async ({
  page,
}) => {
  await openScreen(page);
  await page.getByRole('button', { name: 'Desativar Dispensa de licitação' }).click();
  const dialog = page.getByRole('dialog', { name: 'Desativar Dispensa de licitação?' });
  await expect(
    dialog.getByText(
      'Este item deixará de aparecer em novas seleções; registros existentes não são afetados.',
    ),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Desativar' }).click();
  const row = page.getByRole('row', { name: /Dispensa de licitação/ });
  await expect(row.getByText('Inativo')).toBeVisible();
  await row.getByRole('button', { name: 'Ativar Dispensa de licitação' }).click();
  await expect(row.getByText('Ativo', { exact: true })).toBeVisible();
});

test('reordena pelo teclado ("Mover para baixo") e a nova ordem persiste após recarregar', async ({
  page,
}) => {
  await openScreen(page);
  const labels = () => page.getByRole('rowheader').allTextContents();
  const before = await labels();
  await page.getByRole('button', { name: `Mover ${before[0] ?? ''} para baixo` }).focus();
  await page.keyboard.press('Enter');
  await expect.poll(labels).toEqual([before[1], before[0], ...before.slice(2)]);

  await page.reload();
  await page.getByRole('tab', { name: 'Modalidades' }).click();
  await expect(page.getByRole('table', { name: 'Itens do catálogo Modalidades' })).toBeVisible();
  expect(await labels()).toEqual([before[1], before[0], ...before.slice(2)]);
  await expectNoSeriousA11yViolations(page, 'catálogos reordenados');
});
