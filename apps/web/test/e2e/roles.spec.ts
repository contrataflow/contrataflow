// E2E do SCR-030/031 (US-095): criar perfil → ajustar a matriz → duplicar → desativar, o bloqueio
// de desativação do ADMIN_ORGAO e o step-up de MFA da RN-IAM-83, com axe-core em cada estado. A API é
// simulada (support/mock-api.mjs): Ana tem ROLE_VIEW/ROLE_MANAGE sem ser ADMIN_ORGAO, então POL-13
// trava o que ela não possui. Regras e isolamento por tenant: testes da API (módulo `access` e suíte
// tenant leak).
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/a11y';

// O cadastro da API simulada é global: os passos desta jornada rodam em série.
test.describe.configure({ mode: 'serial' });

async function openList(page: Page): Promise<void> {
  await page.goto(`/api/auth/login?as=ana&returnTo=${encodeURIComponent('/admin/perfis')}`);
  await expect(page).toHaveURL(/\/admin\/perfis$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Perfis e permissões' })).toBeVisible();
}

/** Caixa da permissão na matriz: a busca abre o módulo recolhido em que ela está (prd-5). */
async function checkboxOf(page: Page, code: string) {
  await page.getByLabel('Buscar permissão na matriz').fill(code);
  return page.locator(`[role="checkbox"][data-code="${code}"]`);
}

/** Ação do menu "Mais" do cabeçalho do perfil. */
async function moreAction(page: Page, action: string): Promise<void> {
  await page.getByRole('button', { name: 'Mais', exact: true }).click();
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}

test('lista os perfis padrão; o ADMIN_ORGAO não oferece "Desativar"; sem violações de acessibilidade', async ({
  page,
}) => {
  await openList(page);
  const admin = page.getByRole('row', { name: /Administrador do órgão/ });
  await expect(admin.getByText('Protegido')).toBeVisible();
  await expect(page.getByText('Nenhum perfil personalizado ainda')).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'lista de perfis');
  await admin.getByRole('button', { name: 'Ações de Administrador do órgão' }).click();
  await expect(page.getByRole('menuitem', { name: 'Duplicar' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Desativar' })).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('cria um perfil, ajusta a matriz e vê as permissões fora do seu alcance travadas', async ({
  page,
}) => {
  await openList(page);
  await page.getByRole('button', { name: 'Novo perfil' }).click();
  const dialog = page.getByRole('dialog', { name: 'Novo perfil' });
  await expect(dialog.getByRole('textbox', { name: 'Nome', exact: true })).toBeFocused();
  await dialog.getByRole('textbox', { name: 'Nome', exact: true }).fill('Fiscal de Obras');
  await dialog.getByRole('button', { name: 'Criar perfil' }).click();

  await expect(page).toHaveURL(/\/admin\/perfis\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Fiscal de Obras' })).toBeVisible();
  // Fora do alcance da Ana: o ME-03 simulado não traz PROCESS_VIEW (USER_MANAGE entrou com a
  // US-092 para a gestão de usuários).
  const processView = await checkboxOf(page, 'PROCESS_VIEW');
  await expect(processView).toHaveAttribute('aria-disabled', 'true');
  await expect(processView).toHaveAttribute(
    'title',
    'Você não possui esta permissão e por isso não pode concedê-la.',
  );
  await expectNoSeriousA11yViolations(page, 'matriz de permissões');

  const processCreate = await checkboxOf(page, 'PROCESS_CREATE');
  await processCreate.click();
  await expect(processCreate).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('button', { name: 'Salvar matriz' }).click();
  await expect(page.getByText('Matriz atualizada.', { exact: true })).toBeVisible();
  await expect(page.getByText('Nenhuma alteração pendente.')).toBeVisible();
});

test('RN-IAM-83: ligar a atribuição externa em perfil com permissão de risco alto leva ao step-up de MFA', async ({
  page,
}) => {
  await openList(page);
  await page.getByRole('link', { name: 'Abrir Fiscal de Obras' }).click();
  await (await checkboxOf(page, 'SETTINGS_MANAGE')).click();
  await page.getByRole('button', { name: 'Salvar matriz' }).click();
  await expect(page.getByText('Matriz atualizada.', { exact: true })).toBeVisible();
  const detailUrl = page.url();

  const enableExternal = async () => {
    await moreAction(page, 'Editar perfil');
    const dialog = page.getByRole('dialog', { name: 'Editar perfil' });
    await dialog.getByRole('checkbox', { name: 'Permite atribuição a vínculos externos' }).click();
    await dialog.getByRole('button', { name: 'Salvar' }).click();
  };
  // Sem MFA na sessão, a API responde MFA_REQUIRED e o BFF conduz o step-up de volta ao perfil.
  await enableExternal();
  await expect(page).toHaveURL(detailUrl);
  await expect(page.getByRole('heading', { level: 1, name: 'Fiscal de Obras' })).toBeVisible();
  // Com a identidade confirmada, a mesma alteração passa.
  await enableExternal();
  await expect(
    page.getByText('Perfil "Fiscal de Obras" atualizado.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Aceita vínculo externo')).toBeVisible();
});

test('duplica e desativa a cópia', async ({ page }) => {
  await openList(page);
  await page.getByRole('link', { name: 'Abrir Fiscal de Obras' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Fiscal de Obras' })).toBeVisible();
  await moreAction(page, 'Duplicar');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Fiscal de Obras (cópia)' }),
  ).toBeVisible();

  await moreAction(page, 'Desativar');
  const dialog = page.getByRole('dialog', { name: 'Desativar o perfil Fiscal de Obras (cópia)?' });
  await expect(dialog.getByText('Nenhum vínculo ativo usa este perfil.')).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'desativar perfil');
  await dialog.getByRole('button', { name: 'Desativar perfil' }).click();
  await expect(
    page.getByText('Perfil "Fiscal de Obras (cópia)" desativado.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/Este perfil está desativado/)).toBeVisible();
});
