// E2E do SCR-107 (US-025): Fornecedores — cadastrar (CNPJ e CPF mascarado), editar, inativar e
// tentar o cadastro duplicado, com axe-core em cada estado. A API é simulada (support/mock-api.mjs);
// as regras de negócio (dígito verificador, criptografia do CPF, exclusão de fornecedor em uso) e o
// isolamento por tenant são cobertos nos testes da API (módulo `supplier` e suíte tenant leak).
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/a11y';
import { refetchOf } from './support/refetch';

// O cadastro da API simulada é global: os passos desta jornada rodam em série.
test.describe.configure({ mode: 'serial' });

/** Ação da linha no menu ⋯ (prd-5 · regra 3). */
async function rowAction(page: Page, name: string, action: string): Promise<void> {
  await page.getByRole('button', { name: `Ações de ${name}` }).click();
  await page.getByRole('menuitem', { name: action }).click();
}

async function openScreen(page: Page): Promise<void> {
  await page.goto(`/api/auth/login?as=ana&returnTo=${encodeURIComponent('/fornecedores')}`);
  await expect(page).toHaveURL(/\/fornecedores$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Fornecedores' })).toBeVisible();
}

test('lista os fornecedores com CNPJ mascarado e CPF mascarado, sem violações de acessibilidade', async ({
  page,
}) => {
  await openScreen(page);
  const abc = page.getByRole('row', { name: /Construtora ABC Ltda/ });
  await expect(abc.getByText('11.222.333/0001-81')).toBeVisible();
  const joao = page.getByRole('row', { name: /João da Silva/ });
  await expect(joao.getByText('***.444.777-**')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Fornecedores' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expectNoSeriousA11yViolations(page, 'fornecedores');
});

test('cadastra um fornecedor com CNPJ e o vê na lista', async ({ page }) => {
  await openScreen(page);
  await page.getByRole('button', { name: 'Novo fornecedor' }).click();
  const dialog = page.getByRole('dialog', { name: 'Novo fornecedor' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Número do documento *').fill('45997418000153');
  await expect(dialog.getByLabel('Número do documento *')).toHaveValue('45.997.418/0001-53');
  await dialog.getByLabel('Razão social / Nome *').fill('Papelaria Central Ltda');
  await expectNoSeriousA11yViolations(page, 'novo fornecedor');

  await dialog.getByRole('button', { name: 'Salvar' }).click();
  await expect(
    page.getByText('Fornecedor Papelaria Central Ltda cadastrado.', { exact: true }),
  ).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('row', { name: /Papelaria Central Ltda/ })).toBeVisible();
});

test('CPF: máscara própria e, depois de salvo, aparece mascarado', async ({ page }) => {
  await openScreen(page);
  await page.getByRole('button', { name: 'Novo fornecedor' }).click();
  const dialog = page.getByRole('dialog', { name: 'Novo fornecedor' });
  await dialog.getByRole('combobox', { name: 'Tipo de documento *' }).click();
  await page.getByRole('option', { name: 'CPF' }).click();
  await dialog.getByLabel('Número do documento *').fill('52998224725');
  await expect(dialog.getByLabel('Número do documento *')).toHaveValue('529.982.247-25');
  await dialog.getByLabel('Razão social / Nome *').fill('Maria Souza');
  await dialog.getByRole('button', { name: 'Salvar' }).click();
  await expect(dialog).toBeHidden();
  const row = page.getByRole('row', { name: /Maria Souza/ });
  await expect(row.getByText('***.982.247-**')).toBeVisible();
  await expect(page.getByText('52998224725')).toHaveCount(0);
});

test('CNPJ com dígito verificador inválido: erro no campo e o formulário continua aberto', async ({
  page,
}) => {
  await openScreen(page);
  await page.getByRole('button', { name: 'Novo fornecedor' }).click();
  const dialog = page.getByRole('dialog', { name: 'Novo fornecedor' });
  await dialog.getByLabel('Número do documento *').fill('11222333000100');
  await dialog.getByLabel('Razão social / Nome *').fill('Inválida Ltda');
  await expect(
    dialog.getByText('CNPJ inválido. Verifique o número digitado.').first(),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Salvar' }).click();
  await expect(dialog).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'CNPJ inválido');
});

test('documento já cadastrado: aviso antecipado com o nome do fornecedor existente', async ({
  page,
}) => {
  await openScreen(page);
  await page.getByRole('button', { name: 'Novo fornecedor' }).click();
  const dialog = page.getByRole('dialog', { name: 'Novo fornecedor' });
  await dialog.getByLabel('Número do documento *').fill('11222333000181');
  await dialog.getByLabel('Razão social / Nome *').click();
  await expect(
    dialog.getByText('Este documento já está cadastrado para Construtora ABC Ltda.'),
  ).toBeVisible();
  await expect(
    dialog.getByText('Já existe um fornecedor cadastrado com este documento.'),
  ).toBeVisible();
});

test('edita o telefone com o documento bloqueado e inativa o fornecedor', async ({ page }) => {
  await openScreen(page);
  await rowAction(page, 'Construtora ABC Ltda', 'Editar');
  const dialog = page.getByRole('dialog', { name: 'Editar Construtora ABC Ltda' });
  await expect(dialog.getByLabel('Número do documento *')).toHaveAttribute('readonly', '');
  await expect(dialog.getByRole('combobox', { name: 'Tipo de documento *' })).toBeDisabled();
  await dialog.getByLabel('Telefone').fill('4833810000');
  const listRefetched = refetchOf(page, {
    mutation: /^\/api\/v1\/suppliers\/[0-9a-f-]{36}$/,
    refetch: /^\/api\/v1\/suppliers$/,
  });
  await dialog.getByRole('button', { name: 'Salvar' }).click();
  await expect(
    page.getByText('Fornecedor Construtora ABC Ltda atualizado.', { exact: true }),
  ).toBeVisible();
  await listRefetched;

  await rowAction(page, 'Construtora ABC Ltda', 'Inativar');
  const confirm = page.getByRole('dialog', { name: 'Inativar Construtora ABC Ltda?' });
  await expectNoSeriousA11yViolations(page, 'inativar fornecedor');
  await confirm.getByRole('button', { name: 'Inativar' }).click();
  await expect(
    page.getByText('Fornecedor Construtora ABC Ltda inativado.', { exact: true }),
  ).toBeVisible();
  const row = page.getByRole('row', { name: /Construtora ABC Ltda/ });
  await expect(row.getByText('Inativo')).toBeVisible();
  await page.getByRole('button', { name: 'Ações de Construtora ABC Ltda' }).click();
  await expect(page.getByRole('menuitem', { name: 'Reativar' })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('filtra por situação e busca por razão social', async ({ page }) => {
  await openScreen(page);
  // Logo após o login o HTML do SSR ainda pode estar no DOM, oculto (<div hidden id="S:0">).
  await page.getByRole('button', { name: 'Filtros' }).filter({ visible: true }).click();
  await page.getByRole('combobox', { name: 'Situação' }).click();
  await page.getByRole('option', { name: 'Inativos' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('row', { name: /Acme GmbH/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /João da Silva/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Remover o filtro Situação: Inativos' }).click();
  await page.getByLabel('Buscar', { exact: true }).fill('acme');
  await expect(page.getByRole('row', { name: /Acme GmbH/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /João da Silva/ })).toHaveCount(0);
});
