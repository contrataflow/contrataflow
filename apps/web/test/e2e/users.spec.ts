// E2E do SCR-029 (US-091/US-092): convidar usuário → convite pendente listado → reenviar → cancelar,
// a sugestão de reenvio quando a pessoa já tem vínculo e, no detalhe de um usuário de teste
// (Diego), editar o cargo, trocar a lotação principal, suspender e reativar e — US-096 — atribuir
// e revogar perfis (com o bloqueio do último administrador), com axe-core nas telas e na largura
// de 360 px. A API é simulada (support/mock-api.mjs): Ana tem USER_VIEW/
// USER_INVITE/USER_MANAGE/ROLE_VIEW. Regras de vínculo (POL-12/16) e isolamento por tenant:
// testes da API (módulo `identity` e suíte tenant leak).
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/a11y';

// O cadastro da API simulada é global: os passos desta jornada rodam em série.
test.describe.configure({ mode: 'serial' });

async function openList(page: Page): Promise<void> {
  await page.goto(`/api/auth/login?as=ana&returnTo=${encodeURIComponent('/admin/usuarios')}`);
  await expect(page).toHaveURL(/\/admin\/usuarios$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Usuários' })).toBeVisible();
}

test('lista vazia de convites pendentes; sem violações de acessibilidade', async ({ page }) => {
  await openList(page);
  await expect(page.getByText('Nenhum convite pendente')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Convidar usuário' })).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'convites pendentes (vazio)');
});

test('convida um usuário interno e o convite aparece na lista pendente', async ({ page }) => {
  await openList(page);
  await page.getByRole('button', { name: 'Convidar usuário' }).click();
  const dialog = page.getByRole('dialog', { name: 'Convidar usuário' });
  await expect(dialog.getByLabel('E-mail *')).toBeFocused();

  // Validação no cliente: o foco vai ao primeiro campo com erro.
  await dialog.getByLabel('E-mail *').fill('sem-arroba');
  await dialog.getByRole('button', { name: 'Enviar convite' }).click();
  await expect(dialog.getByText('Informe um e-mail válido.')).toBeVisible();
  await expect(dialog.getByLabel('E-mail *')).toBeFocused();

  await dialog.getByLabel('E-mail *').fill('marta@exemplo.gov.br');
  await dialog.getByLabel('Nome *').fill('Marta Lima');
  await dialog.getByLabel('Cargo ou função').fill('Engenheira');
  await dialog.getByRole('checkbox', { name: 'Gabinete', exact: true }).check();
  await expect(dialog.getByRole('list', { name: 'Unidades selecionadas' })).toContainText(
    'Gabinete',
  );
  await expectNoSeriousA11yViolations(page, 'formulário de convite');

  await dialog.getByRole('button', { name: 'Enviar convite' }).click();
  await expect(
    page.getByText('Convite enviado para marta@exemplo.gov.br.', { exact: true }),
  ).toBeVisible();
  await expect(dialog).toBeHidden();
  const row = page.getByRole('row', { name: /Marta Lima/ });
  await expect(row).toContainText('marta@exemplo.gov.br');
  await expect(row).toContainText('Interno');
  await expectNoSeriousA11yViolations(page, 'convites pendentes');
});

test('vínculo externo exige a validade e a pessoa que já tem vínculo recebe a sugestão de reenvio', async ({
  page,
}) => {
  await openList(page);
  await page.getByRole('button', { name: 'Convidar usuário' }).click();
  const dialog = page.getByRole('dialog', { name: 'Convidar usuário' });
  await dialog.getByLabel('E-mail *').fill('existente@exemplo.gov.br');
  await dialog.getByLabel('Nome *').fill('Pessoa Existente');
  await dialog.getByLabel('Tipo de vínculo *').selectOption('EXTERNAL');
  await dialog.getByRole('button', { name: 'Enviar convite' }).click();
  await expect(dialog.getByText('Informe a validade do vínculo externo.')).toBeVisible();
  await expect(dialog.getByLabel('Validade do vínculo *')).toBeFocused();

  await dialog.getByLabel('Validade do vínculo *').fill('2099-12-31');
  await dialog.getByRole('button', { name: 'Enviar convite' }).click();
  await expect(
    dialog.getByText('Esta pessoa já tem um vínculo com esta instituição.'),
  ).toBeVisible();
  await expect(dialog.getByText(/use "Reenviar" na lista de convites/)).toBeVisible();
  // Os dados continuam no formulário.
  await expect(dialog.getByLabel('Nome *')).toHaveValue('Pessoa Existente');
  await expectNoSeriousA11yViolations(page, 'convite duplicado');
});

test('reenvia e cancela um convite pendente (com confirmação)', async ({ page }) => {
  await openList(page);
  const row = page.getByRole('row', { name: /Marta Lima/ });
  await row.getByRole('button', { name: 'Reenviar convite para Marta Lima' }).click();
  await expect(
    page.getByText('Convite reenviado para marta@exemplo.gov.br.', { exact: true }),
  ).toBeVisible();

  await row.getByRole('button', { name: 'Cancelar convite de Marta Lima' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Cancelar o convite de Marta Lima?' });
  await expectNoSeriousA11yViolations(page, 'cancelar convite');
  await confirm.getByRole('button', { name: 'Cancelar convite' }).click();
  await expect(page.getByText('Convite de Marta Lima cancelado.', { exact: true })).toBeVisible();
  await expect(page.getByText('Nenhum convite pendente')).toBeVisible();
});

async function openDetail(page: Page): Promise<void> {
  await openList(page);
  await page.getByRole('link', { name: 'Diego Ramos' }).click();
  await expect(page).toHaveURL(/\/admin\/usuarios\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Diego Ramos' })).toBeVisible();
}

test('a lista de usuários mostra o vínculo, busca por nome e tem estado vazio', async ({
  page,
}) => {
  await openList(page);
  const table = page.getByRole('table', { name: 'Usuários da instituição' });
  const row = table.getByRole('row', { name: /Diego Ramos/ });
  await expect(row).toContainText('diego@exemplo.gov.br');
  await expect(row).toContainText('Ativo');
  await expect(row).toContainText('Interno');
  await expectNoSeriousA11yViolations(page, 'lista de usuários');

  await page.getByRole('searchbox', { name: 'Buscar por nome ou e-mail' }).fill('zzzz');
  await expect(page.getByText('Nenhum usuário encontrado')).toBeVisible();
  await page.getByRole('searchbox', { name: 'Buscar por nome ou e-mail' }).fill('dieg');
  await expect(table.getByRole('row', { name: /Diego Ramos/ })).toBeVisible();
  await page.getByLabel('Status', { exact: true }).selectOption('SUSPENDED');
  await expect(page.getByText('Nenhum usuário encontrado')).toBeVisible();
});

test('edita o cargo do usuário e o dado persiste', async ({ page }) => {
  await openDetail(page);
  const cargo = page.getByRole('textbox', { name: 'Cargo ou função' });
  await expect(cargo).toBeFocused();
  await expectNoSeriousA11yViolations(page, 'detalhe do usuário');

  await cargo.fill('x'.repeat(151));
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(page.getByText('O cargo deve ter no máximo 150 caracteres.')).toBeVisible();
  await expect(cargo).toBeFocused();

  await cargo.fill('Coordenador de Compras');
  await page.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(
    page.getByText('Dados do vínculo de Diego Ramos atualizados.', { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Cargo ou função' })).toHaveValue(
    'Coordenador de Compras',
  );
});

test('troca a lotação principal do usuário', async ({ page }) => {
  await openDetail(page);
  const selected = page.getByRole('list', { name: 'Unidades selecionadas' });
  await expect(selected).toContainText('Gabinete');
  await page.getByRole('checkbox', { name: 'Licitações', exact: true }).check();
  await page.getByRole('radio', { name: 'Lotação principal: Licitações' }).check();
  await page.getByRole('button', { name: 'Remover Gabinete' }).click();
  await expectNoSeriousA11yViolations(page, 'lotações do usuário');

  await page.getByRole('button', { name: 'Salvar lotações' }).click();
  await expect(
    page.getByText('Lotações de Diego Ramos atualizadas.', { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByRole('list', { name: 'Unidades selecionadas' })).toContainText(
    'Licitações',
  );
  await expect(page.getByRole('radio', { name: 'Lotação principal: Licitações' })).toBeChecked();
});

test('suspende e reativa o usuário (com confirmação e motivo)', async ({ page }) => {
  await openDetail(page);
  await page.getByRole('button', { name: 'Suspender acesso' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Suspender o acesso de Diego Ramos?' });
  await expect(dialog.getByRole('textbox', { name: 'Motivo (opcional)' })).toBeFocused();
  await expectNoSeriousA11yViolations(page, 'suspender usuário');
  await dialog.getByRole('textbox', { name: 'Motivo (opcional)' }).fill('Licença');
  await dialog.getByRole('button', { name: 'Suspender acesso' }).click();
  await expect(page.getByText('Acesso de Diego Ramos suspenso.', { exact: true })).toBeVisible();
  await expect(page.getByText('Motivo: Licença')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Suspender acesso' })).toBeHidden();
  await expectNoSeriousA11yViolations(page, 'usuário suspenso');

  await page.getByRole('button', { name: 'Reativar' }).click();
  await expect(page.getByText('Acesso de Diego Ramos reativado.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Suspender acesso' })).toBeVisible();
});

test('perfis e acessos: atribui e revoga um perfil; o último administrador fica protegido', async ({
  page,
}) => {
  await openDetail(page);
  const list = page.getByRole('list', { name: 'Perfis atribuídos' });
  await expect(list).toContainText('Administrador do órgão');

  // US-096 · POL-12: Diego é o único administrador — a revogação é recusada com a sugestão.
  await page.getByRole('button', { name: 'Revogar o perfil Administrador do órgão' }).click();
  const blocked = page.getByRole('alertdialog', {
    name: 'Revogar o perfil Administrador do órgão?',
  });
  await expect(blocked.getByRole('textbox', { name: 'Motivo (opcional)' })).toBeFocused();
  await blocked.getByRole('button', { name: 'Revogar perfil' }).click();
  await expect(
    blocked.getByText('É preciso manter ao menos um administrador ativo.'),
  ).toBeVisible();
  await expect(
    blocked.getByText(/Atribua o perfil Administrador do órgão a outra pessoa/),
  ).toBeVisible();
  await blocked.getByRole('button', { name: 'Cancelar' }).click();

  // Atribui o Auditor (escopo de toda a instituição) e o revoga.
  await page.getByRole('button', { name: 'Atribuir perfil' }).click();
  const dialog = page.getByRole('dialog', { name: 'Atribuir perfil a Diego Ramos' });
  const perfil = dialog.getByRole('combobox', { name: 'Perfil' });
  await expect(perfil).toBeFocused();
  await dialog.getByRole('button', { name: 'Atribuir', exact: true }).click();
  await expect(dialog.getByText('Selecione o perfil e o escopo.')).toBeVisible();
  await perfil.selectOption({ label: 'Auditor' });
  await expectNoSeriousA11yViolations(page, 'atribuir perfil');
  await dialog.getByRole('button', { name: 'Atribuir', exact: true }).click();
  await expect(page.getByText('Perfil atribuído: Auditor.', { exact: true })).toBeVisible();
  await expect(list).toContainText('Auditor');

  await page.getByRole('button', { name: 'Revogar o perfil Auditor' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Revogar o perfil Auditor?' });
  await confirm.getByRole('textbox', { name: 'Motivo (opcional)' }).fill('Fim da auditoria');
  await confirm.getByRole('button', { name: 'Revogar perfil' }).click();
  await expect(page.getByText('Perfil revogado: Auditor.', { exact: true })).toBeVisible();
  await expect(list).not.toContainText('Auditor');
  await expectNoSeriousA11yViolations(page, 'perfis e acessos');
});

test('no celular (360 px) a lista vira cartões e o detalhe é acessível', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await openList(page);
  await expect(page.getByRole('link', { name: 'Diego Ramos' })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1),
  ).toBe(false);
  await expectNoSeriousA11yViolations(page, 'lista de usuários em 360 px');

  await page.getByRole('link', { name: 'Diego Ramos' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Diego Ramos' })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1),
  ).toBe(false);
  await expectNoSeriousA11yViolations(page, 'detalhe do usuário em 360 px');
});
