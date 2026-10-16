// E2E do SCR-034 (US-042): Administração › Workflows — a lista com o selo "Padrão", "Tornar padrão"
// com confirmação e toast, a ação desabilitada para workflow sem versão publicada, axe-core em cada
// estado e a largura de 360 px. A API é simulada (support/mock-api.mjs); seeder, aplicabilidade
// (WF-06), concorrência e isolamento por tenant são cobertos nos testes da API (módulo `workflow`
// e suíte tenant leak). A criação de processo de dispensa resolvendo o workflow chega com a US-001.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/a11y';

// A lista da API simulada é global: os passos desta jornada rodam em série.
test.describe.configure({ mode: 'serial' });

const DIRECT = 'Contratação direta — Lei 14.133/2021, art. 72';
const STANDARD = 'Fase preparatória — Lei 14.133/2021';

async function openList(page: Page): Promise<void> {
  await page.goto(`/api/auth/login?as=ana&returnTo=${encodeURIComponent('/admin/workflows')}`);
  await expect(page).toHaveURL(/\/admin\/workflows$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Workflows' })).toBeVisible();
}

const cardOf = (page: Page, name: string) =>
  page.getByRole('listitem').filter({ has: page.getByRole('heading', { name, exact: true }) });

test('workflow sem versão publicada não pode ser o padrão', async ({ page }) => {
  await openList(page);
  await expect(cardOf(page, STANDARD).getByText('Padrão', { exact: true })).toBeVisible();
  await expect(
    cardOf(page, 'Piloto de obras').getByRole('button', { name: /Tornar Piloto de obras/ }),
  ).toBeDisabled();
  await expect(
    cardOf(page, 'Piloto de obras').getByText(
      'Publique uma versão e ative o workflow antes de torná-lo padrão.',
    ),
  ).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'lista de workflows');
});

test('torna a contratação direta o padrão com confirmação, toast e selo atualizado', async ({
  page,
}) => {
  await openList(page);
  await cardOf(page, DIRECT)
    .getByRole('button', { name: `Tornar ${DIRECT} o workflow padrão` })
    .click();
  const dialog = page.getByRole('dialog', { name: `Tornar "${DIRECT}" o workflow padrão?` });
  await expect(dialog.getByText(`Hoje o padrão é "${STANDARD}".`)).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'confirmação de tornar padrão');
  await dialog.getByRole('button', { name: 'Tornar padrão' }).click();

  await expect(page.getByText(`Workflow ${DIRECT} agora é o padrão.`)).toBeVisible();
  await expect(cardOf(page, DIRECT).getByText('Padrão', { exact: true })).toBeVisible();
  await expect(cardOf(page, STANDARD).getByText('Padrão', { exact: true })).toHaveCount(0);
});

test('no celular (360 px) a lista vira cartões sem rolagem horizontal e acessível', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await openList(page);
  await expect(cardOf(page, STANDARD)).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1),
  ).toBe(false);
  await expectNoSeriousA11yViolations(page, 'lista de workflows em 360 px');
});
