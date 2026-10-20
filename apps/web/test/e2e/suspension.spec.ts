// E2E da jornada J-06 (US-008 · SCR-116 sobre SCR-006): a gestora suspende o processo pelo menu
// "Mais" com o motivo, vê o banner "Suspenso desde … — motivo" e o prazo pausado, retoma pela ação
// primária "Retomar processo" com a prévia do prazo e confere o processo de volta à situação
// anterior. axe-core nos diálogos e o diálogo em tela cheia a 360 px. A API é simulada
// (support/mock-api.mjs — suspensão e retomada no mesmo dia: nenhum dia útil acrescentado); a
// extensão por dias úteis com feriados, o congelamento das ações, permissões e concorrência são
// cobertos nos testes da API.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/a11y';

// A suspensão da API simulada é global: os passos desta jornada rodam em série.
test.describe.configure({ mode: 'serial' });

/** Processo 0031/2026 da lista simulada (`listProcessId(31)`, devolvido). */
const PROCESS_PATH = '/processos/0192a000-0000-7000-8000-000000100031';
const REASON = 'Aguardando definição da dotação pela Secretaria de Finanças';

async function openProcess(page: Page): Promise<void> {
  await page.goto(`/api/auth/login?as=ana&returnTo=${encodeURIComponent(PROCESS_PATH)}`);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Contratação de limpeza hospitalar' }),
  ).toBeVisible();
}

test('J-06: suspender com motivo, ver o painel suspenso, retomar e voltar à situação anterior', async ({
  page,
}) => {
  await openProcess(page);

  await page.getByRole('button', { name: 'Mais ações do processo' }).click();
  await page.getByRole('menuitem', { name: 'Suspender processo' }).click();
  const suspend = page.getByRole('dialog', { name: 'Suspender processo' });
  await expect(
    suspend.getByText(
      'Os prazos ficam pausados e ninguém poderá tramitar ou decidir aprovações até a retomada.',
    ),
  ).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'diálogo Suspender processo');

  // V-01 no front: motivo curto não chega à API.
  await suspend.getByLabel('Motivo').fill('Pausa');
  await suspend.getByRole('button', { name: 'Suspender' }).click();
  await expect(
    suspend.getByText('Informe o motivo da suspensão (mínimo de 20 caracteres).'),
  ).toBeVisible();

  await suspend.getByLabel('Motivo').fill(REASON);
  await suspend.getByRole('button', { name: 'Suspender' }).click();
  await expect(suspend).toBeHidden();
  await expect(
    page.getByText('Processo suspenso. Os prazos estão pausados.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(new RegExp(`^Suspenso desde \\d{2}/\\d{2}/\\d{4} — ${REASON}$`)),
  ).toBeVisible();
  await expect(page.getByText('Prazo pausado').first()).toBeVisible();

  await page.getByRole('button', { name: 'Retomar processo' }).click();
  const resume = page.getByRole('dialog', { name: 'Retomar processo' });
  await expect(resume.getByText('Nenhum dia útil será acrescentado.')).toBeVisible();
  await expect(resume.getByText('O prazo alvo continua 30/11/2026.')).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'diálogo Retomar processo');
  await resume.getByLabel('Comentário (opcional)').fill('Dotação definida pela Secretaria.');
  await resume.getByRole('button', { name: 'Retomar' }).click();
  await expect(resume).toBeHidden();
  await expect(
    page.getByText('Processo retomado. Novo prazo da etapa: 07/10/2026.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/^Suspenso desde/)).toHaveCount(0);
});

test('em 360 px: o diálogo de suspensão ocupa a tela, sem rolagem horizontal', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await openProcess(page);
  await page.getByRole('button', { name: 'Mais ações do processo' }).click();
  await page.getByRole('menuitem', { name: 'Suspender processo' }).click();
  const dialog = page.getByRole('dialog', { name: 'Suspender processo' });
  await expect(dialog.getByLabel('Motivo')).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(359);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});
