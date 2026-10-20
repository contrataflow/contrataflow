// Cria um processo pelo wizard (SCR-005 · US-001) para os E2E das abas do painel (SCR-006).
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

const PANEL_URL = /\/processos\/[0-9a-f-]{36}$/;

/**
 * Percorre Identificação → Origem e planejamento → Revisão e abre o painel do processo criado.
 * A API simulada é global: testes do mesmo arquivo em paralelo (ou a nova tentativa do CI) criam
 * títulos repetidos e a PRC-02 responde 409 de duplicidade; aqui isso não está em teste, então
 * confirma com "Criar mesmo assim" (o aviso em si é coberto em processes.spec.ts).
 */
export async function createProcessViaWizard(
  page: Page,
  { title, object }: { readonly title: string; readonly object: string },
): Promise<void> {
  await page.goto(`/api/auth/login?as=ana&returnTo=${encodeURIComponent('/processos/novo')}`);
  // Primeira carga do wizard (sessão, permissões e catálogos) sob a suíte em paralelo.
  await expect(page.getByRole('heading', { level: 1, name: 'Novo processo' })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByLabel('Título *').fill(title);
  await page.getByLabel('Objeto *').fill(object);
  await page.getByLabel('Tipo de contratação *').selectOption({ label: 'Aquisição de bens' });
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(
    page.getByRole('heading', { level: 2, name: 'Origem e planejamento' }),
  ).toBeVisible();
  await page.getByLabel('Origem *').selectOption({ label: 'Demanda não prevista' });
  await page.getByRole('radio', { name: 'Não se aplica' }).check();
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Revisão' })).toBeVisible();
  const [created] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/v1/processes',
    ),
    page.getByRole('button', { name: 'Criar processo' }).click(),
  ]);
  if (created.status() === 409) {
    await page.getByRole('button', { name: 'Criar mesmo assim' }).click();
  }
  await expect(page).toHaveURL(PANEL_URL);
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  // A navegação do cliente termina com o <title> da página (o axe de quem chama confere).
  await expect(page).toHaveTitle(/\S/);
}
