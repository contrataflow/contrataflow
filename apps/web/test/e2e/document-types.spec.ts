// E2E do SCR-108 (US-061): Administração › Tipos de documento — criar tipo, ligar a aprovação
// avulsa em tipo de sistema e desativar, com axe-core em cada estado. A API é simulada
// (support/mock-api.mjs); as regras de negócio e o isolamento por tenant são cobertos nos testes
// da API (módulo `document` e suíte tenant leak).
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/a11y';

// O catálogo da API simulada é global: os passos desta jornada rodam em série.
test.describe.configure({ mode: 'serial' });

async function openScreen(page: Page): Promise<void> {
  await page.goto(
    `/api/auth/login?as=ana&returnTo=${encodeURIComponent('/admin/tipos-documento')}`,
  );
  await expect(page).toHaveURL(/\/admin\/tipos-documento$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Tipos de documento' })).toBeVisible();
}

test('lista os tipos por natureza e passa na verificação de acessibilidade', async ({ page }) => {
  await openScreen(page);
  await expect(page.getByRole('heading', { level: 2, name: 'Estruturado' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Texto livre' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Arquivo externo' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Tipos de documento' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(
    page.getByRole('button', { name: /^Desativar Documento de Formalização/ }),
  ).toHaveCount(0);
  await expectNoSeriousA11yViolations(page, 'tipos de documento');
});

test('cria um tipo personalizado com a prévia da numeração', async ({ page }) => {
  await openScreen(page);
  await page.getByRole('button', { name: 'Novo tipo' }).click();
  const dialog = page.getByRole('dialog', { name: 'Novo tipo de documento' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Nome').fill('Parecer técnico');
  await expect(dialog.getByLabel('Código')).toHaveValue('PARECER_TECNICO');
  await dialog.getByLabel('Máscara de numeração').fill('PT {seq:3}/{year}');
  await expect(dialog.getByText(/Prévia: PT 001\/\d{4}/)).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'novo tipo de documento');

  await dialog.getByRole('button', { name: 'Salvar' }).click();
  await expect(
    page.getByText('Tipo de documento "Parecer técnico" criado.', { exact: true }),
  ).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('rowheader', { name: /Parecer técnico/ })).toBeVisible();
});

test('mostra o erro da máscara inválida sem enviar o formulário', async ({ page }) => {
  await openScreen(page);
  await page.getByRole('button', { name: 'Novo tipo' }).click();
  const dialog = page.getByRole('dialog', { name: 'Novo tipo de documento' });
  await dialog.getByLabel('Nome').fill('Memorando');
  await dialog.getByLabel('Máscara de numeração').fill('MEMO {seq:3}');
  await dialog.getByRole('button', { name: 'Salvar' }).click();
  await expect(
    dialog.getByText('A máscara deve conter {seq:N} e {year} e usar apenas os campos permitidos.'),
  ).toBeVisible();
  await expect(dialog).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'máscara inválida');
});

test('liga a aprovação avulsa em tipo de sistema, com campos restritos em texto', async ({
  page,
}) => {
  await openScreen(page);
  await page.getByRole('button', { name: 'Editar Ofício' }).click();
  const dialog = page.getByRole('dialog', { name: 'Editar Ofício' });
  await expect(dialog.getByText('Definido pela plataforma').first()).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Código' })).toHaveCount(0);
  await dialog.getByLabel('Exige aprovação avulsa').check();
  await expect(dialog.getByRole('group', { name: 'Quem aprova' })).toBeVisible();
  await dialog.getByLabel('Prazo da aprovação (dias)').fill('3');
  await expectNoSeriousA11yViolations(page, 'editar tipo de sistema');
  await dialog.getByRole('button', { name: 'Salvar' }).click();
  await expect(
    page.getByText('Tipo de documento "Ofício" atualizado.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('row', { name: /Ofício/ }).getByRole('cell', { name: 'Sim' }),
  ).toBeVisible();
});

test('desativa o tipo com confirmação e o reativa', async ({ page }) => {
  await openScreen(page);
  await page.getByRole('button', { name: 'Desativar Parecer técnico' }).click();
  const dialog = page.getByRole('dialog', { name: 'Desativar Parecer técnico?' });
  await expect(dialog).toContainText('Os documentos existentes continuam acessíveis.');
  await expectNoSeriousA11yViolations(page, 'confirmar desativação');
  await dialog.getByRole('button', { name: 'Desativar' }).click();
  await expect(
    page.getByText('Tipo de documento "Parecer técnico" desativado.', { exact: true }),
  ).toBeVisible();
  const row = page.getByRole('row', { name: /Parecer técnico/ });
  await expect(row.getByText('Inativo')).toBeVisible();

  await page.getByRole('button', { name: 'Reativar Parecer técnico' }).click();
  await expect(
    page.getByText('Tipo de documento "Parecer técnico" reativado.', { exact: true }),
  ).toBeVisible();
  await expect(row.getByText('Ativo', { exact: true })).toBeVisible();
});
