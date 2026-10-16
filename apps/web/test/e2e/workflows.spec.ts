// E2E do SCR-034 (US-042/US-043): Administração › Workflows — a lista com o selo "Padrão", "Tornar
// padrão" com confirmação e toast, a ação desabilitada para workflow sem versão publicada; o editor
// (criar workflow, adicionar etapas e transição, recarregar e confirmar a persistência, "Criar
// rascunho" a partir da publicada, reordenação pelo teclado), axe-core em cada estado e a largura
// de 360 px. A API é simulada (support/mock-api.mjs); seeder, aplicabilidade
// (WF-06), concorrência e isolamento por tenant são cobertos nos testes da API (módulo `workflow`
// e suíte tenant leak). A criação de processo de dispensa resolvendo o workflow chega com a US-001.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/a11y';

// A lista da API simulada é global: os passos desta jornada rodam em série.
test.describe.configure({ mode: 'serial' });

const DIRECT = 'Contratação direta — Lei 14.133/2021, art. 72';
const STANDARD = 'Fase preparatória — Lei 14.133/2021';

async function openList(page: Page): Promise<void> {
  await page.goto(`/api/auth/login?as=ana&returnTo=${encodeURIComponent('/admin/workflows')}`);
  await expect(page).toHaveURL(/\/admin\/workflows$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Workflows' })).toBeVisible();
}

const cardOf = (page: Page, name: string) =>
  page.getByRole('listitem').filter({ has: page.getByRole('heading', { name, exact: true }) });

test('workflow sem versão publicada não pode ser o padrão', async ({ page }) => {
  await openList(page);
  await expect(cardOf(page, STANDARD).getByText('Padrão', { exact: true })).toBeVisible();
  await expect(
    cardOf(page, 'Piloto de obras').getByRole('button', { name: /Tornar Piloto de obras/ }),
  ).toBeDisabled();
  await expect(
    cardOf(page, 'Piloto de obras').getByText(
      'Publique uma versão e ative o workflow antes de torná-lo padrão.',
    ),
  ).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'lista de workflows');
});

test('torna a contratação direta o padrão com confirmação, toast e selo atualizado', async ({
  page,
}) => {
  await openList(page);
  await cardOf(page, DIRECT)
    .getByRole('button', { name: `Tornar ${DIRECT} o workflow padrão` })
    .click();
  const dialog = page.getByRole('dialog', { name: `Tornar "${DIRECT}" o workflow padrão?` });
  await expect(dialog.getByText(`Hoje o padrão é "${STANDARD}".`)).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'confirmação de tornar padrão');
  await dialog.getByRole('button', { name: 'Tornar padrão' }).click();

  await expect(page.getByText(`Workflow ${DIRECT} agora é o padrão.`)).toBeVisible();
  await expect(cardOf(page, DIRECT).getByText('Padrão', { exact: true })).toBeVisible();
  await expect(cardOf(page, STANDARD).getByText('Padrão', { exact: true })).toHaveCount(0);
});

test('no celular (360 px) a lista vira cartões sem rolagem horizontal e acessível', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await openList(page);
  await expect(cardOf(page, STANDARD)).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1),
  ).toBe(false);
  await expectNoSeriousA11yViolations(page, 'lista de workflows em 360 px');
});

// US-043 — editor de workflow.
const NEW_WORKFLOW = 'Obras — rito simplificado';

async function addStage(page: Page, name: string, type: string): Promise<void> {
  await page.getByRole('button', { name: 'Adicionar etapa' }).first().click();
  const panel = page.getByRole('region', { name: 'Nova etapa' });
  await panel.getByLabel('Nome', { exact: true }).fill(name);
  await panel.getByLabel('Tipo', { exact: true }).selectOption(type);
  await panel.getByRole('button', { name: 'Adicionar etapa' }).click();
  await expect(
    page.getByRole('button', { name: `Abrir as propriedades de ${name}` }),
  ).toBeVisible();
}

test('cria um workflow, adiciona etapas e transição e a recarga mantém o desenho', async ({
  page,
}) => {
  await openList(page);
  await page.getByRole('button', { name: 'Novo workflow' }).click();
  const dialog = page.getByRole('dialog', { name: 'Novo workflow' });
  await dialog.getByLabel('Nome').fill(NEW_WORKFLOW);
  await expect(dialog.getByLabel('Chave técnica')).toHaveValue('OBRAS_RITO_SIMPLIFICADO');
  await expectNoSeriousA11yViolations(page, 'novo workflow');
  await dialog.getByRole('button', { name: 'Criar e abrir o editor' }).click();

  await expect(page).toHaveURL(/\/admin\/workflows\/[0-9a-f-]+$/);
  await expect(page.getByText('Nenhuma etapa ainda — adicione a primeira.')).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'editor de workflow vazio');

  await addStage(page, 'Abertura', 'START');
  await addStage(page, 'Parecer jurídico', 'TASK');
  // Aprovação sem aprovador: mensagem no painel, sem salvar (V-03).
  await page.getByRole('button', { name: 'Adicionar etapa' }).first().click();
  const panel = page.getByRole('region', { name: 'Nova etapa' });
  await panel.getByLabel('Nome', { exact: true }).fill('Aprovação da autoridade');
  await panel.getByLabel('Tipo', { exact: true }).selectOption('APPROVAL');
  await panel.getByRole('button', { name: 'Adicionar etapa' }).click();
  await expect(panel.getByText('Selecione quem aprova esta etapa.')).toBeVisible();
  await panel.getByRole('button', { name: 'Fechar o painel' }).click();

  await page.getByRole('tab', { name: 'Transições' }).click();
  await page.getByRole('button', { name: 'Adicionar transição' }).click();
  const form = page.getByRole('dialog', { name: 'Nova transição' });
  await form.getByLabel('Rótulo do botão').fill('Encaminhar para o jurídico');
  await form.getByLabel('Etapa de origem').selectOption({ label: 'Abertura' });
  await form.getByLabel('Etapa de destino').selectOption({ label: 'Parecer jurídico' });
  await form.getByRole('button', { name: 'Adicionar transição' }).click();
  await expect(page.getByText('Abertura → Parecer jurídico')).toBeVisible();

  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Abrir as propriedades de Abertura' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Abrir as propriedades de Parecer jurídico' }),
  ).toBeVisible();
  // FA-04: setas no botão de reordenar (alternativa ao arrastar).
  await page
    .getByRole('button', { name: 'Reordenar Parecer jurídico (posição 2)' })
    .press('ArrowUp');
  await expect(
    page.getByRole('button', { name: 'Reordenar Parecer jurídico (posição 1)' }),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'Transições' }).click();
  await expect(page.getByText('Abertura → Parecer jurídico')).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'editor de workflow com etapas e transição');
});

test('"Criar rascunho" a partir da versão publicada libera a edição', async ({ page }) => {
  await openList(page);
  await page.getByRole('link', { name: STANDARD }).click();
  await expect(page.getByText(/Esta é a versão publicada/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Adicionar etapa' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Criar rascunho' }).click();
  await expect(page.getByText('Rascunho v2 criado.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Adicionar etapa' })).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'rascunho criado a partir da publicada');
});

test('no celular (360 px) o painel da etapa vira modal, sem rolagem horizontal', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await openList(page);
  await page.getByRole('link', { name: NEW_WORKFLOW }).click();
  await page.getByRole('button', { name: 'Abrir as propriedades de Abertura' }).click();
  await expect(page.getByRole('dialog', { name: 'Etapa Abertura' })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1),
  ).toBe(false);
  await expectNoSeriousA11yViolations(page, 'editor de workflow em 360 px');
});
