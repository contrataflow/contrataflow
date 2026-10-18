// E2E da pesquisa de preços (US-024 · SCR-006 e SCR-009): a partir do painel do processo, a analista
// abre o diálogo "Criar pesquisa de preços", desmarca um item, tenta enviar com a quantidade ausente
// (a linha acusa o erro e o envio fica bloqueado), informa a quantidade e cai na SCR-009 vendo os
// itens e o painel "Parâmetros". axe-core no diálogo e na SCR-009, e a SCR-009 legível em 360 px.
// A API é simulada (support/mock-api.mjs): três processos dedicados (um para criar, um que já tem a
// pesquisa e um sem itens); resolução de quantidade, snapshot de parâmetros, atomicidade, POL-02,
// POL-09 e o isolamento por tenant são cobertos nos testes da API (módulo `price-research` e suíte
// tenant leak).
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/a11y';

/** Processo 0024/2026 da API simulada: itens 1 (100 SC), 2 (12 M3) e 3 sem quantidade de referência. */
const CREATE_PROCESS_PATH = '/processos/0192a000-0000-7000-8000-000000100024';
/** Processo 0025/2026: já tem a pesquisa "PP 0004/2026" (FA-01). */
const EXISTING_PROCESS_PATH = '/processos/0192a000-0000-7000-8000-000000100025';
/** Processo 0026/2026: sem itens (FA-02). */
const EMPTY_PROCESS_PATH = '/processos/0192a000-0000-7000-8000-000000100026';
const RESEARCH_PATH = /\/processos\/[0-9a-f-]{36}\/pesquisa-precos\/[0-9a-f-]{36}$/;

async function openProcess(page: Page, path: string, title: string): Promise<void> {
  await page.goto(`/api/auth/login?as=ana&returnTo=${encodeURIComponent(path)}`);
  await expect(page).toHaveURL(new RegExp(`${path}$`));
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
}

function hasHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
}

