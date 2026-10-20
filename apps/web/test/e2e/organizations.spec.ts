// E2E do SCR-032 (US-101): Administração › Estrutura › Órgãos — criar, editar e tentar inativar o
// órgão principal, com axe-core em cada estado. A API é simulada (support/mock-api.mjs); as regras
// de negócio e o isolamento por tenant são cobertos nos testes da API (módulo `tenancy` e suíte
// tenant leak).
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/a11y';

// O cadastro da API simulada é global: os passos desta jornada rodam em série.
test.describe.configure({ mode: 'serial' });

async function openScreen(page: Page): Promise<void> {
  await page.goto(`/api/auth/login?as=ana&returnTo=${encodeURIComponent('/admin/estrutura')}`);
  await expect(page).toHaveURL(/\/admin\/estrutura$/);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Estrutura organizacional' }),
  ).toBeVisible();
}

test('lista os órgãos com CNPJ mascarado e o selo "Principal", sem violações de acessibilidade', async ({
  page,
}) => {
  await openScreen(page);
  const principal = page.getByRole('row', { name: /Prefeitura Municipal de São José/ });
  await expect(principal.getByText('11.222.333/0001-81')).toBeVisible();
  await expect(principal.getByText('Principal')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Estrutura organizacional' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expectNoSeriousA11yViolations(page, 'órgãos');
});

test('cria um órgão com máscara no CNPJ e o vê na lista', async ({ page }) => {
  await openScreen(page);
  await page.getByRole('button', { name: 'Novo órgão' }).click();
  const dialog = page.getByRole('dialog', { name: 'Novo órgão' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Nome *')).toBeFocused();
  await dialog.getByLabel('Nome *').fill('Autarquia Municipal de Trânsito');
  await dialog.getByLabel('Sigla *').fill('amt');
  await dialog.getByLabel('CNPJ *').fill('45997418000153');
  await expect(dialog.getByLabel('CNPJ *')).toHaveValue('45.997.418/0001-53');
  await dialog.getByLabel('Tipo *').selectOption('AUTARCHY');
  await expectNoSeriousA11yViolations(page, 'novo órgão');

  await dialog.getByRole('button', { name: 'Salvar' }).click();
  await expect(
    page.getByText('Órgão Autarquia Municipal de Trânsito criado.', { exact: true }),
  ).toBeVisible();
  await expect(dialog).toBeHidden();
  const row = page.getByRole('row', { name: /Autarquia Municipal de Trânsito/ });
  await expect(row.getByText('AMT')).toBeVisible();
});

test('CNPJ com dígito verificador inválido: erro no campo e o formulário continua aberto', async ({
  page,
}) => {
  await openScreen(page);
  await page.getByRole('button', { name: 'Novo órgão' }).click();
  const dialog = page.getByRole('dialog', { name: 'Novo órgão' });
  await dialog.getByLabel('Nome *').fill('Fundo de Teste');
  await dialog.getByLabel('Sigla *').fill('FT');
  await dialog.getByLabel('CNPJ *').fill('11111111111100');
  await dialog.getByLabel('Tipo *').selectOption('FUND');
  await dialog.getByRole('button', { name: 'Salvar' }).click();
  await expect(dialog.getByText(/CNPJ válido|dígitos verificadores/).first()).toBeVisible();
  await expect(dialog).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'CNPJ inválido');
});

test('edita o telefone do órgão com If-Match', async ({ page }) => {
  await openScreen(page);
  await page.getByRole('button', { name: 'Editar Fundo Municipal de Saúde' }).click();
  const dialog = page.getByRole('dialog', { name: 'Editar Fundo Municipal de Saúde' });
  await dialog.getByLabel('Telefone').fill('4833810000');
  await dialog.getByRole('button', { name: 'Salvar' }).click();
  await expect(
    page.getByText('Órgão Fundo Municipal de Saúde atualizado.', { exact: true }),
  ).toBeVisible();
  await expect(dialog).toBeHidden();
});

test('inativar o órgão principal é bloqueado com explicação (RN-TEN-41)', async ({ page }) => {
  await openScreen(page);
  await page.getByRole('button', { name: 'Inativar Prefeitura Municipal de São José' }).click();
  const dialog = page.getByRole('dialog', { name: 'Inativar Prefeitura Municipal de São José?' });
  await dialog.getByRole('button', { name: 'Inativar' }).click();
  await expect(dialog.getByText('Ative outro órgão antes de inativar este.')).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'inativação bloqueada');
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(
    page
      .getByRole('row', { name: /Prefeitura Municipal de São José/ })
      .getByText('Ativo', { exact: true }),
  ).toBeVisible();
});
