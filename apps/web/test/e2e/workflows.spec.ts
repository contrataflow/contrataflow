// E2E do SCR-034 (US-042/US-043): Administração › Workflows — a lista com o selo "Padrão", "Tornar
// padrão" com confirmação e toast, a ação desabilitada para workflow sem versão publicada; o editor
// (criar workflow, adicionar etapas e transição, recarregar e confirmar a persistência, "Criar
// rascunho" a partir da publicada, reordenação pelo teclado), as regras do SCR-035 (US-044: criar
// `REQUIRED_DOCUMENT`, testá-la contra um processo e salvar), a aba "Versões" (US-045: validar →
// corrigir → publicar; a corrente única não é aposentada), o diagrama (US-046: só leitura,
// detalhes, versão aposentada), axe-core em cada estado e a largura de 360 px. A API é simulada
// (support/mock-api.mjs); seeder, aplicabilidade (WF-06), concorrência e isolamento por tenant são
// cobertos nos testes da API (módulo `workflow` e suíte tenant leak). A criação de processo de
// dispensa resolvendo o workflow chega com a US-001.
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/a11y';

// A lista da API simulada é global: os passos desta jornada rodam em série.
test.describe.configure({ mode: 'serial' });

const DIRECT = 'Contratação direta — Lei 14.133/2021, art. 72';
const STANDARD = 'Fase preparatória — Lei 14.133/2021';
/** Rótulos dos tipos de etapa no `Select` do painel. */
const STAGE_TYPE = { START: 'Início', TASK: 'Tarefa', APPROVAL: 'Aprovação' } as const;

async function openList(page: Page): Promise<void> {
  await page.goto(`/api/auth/login?as=ana&returnTo=${encodeURIComponent('/admin/workflows')}`);
  await expect(page).toHaveURL(/\/admin\/workflows$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Workflows' })).toBeVisible();
}

const rowOf = (page: Page, name: string) =>
  page.getByRole('row').filter({ has: page.getByRole('link', { name, exact: true }) });

/** Escolhe a opção num `Select` do kit (combobox do Radix). */
async function choose(scope: Page | Locator, field: string, option: string) {
  await scope.getByRole('combobox', { name: field, exact: true }).click();
  // As opções abrem num portal, fora do escopo do campo.
  const root = 'page' in scope ? scope.page() : scope;
  await root.getByRole('option', { name: option, exact: true }).click();
}

/** Abre o menu ⋯ da linha (prd-5 · regra 3). */
async function openRowMenu(page: Page, menu: string): Promise<void> {
  await page.getByRole('button', { name: menu }).click();
}

/** Abre o editor e, pelo menu "Mais", as regras da versão. */
async function openRules(page: Page): Promise<void> {
  await page.getByRole('link', { name: NEW_WORKFLOW, exact: true }).click();
  await page.getByRole('button', { name: 'Mais' }).click();
  await page.getByRole('menuitem', { name: 'Regras da versão' }).click();
}

test('workflow sem versão publicada não pode ser o padrão', async ({ page }) => {
  await openList(page);
  await expect(rowOf(page, STANDARD).getByText('Padrão', { exact: true })).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'lista de workflows');
  await openRowMenu(page, 'Ações de Piloto de obras');
  await expect(page.getByRole('menuitem', { name: 'Tornar padrão' })).toBeDisabled();
  await expect(
    page.getByText('Publique uma versão e ative o workflow antes de torná-lo padrão.'),
  ).toBeVisible();
  await page.keyboard.press('Escape');
});

test('torna a contratação direta o padrão com confirmação, toast e selo atualizado', async ({
  page,
}) => {
  await openList(page);
  await openRowMenu(page, `Ações de ${DIRECT}`);
  await page.getByRole('menuitem', { name: 'Tornar padrão' }).click();
  const dialog = page.getByRole('dialog', { name: `Tornar "${DIRECT}" o workflow padrão?` });
  await expect(dialog.getByText(`Hoje o padrão é "${STANDARD}".`)).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'confirmação de tornar padrão');
  await dialog.getByRole('button', { name: 'Tornar padrão' }).click();

  await expect(
    page.getByText(`Workflow ${DIRECT} agora é o padrão.`, { exact: true }),
  ).toBeVisible();
  await expect(rowOf(page, DIRECT).getByText('Padrão', { exact: true })).toBeVisible();
  await expect(rowOf(page, STANDARD).getByText('Padrão', { exact: true })).toHaveCount(0);
});

