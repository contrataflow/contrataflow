// E2E do SCR-110 (US-106): Administração › Calendário — cadastrar, editar, desativar e excluir
// feriados, com axe-core em cada estado. A API é simulada (support/mock-api.mjs); o cálculo de dias
// úteis (CAL-05/CAL-06), a unicidade, a concorrência e o isolamento por tenant são cobertos nos
// testes da API (módulo `catalog` e suíte tenant leak).
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/a11y';
import { chooseOption } from './support/kit';

// Os feriados da API simulada são globais: os passos desta jornada rodam em série.
test.describe.configure({ mode: 'serial' });

async function openScreen(page: Page): Promise<void> {
  await page.goto(`/api/auth/login?as=ana&returnTo=${encodeURIComponent('/admin/calendario')}`);
  await expect(page).toHaveURL(/\/admin\/calendario$/);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Calendário de dias úteis' }),
  ).toBeVisible();
  // A API simulada guarda os feriados de 2026.
  await chooseOption(page, 'Ano', '2026');
  await expect(page.getByRole('table', { name: 'Feriados de 2026' })).toBeVisible();
}

/** Ação da linha no menu ⋯ (prd-5 · regra 3). */
async function rowAction(page: Page, name: string, action: string): Promise<void> {
  await page.getByRole('button', { name: `Ações de ${name}` }).click();
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}

/** Escolhe `aaaa-MM-dd` no `DatePicker` "Data *" do kit, que abre no mês corrente. */
async function pickDate(page: Page, dialog: Locator, iso: string): Promise<void> {
  const [year, month, day] = iso.split('-').map(Number) as [number, number, number];
  const today = new Date();
  const back = (today.getFullYear() - year) * 12 + today.getMonth() + 1 - month;
  await dialog.getByRole('button', { name: 'Data *' }).click();
  const calendar = page.getByRole('dialog', { name: 'Escolher data' });
  for (let step = 0; step < back; step += 1) {
    await calendar.getByRole('button', { name: 'Ir para o mês anterior' }).click();
  }
  await calendar
    .locator('td[role="gridcell"]:not([data-outside]) button')
    .getByText(String(day), { exact: true })
    .click();
}

test('lista os feriados de 2026 com os selos "Padrão do sistema" e "Recorrente", sem violações de acessibilidade', async ({
  page,
}) => {
  await openScreen(page);
  const natal = page.getByRole('row', { name: /Natal/ });
  await expect(natal.getByText('25/12/2026')).toBeVisible();
  await expect(natal.getByText('Padrão do sistema')).toBeVisible();
  await expect(natal.getByText('Recorrente')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Calendário' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  // FA-01: feriado de sistema não oferece "Excluir".
  await expectNoSeriousA11yViolations(page, 'calendário');
  await page.getByRole('button', { name: 'Ações de Natal' }).click();
  await expect(page.getByRole('menuitem', { name: 'Desativar' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Excluir' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Ações de Aniversário da cidade' }).click();
  await expect(page.getByRole('menuitem', { name: 'Excluir' })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('cadastra um feriado municipal e o vê na lista; o mesmo feriado de novo é recusado', async ({
  page,
}) => {
  await openScreen(page);
  await page.getByRole('button', { name: 'Novo feriado' }).click();
  const dialog = page.getByRole('dialog', { name: 'Novo feriado' });
  await expect(dialog).toBeVisible();
  await pickDate(page, dialog, '2026-03-19');
  await dialog.getByLabel('Nome *').fill('Dia de São José');
  await chooseOption(page, 'Escopo *', 'Municipal', dialog);
  await expectNoSeriousA11yViolations(page, 'novo feriado');
  await dialog.getByRole('button', { name: 'Salvar' }).click();
  await expect(dialog).toBeHidden();
  const row = page.getByRole('row', { name: /Dia de São José/ });
  await expect(row.getByText('19/03/2026')).toBeVisible();
  await expect(row.getByText('Municipal')).toBeVisible();

  await page.getByRole('button', { name: 'Novo feriado' }).click();
  const again = page.getByRole('dialog', { name: 'Novo feriado' });
  await pickDate(page, again, '2026-03-19');
  await again.getByLabel('Nome *').fill('dia de são josé');
  await chooseOption(page, 'Escopo *', 'Estadual', again);
  await again.getByRole('button', { name: 'Salvar' }).click();
  // Todo 409 de mutação abre o aviso global de conflito (error-policy); a mensagem específica
  // continua no formulário, que não é fechado.
  const conflict = page.getByRole('dialog', {
    name: 'Este registro foi alterado por outra pessoa.',
  });
  await expect(conflict).toBeVisible();
  await conflict.getByRole('button', { name: 'Cancelar' }).click();
  await expect(again.getByText('Já existe um feriado com esta data e nome.')).toBeVisible();
  await again.getByRole('button', { name: 'Cancelar' }).click();
});

test('data ausente: erro inline e nada é criado', async ({ page }) => {
  await openScreen(page);
  await page.getByRole('button', { name: 'Novo feriado' }).click();
  const dialog = page.getByRole('dialog', { name: 'Novo feriado' });
  await dialog.getByLabel('Nome *').fill('Sem data');
  await chooseOption(page, 'Escopo *', 'Estadual', dialog);
  await dialog.getByRole('button', { name: 'Salvar' }).click();
  await expect(dialog.getByText('Informe a data.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancelar' }).click();
  await expect(page.getByRole('row', { name: /Sem data/ })).toHaveCount(0);
});

test('edita a recorrência de um feriado próprio e vê o selo "Recorrente"', async ({ page }) => {
  await openScreen(page);
  await rowAction(page, 'Aniversário da cidade', 'Editar');
  const dialog = page.getByRole('dialog', { name: 'Editar Aniversário da cidade' });
  await expect(dialog.getByRole('button', { name: 'Data *' })).toBeDisabled();
  await dialog.getByRole('checkbox', { name: 'Repetir todos os anos' }).click();
  await dialog.getByRole('button', { name: 'Salvar' }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole('row', { name: /Aniversário da cidade/ }).getByText('Recorrente'),
  ).toBeVisible();
});

test('desativa um feriado de sistema com o aviso sem efeito retroativo e o reativa', async ({
  page,
}) => {
  await openScreen(page);
  await rowAction(page, 'Carnaval (terça-feira)', 'Desativar');
  const dialog = page.getByRole('dialog', { name: 'Desativar Carnaval (terça-feira)?' });
  await expect(dialog.getByText(/Prazos já gravados não são recalculados/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Desativar' }).click();
  const row = page.getByRole('row', { name: /Carnaval/ });
  await expect(row.getByText('Inativo')).toBeVisible();
  await rowAction(page, 'Carnaval (terça-feira)', 'Ativar');
  await expect(row.getByText('Ativo', { exact: true })).toBeVisible();
});

test('exclui um feriado próprio depois de confirmar', async ({ page }) => {
  await openScreen(page);
  await rowAction(page, 'Dia de São José', 'Excluir');
  const dialog = page.getByRole('dialog', { name: 'Excluir Dia de São José?' });
  await expectNoSeriousA11yViolations(page, 'excluir feriado');
  await dialog.getByRole('button', { name: 'Excluir' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('row', { name: /Dia de São José/ })).toHaveCount(0);
});
