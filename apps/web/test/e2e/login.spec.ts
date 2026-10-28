// E2E da entrada nativa (SCR-001 · DEC-187 · US-090/US-088) no build de produção com o provedor
// fake (FA-06): usuário e senha na tela do ContrataFlow, etapa de código para quem tem MFA,
// mensagens genéricas, bloqueio, IdP fora e logout sem passar pelo IdP — com axe em cada estado e
// a tela em 390 px. Pessoas do diretório fake; senha `senha-fake`; `lucia` usa o código 123456;
// `bloqueada` e `indisponivel` simulam o bloqueio e o IdP fora. O Authentik real fica no smoke
// manual (spec-509) e nos testes do cliente do executor de fluxos.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/a11y';

const PASSWORD = 'senha-fake';
const INVALID =
  'Usuário ou senha inválidos. Confira os dados e tente de novo. Após 5 tentativas, o acesso é bloqueado temporariamente.';

async function fill(page: Page, username: string, password: string): Promise<void> {
  await page.getByLabel('Usuário ou e-mail').fill(username);
  await page.getByLabel('Senha', { exact: true }).fill(password);
}

/** Alerta do formulário (o anunciador de rotas do Next também tem `role="alert"`). */
function formAlert(page: Page) {
  return page.getByRole('main').getByRole('alert');
}

/** Toda navegação fica na origem do app: o navegador nunca vê o IdP no login. */
function trackForeignNavigations(page: Page): string[] {
  const foreign: string[] = [];
  const origin = new URL(String(test.info().project.use.baseURL)).origin;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame() && new URL(frame.url()).origin !== origin) {
      foreign.push(frame.url());
    }
  });
  return foreign;
}

test('[Sucesso] usuário e senha entram pela tela do app e caem no destino; logout volta à entrada', async ({
  page,
}) => {
  const foreign = trackForeignNavigations(page);
  await page.goto('/api/auth/login?returnTo=%2Fexemplo');
  await expect(page).toHaveURL(/\/entrar\?returnTo=%2Fexemplo$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Entrar' })).toBeVisible();
  await expect(page.getByLabel('Usuário ou e-mail')).toBeFocused();
  await expect(page.getByText(/gov\.br/i)).toHaveCount(0);
  await expectNoSeriousA11yViolations(page, 'SCR-001');

  await fill(page, 'ana', PASSWORD);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page).toHaveURL(/\/exemplo$/);
  await expect(page.getByRole('banner')).toBeVisible();

  await page.getByRole('button', { name: 'Menu do usuário Ana Souza' }).click();
  await page.getByRole('menuitem', { name: 'Sair' }).click();
  await expect(page).toHaveURL(/\/entrar\?motivo=saiu$/);
  await expect(page.getByRole('status')).toHaveText('Você saiu com segurança.');
  expect(foreign).toEqual([]);
});

test('[Validação] campos vazios e senha errada: mensagens genéricas, foco e nenhuma sessão', async ({
  page,
}) => {
  await page.goto('/entrar');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByText('Informe o usuário ou e-mail.')).toBeVisible();
  await expect(page.getByLabel('Usuário ou e-mail')).toBeFocused();

  await fill(page, 'ana', 'errada');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(formAlert(page)).toHaveText(INVALID);
  await expect(page.getByLabel('Senha', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Senha', { exact: true })).toBeFocused();
  await expectNoSeriousA11yViolations(page, 'SCR-001 com erro de credencial');

  // Usuário inexistente: exatamente a mesma mensagem (RN-IAM-18).
  await fill(page, 'ninguem', 'errada');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(formAlert(page)).toHaveText(INVALID);
  await page.goto('/exemplo');
  await expect(page).toHaveURL(/\/entrar\?returnTo=%2Fexemplo$/);
});

test('[Sucesso] MFA: etapa de código, código errado e depois o certo', async ({ page }) => {
  await page.goto('/entrar');
  await fill(page, 'lucia', PASSWORD);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Confirme sua identidade' }),
  ).toBeVisible();
  const code = page.getByLabel('Código de verificação');
  await expect(code).toBeFocused();
  await expect(code).toHaveAttribute('autocomplete', 'one-time-code');
  await expectNoSeriousA11yViolations(page, 'SCR-001 etapa de código');

  await code.fill('000000');
  await page.getByRole('button', { name: 'Confirmar e entrar' }).click();
  await expect(formAlert(page)).toHaveText(
    'Código inválido. Confira o aplicativo autenticador e tente de novo.',
  );
  await code.fill('123456');
  await page.getByRole('button', { name: 'Confirmar e entrar' }).click();
  await expect(page).toHaveURL(/\/painel$/);
});

test('[Permissão] bloqueio pelo IdP e usuário bloqueado na plataforma', async ({ page }) => {
  await page.goto('/entrar');
  await fill(page, 'bloqueada', PASSWORD);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(formAlert(page)).toHaveText(
    'Acesso bloqueado temporariamente após tentativas inválidas. Tente mais tarde ou use “Esqueci minha senha”.',
  );

  await fill(page, 'eva', PASSWORD);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page).toHaveURL(/\/erro\/acesso-bloqueado$/);
});

test('[Tenant incorreto] sem vínculo utilizável: "sem vínculo", sem shell de nenhuma instituição', async ({
  page,
}) => {
  await page.goto('/entrar?returnTo=%2Fprocessos');
  await fill(page, 'gil', PASSWORD);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page).toHaveURL(/\/erro\/sem-vinculo$/);
  await expect(page.getByRole('navigation', { name: /principal/i })).toHaveCount(0);
});

test('[Duplicidade] duplo clique em "Entrar" envia uma vez só', async ({ page }) => {
  await page.goto('/entrar');
  await fill(page, 'ana', PASSWORD);
  const posts: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/auth/login')) {
      posts.push(request.url());
    }
  });
  await page.getByRole('button', { name: 'Entrar' }).dblclick();
  await expect(page).toHaveURL(/\/painel$/);
  expect(posts).toHaveLength(1);
});

test('[Concorrência] duas pessoas entram ao mesmo tempo em navegadores separados', async ({
  browser,
}) => {
  const [first, second] = await Promise.all([browser.newContext(), browser.newContext()]);
  const pages = await Promise.all([first.newPage(), second.newPage()]);
  await Promise.all(pages.map((page) => page.goto('/entrar')));
  await fill(pages[0], 'ana', PASSWORD);
  await fill(pages[1], 'lucia', PASSWORD);
  await Promise.all(pages.map((page) => page.getByRole('button', { name: 'Entrar' }).click()));
  await expect(pages[0]).toHaveURL(/\/painel$/);
  await expect(pages[1].getByLabel('Código de verificação')).toBeVisible();
  await Promise.all([first.close(), second.close()]);
});

test('[Falha de integração] IdP fora do ar: "indisponível" sem quebrar a página', async ({
  page,
}) => {
  await page.goto('/entrar');
  await fill(page, 'indisponivel', PASSWORD);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(formAlert(page)).toHaveText(
    'O serviço de autenticação está indisponível. Tente novamente em instantes.',
  );
  await expect(page.getByRole('button', { name: 'Entrar' })).toBeEnabled();
});

test('390 px: só o acesso, com a marca no topo e sem rolagem horizontal', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/entrar?motivo=sessao-expirada');
  await expect(page.getByRole('heading', { level: 1, name: 'Entrar' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Sobre o ContrataFlow' })).toBeHidden();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await expectNoSeriousA11yViolations(page, 'SCR-001 em 390 px');
});
