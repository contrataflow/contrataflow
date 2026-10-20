// E2E da jornada J-08 (US-010 · SCR-116 sobre SCR-006): a gestora conclui manualmente o processo
// pela ação primária "Concluir planejamento" (o diálogo mostra a etapa final, o checklist e a
// observação opcional) e vê o selo "Concluído" com as ações de custódia encerradas; e o processo já
// concluído automaticamente pela aprovação final abre direto como concluído, sem ação (FA-05).
// axe-core no diálogo e o diálogo em tela cheia a 360 px. A API é simulada (support/mock-api.mjs,
// processos 0095/2026, 0096/2026 e 0097/2026, fora da lista padrão); regras BLOCKING/WARNING, custódia,
// auditoria, concorrência e a rotina compartilhada com a aprovação são cobertas nos testes da API.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/a11y';

/** Processos da jornada (`listProcessId(95..97)` em support/mock-api.mjs). */
const MANUAL_PATH = '/processos/0192a000-0000-7000-8000-000000100095';
const AUTO_PATH = '/processos/0192a000-0000-7000-8000-000000100096';
const NARROW_PATH = '/processos/0192a000-0000-7000-8000-000000100097';
const COMMENT = 'Planejamento pronto para a seleção do fornecedor';

async function openProcess(page: Page, path: string, title: string): Promise<void> {
  await page.goto(`/api/auth/login?as=ana&returnTo=${encodeURIComponent(path)}`);
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
}

/** A ação primária abre o diálogo (repete o clique se a página ainda não hidratou). */
async function openCompletion(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Concluir processo' });
  await expect(async () => {
    await page.getByRole('button', { name: 'Concluir planejamento' }).first().click();
    await expect(dialog).toBeVisible({ timeout: 1_000 });
  }).toPass();
  return dialog;
}

test('J-08: concluir o processo manualmente e ver o selo "Concluído"', async ({ page }) => {
  await openProcess(page, MANUAL_PATH, 'Aquisição de cimento para manutenção de vias');
  const dialog = await openCompletion(page);
  await expect(
    dialog.getByText('Etapa final: Planejamento da contratação concluído'),
  ).toBeVisible();
  await expect(dialog.getByText('Nenhuma pendência nesta etapa.')).toBeVisible();
  await expect(dialog.getByLabel('Observação (opcional)')).toBeFocused();
  await expectNoSeriousA11yViolations(page, 'diálogo Concluir processo');

  await dialog.getByLabel('Observação (opcional)').fill(COMMENT);
  await dialog.getByRole('button', { name: 'Concluir processo' }).click();

  await expect(dialog).toBeHidden();
  await expect(page.getByText('Processo concluído', { exact: true })).toBeVisible();
  await expect(page.getByText('Concluído', { exact: true }).first()).toBeVisible();
  await expect(
    page.getByText(/^Planejamento da contratação concluído em \d{2}\/\d{2}\/\d{4}$/),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Concluir planejamento' })).toHaveCount(0);
});

test('J-08 · FA-05: processo concluído pela aprovação final abre como concluído, sem ação', async ({
  page,
}) => {
  await openProcess(page, AUTO_PATH, 'Contratação de serviços de limpeza urbana');
  await expect(page.getByText('Concluído', { exact: true }).first()).toBeVisible();
  await expect(
    page.getByText('Planejamento da contratação concluído em 15/10/2026', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Concluir planejamento' })).toHaveCount(0);
});

test('em 360 px: o diálogo de conclusão ocupa a tela, sem rolagem horizontal', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await openProcess(page, NARROW_PATH, 'Aquisição de sinalização viária');
  const dialog = await openCompletion(page);
  await expect(dialog.getByLabel('Observação (opcional)')).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(359);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});
