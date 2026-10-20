// E2E do Termo de Referência (US-036 · SCR-006 e SCR-012): a partir do painel do processo, a
// planejadora abre o diálogo "Criar Termo de Referência" (modelo padrão pré-selecionado e título
// sugerido), cria o TR e cai na SCR-012 com o foco no título; redige seções com o autosave (DOC-05),
// marca "Não se aplica" em DELIVERY com justificativa, confere a completude da navegação lateral e o
// painel "Dados do TR" (valor da pesquisa e valor manual com o aviso de FA-04). Num processo que já
// tem o TR, o painel oferece "Abrir TR" no lugar de "Criar" (FA-02). axe-core no diálogo e no
// editor e o diálogo legível em 360 px. US-038: os painéis "Itens" e "Condições contratuais"
// (inclusão, especificação, reordenação, FA-04 e 360 px). A API é simulada
// (support/mock-api.mjs); a numeração, a atomicidade, POL-02/09 e o isolamento por tenant são
// cobertos nos testes da API (módulo `term` e suíte tenant leak).
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/a11y';

/** Processo 0033/2026 da API simulada: sem TR. */
const CREATE_PROCESS_PATH = '/processos/0192a000-0000-7000-8000-000000100033';
/** Processo 0034/2026: já tem o TR 0002/2026 (FA-02). */
const EXISTING_PROCESS_PATH = '/processos/0192a000-0000-7000-8000-000000100034';
/** Processo 0035/2026: sem TR e sem jornada que o crie (o diálogo em 360 px). */
const NARROW_PROCESS_PATH = '/processos/0192a000-0000-7000-8000-000000100035';
const TERM_PATH = /\/processos\/[0-9a-f-]{36}\/tr\/[0-9a-f-]{36}$/;
const PROCESS_TITLE = 'Contratação de manutenção predial das escolas';

async function openProcess(page: Page, path: string, title: string): Promise<void> {
  await page.goto(`/api/auth/login?as=ana&returnTo=${encodeURIComponent(path)}`);
  await expect(page).toHaveURL(new RegExp(`${path}$`));
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
}

function hasHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
}

async function writeSection(page: Page, sectionTitle: string, text: string): Promise<void> {
  const field = page.getByLabel(`Texto da seção ${sectionTitle}`);
  await field.fill(text);
  await expect(page.getByText(/^Salvo às \d{2}:\d{2}$/)).toBeVisible();
}

test('criar o TR a partir do painel, redigir seções, "não se aplica" em DELIVERY e conferir a completude', async ({
  page,
}) => {
  await openProcess(page, CREATE_PROCESS_PATH, PROCESS_TITLE);

  await page.getByRole('button', { name: 'Criar Termo de Referência' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Criar Termo de Referência' });
  await expect(dialog.getByRole('combobox', { name: 'Modelo' })).toHaveValue(/.+/);
  await expect(dialog.getByRole('option', { name: 'TR — Modelo padrão (padrão)' })).toBeAttached();
  await expect(dialog.getByRole('textbox', { name: /Título/ })).toHaveValue(
    `Termo de Referência — ${PROCESS_TITLE}`,
  );
  await expectNoSeriousA11yViolations(page, 'diálogo Criar Termo de Referência');

  await dialog.getByRole('button', { name: 'Criar TR' }).click();

  await expect(page).toHaveURL(TERM_PATH);
  const heading = page.getByRole('heading', {
    level: 1,
    name: `Termo de Referência — ${PROCESS_TITLE}`,
  });
  await expect(heading).toBeVisible();
  await expect(heading).toBeFocused();
  await expect(page.getByText('TR 0001/2026').first()).toBeVisible();

  // Navegação lateral e completude inicial (5 seções exigidas; DELIVERY admite "não se aplica").
  const nav = page.getByRole('navigation', { name: 'Seções do TR' });
  await expect(nav.getByRole('button', { name: /^1\. Definição do objeto/ })).toHaveAttribute(
    'aria-current',
    'true',
  );
  const completeness = page.getByTestId('term-completeness');
  await expect(completeness).toHaveText('0% — 0 de 5 seções exigidas');
  // Em seção obrigatória o "Não se aplica" não existe.
  await expect(page.getByRole('button', { name: 'Não se aplica' })).toHaveCount(0);

  // Redigir três seções (autosave de 1,5 s).
  await writeSection(page, 'Definição do objeto', 'Contratação de manutenção predial preventiva.');
  await expect(completeness).toHaveText('20% — 1 de 5 seções exigidas');
  await expect(nav.getByRole('button', { name: /Definição do objeto.*Preenchida/ })).toBeVisible();

  await nav.getByRole('button', { name: /^2\. Fundamentação/ }).click();
  await writeSection(page, 'Fundamentação da contratação', 'Mantém as escolas em funcionamento.');
  await nav.getByRole('button', { name: /^4\. Critérios de medição/ }).click();
  await writeSection(
    page,
    'Critérios de medição e de pagamento',
    'Medição mensal por ordem de serviço.',
  );
  await expect(completeness).toHaveText('60% — 3 de 5 seções exigidas');

  // "Não se aplica" em DELIVERY: justificativa curta é recusada; a válida é gravada.
  await nav.getByRole('button', { name: /^3\. Local e condições/ }).click();
  await page.getByRole('button', { name: 'Não se aplica' }).click();
  await page.getByLabel('Justificativa *').fill('Serviço remoto');
  await page.getByRole('button', { name: 'Confirmar' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Justifique com pelo menos 20 caracteres.' }),
  ).toBeVisible();
  await page
    .getByLabel('Justificativa *')
    .fill('Serviço prestado nas próprias unidades escolares.');
  await page.getByRole('button', { name: 'Confirmar' }).click();
  await expect(page.getByText('Esta seção não se aplica')).toBeVisible();
  await expect(completeness).toHaveText('80% — 4 de 5 seções exigidas');
  await expect(nav.getByRole('button', { name: /Local e condições.*Não se aplica/ })).toBeVisible();

  // Dados do TR: valor da pesquisa (origem + link) e valor manual com o aviso de FA-04.
  await expect(page.getByTestId('term-estimated-value')).toContainText('98.000,00');
  await expect(page.getByText(/Pesquisa de preços PP 0002\/2026/)).toBeVisible();
  await page.getByRole('button', { name: 'Informar manualmente' }).click();
  await expect(
    page.getByText(
      'Existe pesquisa de preços concluída (PP 0002/2026). O valor manual tem precedência menor e exige justificativa.',
    ),
  ).toBeVisible();
  await page.getByLabel('Valor estimado (R$)').fill('100000.00');
  await page.getByRole('button', { name: 'Confirmar valor' }).click();
  await expect(page.getByText('Valor estimado atualizado.')).toBeVisible();
  await expect(page.getByTestId('term-estimated-value')).toContainText('100.000,00');
  await expect(page.getByText(/Informado manualmente/)).toBeVisible();

  await expectNoSeriousA11yViolations(page, 'editor do Termo de Referência');
});

test('FA-02: com TR ativo o painel oferece "Abrir TR" e não "Criar Termo de Referência"', async ({
  page,
}) => {
  await openProcess(page, EXISTING_PROCESS_PATH, 'Aquisição de mobiliário para a biblioteca');
  const open = page.getByRole('link', { name: 'Abrir TR 0002/2026' });
  await expect(open).toBeVisible();
  await expect(page.getByRole('button', { name: 'Criar Termo de Referência' })).toHaveCount(0);
  await open.click();
  await expect(page).toHaveURL(TERM_PATH);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Termo de Referência — 0034/2026' }),
  ).toBeVisible();
  await expect(page.getByTestId('term-completeness')).toHaveText('0% — 0 de 5 seções exigidas');
});

test('o diálogo "Criar Termo de Referência" é legível em 360 px', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await openProcess(page, NARROW_PROCESS_PATH, 'Contratação de vigilância patrimonial');
  await page.getByRole('button', { name: 'Criar Termo de Referência' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Criar Termo de Referência' });
  await expect(dialog.getByRole('combobox', { name: 'Modelo' })).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: /Título/ })).toBeVisible();
  expect(await hasHorizontalOverflow(page)).toBe(false);
});

