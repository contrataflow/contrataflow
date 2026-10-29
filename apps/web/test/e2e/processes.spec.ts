// E2E do SCR-005/SCR-006 (US-001): wizard "Novo processo" de três passos até o painel do processo
// criado ("Elabore o DFD"), aviso de duplicidade com "Criar mesmo assim", retomada do rascunho após
// recarregar, ausência de fluxo aplicável, 403 sem PROCESS_CREATE, axe-core em cada passo e
// viewport de 360 px sem rolagem horizontal. A API é simulada (support/mock-api.mjs); numeração
// concorrente, transação, auditoria e isolamento por tenant são cobertos nos testes da API.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/a11y';
import { chooseOption } from './support/kit';

// Os processos e a numeração da API simulada são globais: os passos desta jornada rodam em série.
test.describe.configure({ mode: 'serial' });

const TITLE = 'Aquisição de cimento para manutenção de vias';
const OBJECT = 'Aquisição de cimento Portland para a manutenção das vias do município.';
const WORKFLOW_TEXT =
  'Este processo seguirá o fluxo Fase preparatória — Lei 14.133/2021, começando em Formalização da demanda.';

async function openWizard(page: Page): Promise<void> {
  await page.goto(`/api/auth/login?as=ana&returnTo=${encodeURIComponent('/processos/novo')}`);
  await expect(page).toHaveURL(/\/processos\/novo$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Novo processo' })).toBeVisible();
  await expect(page.getByLabel('Tipo de contratação *')).toBeVisible();
}

async function fillIdentification(page: Page, contractingType = 'Aquisição de bens') {
  await page.getByLabel('Título *').fill(TITLE);
  await page.getByLabel('Objeto *').fill(OBJECT);
  await chooseOption(page, 'Tipo de contratação *', contractingType);
}

async function toOrigin(page: Page, contractingType?: string): Promise<void> {
  await fillIdentification(page, contractingType);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(
    page.getByRole('heading', { level: 2, name: 'Origem e planejamento' }),
  ).toBeVisible();
}

async function toReview(page: Page, contractingType?: string): Promise<void> {
  await toOrigin(page, contractingType);
  await chooseOption(page, 'Origem *', 'Demanda não prevista');
  await page.getByRole('radio', { name: 'Não se aplica' }).check();
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Revisão' })).toBeVisible();
}

test('jornada completa: Identificação → Origem e planejamento → Revisão → painel com "Elabore o DFD"', async ({
  page,
}) => {
  await openWizard(page);
  await expect(page.getByRole('link', { name: 'Novo processo' })).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'wizard · passo 1');

  // Passo 1 sem título não avança.
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(page.getByText('Informe o título.')).toBeVisible();
  await expect(page.getByLabel('Título *')).toBeFocused();
  await expect(page.getByRole('heading', { level: 2, name: 'Identificação' })).toBeVisible();

  await toOrigin(page);
  // O foco vai para o título do passo; secretaria e setor vêm da lotação principal (Gabinete).
  await expect(
    page.getByRole('heading', { level: 2, name: 'Origem e planejamento' }),
  ).toBeFocused();
  await expect(page.getByRole('combobox', { name: 'Secretaria solicitante *' })).toHaveText(
    'Gabinete',
  );
  await expect(page.getByRole('combobox', { name: 'Setor solicitante *' })).toHaveText('Gabinete');
  await expect(page.getByRole('combobox', { name: 'Prioridade *' })).toHaveText('Média');
  await expect(page.getByRole('combobox', { name: 'Órgão/entidade *' })).toHaveText(
    'Prefeitura Municipal de São José',
  );

  // PCA "Não previsto" exige a justificativa (mensagem exata) e bloqueia o avanço.
  await chooseOption(page, 'Origem *', 'Demanda não prevista');
  await page.getByRole('radio', { name: 'Não previsto no PCA' }).check();
  await expect(
    page.getByText(
      'Justifique por que a contratação não está prevista no PCA (mín. 20 caracteres).',
    ),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(
    page.getByRole('heading', { level: 2, name: 'Origem e planejamento' }),
  ).toBeVisible();
  await page.getByRole('radio', { name: 'Não se aplica' }).check();
  await page.getByLabel('Valor estimado').fill('15000,5');
  await page.getByLabel('Valor estimado').blur();
  await expect(page.getByLabel('Valor estimado')).toHaveValue('15.000,50');
  await expectNoSeriousA11yViolations(page, 'wizard · passo 2');
  await page.getByRole('button', { name: 'Continuar' }).click();

  await expect(page.getByRole('heading', { level: 2, name: 'Revisão' })).toBeVisible();
  await expect(page.getByText(WORKFLOW_TEXT)).toBeVisible();
  await expect(page.getByRole('button', { name: /Mais informações/ })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await expectNoSeriousA11yViolations(page, 'wizard · passo 3');

  await page.getByRole('button', { name: 'Criar processo' }).click();
  await expect(page).toHaveURL(/\/processos\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1, name: TITLE })).toBeVisible();
  await expect(page.getByText(/^\d{4}\/\d{4}$/)).toBeVisible();
  await expect(page.getByText('Elabore o DFD para formalizar a demanda.')).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Onde está' })).toBeVisible();
  await expect(page.getByText('Formalização da demanda').first()).toBeVisible();
  await expect(page.getByText(/^Processo \d{4}\/\d{4} criado$/)).toBeVisible();
  await expect(page.getByText('R$ 15.000,50').first()).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'painel do processo');
});

