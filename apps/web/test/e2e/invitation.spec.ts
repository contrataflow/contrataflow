// E2E do SCR-102 (US-091): `/convite/<token>` mostra o convite, o aceite troca a instituição ativa e
// leva ao painel; convite expirado e inválido têm mensagem própria; axe-core em cada estado. A API
// é simulada (support/mock-api.mjs): o token de 43 "A" é válido e o de 43 "E" está expirado.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/a11y';

const VALID = 'A'.repeat(43);
const EXPIRED = 'E'.repeat(43);
const UNKNOWN = 'Z'.repeat(43);

async function openInvite(page: Page, token: string): Promise<void> {
  await page.goto(`/api/auth/login?as=ana&returnTo=${encodeURIComponent(`/convite/${token}`)}`);
  await expect(page).toHaveURL(new RegExp(`/convite/${token}$`));
}

test('aceita o convite, troca para a instituição e abre o painel', async ({ page }) => {
  await openInvite(page, VALID);
  await expect(page.getByRole('heading', { level: 1, name: 'Você foi convidado' })).toBeVisible();
  await expect(page.getByText('Prefeitura B')).toBeVisible();
  await expect(page.getByText('Analista de compras')).toBeVisible();
  await expect(page.getByText('Gabinete')).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'aceite de convite');

  await page.getByRole('button', { name: 'Aceitar convite' }).click();
  await expect(page).toHaveURL(/\/exemplo$/);
  await expect(page.getByRole('button', { name: 'Instituição ativa: Prefeitura B' })).toBeVisible();
});

test('convite expirado pede para reenviarem', async ({ page }) => {
  await openInvite(page, EXPIRED);
  await expect(page.getByText('Este convite expirou. Peça para reenviarem.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Aceitar convite' })).toHaveCount(0);
  await expectNoSeriousA11yViolations(page, 'convite expirado');
});

test('convite inválido (token desconhecido ou malformado) leva à página de entrada', async ({
  page,
}) => {
  await openInvite(page, UNKNOWN);
  await expect(page.getByText('Este convite não é válido.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Ir para a página de entrada' })).toHaveAttribute(
    'href',
    '/entrar',
  );
  await expectNoSeriousA11yViolations(page, 'convite inválido');
});
