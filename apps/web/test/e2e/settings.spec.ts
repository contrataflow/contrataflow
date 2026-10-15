// E2E do SCR-041 (US-103): Administração › Configurações — alterar um rótulo, salvar com a versão
// da chave e ver o valor depois de recarregar, com axe-core em cada estado. A API é simulada
// (support/mock-api.mjs); validação por schema, concorrência por chave e isolamento por tenant são
// cobertos nos testes da API (módulo `tenancy` e suíte tenant leak).
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/a11y';

// As configurações da API simulada são globais: os passos desta jornada rodam em série.
test.describe.configure({ mode: 'serial' });

async function openScreen(page: Page): Promise<void> {
  await page.goto(`/api/auth/login?as=ana&returnTo=${encodeURIComponent('/admin/configuracoes')}`);
  await expect(page).toHaveURL(/\/admin\/configuracoes$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Configurações gerais' })).toBeVisible();
}

test('lista os grupos e os campos da aba Identidade, sem violações de acessibilidade', async ({
  page,
}) => {
  await openScreen(page);
  await expect(page.getByRole('tab', { name: 'Identidade' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByLabel('Nome do nível de unidade requisitante')).toHaveValue('Secretaria');
  await expect(page.getByRole('link', { name: 'Configurações' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expectNoSeriousA11yViolations(page, 'configurações');
});

test('altera o rótulo de secretaria, salva e o valor persiste após recarregar', async ({
  page,
}) => {
  await openScreen(page);
  const field = page.getByLabel('Nome do nível de unidade requisitante');
  await field.fill('Diretoria');
  await expect(page.getByText('1 alteração pendente')).toBeVisible();
  await page.getByRole('button', { name: 'Salvar' }).click();
  await expect(page.getByText('Configurações salvas.', { exact: true })).toBeVisible();
  await expect(page.getByText('Nenhuma alteração pendente')).toBeVisible();

  await page.reload();
  await expect(page.getByLabel('Nome do nível de unidade requisitante')).toHaveValue('Diretoria');
});

test('máscara de numeração sem {year}: erro inline e "Salvar" desabilitado', async ({ page }) => {
  await openScreen(page);
  await page.getByRole('tab', { name: 'Numeração' }).click();
  await page.getByLabel('Máscara do número do processo').fill('PROC-{seq:4}');
  await expect(page.getByText('A máscara deve conter {seq:N} e {year}.')).toBeVisible();
  await expect(page.getByText('Efeito a partir do próximo número')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Salvar' })).toBeDisabled();
  await expectNoSeriousA11yViolations(page, 'numeração');
});