test('processo parecido: aviso de duplicidade com link e "Criar mesmo assim"', async ({ page }) => {
  await openWizard(page);
  await toReview(page);

  await expect(
    page.getByText('Encontramos processos parecidos criados recentemente.'),
  ).toBeVisible();
  const existing = page.getByRole('link', { name: /^\d{4}\/\d{4}$/ });
  await expect(existing).toBeVisible();
  const existingHref = await existing.getAttribute('href');
  expect(existingHref).toMatch(/^\/processos\/[0-9a-f-]{36}$/);
  await expectNoSeriousA11yViolations(page, 'wizard · aviso de duplicidade');

  // Criar sem confirmar: a API responde 409 e o painel segue pedindo a decisão.
  await page.getByRole('button', { name: 'Criar processo' }).click();
  await expect(page).toHaveURL(/\/processos\/novo$/);
  await expect(
    page.getByText('Encontramos processos parecidos criados recentemente.'),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Criar mesmo assim' }).click();
  await expect(page).toHaveURL(/\/processos\/[0-9a-f-]{36}$/);
  expect(new URL(page.url()).pathname).not.toBe(existingHref);
  await expect(page.getByText('Elabore o DFD para formalizar a demanda.')).toBeVisible();
});

test('retomada do rascunho após recarregar a página', async ({ page }) => {
  await openWizard(page);
  await toOrigin(page);
  // Prazo alvo no DatePicker do kit: dia 15 do mês seguinte.
  await page.getByRole('button', { name: 'Prazo alvo', exact: true }).click();
  const calendar = page.getByRole('dialog', { name: /^Escolher/ });
  await calendar.getByRole('button', { name: 'Ir para o próximo mês' }).click();
  await calendar
    .locator('td[role="gridcell"]:not([data-outside]) button')
    .getByText('15', { exact: true })
    .click();
  const targetDate = await page
    .getByRole('button', { name: 'Prazo alvo', exact: true })
    .textContent();
  expect(targetDate).toMatch(/^15\/\d{2}\/\d{4}$/);

  await page.reload();
  await expect(page.getByText('Recuperamos o que você estava preenchendo')).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 2, name: 'Origem e planejamento' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Prazo alvo', exact: true })).toHaveText(
    targetDate ?? '',
  );
  await expectNoSeriousA11yViolations(page, 'wizard · rascunho recuperado');

  await page.getByRole('button', { name: 'Voltar' }).click();
  await expect(page.getByLabel('Título *')).toHaveValue(TITLE);
  await expect(page.getByLabel('Objeto *')).toHaveValue(OBJECT);

  // Começar do zero apaga o rascunho: uma nova recarga não o oferece de volta.
  await page.getByRole('button', { name: 'Começar do zero' }).click();
  await expect(page.getByLabel('Título *')).toHaveValue('');
  await page.reload();
  await expect(page.getByLabel('Título *')).toHaveValue('');
  await expect(page.getByText('Recuperamos o que você estava preenchendo')).toHaveCount(0);
});

