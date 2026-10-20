// E2E da autorização no frontend (US-097 · RN-IAM-106/107): os itens protegidos vêm de ME-03 e
// mudam quando o perfil efetivo muda — na Prefeitura A a Ana tem ROLE_VIEW; na B, nenhum perfil
// administrativo (support/mock-api.mjs). A decisão continua sendo da API em cada requisição.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/a11y';

async function openAdmin(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/painel$/);
  await page.goto('/admin');
  await expect(page.getByRole('heading', { level: 1, name: 'Administração' })).toBeVisible();
}

test('item de administração aparece com ROLE_VIEW e some ao trocar para a instituição sem o perfil', async ({
  page,
}) => {
  await page.goto(`/api/auth/login?as=ana&returnTo=${encodeURIComponent('/admin')}`);
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole('link', { name: 'Perfis e permissões' })).toBeVisible();

  await page.getByRole('button', { name: 'Instituição ativa: Prefeitura A' }).click();
  await page.getByRole('menuitem', { name: 'Prefeitura B' }).click();
  await expect(page.getByRole('button', { name: 'Instituição ativa: Prefeitura B' })).toBeVisible();
  // A troca leva ao Dashboard (US-093 · fluxo principal 7): volta à administração para conferir.
  await openAdmin(page);
  await expect(page.getByRole('link', { name: 'Perfis e permissões' })).toHaveCount(0);
  await expectNoSeriousA11yViolations(page, 'administração sem perfil');

  await page.getByRole('button', { name: 'Instituição ativa: Prefeitura B' }).click();
  await page.getByRole('menuitem', { name: 'Prefeitura A' }).click();
  await expect(page.getByRole('button', { name: 'Instituição ativa: Prefeitura A' })).toBeVisible();
  await openAdmin(page);
  await expect(page.getByRole('link', { name: 'Perfis e permissões' })).toBeVisible();
});
