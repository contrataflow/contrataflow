// E2E da aba "Tramitação" de SCR-006 (US-054): processo criado pelo wizard, histórico mais recente
// primeiro, filtro por ação, scroll infinito até o início, link "Ver decisão" da aprovação
// vinculada, axe-core e viewport de 360 px (filtros colapsáveis, sem rolagem horizontal). A API é
// simulada (support/mock-api.mjs — 60 tramitações); SQL, RLS, IP com AUDIT_VIEW e cursor sob
// concorrência são cobertos nos testes da API.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/a11y';

const TITLE = 'Contratação de manutenção predial da escola municipal';

async function createProcess(page: Page): Promise<void> {
  await page.goto(`/api/auth/login?as=ana&returnTo=${encodeURIComponent('/processos/novo')}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Novo processo' })).toBeVisible();
  await page.getByLabel('Título *').fill(TITLE);
  await page
    .getByLabel('Objeto *')
    .fill('Serviços de manutenção predial preventiva e corretiva da escola municipal.');
  await page.getByLabel('Tipo de contratação *').selectOption({ label: 'Aquisição de bens' });
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(
    page.getByRole('heading', { level: 2, name: 'Origem e planejamento' }),
  ).toBeVisible();
  await page.getByLabel('Origem *').selectOption({ label: 'Demanda não prevista' });
  await page.getByRole('radio', { name: 'Não se aplica' }).check();
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Revisão' })).toBeVisible();
  await page.getByRole('button', { name: 'Criar processo' }).click();
  await expect(page).toHaveURL(/\/processos\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1, name: TITLE })).toBeVisible();
}

test('aba "Tramitação": mais recente primeiro, filtro por ação, scroll infinito e decisão vinculada', async ({
  page,
}) => {
  await createProcess(page);
  await page.getByRole('tab', { name: 'Tramitação' }).click();

  const list = page.getByRole('list', { name: 'Histórico de tramitações' });
  const rows = list.locator(':scope > li');
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
  await page.getByRole('checkbox', { name: 'Devolução' }).check();
  await expect(rows).toHaveCount(29);
  for (const name of await rows.evaluateAll((items) =>
    items.map((item) => item.getAttribute('aria-label') ?? ''),
  )) {
    expect(name).toMatch(/^Devolução/);
  }
  await page.getByRole('button', { name: 'Limpar filtros' }).click();
  await expect(page.getByRole('checkbox', { name: 'Devolução' })).not.toBeChecked();
  await expect(rows.first()).toHaveAccessibleName(/^Aprovação nº 60/);
});

test('em 360 px: filtros colapsáveis e sem rolagem horizontal', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await createProcess(page);
  await page.getByRole('tab', { name: 'Tramitação' }).click();
  await expect(page.getByRole('list', { name: 'Histórico de tramitações' })).toBeVisible();

  await expect(page.getByRole('checkbox', { name: 'Devolução' })).toBeHidden();
  await page.getByRole('button', { name: 'Filtros' }).click();
  await expect(page.getByRole('checkbox', { name: 'Devolução' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await expectNoSeriousA11yViolations(page, 'aba Tramitação · 360 px');
});