test('US-038: incluir itens, especificar, reordenar e preencher as condições contratuais do TR', async ({
  page,
}) => {
  await openProcess(page, EXISTING_PROCESS_PATH, 'Aquisição de mobiliário para a biblioteca');
  await page.getByRole('link', { name: 'Abrir TR 0002/2026' }).click();
  await expect(page).toHaveURL(TERM_PATH);

  // Painel "Itens": a quantidade de referência pré-preenche a linha (US-037/US-006).
  await page.getByRole('button', { name: /^Itens/ }).click();
  const electric = page.getByTestId('term-item-1');
  const hydraulic = page.getByTestId('term-item-2');
  await electric.getByRole('checkbox').check();
  await expect(electric.getByLabel('Quantidade')).toHaveValue('10');
  await electric.getByLabel('Especificação').fill('Kit com disjuntores, fios e conectores.');
  await electric.getByLabel('Critérios de aceitação').fill('Conferência item a item na entrega.');
  await hydraulic.getByRole('checkbox').check();
  await hydraulic.getByLabel('Quantidade').fill('0');
  await page.getByRole('button', { name: 'Salvar itens' }).click();
  await expect(hydraulic.getByRole('alert')).toHaveText('Informe uma quantidade maior que zero.');
  await hydraulic.getByLabel('Quantidade').fill('5');
  await page.getByRole('button', { name: 'Mover o item 2 para cima' }).click();
  await page.getByRole('button', { name: 'Salvar itens' }).click();
  await expect(page.getByText(/^Salvo às \d{2}:\d{2}$/).first()).toBeVisible();
  await expect(page.getByText('2 itens no TR')).toBeVisible();
  await expect(page.getByTestId(/^term-item-/).first()).toHaveAttribute(
    'data-testid',
    'term-item-2',
  );

  // Painel "Condições contratuais": prazo sem tipo de contagem bloqueia (FA-04); depois salva.
  await page.getByRole('button', { name: /^Condições contratuais/ }).click();
  await page.getByLabel('Vigência do contrato (meses)').fill('12');
  await page.getByLabel('Prazo de execução/entrega').fill('30');
  await page.getByLabel('Garantia contratual (%)').fill('5');
  await page.getByRole('button', { name: 'Salvar condições' }).click();
  await expect(page.getByText('Informe o tipo de contagem do prazo.')).toBeVisible();
  await page.getByLabel('Dias corridos').check();
  await page.getByLabel('Prazo de pagamento (dias)').fill('30');
  await page.getByLabel('Critério de julgamento').selectOption({ label: 'Menor preço' });
  await page.getByLabel('Tipo de adjudicação').selectOption({ label: 'Por item' });
  await page.getByRole('button', { name: 'Salvar condições' }).click();
  await expect(page.getByText(/^Salvo às \d{2}:\d{2}$/).last()).toBeVisible();

  await expectNoSeriousA11yViolations(page, 'painéis Itens e Condições contratuais do TR');

  // 360 px: a tabela de itens vira cartões, sem rolagem horizontal.
  await page.setViewportSize({ width: 360, height: 780 });
  await expect(electric.getByLabel('Especificação')).toBeVisible();
  expect(await hasHorizontalOverflow(page)).toBe(false);
});
