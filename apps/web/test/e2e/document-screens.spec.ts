// E2E de fumaça das telas de documento do processo (spec-597): DFD (SCR-007), ETP (SCR-008), TR e
// Riscos (SCR-011) abrem inteiras na API simulada — anexos, comentários e pendências carregam, sem
// "Não foi possível carregar…" — e não têm violação séria do axe-core. A API é simulada
// (support/mock-api.mjs: processos 0028, 0034, 0047 e 0048); as regras de cada módulo são cobertas
// nos testes da API e nos E2E de cada tela.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/a11y';

const processPath = (n: number) =>
  `/processos/0192a000-0000-7000-8000-${String(100000 + n).padStart(12, '0')}`;

async function open(page: Page, path: string): Promise<void> {
  await page.goto(`/api/auth/login?as=ana&returnTo=${encodeURIComponent(path)}`);
  await expect(page).toHaveURL(new RegExp(`${path}$`));
}

async function expectLoadedWithoutErrors(page: Page): Promise<void> {
  // Espera os blocos assíncronos (anexos, comentários, pendências) saírem do carregamento.
  await expect(page.getByText(/Carregando/i)).toHaveCount(0);
  await expect(page.getByText(/Não foi possível/)).toHaveCount(0);
}

test.describe('Telas de documento na API simulada', () => {
  test('ETP 0002/2026: seções, pendências, anexo e comentários', async ({ page }) => {
    await open(page, `${processPath(28)}/etp/0192a000-0000-7000-8000-0000000e1928`);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Estudo Técnico Preliminar — 0028/2026' }),
    ).toBeVisible();
    await expect(page.getByText('1 pendência impede a conclusão')).toBeVisible();
    await expect(page.getByText('planilha-de-quantitativos.pdf')).toBeVisible();
    await expect(page.getByText('a planilha segue na próxima versão.')).toBeVisible();
    await expectLoadedWithoutErrors(page);
    await expectNoSeriousA11yViolations(page, 'ETP (API simulada)');
  });

  test('TR 0002/2026: pendências, anexos e comentários', async ({ page }) => {
    await open(page, `${processPath(34)}/tr/0192a000-0000-7000-8000-0000000e2934`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByText('planilha-de-quantitativos.pdf')).toBeVisible();
    await expect(
      page.getByText('Favor anexar a planilha de quantitativos do item 2.'),
    ).toBeVisible();
    await expectLoadedWithoutErrors(page);
    await expectNoSeriousA11yViolations(page, 'TR (API simulada)');
  });

  test('Riscos 0048/2026: lista, matriz e pendência do mapa', async ({ page }) => {
    await open(page, `${processPath(48)}/riscos`);
    await expect(page.getByRole('heading', { level: 1, name: 'Riscos' })).toBeVisible();
    await expect(page.getByText('Atraso na entrega dos equipamentos')).toBeVisible();
    await expectLoadedWithoutErrors(page);
    await expectNoSeriousA11yViolations(page, 'Riscos — lista (API simulada)');

    await page.getByRole('tab', { name: 'Matriz' }).click();
    await expect(
      page.getByText('O risco R01 precisa de ao menos uma ação de tratamento.'),
    ).toBeVisible();
    await expectLoadedWithoutErrors(page);
    await expectNoSeriousA11yViolations(page, 'Riscos — matriz (API simulada)');
  });

  test('DFD 0006/2026: revisão com o resumo, os itens e as pendências', async ({ page }) => {
    await open(page, `${processPath(47)}/dfd/0192a000-0000-7000-8000-0000000e4701`);
    await expect(page.getByRole('heading', { level: 1, name: 'DFD 0006/2026' })).toBeVisible();
    await expect(page.getByRole('definition').filter({ hasText: '2 itens' })).toBeVisible();
    await expect(page.getByText('A seção "Observações" ainda não foi preenchida.')).toBeVisible();
    await expectLoadedWithoutErrors(page);
    await expectNoSeriousA11yViolations(page, 'DFD — revisão (API simulada)');
  });

  test('DFD 0006/2026: conteúdo de IA pendente é revisado no próprio assistente', async ({
    page,
  }) => {
    const mockApiUrl = String(test.info().config.metadata.mockApiUrl);
    await fetch(`${mockApiUrl}/__mock/dfd-ai-pending`, { method: 'POST' });
    await open(page, `${processPath(47)}/dfd/0192a000-0000-7000-8000-0000000e4701`);
    const pending = page.getByText(
      'Revise o conteúdo gerado por IA na seção "Resultados esperados".',
    );
    await expect(pending).toBeVisible();

    await page
      .getByRole('button', { name: 'Marcar a seção Resultados esperados como revisada' })
      .click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('checkbox', { name: 'Li e revisei a seção' }).click();
    await expectNoSeriousA11yViolations(page, 'DFD — confirmação da revisão de IA');
    await dialog.getByRole('button', { name: 'Marcar a seção como revisada' }).click();
    await expect(pending).toHaveCount(0);
    await expectLoadedWithoutErrors(page);

    // No passo de edição o selo passa a "revisada" e o botão some.
    await page.goto(
      `${processPath(47)}/dfd/0192a000-0000-7000-8000-0000000e4701?passo=justificativa`,
    );
    await expect(page.getByRole('heading', { level: 2, name: 'Justificativa' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Marcar seção como revisada' })).toHaveCount(0);
    await expectNoSeriousA11yViolations(page, 'DFD — justificativa com selo de IA');
  });
});
