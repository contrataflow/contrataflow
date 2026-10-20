// E2E do shell (US-086/US-088): login (provedor fake — FA-06) → shell → página de exemplo →
// classes de erro de architecture.md §8.12 → aviso de ociosidade e expiração (relógio simulado) →
// logout, com axe-core em cada tela. A API é simulada
// (support/mock-api.mjs); o login real com Authentik é coberto pela US-087.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/a11y';

// As falhas injetadas na API simulada são globais: os testes deste arquivo rodam em série.
test.describe.configure({ mode: 'serial' });

/** Injeta (ou remove, sem `status`) uma falha na API simulada. */
async function failApi(path: string, status?: number, code?: string): Promise<void> {
  const mockApiUrl = String(test.info().config.metadata.mockApiUrl);
  await fetch(`${mockApiUrl}/__mock/fail`, {
    method: 'POST',
    body: JSON.stringify({ path, status, code }),
  });
}

async function signIn(page: Page, persona = 'ana', returnTo = '/exemplo'): Promise<void> {
  await page.goto(`/api/auth/login?as=${persona}&returnTo=${encodeURIComponent(returnTo)}`);
}

test.afterEach(async () => {
  await failApi('/api/v1/_internal/ping');
  await failApi('/api/v1/_internal/items');
});

test('sem sessão, rota de (app) leva ao login com returnTo (FA-01)', async ({ request }) => {
  const response = await request.get('/exemplo', { maxRedirects: 0 });
  expect(response.status()).toBe(307);
  expect(response.headers().location).toBe('/api/auth/login?returnTo=%2Fexemplo');
});

test('jornada do shell: dados pré-carregados, CSP com nonce, permissões e logout', async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await signIn(page);
  await expect(page).toHaveURL(/\/exemplo$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Exemplo do shell' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Menu principal' })).toBeVisible();
  await expect(page.getByRole('search')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Instituição ativa: Prefeitura A' })).toBeVisible();
  await expect(page.getByRole('main').getByText('item-01')).toBeVisible();
  // Hidratado: o formulário protegido por <Can> só aparece com o JS rodando sob a CSP.
  await expect(page.getByRole('button', { name: 'Criar registro' })).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'página de exemplo');

  const cookies = await page.context().cookies();
  const session = cookies.find((cookie) => cookie.name === '__Host-cf_session');
  expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
  expect(await page.evaluate(() => document.cookie)).not.toContain('cf_session');

  await page.getByLabel('Nome').fill('Registro E2E');
  await page.getByRole('button', { name: 'Criar registro' }).click();
  await expect(page.getByText('Registro “Registro E2E” criado.', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Menu do usuário Ana Souza' }).click();
  await page.getByRole('menuitem', { name: 'Sair' }).click();
  await expect(page).toHaveURL(/\/entrar\?motivo=saiu$/);
  await expect(page.getByRole('status')).toContainText('Você saiu com segurança.');
  expect(consoleErrors.filter((text) => text.includes('Content Security Policy'))).toEqual([]);
});

test('cabeçalhos de segurança em página e em /api/*', async ({ page, request }) => {
  await signIn(page);
  const pageResponse = await page.request.get('/exemplo');
  const headers = pageResponse.headers();
  expect(headers['content-security-policy']).toMatch(
    /script-src 'self' 'nonce-[^']+' 'strict-dynamic'/,
  );
  expect(headers['strict-transport-security']).toBe('max-age=63072000; includeSubDomains; preload');
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['cache-control']).toContain('no-store');
  const api = await request.post('/api/v1/_internal/echo', { data: {} });
  expect(api.status()).toBe(403);
  expect((await api.json()) as { code: string }).toMatchObject({ code: 'CSRF_REJECTED' });
  expect(api.headers()['content-security-policy']).toContain("default-src 'none'");
});

test('troca de instituição (US-093): mesma sessão, dados do novo tenant e aviso', async ({
  page,
}) => {
  await signIn(page);
  await expect(page.getByRole('main').getByText('item-01')).toBeVisible();
  const cookiesBefore = await page.context().cookies();
  await page.getByRole('button', { name: 'Instituição ativa: Prefeitura A' }).click();
  await page.getByRole('menuitem', { name: 'Prefeitura B' }).click();
  await expect(page.getByRole('button', { name: 'Instituição ativa: Prefeitura B' })).toBeVisible();
  await expect(page.getByText('Agora você está em Prefeitura B.', { exact: true })).toBeVisible();
  // Fluxo principal 7 da US-093: depois da troca o front navega ao Dashboard (US-076).
  await expect(page).toHaveURL(/\/painel$/);
  // A API passa a receber o X-Tenant-Id da Prefeitura B, na MESMA sessão (RN-IAM-66).
  const ping = await page.request.get('/api/v1/_internal/ping');
  expect(((await ping.json()) as { data: { tenantId: string } }).data.tenantId).toBe(
    '0192a000-0000-7000-8000-00000000000b',
  );
  const session = (cookies: typeof cookiesBefore) =>
    cookies.find((cookie) => cookie.name === '__Host-cf_session')?.value;
  expect(session(await page.context().cookies())).toBe(session(cookiesBefore));
  await expectNoSeriousA11yViolations(page, 'troca de instituição');
});

