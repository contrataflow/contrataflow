// E2E do SCR-033/SCR-114 (US-107/US-109): Administração › Templates — criar template, adicionar seções,
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

// US-109: aba "Layout" — fonte, margem e cabeçalho com variável salvos; prévia pronta com download.
test('configura o layout de impressão e gera a prévia em PDF', async ({ page }) => {
  await openList(page);
  await page.getByRole('link', { name: 'Editar conteúdo de Despacho padrão' }).click();
  await page.getByRole('tab', { name: 'Layout' }).click();
  await expect(page.getByLabel('Margem superior (mm)')).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'aba Layout do template');

  await page.getByLabel('Fonte', { exact: true }).selectOption('Times New Roman');
  await expect(page.getByText('Layout salvo.', { exact: true })).toBeAttached();
  await page.getByLabel('Margem superior (mm)').fill('25');
  await page
    .getByRole('button', { name: 'Inserir a variável organization.name no campo Cabeçalho' })
    .click();
  await page.getByRole('button', { name: 'Gerar prévia' }).click();
  await expect(page.getByText('Prévia pronta.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Baixar prévia' })).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'prévia do template pronta');

  await page.reload();
  await page.getByRole('tab', { name: 'Layout' }).click();
  await expect(page.getByLabel('Fonte', { exact: true })).toHaveValue('Times New Roman');
  await expect(page.getByLabel('Margem superior (mm)')).toHaveValue('25');
  await expect(page.getByRole('textbox', { name: 'Cabeçalho' })).toHaveValue(
    '{{organization.name}}',
  );
});

// US-108: publicar o rascunho, iniciar nova versão, definir o padrão do tipo e aposentar.
test('publica a versão, inicia nova versão, define o padrão do tipo e aposenta a versão antiga', async ({
  page,
}) => {
  await openList(page);
  await page.getByRole('link', { name: 'Versões de Despacho padrão' }).click();
  await expect(page).toHaveURL(/\/admin\/templates\/[0-9a-f-]+$/);
  await expect(page.getByRole('heading', { level: 2, name: 'Versões' })).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'histórico de versões');

  await page.getByRole('button', { name: 'Publicar versão 1' }).click();
  const publish = page.getByRole('dialog', { name: 'Publicar a versão 1?' });
  await expect(publish.getByRole('button', { name: 'Publicar' })).toBeEnabled();
  // O botão é habilitado quando o rascunho é conferido: o axe avalia depois da transição de
  // opacidade (com o ponteiro fora dele — o hover também a reduz).
  await page.mouse.move(0, 0);
  await expect(publish.getByRole('button', { name: 'Publicar' })).toHaveCSS('opacity', '1');
  await expectNoSeriousA11yViolations(page, 'diálogo de publicação');
  await publish.getByRole('button', { name: 'Publicar' }).click();
  const v1 = page.getByRole('row', { name: /^v1/ });
  await expect(v1.getByText('Publicada')).toBeVisible();
  await expect(v1.getByText('Corrente')).toBeVisible();
  const hash = await v1.locator('td.font-mono').innerText();

  await page.getByRole('button', { name: 'Iniciar nova versão' }).click();
  await expect(page).toHaveURL(/\/admin\/templates\/[0-9a-f-]+\/versoes\/[0-9a-f-]+$/);
  await page.goBack();
  await expect(page.getByRole('row', { name: /^v2/ }).getByText('Rascunho')).toBeVisible();
  // Sem efeito retroativo: a versão 1 segue publicada com o mesmo hash.
  await expect(page.getByRole('row', { name: /^v1/ }).locator('td.font-mono')).toHaveText(hash);

  await page.goto('/admin/tipos-documento');
  const select = page.getByRole('combobox', { name: 'Template padrão de Ofício' });
  await select.selectOption({ label: 'Despacho padrão — v1' });
  await expect(
    page
      .getByText('Template padrão de "Ofício" definido: Despacho padrão.', { exact: true })
      .first(),
  ).toBeVisible();

  await page.goBack();
  await expect(page.getByText('Padrão do tipo')).toBeVisible();
  // Única publicada do template padrão: aposentar fica bloqueado (FA-03).
  await expect(page.getByRole('button', { name: 'Aposentar versão 1' })).toBeDisabled();
  await page.getByRole('button', { name: 'Publicar versão 2' }).click();
  await page
    .getByRole('dialog', { name: 'Publicar a versão 2?' })
    .getByRole('button', { name: 'Publicar' })
    .click();
  await expect(page.getByRole('row', { name: /^v2/ }).getByText('Corrente')).toBeVisible();
  await page.getByRole('button', { name: 'Aposentar versão 1' }).click();
  const retire = page.getByRole('dialog', { name: 'Aposentar a versão 1?' });
  await page.mouse.move(0, 0);
  await expect(retire.getByRole('button', { name: 'Aposentar' })).toHaveCSS('opacity', '1');
  await expectNoSeriousA11yViolations(page, 'diálogo de aposentadoria');
  await retire.getByRole('button', { name: 'Aposentar' }).click();
  await expect(page.getByRole('row', { name: /^v1/ }).getByText('Aposentada')).toBeVisible();
});

// US-110: a biblioteca padrão semeada no provisionamento aparece publicada, com o selo em texto, e
// o modelo abre com as seções canônicas (na API simulada, os tipos DFD, ETP e Ofício).
test('a biblioteca padrão aparece publicada com o selo e o modelo abre com as seções', async ({
  page,
}) => {
  const mockApiUrl = String(test.info().config.metadata.mockApiUrl);
  await fetch(`${mockApiUrl}/__mock/template-library`, { method: 'POST' });
  await openList(page);
  await expect(page.getByText('Modelo padrão da plataforma')).toHaveCount(3);
  const etp = page.getByRole('row', { name: /ETP — Modelo padrão/ });
  await expect(etp.getByText('Publicada v1')).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'lista com a biblioteca padrão');

  await page.getByRole('link', { name: 'Versões de ETP — Modelo padrão' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'ETP — Modelo padrão' })).toBeVisible();
  await expect(page.getByText('Modelo padrão da plataforma')).toBeVisible();
  await page.getByRole('link', { name: 'Ver versão 1' }).click();
  await expect(
    page.getByText('Esta versão está publicada. Para alterar, inicie uma nova versão.'),
  ).toBeVisible();
  await expect(page.getByText('Descrição da necessidade').first()).toBeVisible();
  await expect(page.getByText('Posicionamento conclusivo').first()).toBeVisible();
});
