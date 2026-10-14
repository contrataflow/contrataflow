// Smoke E2E do estágio 7 (US-079): página inicial no build de produção, acessível, com o IdP do
// ambiente efêmero (Authentik real do Compose) respondendo. Os fluxos de negócio entram aqui com
// as stories de cada tela (SCR-*), sempre com a checagem de acessibilidade.
import { expect, test } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/a11y';

test('página inicial renderiza em pt-BR sem violações sérias de acessibilidade', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'ContrataFlow' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
  await expectNoSeriousA11yViolations(page, 'página inicial');
});

test('o gate de acessibilidade barra violação séria (V-10)', async ({ page }) => {
  await page.setContent(
    '<!doctype html><html lang="pt-BR"><head><title>Fixture</title></head><body><main><img src="data:,"></main></body></html>',
  );
  await expect(expectNoSeriousA11yViolations(page, 'fixture')).rejects.toThrow(
    /Violação de acessibilidade: image-alt em fixture\./,
  );
});

test('Authentik do ambiente efêmero publica a descoberta OIDC', async ({ request }, testInfo) => {
  const issuer = String(testInfo.config.metadata.oidcIssuer);
  const response = await request.get(`${issuer}.well-known/openid-configuration`);
  expect(response.status()).toBe(200);
  const discovery = (await response.json()) as { issuer?: string };
  expect(discovery.issuer).toBe(issuer);
});
