// E2E da jornada J-07 (US-009 · SCR-116 sobre SCR-006): a gestora cancela pelo menu "Mais" um
// processo com aprovação pendente (o diálogo avisa o que será encerrado e só habilita com 20
// caracteres), vê o painel "Cancelado em … — motivo"; descarta um rascunho sem número e volta à
// lista; e tenta descartar um rascunho já numerado, recebendo a oferta "Cancelar processo".
// axe-core nos diálogos e o diálogo em tela cheia a 360 px. A API é simulada (support/mock-api.mjs,
// processos 0091/2026, rascunho sem número e 0093/2026, fora da lista padrão); efeitos sobre
// aprovações e documentos, permissões, auditoria e concorrência são cobertos nos testes da API.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/a11y';

/** Processos da jornada (`listProcessId(91..93)` em support/mock-api.mjs). */
const AWAITING_PATH = '/processos/0192a000-0000-7000-8000-000000100091';
const DRAFT_PATH = '/processos/0192a000-0000-7000-8000-000000100092';
const NUMBERED_DRAFT_PATH = '/processos/0192a000-0000-7000-8000-000000100093';
const REASON = 'Demanda já atendida por contrato vigente';

async function openProcess(page: Page, path: string, title: string): Promise<void> {
  await page.goto(`/api/auth/login?as=ana&returnTo=${encodeURIComponent(path)}`);
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
}

async function openMenuAction(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Mais ações do processo' }).click();
  await page.getByRole('menuitem', { name }).click();
}

test('J-07: cancelar processo com aprovação pendente e ver o painel cancelado', async ({
  page,
}) => {
  await openProcess(page, AWAITING_PATH, 'Aquisição de mobiliário escolar');
  await openMenuAction(page, 'Cancelar processo');
  const dialog = page.getByRole('dialog', { name: 'Cancelar processo' });
  // FA-02: o diálogo avisa a quantidade de aprovações que serão canceladas.
  await expect(dialog.getByText('1 aprovação pendente será cancelada')).toBeVisible();
  await expect(dialog.getByLabel('Justificativa')).toBeFocused();
  await expectNoSeriousA11yViolations(page, 'diálogo Cancelar processo');

  // FA-04: o botão fica desabilitado até 20 caracteres.
  await dialog.getByLabel('Justificativa').fill('Curta demais');
  await expect(dialog.getByRole('button', { name: 'Cancelar processo' })).toBeDisabled();
  await dialog.getByLabel('Justificativa').fill(REASON);
  await dialog.getByRole('button', { name: 'Cancelar processo' }).click();

  await expect(dialog).toBeHidden();
  await expect(page.getByText('Processo cancelado', { exact: true })).toBeVisible();
  await expect(
    page.getByText(new RegExp(`^Cancelado em \\d{2}/\\d{2}/\\d{4} — motivo: ${REASON}$`)),
  ).toBeVisible();
});

test('J-07: descartar rascunho sem número e voltar à lista', async ({ page }) => {
  await openProcess(page, DRAFT_PATH, 'Rascunho de compra de uniformes');
  await openMenuAction(page, 'Descartar rascunho');
  const dialog = page.getByRole('dialog', { name: 'Descartar rascunho' });
  await expect(
    dialog.getByText(
      'O rascunho será excluído e deixará de aparecer nas listas e buscas. Esta ação não pode ser desfeita.',
    ),
  ).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'diálogo Descartar rascunho');
  await dialog.getByLabel('Motivo (opcional)').fill('Aberto em duplicidade.');
  await dialog.getByRole('button', { name: 'Descartar' }).click();

  await expect(page).toHaveURL(/\/processos$/);
  await expect(page.getByText('Rascunho descartado', { exact: true })).toBeVisible();
});

test('J-07: tentar descartar rascunho já numerado oferece "Cancelar processo"', async ({
  page,
}) => {
  await openProcess(page, NUMBERED_DRAFT_PATH, 'Rascunho numerado de compra de toners');
  await openMenuAction(page, 'Descartar rascunho');
  const discard = page.getByRole('dialog', { name: 'Descartar rascunho' });
  await discard.getByRole('button', { name: 'Descartar' }).click();
  await expect(discard.getByText('Este processo já tem número; cancele-o.')).toBeVisible();

  await discard.getByRole('button', { name: 'Cancelar processo' }).click();
  await expect(discard).toBeHidden();
  await expect(page.getByRole('dialog', { name: 'Cancelar processo' })).toBeVisible();
});

test('em 360 px: o diálogo de cancelamento ocupa a tela, sem rolagem horizontal', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await openProcess(page, NUMBERED_DRAFT_PATH, 'Rascunho numerado de compra de toners');
  await openMenuAction(page, 'Cancelar processo');
  const dialog = page.getByRole('dialog', { name: 'Cancelar processo' });
  await expect(dialog.getByLabel('Justificativa')).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(359);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});
