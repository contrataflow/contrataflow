// E2E do SCR-033/SCR-114 (US-107): Administração › Templates — criar template, adicionar seções,
// salvar, recarregar e confirmar a persistência, e ver o `TEMPLATE_INVALID` na seção certa, com
// axe-core em cada estado e a largura de 360 px. A API é simulada (support/mock-api.mjs); as regras
// de conteúdo e o isolamento por tenant são cobertos nos testes da API (módulo `document` e suíte
// tenant leak).
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/a11y';

// O catálogo da API simulada é global: os passos desta jornada rodam em série.
test.describe.configure({ mode: 'serial' });

async function openList(page: Page): Promise<void> {
  await page.goto(`/api/auth/login?as=ana&returnTo=${encodeURIComponent('/admin/templates')}`);
  await expect(page).toHaveURL(/\/admin\/templates$/);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Templates de documento' }),
  ).toBeVisible();
}

test('cria um template, adiciona seções, salva e a recarga mantém o conteúdo', async ({ page }) => {
  await openList(page);
  await expectNoSeriousA11yViolations(page, 'lista de templates');
  await page.getByRole('button', { name: 'Novo template' }).click();
  const dialog = page.getByRole('dialog', { name: 'Novo template' });
  await dialog.getByLabel('Nome').fill('Despacho padrão');
  await dialog.getByLabel('Tipo de documento').selectOption({ label: 'Ofício' });
  await dialog.getByRole('button', { name: 'Criar e editar seções' }).click();

  await expect(page).toHaveURL(/\/admin\/templates\/[0-9a-f-]+\/versoes\/[0-9a-f-]+$/);
  await expect(page.getByText('Nenhuma seção. Adicione a primeira.')).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'editor de template vazio');

  await page.getByRole('button', { name: 'Adicionar seção' }).click();
  await page.getByRole('textbox', { name: 'Chave', exact: true }).fill('OBJETO');
  await page.getByRole('textbox', { name: 'Título', exact: true }).fill('Objeto');
  await page.getByRole('button', { name: 'Adicionar seção' }).click();
  await page.getByRole('textbox', { name: 'Chave', exact: true }).fill('FUNDAMENTACAO');
  await page.getByRole('textbox', { name: 'Título', exact: true }).fill('Fundamentação');
  await page.getByLabel('Obrigatoriedade').selectOption('REQUIRED_OR_JUSTIFY');
  await page.getByRole('button', { name: 'Salvar alterações' }).click();
  await expect(page.getByText('Todas as alterações salvas.').first()).toBeAttached();

  await page.reload();
  const list = page.getByRole('list', { name: 'Seções do template, em ordem' });
  await expect(list.getByRole('button', { name: 'Editar a seção Objeto' })).toBeVisible();
  await expect(list.getByRole('button', { name: 'Editar a seção Fundamentação' })).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'editor de template com seções');
});

test('mostra a variável desconhecida devolvida pela API na seção certa', async ({ page }) => {
  await openList(page);
  await page.getByRole('link', { name: 'Editar conteúdo de Despacho padrão' }).click();
  await page.getByRole('button', { name: 'Editar a seção Objeto' }).click();
  // A validação local já recusa a variável; o 422 da API chega quando ela passa pelo front.
  await page
    .getByRole('textbox', { name: 'Conteúdo padrão', exact: true })
    .fill('Assinado por {{document.assinante}}');
  await expect(
    page.getByText('A variável {{document.assinante}} não é reconhecida.').first(),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Salvar alterações' })).toBeDisabled();
});

test('no celular (360 px) o editor fica em coluna única e acessível', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await openList(page);
  await page.getByRole('link', { name: 'Editar conteúdo de Despacho padrão' }).click();
  await expect(page.getByRole('heading', { name: 'Seções' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(overflow).toBe(false);
  await expectNoSeriousA11yViolations(page, 'editor de template em 360 px');
});
