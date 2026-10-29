// E2E do alerta de atraso de etapa (US-114 · SCR-036): o job `deadlines` + `NotificationDispatcher`
// são simulados na API (`/__mock/stage-overdue`, um STAGE_OVERDUE por destinatário distinto); o
// responsável da etapa (Ana) e a titular da unidade (Lúcia) veem o aviso no sininho e na página
// de notificações, com o nome da etapa e as datas no fuso do tenant. axe-core na página (com o
// menu aberto, o Radix marca o resto da tela como `aria-hidden` e o axe acusa falso positivo).
// Quem recebe, a deduplicação e o isolamento por tenant são cobertos nos testes do worker.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/a11y';

const PROCESS_ID = '0192a114-0000-7000-8000-000000000001';
// Nome único por execução: com o servidor da API simulada reaproveitado, avisos antigos não
// confundem as asserções.
const STAGE = `Análise jurídica ${Date.now().toString(36)}`;

// O aviso é gravado uma vez na API simulada compartilhada: os testes deste arquivo rodam em série.
test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  const mockApiUrl = String(test.info().config.metadata.mockApiUrl);
  await fetch(`${mockApiUrl}/__mock/stage-overdue`, {
    method: 'POST',
    body: JSON.stringify({
      processId: PROCESS_ID,
      stageName: STAGE,
      dueDate: '16/10/2026',
      overdueSince: '17/10/2026 às 00:15',
      // Responsável e titular da unidade (escalonamento do atraso — RN-NTF-27).
      recipients: ['sub-ana', 'sub-lucia'],
    }),
  });
});

async function expectOverdueAlert(page: Page, persona: string): Promise<void> {
  await page.goto(`/api/auth/login?as=${persona}&returnTo=${encodeURIComponent('/')}`);
  const bell = page.getByRole('button', { name: /^Notificações \(\d+ não lidas?\)$/ });
  await expect(bell).toBeVisible();
  await bell.click();
  const panel = page.getByRole('dialog', { name: 'Notificações recentes' });
  await expect(panel).toBeVisible();
  const item = panel.getByRole('link', { name: /Prazo da etapa vencido/ }).first();
  await expect(item).toHaveAttribute('href', `/processos/${PROCESS_ID}`);
  await page.keyboard.press('Escape');

  await page.goto('/notificacoes');
  await expect(
    page
      .getByText(
        `O prazo da etapa “${STAGE}” terminou em 16/10/2026; o atraso foi registrado em 17/10/2026 às 00:15. Abra o processo para regularizar.`,
      )
      .first(),
  ).toBeVisible();
  await expectNoSeriousA11yViolations(page, `notificações com aviso de atraso (${persona})`);
}

test('o responsável da etapa vê o aviso de atraso no sininho e na página de notificações', async ({
  page,
}) => {
  await expectOverdueAlert(page, 'ana');
});

test('a titular da unidade também recebe o mesmo aviso (escalonamento)', async ({ page }) => {
  await expectOverdueAlert(page, 'lucia');
});
