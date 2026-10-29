// E2E da caixa de tarefas (US-056 · SCR-013 `/tarefas`, modelo de lista do prd-5): a Ana abre a
// caixa em "Comigo", troca de aba, ordena, assume pelo menu ⋯ o processo da fila da unidade
// (PRC-21) e vê o contador das duas abas mudar; depois (US-058) assume em lote com sucesso parcial e
// atribui em lote com motivo obrigatório. axe-core na tela e a lista em cartões a 360 px. A API é simulada (support/mock-api.mjs); visões,
// contadores, RLS, concorrência e reenvio idempotente são cobertos nos testes da API.
import { expect, test } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/a11y';

// O "Assumir" da API simulada é global: os passos desta jornada rodam em série.
test.describe.configure({ mode: 'serial' });

const login = (returnTo = '/tarefas') =>
  `/api/auth/login?as=ana&returnTo=${encodeURIComponent(returnTo)}`;

test('trocar de aba, ordenar e assumir da fila atualizando os contadores', async ({ page }) => {
  await page.goto(login());
  await expect(page.getByRole('heading', { level: 1, name: 'Caixa de tarefas' })).toBeVisible();
  const mine = page.getByRole('tab', { name: 'Comigo: 2 itens' });
  await expect(mine).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('0002/2026', { exact: true })).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'caixa de tarefas');

  // Ordenação: código, mais antigo primeiro.
  await page.getByRole('combobox', { name: 'Ordenar por' }).click();
  await page.getByRole('option', { name: 'Código (mais antigo primeiro)' }).click();
  await expect(page.getByRole('row').nth(1)).toContainText('0001/2026');

  // Aprovações pendentes: solicitante na linha.
  await page.getByRole('tab', { name: /Aprovações pendentes/ }).click();
  await expect(page.getByText('Bruno Lima')).toBeVisible();

  // Fila da unidade: "Assumir" move o processo para "Comigo".
  await page.getByRole('tab', { name: 'Na fila da minha unidade: 4 itens' }).click();
  await page.getByRole('button', { name: 'Ações de 0012/2026' }).click();
  await page.getByRole('menuitem', { name: 'Assumir o processo 0012/2026' }).click();
  await expect(page.getByText('Você assumiu este processo.', { exact: true })).toBeVisible();
  await expect(page.getByText('0012/2026', { exact: true })).toBeHidden();
  await expect(page.getByRole('tab', { name: 'Comigo: 3 itens' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Na fila da minha unidade: 3 itens' })).toBeVisible();
  await page.getByRole('tab', { name: 'Comigo: 3 itens' }).click();
  await expect(page.getByText('0012/2026', { exact: true })).toBeVisible();
});

test('US-058: assumir em lote com sucesso parcial e atribuir em lote com motivo', async ({
  page,
}) => {
  await page.goto(login());
  await page.getByRole('tab', { name: 'Na fila da minha unidade: 3 itens' }).click();
  await page.getByRole('checkbox', { name: 'Selecionar o processo 0013/2026' }).check();
  await page.getByRole('checkbox', { name: 'Selecionar o processo 0015/2026' }).check();
  const bar = page.getByRole('region', { name: 'Ações em lote' });
  await expect(bar.getByText('2 selecionados')).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'barra de ações em lote');

  await bar.getByRole('button', { name: 'Assumir selecionados' }).click();
  await page
    .getByRole('dialog', { name: 'Assumir 2 processos?' })
    .getByRole('button', { name: 'Assumir' })
    .click();
  await expect(
    page.getByText('1 de 2 processos assumidos. 1 não pôde ser assumido.', { exact: true }),
  ).toBeVisible();
  await page.getByText('Ver o erro').click();
  await expect(
    page.getByText('0015/2026 — já havia sido assumido por outra pessoa.'),
  ).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Na fila da minha unidade: 2 itens' })).toBeVisible();

  // Atribuir em lote (a Ana é titular da unidade): responsável e motivo obrigatórios.
  await page.getByRole('checkbox', { name: 'Selecionar o processo 0014/2026' }).check();
  await bar.getByRole('button', { name: 'Atribuir selecionados' }).click();
  const dialog = page.getByRole('dialog', { name: 'Atribuir 2 processos a' });
  await dialog.getByRole('button', { name: 'Atribuir' }).click();
  await expect(
    dialog.getByText('Selecione o responsável e informe o motivo.').first(),
  ).toBeVisible();
  await dialog.getByRole('combobox', { name: /Responsável/ }).click();
  await page.getByRole('option', { name: 'Juliana Prado' }).click();
  await dialog.getByRole('textbox', { name: /Motivo/ }).fill('Mutirão de triagem do exercício');
  await expectNoSeriousA11yViolations(page, 'atribuir em lote');
  await dialog.getByRole('button', { name: 'Atribuir' }).click();
  await expect(page.getByText('2 processos atribuídos.', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('tab', { name: 'Na fila da minha unidade: nenhum item' }),
  ).toBeVisible();
  await expect(bar).toBeHidden();
});

test('em 360 px: as linhas viram cartões, sem rolagem horizontal', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto(login());
  await expect(page.getByText('0001/2026', { exact: true })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});
