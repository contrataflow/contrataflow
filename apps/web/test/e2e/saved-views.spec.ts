// E2E das visões salvas e da exportação CSV da lista de processos (US-003 · SCR-004): Ana filtra os
// atrasados, salva a visão, solta e reaplica pelo seletor, a define como padrão (reabre aplicada),
// exporta o CSV e confere o arquivo baixado (BOM, `;`, só as colunas da tela) e exclui a visão.
// Uma visão compartilhada pela Beatriz com uma unidade que não existe mais mostra o aviso de
// filtros ignorados. axe-core nos diálogos e em 360 px. A API é simulada (support/mock-api.mjs);
// unicidade, limite, mascaramento POL-09 e a neutralização real de fórmulas são cobertos nos testes
// da API.
import { readFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/a11y';

// As visões e os processos da API simulada são globais: os passos desta jornada rodam em série.
test.describe.configure({ mode: 'serial' });

const VIEW_NAME = `Atrasados por prioridade ${String(Date.now())}`;
const TABLE = 'Processos encontrados';

async function openList(page: Page, path = '/processos'): Promise<void> {
  await page.goto(`/api/auth/login?as=ana&returnTo=${encodeURIComponent(path)}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Processos' })).toBeVisible();
  await expect(page.getByRole('table', { name: TABLE })).toBeVisible();
}

const rows = (page: Page) => page.getByRole('table', { name: TABLE }).getByRole('row');

test('salvar a visão → aplicar → definir como padrão → exportar o CSV → excluir', async ({
  page,
}) => {
  await openList(page);
  await expect(rows(page)).toHaveCount(4); // cabeçalho + 3 processos
  await page.getByRole('link', { name: /^Atrasados/ }).click();
  await expect(page).toHaveURL(/overdue=true/);
  await expect(rows(page)).toHaveCount(2);

  // Salvar a visão com os critérios da tela.
  await page.getByRole('button', { name: 'Salvar visão' }).click();
  const save = page.getByRole('dialog', { name: 'Salvar visão' });
  await expect(save.getByText(/Atrasados/)).toBeVisible();
  await save.getByLabel('Nome da visão *').fill(VIEW_NAME);
  await expectNoSeriousA11yViolations(page, 'diálogo Salvar visão');
  await save.getByRole('button', { name: 'Salvar', exact: true }).click();
  await expect(save).toBeHidden();
  await expect(page.getByText(`Visão: ${VIEW_NAME}`)).toBeVisible();
  await expect(page.getByText('Alterações não salvas')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Salvar visão' })).toBeFocused();

  // Soltar a visão (volta ao padrão da tela) e reaplicá-la pelo seletor.
  await page.getByRole('button', { name: new RegExp(`^Limpar a visão ${VIEW_NAME}`) }).click();
  await expect(rows(page)).toHaveCount(4);
  await page.getByRole('combobox', { name: 'Visão' }).click();
  await page.getByRole('option', { name: VIEW_NAME }).click();
  await expect(page).toHaveURL(/overdue=true/);
  await expect(rows(page)).toHaveCount(2);
  await expect(page.getByText(`Visão: ${VIEW_NAME}`)).toBeVisible();

  // Exportar a consulta atual.
  await page.getByRole('button', { name: 'Exportar CSV' }).click();
  const exportDialog = page.getByRole('dialog', { name: 'Exportar CSV' });
  await expect(exportDialog.getByText('1 processo na consulta atual')).toBeVisible();
  await expect(exportDialog.getByRole('list', { name: 'Colunas do arquivo' })).toContainText(
    'Situação',
  );
  await expectNoSeriousA11yViolations(page, 'diálogo Exportar CSV');
  const downloadPromise = page.waitForEvent('download');
  await exportDialog.getByRole('button', { name: 'Exportar', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('processos-20261005-1432.csv');
  const content = await readFile(await download.path(), 'utf8');
  // Colunas na ordem da tela (padrão da repaginação: Número, Objeto, Secretaria, …).
  expect(content.startsWith('\uFEFFCódigo;Título;')).toBe(true);
  expect(content).toContain('0045/2026;Aquisição de medicamentos da farmácia básica;');
  expect(content).not.toContain('0012/2026');
  expect(content).toContain('\r\n');
  await expect(page.getByText('Exportação concluída: 1 processo.', { exact: true })).toBeVisible();
  await expect(exportDialog).toBeHidden();

  // Definir como padrão em "Gerenciar visões".
  await page.getByRole('button', { name: 'Ações da visão' }).click();
  await page.getByRole('menuitem', { name: 'Gerenciar visões' }).click();
  const manage = page.getByRole('dialog', { name: 'Gerenciar visões' });
  await manage.getByRole('button', { name: `Usar a visão ${VIEW_NAME} como padrão` }).click();
  await expect(manage.getByText('Padrão', { exact: true })).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'diálogo Gerenciar visões');
  await page.keyboard.press('Escape');
  await expect(manage).toBeHidden();

  // Abrir /processos sem parâmetros aplica a visão padrão.
  await page.goto('/processos');
  await expect(page.getByText(`Visão: ${VIEW_NAME}`)).toBeVisible();
  await expect(page).toHaveURL(/overdue=true/);
  await expect(rows(page)).toHaveCount(2);

  // Excluir (com confirmação) para não deixar a padrão nas demais jornadas.
  await page.getByRole('button', { name: 'Ações da visão' }).click();
  await page.getByRole('menuitem', { name: 'Gerenciar visões' }).click();
  await manage.getByRole('button', { name: `Excluir a visão ${VIEW_NAME}` }).click();
  await expect(manage.getByText(/Esta ação não pode ser desfeita/)).toBeVisible();
  await manage.getByRole('button', { name: 'Excluir visão' }).click();
  await expect(manage.getByText('Você ainda não tem visões próprias.')).toBeVisible();
});

test('visão compartilhada com unidade removida: filtro ignorado, aviso e sem edição', async ({
  page,
}) => {
  await openList(page);
  await page.getByRole('combobox', { name: 'Visão' }).click();
  await page.getByRole('option', { name: 'Devolvidos da Saúde (de Beatriz Lima)' }).click();
  await expect(
    page.getByText('Alguns filtros desta visão não estão mais disponíveis e foram ignorados.'),
  ).toBeVisible();
  await expect(page).toHaveURL(/status=RETURNED/);
  expect(page.url()).toContain('currentDepartmentId=');
  expect(page.url()).not.toContain('00000000dead');
  await expect(rows(page)).toHaveCount(2); // cabeçalho + 0031/2026 (Devolvido)
  await expectNoSeriousA11yViolations(page, 'visão com filtros ignorados');

  // Quem não é dono só aplica ou copia: nada de renomear/excluir.
  await page.getByRole('button', { name: 'Ações da visão' }).click();
  await expect(page.getByRole('menuitem', { name: 'Salvar como minha' })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Gerenciar visões' }).click();
  const manage = page.getByRole('dialog', { name: 'Gerenciar visões' });
  await expect(manage.getByText('Devolvidos da Saúde')).toHaveCount(0);
  await expect(manage.getByRole('button', { name: /Renomear a visão/ })).toHaveCount(0);
});

test('em 360 px: seletor e botões cabem sem rolagem horizontal e o diálogo é acessível', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await openList(page);
  await expect(page.getByRole('combobox', { name: 'Visão' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Salvar visão' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Exportar CSV' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await page.getByRole('button', { name: 'Exportar CSV' }).click();
  const dialog = page.getByRole('dialog', { name: 'Exportar CSV' });
  await expect(dialog.getByRole('button', { name: 'Exportar', exact: true })).toBeInViewport();
  await expectNoSeriousA11yViolations(page, 'diálogo Exportar CSV · 360 px');
});
