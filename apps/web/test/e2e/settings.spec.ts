// E2E do SCR-041 (US-103): Administração › Configurações — alterar um rótulo, salvar com a versão
// da chave e ver o valor depois de recarregar, com axe-core em cada estado. A API é simulada
// (support/mock-api.mjs); validação por schema, concorrência por chave e isolamento por tenant são
// cobertos nos testes da API (módulo `tenancy` e suíte tenant leak).
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/a11y';

// As configurações da API simulada são globais: os passos desta jornada rodam em série.
test.describe.configure({ mode: 'serial' });

const NAV_LABEL = 'Seções de configurações';

async function openScreen(page: Page): Promise<void> {
  await page.goto(`/api/auth/login?as=ana&returnTo=${encodeURIComponent('/admin/configuracoes')}`);
  await expect(page).toHaveURL(/\/admin\/configuracoes$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Configurações gerais' })).toBeVisible();
}

/** Abre uma seção na navegação à esquerda do `SettingsPage` (prd-5). */
async function openSection(page: Page, name: string): Promise<void> {
  const nav = page.getByRole('navigation', { name: NAV_LABEL });
  await nav.getByRole('button', { name, exact: true }).click();
  await expect(nav.getByRole('button', { name, exact: true })).toHaveAttribute(
    'aria-current',
    'true',
  );
}

test('lista as seções e os campos da seção Rótulos, sem violações de acessibilidade', async ({
  page,
}) => {
  await openScreen(page);
  await expect(
    page.getByRole('navigation', { name: NAV_LABEL }).getByRole('button', { name: 'Marca' }),
  ).toHaveAttribute('aria-current', 'true');
  await openSection(page, 'Rótulos');
  await expect(page).toHaveURL(/\?secao=labels$/);
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
  await openSection(page, 'Rótulos');
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
  await openSection(page, 'Numeração');
  await page.getByLabel('Máscara do número do processo').fill('PROC-{seq:4}');
  await expect(
    page.getByText('A máscara deve conter {seq:N} e {year}; verifique os marcadores usados.'),
  ).toBeVisible();
  await expect(page.getByText('Efeito a partir do próximo número')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Salvar' })).toBeDisabled();
  await expectNoSeriousA11yViolations(page, 'numeração');
});

test('prévia da máscara de numeração: exemplo do próximo número sem salvar (US-105)', async ({
  page,
}) => {
  await openScreen(page);
  await openSection(page, 'Numeração');
  await expect(page.getByText('Próximo número: 0012/2026')).toBeVisible();
  await page.getByLabel('Máscara do número do processo').fill('{org}-{seq:5}/{year}');
  await expect(page.getByText('Próximo número: PMSJ-00012/2026')).toBeVisible();
  await expect(page.getByText('1 alteração pendente')).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'prévia da numeração');
});
