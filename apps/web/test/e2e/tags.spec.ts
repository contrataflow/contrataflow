// E2E das etiquetas do processo (US-007 · SCR-109 aba "Etiquetas", SCR-006 e SCR-004): a gestora
// cadastra a etiqueta, aplica ao processo no cabeçalho, filtra a lista por ela, desativa e vê a
// etiqueta esmaecida com "(inativa)" — que ainda pode ser removida. axe-core nos diálogos e o
// seletor utilizável em 360 px. A API é simulada (support/mock-api.mjs); unicidade, limite de 10,
// paleta, custódia e versão são cobertos nos testes da API.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/a11y';

// O cadastro e os vínculos da API simulada são globais: os passos desta jornada rodam em série.
test.describe.configure({ mode: 'serial' });

const TAG = `Obras emergenciais ${String(Date.now())}`;
/** Processo 0012/2026 da lista simulada (`listProcessId(12)`). */
const PROCESS_PATH = '/processos/0192a000-0000-7000-8000-000000100012';
const TABLE = 'Processos encontrados';

async function loginAt(page: Page, path: string): Promise<void> {
  await page.goto(`/api/auth/login?as=ana&returnTo=${encodeURIComponent(path)}`);
}

async function openProcess(page: Page): Promise<void> {
  await loginAt(page, PROCESS_PATH);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Aquisição de cimento para manutenção de vias' }),
  ).toBeVisible();
}

async function openTagsAdmin(page: Page): Promise<void> {
  await loginAt(page, '/admin/catalogos');
  await page.getByRole('tab', { name: 'Etiquetas' }).click();
  await expect(page.getByRole('table', { name: 'Etiquetas do órgão' })).toBeVisible();
}

test('cadastrar a etiqueta na aba "Etiquetas" da administração', async ({ page }) => {
  await loginAt(page, '/admin/catalogos');
  await page.getByRole('tab', { name: 'Etiquetas' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Etiquetas' })).toBeVisible();
  await page.getByRole('button', { name: 'Nova etiqueta' }).click();
  const dialog = page.getByRole('dialog', { name: 'Nova etiqueta' });
  await dialog.getByLabel('Nome').fill(TAG);
  await dialog.getByRole('radio', { name: 'Âmbar' }).click();
  await expect(dialog.getByRole('radio', { name: 'Âmbar' })).toBeChecked();
  await expectNoSeriousA11yViolations(page, 'formulário de etiqueta');
  await dialog.getByRole('button', { name: 'Salvar etiqueta' }).click();
  await expect(dialog).toBeHidden();
  const table = page.getByRole('table', { name: 'Etiquetas do órgão' });
  await expect(table.getByText(TAG)).toBeVisible();
  await expect(table.getByRole('cell', { name: 'Ativa', exact: true })).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'aba Etiquetas');
});

test('aplicar a etiqueta no cabeçalho do processo (2 cliques) e vê-la no painel', async ({
  page,
}) => {
  await openProcess(page);
  await page.getByRole('button', { name: 'Etiquetas', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Etiquetas do processo' });
  await expect(dialog.getByText('0/10')).toBeVisible();
  await dialog.getByRole('option', { name: new RegExp(TAG) }).click();
  await expect(dialog.getByText('1/10')).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'seletor de etiquetas');
  await dialog.getByRole('button', { name: 'Aplicar etiquetas' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('list', { name: 'Etiquetas' }).getByText(TAG)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Etiquetas (1)' })).toBeVisible();
});

test('filtrar a lista de processos pela etiqueta', async ({ page }) => {
  await loginAt(page, '/processos');
  const table = page.getByRole('table', { name: TABLE });
  await expect(table).toBeVisible();
  await expect(table.getByRole('row')).toHaveCount(4); // cabeçalho + 3 processos
  // A lista abre com o filtro padrão de situação: o botão traz o contador ("Filtros, 1 filtro ativo").
  await page.getByRole('button', { name: /^Filtros/ }).click();
  const filters = page.getByRole('dialog');
  await filters
    .getByRole('group', { name: 'Etiquetas', exact: true })
    .getByRole('checkbox', { name: TAG })
    .check();
  await filters.getByRole('button', { name: 'Aplicar filtros' }).click();
  await expect(page).toHaveURL(/tagId=/);
  await expect(table.getByRole('row')).toHaveCount(2); // cabeçalho + 0012/2026
  await expect(table.getByText('0012/2026')).toBeVisible();
});

test('desativar a etiqueta: continua no processo, esmaecida com "(inativa)", e pode ser removida', async ({
  page,
}) => {
  await openTagsAdmin(page);
  await page.getByRole('button', { name: `Desativar a etiqueta ${TAG}` }).click();
  const row = page.getByRole('table', { name: 'Etiquetas do órgão' }).getByRole('row', {
    name: new RegExp(TAG),
  });
  await expect(row.getByRole('cell', { name: 'Inativa', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: `Reativar a etiqueta ${TAG}` })).toBeVisible();

  await openProcess(page);
  const chips = page.getByRole('list', { name: 'Etiquetas' });
  await expect(chips.getByText(TAG)).toBeVisible();
  await expect(chips.getByText('(inativa)')).toBeVisible();

  // Inativa já aplicada: aparece marcada e pode ser removida.
  await page.getByRole('button', { name: 'Etiquetas (1)' }).click();
  const dialog = page.getByRole('dialog', { name: 'Etiquetas do processo' });
  const option = dialog.getByRole('option', { name: new RegExp(TAG) });
  await expect(option).toHaveAttribute('aria-selected', 'true');
  await option.click();
  await expect(option).toHaveAttribute('aria-selected', 'false');
  await dialog.getByRole('button', { name: 'Aplicar etiquetas' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('list', { name: 'Etiquetas' })).toHaveCount(0);
});

test('em 360 px: o seletor abre em painel inferior, cabe na tela e é acessível', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await openProcess(page);
  await page.getByRole('button', { name: 'Etiquetas', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Etiquetas do processo' });
  await expect(dialog.getByRole('combobox', { name: 'Buscar etiqueta' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Aplicar etiquetas' })).toBeInViewport();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await expectNoSeriousA11yViolations(page, 'seletor de etiquetas · 360 px');
});