test('no celular (360 px) a lista não rola na horizontal e é acessível', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await openList(page);
  await expect(rowOf(page, STANDARD)).toBeVisible();
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
  await choose(panel, 'Tipo', type);
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
  await dialog.getByLabel(/^Nome/).fill(NEW_WORKFLOW);
  await expect(dialog.getByLabel(/^Chave técnica/)).toHaveValue('OBRAS_RITO_SIMPLIFICADO');
  await expectNoSeriousA11yViolations(page, 'novo workflow');
  await dialog.getByRole('button', { name: 'Criar e abrir o editor' }).click();

  await expect(page).toHaveURL(/\/admin\/workflows\/[0-9a-f-]+$/);
  await expect(page.getByText('Nenhuma etapa ainda — adicione a primeira.')).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'editor de workflow vazio');

  await addStage(page, 'Abertura', STAGE_TYPE.START);
  await addStage(page, 'Parecer jurídico', STAGE_TYPE.TASK);
  // Aprovação sem aprovador: mensagem no painel, sem salvar (V-03).
  await page.getByRole('button', { name: 'Adicionar etapa' }).first().click();
  const panel = page.getByRole('region', { name: 'Nova etapa' });
  await panel.getByLabel('Nome', { exact: true }).fill('Aprovação da autoridade');
  await choose(panel, 'Tipo', STAGE_TYPE.APPROVAL);
  await panel.getByRole('button', { name: 'Adicionar etapa' }).click();
  await expect(panel.getByText('Selecione quem aprova esta etapa.')).toBeVisible();
  await panel.getByRole('button', { name: 'Fechar o painel' }).click();

  await page.getByRole('tab', { name: 'Transições' }).click();
  await page.getByRole('button', { name: 'Adicionar transição' }).click();
  const form = page.getByRole('dialog', { name: 'Nova transição' });
  await form.getByLabel('Rótulo do botão').fill('Encaminhar para o jurídico');
  await choose(form, 'Etapa de origem', 'Abertura');
  await choose(form, 'Etapa de destino', 'Parecer jurídico');
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
  await page.getByRole('link', { name: STANDARD, exact: true }).click();
  await expect(page.getByText(/Esta é a versão publicada/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Adicionar etapa' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Criar rascunho' }).click();
  await expect(page.getByText('Rascunho v2 criado.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Adicionar etapa' })).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'rascunho criado a partir da publicada');
});

test('versões (US-045): validar → corrigir → publicar; a corrente única não é aposentada', async ({
  page,
}) => {
  await openList(page);
  await page.getByRole('link', { name: STANDARD, exact: true }).click();
  await page.getByRole('tab', { name: 'Versões' }).click();
  const versions = page.getByRole('tabpanel', { name: 'Versões' });
  await expect(versions.getByRole('button', { name: 'Publicar' })).toBeDisabled();

  // FA-05: sem etapa inicial, a validação bloqueia e leva à aba "Etapas".
  await versions.getByRole('button', { name: 'Validar' }).click();
  await expect(versions.getByText(/precisa de exatamente uma etapa inicial/)).toBeVisible();
  await expect(versions.getByRole('button', { name: 'Publicar' })).toBeDisabled();
  await expectNoSeriousA11yViolations(page, 'validação com erro');
  await versions.getByRole('button', { name: 'Ir para as etapas' }).click();
  await addStage(page, 'Abertura', STAGE_TYPE.START);

  await page.getByRole('tab', { name: 'Versões' }).click();
  await versions.getByRole('button', { name: 'Validar' }).click();
  await expect(
    versions.getByText('Nenhum erro bloqueante. A versão pode ser publicada.'),
  ).toBeVisible();
  await versions.getByRole('button', { name: 'Publicar' }).click();
  const dialog = page.getByRole('dialog', { name: 'Publicar a versão 2' });
  await dialog.getByRole('button', { name: 'Publicar' }).click();
  await expect(dialog.getByText('Descreva o que mudou nesta versão.')).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'diálogo de publicação');
  await dialog.getByLabel('Notas da versão (obrigatório)').fill('Inclui a etapa de abertura.');
  await dialog.getByRole('button', { name: 'Publicar' }).click();
  await expect(page.getByText('Versão 2 publicada', { exact: true })).toBeVisible();

  await expect(versions.getByText('Inclui a etapa de abertura.').first()).toBeVisible();
  await expect(versions.getByText('Aposentada').first()).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'histórico de versões');
  await versions.getByRole('button', { name: 'Ações da versão 2' }).click();
  await expect(page.getByRole('menuitem', { name: 'Aposentar' })).toBeDisabled();
});