test('cancelar com alterações pede confirmação e descarta o rascunho', async ({ page }) => {
  await openWizard(page);
  await page.getByLabel('Título *').fill(TITLE);
  await page.getByRole('button', { name: 'Cancelar' }).click();
  const dialog = page.getByRole('dialog', { name: 'Descartar o que você preencheu?' });
  await expect(dialog).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'wizard · confirmar abandono');
  await dialog.getByRole('button', { name: 'Continuar preenchendo' }).click();
  await expect(page).toHaveURL(/\/processos\/novo$/);
  await expect(page.getByLabel('Título *')).toHaveValue(TITLE);

  // Sair por um link do shell também pergunta.
  await page
    .getByRole('navigation', { name: 'Menu principal' })
    .getByRole('link', { name: 'Painel' })
    .click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Descartar e sair' }).click();
  await expect(page).toHaveURL(/\/painel$/);
});

test('sem fluxo aplicável: orientação e "Criar processo" desabilitado', async ({ page }) => {
  await openWizard(page);
  await toReview(page, 'Serviços comuns');
  await expect(
    page.getByText(
      'Não há fluxo configurado para este tipo de contratação. Fale com o administrador do órgão.',
    ),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Criar processo' })).toBeDisabled();
  await expectNoSeriousA11yViolations(page, 'wizard · sem fluxo aplicável');
});

test('em 360 px: indicador "Passo N de 3", coluna única e sem rolagem horizontal', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 740 });
  const overflow = () =>
    page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );

  await openWizard(page);
  await expect(page.getByText('Passo 1 de 3')).toBeVisible();
  // No WizardShell estreito os passos viram a barra de progresso (StageProgress), não a coluna.
  await expect(
    page.getByRole('listitem').filter({ hasText: 'Identificação (etapa atual)' }),
  ).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);
  // O botão global continua acessível (só o ícone, com nome acessível).
  await expect(page.getByRole('link', { name: 'Novo processo' })).toBeVisible();

  await toOrigin(page);
  await expect(page.getByText('Passo 2 de 3')).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);
  await chooseOption(page, 'Origem *', 'Demanda não prevista');
  await page.getByRole('radio', { name: 'Não previsto no PCA' }).check();
  expect(await overflow()).toBeLessThanOrEqual(0);
  await page.getByRole('radio', { name: 'Não se aplica' }).check();
  await page.getByRole('button', { name: 'Continuar' }).click();

  await expect(page.getByText('Passo 3 de 3')).toBeVisible();
  await expect(page.getByText(WORKFLOW_TEXT)).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);
  // Botões fixos no rodapé: "Criar processo" fica visível sem rolar até o fim.
  await expect(page.getByRole('button', { name: 'Criar processo' })).toBeInViewport();
  await expectNoSeriousA11yViolations(page, 'wizard · 360 px');
});

test('sem PROCESS_CREATE (Prefeitura B): sem botão "Novo processo" e a rota mostra o 403', async ({
  page,
}) => {
  await page.goto(`/api/auth/login?as=ana&returnTo=${encodeURIComponent('/exemplo')}`);
  await expect(page.getByRole('link', { name: 'Novo processo' })).toBeVisible();
  await page.getByRole('button', { name: 'Instituição ativa: Prefeitura A' }).click();
  await page.getByRole('menuitem', { name: 'Prefeitura B' }).click();
  await expect(page.getByRole('button', { name: 'Instituição ativa: Prefeitura B' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Novo processo' })).toHaveCount(0);

  await page.goto('/processos/novo');
  await expect(page.getByRole('heading', { level: 1, name: 'Acesso negado' })).toBeVisible();
  await expect(page.getByLabel('Título *')).toHaveCount(0);
  await expectNoSeriousA11yViolations(page, 'novo processo sem permissão');
});
