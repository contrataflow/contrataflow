// E2E da aba "Tramitação" de SCR-006 (US-054): processo criado pelo wizard, histórico mais recente
// primeiro, filtro por ação, scroll infinito até o início, link "Ver decisão" da aprovação
// vinculada, axe-core e viewport de 360 px (filtros colapsáveis, sem rolagem horizontal). A API é
// simulada (support/mock-api.mjs — 60 tramitações); SQL, RLS, IP com AUDIT_VIEW e cursor sob
// concorrência são cobertos nos testes da API.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/a11y';
import { createProcessViaWizard } from './support/process-wizard';

const TITLE = 'Contratação de manutenção predial da escola municipal';

async function createProcess(page: Page): Promise<void> {
  await createProcessViaWizard(page, {
    title: TITLE,
    object: 'Serviços de manutenção predial preventiva e corretiva da escola municipal.',
  });
}

test('aba "Tramitação": mais recente primeiro, filtro por ação, scroll infinito e decisão vinculada', async ({
  page,
}) => {
  await createProcess(page);
  await page.getByRole('tab', { name: 'Tramitação' }).click();

  // Agrupadas por dia: cada grupo é uma lista; as linhas são os itens "Ação nº N, em …".
  const list = page.getByRole('region', { name: 'Histórico de tramitações' });
  const rows = list.getByRole('listitem', { name: / nº \d+, em / });
  await expect(rows.first()).toHaveAccessibleName(/^Aprovação nº 60/);
  // Sem AUDIT_VIEW, nenhuma informação de IP (FA-02).
  await expect(page.getByText(/IP de origem/)).toHaveCount(0);
  await expectNoSeriousA11yViolations(page, 'aba Tramitação');

  // Scroll infinito: 50 por página; rolar até o fim carrega o restante (60 no total).
  await expect(rows).toHaveCount(50);
  await page.getByText('Carregar mais').scrollIntoViewIfNeeded();
  await expect(rows).toHaveCount(60);
  await expect(page.getByText('Início do histórico.')).toBeVisible();
  await expect(rows.last()).toHaveAccessibleName(/^Criação nº 1/);

  // FA-03: a decisão de aprovação leva à aprovação (US-052).
  const decision = rows.first().getByRole('link', { name: 'Ver decisão' });
  await expect(decision).toHaveAttribute('href', /^\/aprovacoes\/[0-9a-f-]{36}$/);

  // FA-01: filtro por ação reinicia a paginação só com devoluções.
  await page.getByRole('button', { name: 'Filtros', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Devolução' }).check();
  await page.keyboard.press('Escape');
  await expect(rows).toHaveCount(29);
  for (const name of await rows.evaluateAll((items) =>
    items.map((item) => item.getAttribute('aria-label') ?? ''),
  )) {
    expect(name).toMatch(/^Devolução/);
  }
  await page.getByRole('button', { name: 'Remover filtro Ação: Devolução' }).click();
  await expect(rows.first()).toHaveAccessibleName(/^Aprovação nº 60/);
  await page.getByRole('button', { name: 'Filtros', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Devolução' })).not.toBeChecked();
});

test('em 360 px: filtros colapsáveis e sem rolagem horizontal', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await createProcess(page);
  await page.getByRole('tab', { name: 'Tramitação' }).click();
  await expect(page.getByRole('region', { name: 'Histórico de tramitações' })).toBeVisible();

  await expect(page.getByRole('checkbox', { name: 'Devolução' })).toBeHidden();
  await page.getByRole('button', { name: 'Filtros', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Devolução' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await expectNoSeriousA11yViolations(page, 'aba Tramitação · 360 px');
});
