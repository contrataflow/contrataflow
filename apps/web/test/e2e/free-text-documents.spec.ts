// E2E do documento livre (US-063 · SCR-006 e SCR-105): na aba "Documentos" do processo, a
// redatora escolhe o Ofício no menu "Criar documento", informa o título no diálogo e cai na SCR-105
// com o ofício numerado e o editor de seções do modelo; redige o conteúdo com o autosave (DOC-05),
// marca "Não se aplica" com justificativa na seção que admite, recarrega a página e confere que
// tudo persistiu. axe-core no diálogo e no editor e o editor em coluna única em 360 px. A API é
// simulada (support/mock-api.mjs); a numeração, o template publicado, a atomicidade, POL-02 e o
// isolamento por tenant são cobertos nos testes da API (módulo `document` e suíte tenant leak).
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/a11y';

/** Processo 0036/2026 da API simulada: o Ofício (livre) no menu "Criar documento". */
const PROCESS_PATH = '/processos/0192a000-0000-7000-8000-000000100036';
const DOCUMENT_PATH = /\/processos\/[0-9a-f-]{36}\/documentos\/[0-9a-f-]{36}$/;
const PROCESS_TITLE = 'Manutenção das praças do centro';

// O estado da API simulada é global: os passos desta jornada rodam em série.
test.describe.configure({ mode: 'serial' });

async function openDocumentsTab(page: Page): Promise<void> {
  const path = `${PROCESS_PATH}?aba=documentos`;
  await page.goto(`/api/auth/login?as=ana&returnTo=${encodeURIComponent(path)}`);
  await expect(page.getByRole('heading', { level: 1, name: PROCESS_TITLE })).toBeVisible();
}

async function createOficio(page: Page, title: string): Promise<void> {
  await openDocumentsTab(page);
  await page.getByRole('button', { name: 'Criar documento' }).first().click();
  // No desktop o "Criar documento" abre um menu; no celular, uma folha (diálogo) com botões.
  await page
    .getByRole('menuitem', { name: 'Ofício' })
    .or(page.getByRole('dialog').getByRole('button', { name: 'Ofício', exact: true }))
    .click();
  const dialog = page.getByRole('dialog', { name: 'Novo documento: Ofício' });
  await expect(dialog.getByText('Em branco, o responsável é você.')).toBeVisible();
  await dialog.getByLabel('Título').fill(title);
  await expectNoSeriousA11yViolations(page, 'diálogo Novo documento: Ofício');
  await dialog.getByRole('button', { name: 'Criar e redigir' }).click();
  await expect(page).toHaveURL(DOCUMENT_PATH);
}

test('criar um ofício pelo painel, redigir com autosave, "não se aplica" justificado e conferir após recarregar', async ({
  page,
}) => {
  await createOficio(page, 'Solicitação de poda das árvores');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Solicitação de poda das árvores' }),
  ).toBeVisible();
  await expect(page.getByText(/^OF \d{4}\/2026$/)).toBeVisible();

  // Seções na ordem do modelo, com orientação e base legal; o conteúdo nasce do modelo.
  const nav = page.getByRole('navigation', { name: 'Seções do documento' });
  await expect(nav.getByRole('button', { name: /^1\. Conteúdo do ofício/ })).toHaveAttribute(
    'aria-current',
    'true',
  );
  await expect(page.getByText(/Base legal: Lei 14\.133\/2021, art\. 12/)).toBeVisible();
  const content = page.getByLabel('Texto da seção Conteúdo do ofício');
  await expect(content).toHaveValue(/Processo 0036\/2026/);

  await content.fill('Solicitamos a poda das árvores da Praça XV de Novembro.');
  await expect(page.getByText(/^Salvo às \d{2}:\d{2}$/)).toBeVisible();

  // "Não se aplica" em "Anexos referidos": justificativa curta recusada; a válida é gravada.
  await nav.getByRole('button', { name: /^2\. Anexos referidos/ }).click();
  await page.getByRole('button', { name: 'Não se aplica' }).click();
  await page.getByLabel(/^Justificativa( \*)?$/).fill('Sem anexos');
  await page.getByRole('button', { name: 'Confirmar' }).click();
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: 'Justifique por que esta seção não se aplica (mín. 20 caracteres).' }),
  ).toBeVisible();
  await page.getByLabel(/^Justificativa( \*)?$/).fill('O ofício não encaminha documentos anexos.');
  await page.getByRole('button', { name: 'Confirmar' }).click();
  await expect(page.getByText('Esta seção não se aplica')).toBeVisible();
  await expect(nav.getByRole('button', { name: /Anexos referidos.*Não se aplica/ })).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'editor do documento livre');

  // Recarregar: o texto e o "não se aplica" vêm do servidor.
  await page.reload();
  await expect(page.getByLabel('Texto da seção Conteúdo do ofício')).toHaveValue(
    'Solicitamos a poda das árvores da Praça XV de Novembro.',
  );
  await expect(
    page
      .getByRole('navigation', { name: 'Seções do documento' })
      .getByRole('button', { name: /Anexos referidos.*Não se aplica/ }),
  ).toBeVisible();
});

test('no celular (360 px) o editor fica em coluna única, com o menu "Seções", sem rolagem horizontal', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await createOficio(page, 'Ofício para a Secretaria de Obras');
  await expect(page.getByLabel('Texto da seção Conteúdo do ofício')).toBeVisible();
  await page.getByRole('button', { name: 'Seções' }).click();
  await expect(
    page
      .getByRole('navigation', { name: 'Seções do documento' })
      .first()
      .getByRole('button', { name: /^2\. Anexos referidos/ }),
  ).toBeVisible();
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(overflows).toBe(false);
  await expectNoSeriousA11yViolations(page, 'editor do documento livre em 360 px');
});
