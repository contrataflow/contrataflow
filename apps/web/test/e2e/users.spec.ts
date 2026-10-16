// E2E do SCR-029 (US-091): convidar usuário → convite pendente listado → reenviar → cancelar, a
// sugestão de reenvio quando a pessoa já tem vínculo e axe-core na lista e no formulário. A API é
// simulada (support/mock-api.mjs): Ana tem USER_VIEW/USER_INVITE/ROLE_VIEW. Regras de convite e
// isolamento por tenant: testes da API (módulo `identity` e suíte tenant leak).
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/a11y';

// O cadastro da API simulada é global: os passos desta jornada rodam em série.
test.describe.configure({ mode: 'serial' });

async function openList(page: Page): Promise<void> {
  await page.goto(`/api/auth/login?as=ana&returnTo=${encodeURIComponent('/admin/usuarios')}`);
  await expect(page).toHaveURL(/\/admin\/usuarios$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Usuários' })).toBeVisible();
}

test('lista vazia de convites pendentes; sem violações de acessibilidade', async ({ page }) => {
  await openList(page);
  await expect(page.getByText('Nenhum convite pendente')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Convidar usuário' })).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'convites pendentes (vazio)');
});

test('convida um usuário interno e o convite aparece na lista pendente', async ({ page }) => {
  await openList(page);
  await page.getByRole('button', { name: 'Convidar usuário' }).click();
  const dialog = page.getByRole('dialog', { name: 'Convidar usuário' });
  await expect(dialog.getByLabel('E-mail *')).toBeFocused();

  // Validação no cliente: o foco vai ao primeiro campo com erro.
  await dialog.getByLabel('E-mail *').fill('sem-arroba');
  await dialog.getByRole('button', { name: 'Enviar convite' }).click();
  await expect(dialog.getByText('Informe um e-mail válido.')).toBeVisible();
  await expect(dialog.getByLabel('E-mail *')).toBeFocused();

  await dialog.getByLabel('E-mail *').fill('marta@exemplo.gov.br');
  await dialog.getByLabel('Nome *').fill('Marta Lima');
  await dialog.getByLabel('Cargo ou função').fill('Engenheira');
  await dialog.getByRole('checkbox', { name: 'Gabinete', exact: true }).check();
  await expect(dialog.getByRole('list', { name: 'Unidades selecionadas' })).toContainText(
    'Gabinete',
  );
  await expectNoSeriousA11yViolations(page, 'formulário de convite');

  await dialog.getByRole('button', { name: 'Enviar convite' }).click();
  await expect(page.getByText('Convite enviado para marta@exemplo.gov.br.')).toBeVisible();
  await expect(dialog).toBeHidden();
  const row = page.getByRole('row', { name: /Marta Lima/ });
  await expect(row).toContainText('marta@exemplo.gov.br');
  await expect(row).toContainText('Interno');
  await expectNoSeriousA11yViolations(page, 'convites pendentes');
});

test('vínculo externo exige a validade e a pessoa que já tem vínculo recebe a sugestão de reenvio', async ({
  page,
}) => {
  await openList(page);
  await page.getByRole('button', { name: 'Convidar usuário' }).click();
  const dialog = page.getByRole('dialog', { name: 'Convidar usuário' });
  await dialog.getByLabel('E-mail *').fill('existente@exemplo.gov.br');
  await dialog.getByLabel('Nome *').fill('Pessoa Existente');
  await dialog.getByLabel('Tipo de vínculo *').selectOption('EXTERNAL');
  await dialog.getByRole('button', { name: 'Enviar convite' }).click();
  await expect(dialog.getByText('Informe a validade do vínculo externo.')).toBeVisible();
  await expect(dialog.getByLabel('Validade do vínculo *')).toBeFocused();

  await dialog.getByLabel('Validade do vínculo *').fill('2099-12-31');
  await dialog.getByRole('button', { name: 'Enviar convite' }).click();
  await expect(
    dialog.getByText('Esta pessoa já tem um vínculo com esta instituição.'),
  ).toBeVisible();
  await expect(dialog.getByText(/use "Reenviar" na lista de convites/)).toBeVisible();
  // Os dados continuam no formulário.
  await expect(dialog.getByLabel('Nome *')).toHaveValue('Pessoa Existente');
  await expectNoSeriousA11yViolations(page, 'convite duplicado');
});

test('reenvia e cancela um convite pendente (com confirmação)', async ({ page }) => {
  await openList(page);
  const row = page.getByRole('row', { name: /Marta Lima/ });
  await row.getByRole('button', { name: 'Reenviar convite para Marta Lima' }).click();
  await expect(page.getByText('Convite reenviado para marta@exemplo.gov.br.')).toBeVisible();

  await row.getByRole('button', { name: 'Cancelar convite de Marta Lima' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Cancelar o convite de Marta Lima?' });
  await expectNoSeriousA11yViolations(page, 'cancelar convite');
  await confirm.getByRole('button', { name: 'Cancelar convite' }).click();
  await expect(page.getByText('Convite de Marta Lima cancelado.')).toBeVisible();
  await expect(page.getByText('Nenhum convite pendente')).toBeVisible();
});