test('criar a pesquisa a partir do painel: desmarcar item, informar a quantidade ausente e abrir a SCR-009', async ({
  page,
}) => {
  await openProcess(page, CREATE_PROCESS_PATH, 'Aquisição de cimento e agregados para vias');

  await page.getByRole('button', { name: 'Criar pesquisa de preços' }).click();
  const dialog = page.getByRole('dialog', { name: 'Criar pesquisa de preços' });
  const table = dialog.getByRole('table', {
    name: 'Itens do processo que farão parte da pesquisa de preços',
  });
  await expect(table.getByText('Cimento CP II 50 kg')).toBeVisible();
  await expect(table.getByText('Areia média')).toBeVisible();
  await expect(table.getByText('Brita 1')).toBeVisible();
  await expect(dialog.getByText('3 de 3 itens selecionados')).toBeVisible();
  await expect(dialog.getByLabel('Título')).toHaveValue('Pesquisa de preços — 0024/2026');
  // A quantidade de referência vem preenchida; a do item 3 não existe em nenhuma fonte.
  await expect(dialog.getByLabel('Quantidade do item 1')).toHaveValue('100');
  await expect(dialog.getByLabel('Quantidade do item 2')).toHaveValue('12');
  await expect(dialog.getByLabel('Quantidade do item 3')).toHaveValue('');

  // Desmarca o item 2 ("Areia média"): sai da seleção e a quantidade da linha fica indisponível.
  await dialog.getByRole('checkbox', { name: 'Incluir o item 2 na pesquisa' }).uncheck();
  await expect(dialog.getByText('2 de 3 itens selecionados')).toBeVisible();
  await expect(dialog.getByLabel('Quantidade do item 2')).toBeDisabled();

  // Tenta enviar sem a quantidade do item 3: o envio fica bloqueado e a linha acusa o erro.
  const submit = dialog.getByRole('button', { name: 'Criar pesquisa', exact: true });
  await expect(dialog.getByText('Informe a quantidade')).toBeVisible();
  await expect(dialog.getByLabel('Quantidade do item 3')).toHaveAttribute('aria-invalid', 'true');
  await expect(submit).toBeDisabled();
  await dialog.getByLabel('Título').press('Enter');
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`${CREATE_PROCESS_PATH}$`));
  await expectNoSeriousA11yViolations(
    page,
    'diálogo Criar pesquisa de preços (quantidade ausente)',
  );

  // Informa a quantidade: o erro some e o envio é liberado.
  await dialog.getByLabel('Quantidade do item 3').fill('6');
  await expect(dialog.getByText('Informe a quantidade')).toHaveCount(0);
  await expect(submit).toBeEnabled();
  await submit.click();

  // Cai na SCR-009 com os itens escolhidos e o painel de parâmetros (o snapshot da criação).
  await expect(page).toHaveURL(RESEARCH_PATH);
  await expect(page.getByRole('heading', { level: 1, name: 'PP 0003/2026' })).toBeVisible();
  await expect(page.getByText('Pesquisa de preços — 0024/2026').first()).toBeVisible();
  await expect(page.getByText('Rascunho').first()).toBeVisible();
  const items = page.getByRole('table', { name: 'Itens da pesquisa de preços' });
  await expect(items.getByRole('row')).toHaveCount(3); // cabeçalho + 2 itens
  await expect(items.getByRole('row', { name: /Cimento CP II 50 kg/ })).toContainText('100');
  await expect(items.getByRole('row', { name: /Brita 1/ })).toContainText('6');
  await expect(items.getByText('Areia média')).toHaveCount(0);
  await expect(items.getByText('Sem cotações válidas').first()).toBeVisible();
  await expect(page.locator('dl[aria-label="Resumo da pesquisa"]')).toContainText('Itens');

  const parameters = page.getByRole('complementary', { name: 'Parâmetros' });
  await expect(parameters).toContainText(
    'Automático (média ou mediana conforme o coeficiente de variação)',
  );
  await expect(parameters).toContainText('25 %');
  await expect(parameters).toContainText('3'); // mínimo de cotações
  await expect(parameters).toContainText('180 dias');
  await expect(parameters).toContainText('365 dias');
  await expect(parameters).toContainText('70 % da mediana das demais cotações');
  await expect(parameters).toContainText('130 % da mediana das demais cotações');
  await expect(parameters).toContainText('Alterações posteriores nas configurações não afetam');
  await expectNoSeriousA11yViolations(page, 'SCR-009 Pesquisa de preços');

  // De volta ao painel, a criação vira o link "Abrir pesquisa" (FA-01) em vez do botão.
  await page.getByRole('link', { name: 'Voltar ao processo' }).click();
  await expect(page).toHaveURL(new RegExp(`${CREATE_PROCESS_PATH}$`));
  await expect(page.getByRole('link', { name: 'Abrir pesquisa PP 0003/2026' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Criar pesquisa de preços' })).toHaveCount(0);
});

test('processo sem itens: o diálogo orienta a cadastrar os itens e leva à aba Itens', async ({
  page,
}) => {
  await openProcess(page, EMPTY_PROCESS_PATH, 'Contratação de serviços de jardinagem');
  await page.getByRole('button', { name: 'Criar pesquisa de preços' }).click();
  const dialog = page.getByRole('dialog', { name: 'Criar pesquisa de preços' });
  await expect(
    dialog.getByText('Cadastre os itens da contratação antes de criar a pesquisa.'),
  ).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'diálogo sem itens');
  await dialog.getByRole('link', { name: 'Ir para Itens' }).click();
  await expect(page).toHaveURL(new RegExp(`${EMPTY_PROCESS_PATH}\\?aba=itens$`));
  await expect(dialog).toBeHidden();
});

test('no celular (360 px) a SCR-009 empilha os itens e o painel de parâmetros, sem rolagem horizontal', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await openProcess(page, EXISTING_PROCESS_PATH, 'Aquisição de agregados para a obra da escola');
  await page.getByRole('link', { name: 'Abrir pesquisa PP 0004/2026' }).click();
  await expect(page).toHaveURL(RESEARCH_PATH);
  await expect(page.getByRole('heading', { level: 1, name: 'PP 0004/2026' })).toBeVisible();

  const items = page.getByRole('table', { name: 'Itens da pesquisa de preços' });
  await expect(items.getByText('Cimento CP II 50 kg')).toBeVisible();
  await expect(items.getByText('Areia média')).toBeVisible();
  await expect(items.getByText('Brita 1')).toBeVisible();
  await expect(items.getByRole('row')).toHaveCount(3); // 3 cartões (o cabeçalho fica oculto)
  const parameters = page.getByRole('complementary', { name: 'Parâmetros' });
  await parameters.scrollIntoViewIfNeeded();
  await expect(parameters).toBeVisible();
  await expect(parameters).toContainText('25 %');
  expect(await hasHorizontalOverflow(page)).toBe(false);
  await expectNoSeriousA11yViolations(page, 'SCR-009 Pesquisa de preços em 360 px');
});

