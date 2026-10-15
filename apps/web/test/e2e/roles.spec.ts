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

const switchOf = (page: Page, code: string) => page.locator(`[role="switch"][data-code="${code}"]`);

test('lista os perfis padrão; o ADMIN_ORGAO não oferece "Desativar"; sem violações de acessibilidade', async ({
  page,
}) => {
  await openList(page);
  const admin = page.getByRole('row', { name: /Administrador do órgão/ });
  await expect(admin.getByText('Protegido')).toBeVisible();
  await expect(
    admin.getByRole('button', { name: 'Duplicar Administrador do órgão' }),
  ).toBeVisible();
  await expect(admin.getByRole('button', { name: /Desativar/ })).toHaveCount(0);
  await expect(page.getByText('Nenhum perfil personalizado ainda')).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'lista de perfis');
});

test('cria um perfil, ajusta a matriz e vê as permissões fora do seu alcance travadas', async ({
  page,
}) => {
  await openList(page);
  await page.getByRole('button', { name: 'Novo perfil' }).click();
  const dialog = page.getByRole('dialog', { name: 'Novo perfil' });
  await expect(dialog.getByLabel('Nome *')).toBeFocused();
  await dialog.getByLabel('Nome *').fill('Fiscal de Obras');
  await dialog.getByRole('button', { name: 'Criar perfil' }).click();

  await expect(page).toHaveURL(/\/admin\/perfis\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Fiscal de Obras' })).toBeVisible();
  await expect(switchOf(page, 'USER_MANAGE')).toHaveAttribute('aria-disabled', 'true');
  await expect(switchOf(page, 'USER_MANAGE')).toHaveAttribute(
    'title',
    'Você não possui esta permissão e por isso não pode concedê-la.',
  );
  await expectNoSeriousA11yViolations(page, 'matriz de permissões');

  await switchOf(page, 'PROCESS_CREATE').click();
  await expect(switchOf(page, 'PROCESS_CREATE')).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('button', { name: 'Salvar matriz' }).click();
  await expect(page.getByText('Matriz atualizada.', { exact: true })).toBeVisible();
  await expect(page.getByText('Nenhuma alteração pendente.')).toBeVisible();
});

test('RN-IAM-83: ligar a atribuição externa em perfil com permissão de risco alto leva ao step-up de MFA', async ({
  page,
}) => {
  await openList(page);
  await page.getByRole('link', { name: 'Abrir Fiscal de Obras' }).click();
  await switchOf(page, 'SETTINGS_MANAGE').click();
  await page.getByRole('button', { name: 'Salvar matriz' }).click();
  await expect(page.getByText('Matriz atualizada.', { exact: true })).toBeVisible();
  const detailUrl = page.url();

  const enableExternal = async () => {
    await page.getByRole('button', { name: 'Editar perfil' }).click();
    const dialog = page.getByRole('dialog', { name: 'Editar perfil' });
    await dialog.getByLabel('Permite atribuição a vínculos externos').check();
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
  await page.getByRole('button', { name: 'Duplicar', exact: true }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Fiscal de Obras (cópia)' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Desativar', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Desativar o perfil Fiscal de Obras (cópia)?' });
  await expect(dialog.getByText('Nenhum vínculo ativo usa este perfil.')).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'desativar perfil');
  await dialog.getByRole('button', { name: 'Desativar perfil' }).click();
  await expect(
    page.getByText('Perfil "Fiscal de Obras (cópia)" desativado.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/Este perfil está desativado/)).toBeVisible();
});
