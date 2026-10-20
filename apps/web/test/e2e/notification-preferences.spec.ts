// E2E da aba "Notificações" do perfil (US-113 · SCR-039): abertura direta por `?aba=notificacoes`
// (atalho do sininho), tipos obrigatórios travados, desligar o e-mail de um tipo, salvar e
// confirmar que a escolha persiste ao recarregar, axe-core e viewport de 360 px (cartões, sem
// rolagem horizontal). A API é simulada (support/mock-api.mjs); o efeito no
// `NotificationDispatcher` (próxima notificação respeita a escolha) é coberto nos testes do worker.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/a11y';

const TYPE = 'Processo recebido na sua unidade';

async function open(page: Page): Promise<void> {
  await page.goto(
    `/api/auth/login?as=ana&returnTo=${encodeURIComponent('/perfil?aba=notificacoes')}`,
  );
  await expect(
    page.getByRole('heading', { level: 2, name: 'Preferências de notificação' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { level: 3, name: 'Processos' })).toBeVisible();
}

const emailSwitch = (page: Page) =>
  page.getByRole('group', { name: TYPE }).getByRole('switch', { name: 'Por e-mail' });

// O estado salvo vive na API simulada, compartilhada entre os testes: rodam em série.
test.describe.configure({ mode: 'serial' });

test('desliga o e-mail de um tipo, salva e a escolha persiste ao recarregar', async ({ page }) => {
  await open(page);
  await expect(page.getByRole('tab', { name: 'Notificações' })).toHaveAttribute(
    'aria-selected',
    'true',
  );

  // Tipos obrigatórios: in-app ligado e travado, com a nota.
  const locked = page
    .getByRole('group', { name: 'Aprovação solicitada a você' })
    .getByRole('switch', { name: 'No sistema' });
  await expect(locked).toBeChecked();
  await expect(locked).toBeDisabled();
  await expectNoSeriousA11yViolations(page, 'aba Notificações do perfil');

  await expect(emailSwitch(page)).toBeChecked();
  await emailSwitch(page).click();
  await expect(emailSwitch(page)).not.toBeChecked();
  await page.getByRole('button', { name: 'Salvar' }).click();
  await expect(page.getByText('Preferências salvas', { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { level: 3, name: 'Processos' })).toBeVisible();
  await expect(emailSwitch(page)).not.toBeChecked();

  // Restaura o padrão do registro (FA-01) para não vazar para os demais testes.
  await page.getByRole('button', { name: `Usar padrão: ${TYPE}` }).click();
  await expect(emailSwitch(page)).toBeChecked();
  await page.getByRole('button', { name: 'Salvar' }).click();
  await expect(page.getByText('Preferências salvas', { exact: true }).first()).toBeVisible();
});

test('em 360 px: tipos em cartões e sem rolagem horizontal', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await open(page);
  await expect(emailSwitch(page)).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await expectNoSeriousA11yViolations(page, 'aba Notificações do perfil (360 px)');
});

test('sem ?aba=, o perfil abre em "Dados e preferências" e a aba troca por clique', async ({
  page,
}) => {
  await page.goto(`/api/auth/login?as=ana&returnTo=${encodeURIComponent('/perfil')}`);
  await expect(page.getByRole('tab', { name: 'Dados e preferências' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('tab', { name: 'Notificações' }).click();
  await expect(
    page.getByRole('heading', { level: 2, name: 'Preferências de notificação' }),
  ).toBeVisible();
});