// US-026 — aba "Fontes" da SCR-009: registrar uma fonte de sítio eletrônico (campos do tipo), lançar
// os preços na grade num único envio, editar e remover a fonte (com a confirmação das cotações).
test('fontes: registrar fonte de sítio eletrônico, lançar preços na grade, editar e remover', async ({
  page,
}) => {
  await openProcess(page, EXISTING_PROCESS_PATH, 'Aquisição de agregados para a obra da escola');
  await page.getByRole('link', { name: 'Abrir pesquisa PP 0004/2026' }).click();
  await expect(page).toHaveURL(RESEARCH_PATH);
  await page.getByRole('tab', { name: 'Fontes' }).click();
  await expect(page.getByText('Nenhuma fonte registrada ainda')).toBeVisible();

  await page.getByRole('button', { name: 'Nova fonte' }).click();
  const form = page.getByRole('dialog', { name: 'Nova fonte de pesquisa' });
  await form
    .getByLabel(/Tipo de fonte/)
    .selectOption({ label: 'Sítio eletrônico especializado (art. 23, § 1º, III)' });
  await expect(
    form.getByText(/Campos exigidos para .*: URL, data\/hora de acesso\./),
  ).toBeVisible();
  await form.getByLabel(/Descrição/).fill('Painel de Preços');
  await form.getByLabel(/URL/).fill('https://paineldeprecos.planejamento.gov.br');
  await form.getByLabel(/Data\/hora de acesso/).fill('2026-09-12T14:32');
  await expectNoSeriousA11yViolations(page, 'diálogo Nova fonte de pesquisa');
  await form.getByRole('button', { name: 'Salvar fonte' }).click();
  await expect(page.getByText('Fonte registrada')).toBeVisible();

  // Com a fonte criada, a grade de preços dela abre (uma linha por item da pesquisa).
  const grid = page.getByRole('table', { name: 'Preços da fonte Painel de Preços' });
  await expect(grid.getByText('Cimento CP II 50 kg')).toBeVisible();
  await grid.getByLabel('Preço unitário do item 1').fill('25,90');
  await grid.getByLabel('Preço unitário do item 2').fill('120');
  await grid.getByLabel('Preço unitário do item 3').fill('95,5');
  await grid.getByLabel('Marca/modelo do item 1').fill('Votoran');
  await expectNoSeriousA11yViolations(page, 'grade de preços da fonte');
  await page.getByRole('button', { name: 'Salvar preços' }).click();
  await expect(page.getByText('Preços salvos')).toBeVisible();
  const sources = page.getByRole('list', { name: 'Fontes registradas' });
  await expect(sources.getByText('3 preços lançados')).toBeVisible();
  await expect(grid.getByLabel('Preço unitário do item 1')).toHaveValue('25,90');

  // Em 360 px a grade rola dentro do próprio contêiner, sem rolagem horizontal da página.
  await page.setViewportSize({ width: 360, height: 780 });
  expect(await hasHorizontalOverflow(page)).toBe(false);
  await page.setViewportSize({ width: 1280, height: 800 });

  // FA-01: editar a fonte.
  await sources.getByRole('button', { name: 'Editar' }).click();
  const edit = page.getByRole('dialog', { name: 'Editar fonte de pesquisa' });
  await edit.getByLabel(/Descrição/).fill('Painel de Preços do Governo Federal');
  await edit.getByRole('button', { name: 'Salvar fonte' }).click();
  await expect(page.getByText('Fonte atualizada')).toBeVisible();
  await expect(sources.getByText('Painel de Preços do Governo Federal')).toBeVisible();

  // FA-02: remover a fonte (as cotações vão junto) depois da confirmação.
  await sources.getByRole('button', { name: 'Remover', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: /Remover a fonte/ });
  await expect(
    confirm.getByText(
      '3 preços lançados nesta fonte serão perdidos. Esta ação não pode ser desfeita.',
    ),
  ).toBeVisible();
  await confirm.getByRole('button', { name: 'Remover fonte' }).click();
  await expect(page.getByText('Fonte removida')).toBeVisible();
  await expect(page.getByText('Nenhuma fonte registrada ainda')).toBeVisible();
});