test('diagrama (US-046): nós e arestas só leitura, detalhes e a versão aposentada', async ({
  page,
}) => {
  await openList(page);
  await page.getByRole('link', { name: NEW_WORKFLOW, exact: true }).click();
  await page.getByRole('tab', { name: 'Diagrama' }).click();
  const diagram = page.getByRole('tabpanel', { name: 'Diagrama' });
  await expect(
    diagram.getByRole('list', { name: 'Etapas do diagrama' }).getByRole('button'),
  ).toHaveCount(2);
  await expect(
    diagram.getByRole('list', { name: 'Transições do diagrama' }).getByRole('button'),
  ).toHaveCount(1);
  await diagram.getByRole('button', { name: /^Etapa Parecer jurídico, tipo Tarefa/ }).click();
  await expect(
    diagram.getByRole('complementary', { name: 'Etapa Parecer jurídico' }),
  ).toBeVisible();
  // RN-WF-70: nada se cria, edita ou exclui a partir do diagrama.
  await expect(diagram.getByRole('button', { name: /Adicionar|Excluir|Salvar/ })).toHaveCount(0);
  await diagram.getByRole('button', { name: 'Aproximar' }).click();
  await diagram.getByRole('button', { name: 'Ajustar à tela' }).click();
  await expectNoSeriousA11yViolations(page, 'diagrama do workflow');

  // FA-03: a versão aposentada abre normalmente, com o aviso no topo.
  await openList(page);
  await page.getByRole('link', { name: STANDARD, exact: true }).click();
  await page.getByRole('tab', { name: 'Diagrama' }).click();
  await choose(diagram, 'Versão exibida', 'Versão 1 — Aposentada');
  await expect(diagram.getByText('Esta versão está aposentada')).toBeVisible();
  await expect(diagram.getByText('Nenhuma etapa criada ainda')).toBeVisible();
  await choose(diagram, 'Versão exibida', 'Versão 2 — Publicada');
  await expect(
    diagram.getByRole('list', { name: 'Etapas do diagrama' }).getByRole('button'),
  ).toHaveCount(1);
  await expectNoSeriousA11yViolations(page, 'diagrama de versão publicada');
});

test('no celular (360 px) o diagrama abre ajustado, sem rolagem horizontal', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await openList(page);
  await page.getByRole('link', { name: NEW_WORKFLOW, exact: true }).click();
  await page.getByRole('tab', { name: 'Diagrama' }).click();
  const diagram = page.getByRole('tabpanel', { name: 'Diagrama' });
  await expect(diagram.getByRole('button', { name: 'Minimapa' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(diagram.getByRole('button', { name: /^Minimapa:/ })).toHaveCount(0);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1),
  ).toBe(false);
  await expectNoSeriousA11yViolations(page, 'diagrama em 360 px');
});

test('no celular (360 px) o painel da etapa vira modal, sem rolagem horizontal', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await openList(page);
  await page.getByRole('link', { name: NEW_WORKFLOW, exact: true }).click();
  await page.getByRole('button', { name: 'Abrir as propriedades de Abertura' }).click();
  await expect(page.getByRole('dialog', { name: 'Etapa Abertura' })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1),
  ).toBe(false);
  await expectNoSeriousA11yViolations(page, 'editor de workflow em 360 px');
});

test('regras (SCR-035): cria REQUIRED_DOCUMENT, testa contra um processo e a recarga mantém', async ({
  page,
}) => {
  await openList(page);
  await openRules(page);
  await expect(page).toHaveURL(/\/admin\/workflows\/[0-9a-f-]+\/regras$/);
  await expect(page.getByText('Nenhuma regra configurada para esta etapa.')).toBeVisible();

  await page.getByRole('button', { name: 'Nova regra' }).click();
  const form = page.getByRole('dialog', { name: 'Nova regra' });
  await choose(form, 'Tipo de documento', 'ETP — Estudo Técnico Preliminar');
  await choose(form, 'Situação mínima', 'Completo');
  await form.getByLabel('Nome', { exact: true }).fill('ETP completo');
  await form.getByLabel('Mensagem ao usuário').fill('O ETP deve estar completo.');
  await expectNoSeriousA11yViolations(page, 'formulário de regra');

  // FA-03: o teste roda antes de salvar, sem gravar nada.
  await form.getByLabel('Processo de referência').fill('0012');
  await form.getByRole('button', { name: '0012/2026 — Aquisição de notebooks' }).click();
  await form.getByRole('button', { name: 'Testar regra' }).click();
  await expect(form.getByText('Não satisfeita — O ETP deve estar completo.')).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'resultado do teste de regra');

  await form.getByRole('button', { name: 'Criar regra' }).click();
  await expect(form).toBeHidden();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Ações da regra ETP completo' })).toBeVisible();
  await expect(page.getByText('ETP · COMPLETE')).toBeVisible();
});

test('no celular (360 px) as regras ficam em coluna única, sem rolagem horizontal', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await openList(page);
  await openRules(page);
  await expect(page.getByRole('button', { name: 'Ações da regra ETP completo' })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1),
  ).toBe(false);
  await expectNoSeriousA11yViolations(page, 'regras em 360 px');
});