test('503 da API: error.tsx com correlationId copiável e "Tentar novamente"', async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole('main').getByText('item-01')).toBeVisible();
  await failApi('/api/v1/_internal/ping', 503, 'DEPENDENCY_UNAVAILABLE');
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Serviço temporariamente indisponível' }),
  ).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(/^Código: /)).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'erro 503');
  await failApi('/api/v1/_internal/ping');
  await page.getByRole('button', { name: 'Tentar novamente' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Exemplo do shell' })).toBeVisible();
});

test('401 da API após renovar: modal "Sua sessão expirou" e nova entrada com returnTo', async ({
  page,
}) => {
  await signIn(page);
  await expect(page.getByRole('main').getByText('item-01')).toBeVisible();
  await failApi('/api/v1/_internal/items', 401, 'SESSION_EXPIRED');
  await page.getByRole('button', { name: /Próxima página/ }).click();
  // A tela fica onde estava (o que foi digitado é preservado); o modal bloqueia (CA-T-09).
  const modal = page.getByRole('dialog', { name: 'Sua sessão expirou' });
  await expect(modal).toBeVisible();
  await expect(page).toHaveURL(/\/exemplo$/);
  await expectNoSeriousA11yViolations(page, 'sessão expirada');
  const login = page.waitForRequest((request) =>
    request.url().includes('/api/auth/login?returnTo=%2Fexemplo&reauth=1'),
  );
  await modal.getByRole('link', { name: 'Entrar novamente' }).click();
  await login;
  await failApi('/api/v1/_internal/items');
  await expect(page.getByRole('heading', { level: 1, name: 'Exemplo do shell' })).toBeVisible();
});

test('aviso de ociosidade 2 min antes e "Continuar conectado" (relógio simulado)', async ({
  page,
}) => {
  await page.clock.install();
  await signIn(page);
  await expect(page.getByRole('main').getByText('item-01')).toBeVisible();
  // Página carregada por completo (permissões incluídas): nenhuma requisição em voo durante o salto
  // do relógio — uma resposta atrasada contaria como atividade e fecharia o aviso (FA-02).
  await expect(page.getByRole('button', { name: 'Criar registro' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Contexto da requisição' })).toContainText(
    'Correlação',
  );
  // O contador confere o BFF (sondagem, sem renovar) antes de avisar.
  const probe = page.waitForResponse((response) => response.url().endsWith('/api/auth/session'));
  await page.clock.fastForward('28:30');
  const before = ((await (await probe).json()) as { data: { idleExpiresAt: string } }).data;
  const dialog = page.getByRole('dialog', { name: 'Você continua aí?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Sua sessão será encerrada por inatividade em 2 minutos.');
  await expectNoSeriousA11yViolations(page, 'aviso de ociosidade');
  const keepalive = page.waitForResponse((response) =>
    response.url().includes('/api/auth/session?keepalive=true'),
  );
  await dialog.getByRole('button', { name: 'Continuar conectado' }).click();
  const renewed = await keepalive;
  expect(renewed.status()).toBe(200);
  // O BFF renovou a ociosidade (FA-01). O fechamento do diálogo depende do relógio do BFF, que
  // aqui é o real (o do navegador está 28 min à frente) — coberto no teste de unidade.
  const after = ((await renewed.json()) as { data: { idleExpiresAt: string } }).data;
  expect(Date.parse(after.idleExpiresAt)).toBeGreaterThan(Date.parse(before.idleExpiresAt));
});

for (const variante of [
  '403',
  '404',
  '500',
  'sessao-expirada',
  'manutencao',
  'sem-vinculo',
  'vinculo-inativo',
  'acesso-indisponivel',
]) {
  test(`SCR-111 /erro/${variante} acessível`, async ({ page }) => {
    await page.goto(`/erro/${variante}?codigo=c-e2e-1`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectNoSeriousA11yViolations(page, `/erro/${variante}`);
  });
}
