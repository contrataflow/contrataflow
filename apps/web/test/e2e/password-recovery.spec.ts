// US-089 — "Esqueci minha senha" no build de produção com o provedor fake (FA-06): SCR-001 →
// GET /api/auth/forgot-password → (Authentik simulado: fluxo concluído) → /entrar?motivo=senha-
// redefinida, com axe nas páginas. A jornada dentro do Authentik real (e-mail, política de senha,
// link de uso único) está em tools/test/integration/authentik-recovery.test.ts.
import { expect, test } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/a11y';

test('SCR-001: "Esqueci minha senha" leva à recuperação e volta com "Senha redefinida" e o destino', async ({
  page,
}) => {
  await page.goto('/entrar?motivo=saiu&returnTo=%2Fexemplo%3Faba%3D2');
  const forgot = page.getByRole('link', { name: 'Esqueci minha senha' });
  await expect(forgot).toBeVisible();
  await expect(forgot).toHaveAttribute(
    'href',
    '/api/auth/forgot-password?returnTo=%2Fexemplo%3Faba%3D2',
  );
  await expectNoSeriousA11yViolations(page, 'SCR-001 com "Esqueci minha senha"');

  await forgot.click();
  await expect(page).toHaveURL(/\/entrar\?motivo=senha-redefinida$/);
  await expect(page.getByRole('status')).toHaveText('Senha redefinida. Entre com sua nova senha.');
  // Nenhuma sessão criada; "Entrar" segue o login normal para o destino guardado (FA-05).
  await expect(page.getByRole('link', { name: 'Entrar' })).toHaveAttribute(
    'href',
    '/api/auth/login?returnTo=%2Fexemplo%3Faba%3D2',
  );
  await expectNoSeriousA11yViolations(page, 'SCR-001 após a redefinição');
});

test('SCR-002 com o IdP indisponível: mensagem, "Tentar novamente" e volta à entrada', async ({
  page,
}) => {
  await page.goto('/recuperar-senha?motivo=indisponivel');
  await expect(page.getByRole('heading', { level: 1, name: 'Recuperar senha' })).toBeFocused();
  await expect(page.getByRole('status')).toHaveText(
    'O serviço de autenticação está indisponível. Tente novamente em instantes.',
  );
  await expect(page.getByRole('link', { name: 'Tentar novamente' })).toHaveAttribute(
    'href',
    '/api/auth/forgot-password',
  );
  await expectNoSeriousA11yViolations(page, 'SCR-002 indisponível');
});
