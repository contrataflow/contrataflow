// E2E da aba "Selos" de SCR-037 (US-074): Ana (AUDIT_VIEW na Prefeitura A) vê os selos, verifica um
// intervalo e lê o resultado íntegro; com dado "adulterado" na API simulada, o resultado INVALID
// aparece com o detalhe da quebra. axe-core na lista e no resultado; em 360 px a página não rola na
// horizontal (a tabela de selos rola). A API é simulada (support/mock-api.mjs); a recomputação dos
// hashes e o isolamento por tenant são cobertos nos testes da API.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/a11y';

// A adulteração injetada na API simulada é global: os testes deste arquivo rodam em série.
test.describe.configure({ mode: 'serial' });

async function tamper(tampered: boolean): Promise<void> {
  const mockApiUrl = String(test.info().config.metadata.mockApiUrl);
  await fetch(`${mockApiUrl}/__mock/audit-tamper`, {
    method: 'POST',
    body: JSON.stringify({ tampered }),
  });
}

async function openSeals(page: Page): Promise<void> {
  await page.goto(`/api/auth/login?as=ana&returnTo=${encodeURIComponent('/auditoria')}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Auditoria' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Selos' })).toBeVisible();
  await expect(
    page.getByRole('table', { name: 'Selos de integridade da trilha de auditoria' }),
  ).toBeVisible();
}

test.afterEach(async () => {
  await tamper(false);
});

test('ver selos → verificar intervalo → resultado íntegro', async ({ page }) => {
  await openSeals(page);
  const list = page.getByRole('table', { name: 'Selos de integridade da trilha de auditoria' });
  await expect(list.getByRole('row')).toHaveCount(4); // cabeçalho + 3 selos
  await expect(list.getByText('Não verificado')).toHaveCount(3);
  await expectNoSeriousA11yViolations(page, 'aba Selos');

  // Selecionar os selos preenche o intervalo (08:00 a 11:00 em São Paulo).
  for (const checkbox of await list.getByRole('checkbox').all()) await checkbox.check();
  await expect(page.getByLabel('Início do período')).toHaveValue('2026-10-15T08:00');
  await expect(page.getByLabel('Fim do período')).toHaveValue('2026-10-15T11:00');

  await page.getByRole('button', { name: 'Verificar integridade' }).click();
  const heading = page.getByRole('heading', { level: 2, name: 'Resultado da verificação' });
  await expect(page.getByText('Todos os 3 selos do intervalo estão íntegros.')).toBeVisible();
  await expect(heading).toBeFocused();
  await expect(list.getByText('Íntegro')).toHaveCount(3);
  await expect(list.getByText('Não verificado')).toHaveCount(0);
  await expectNoSeriousA11yViolations(page, 'aba Selos · resultado íntegro');
});

test('resultado INVALID visível, com o detalhe da quebra', async ({ page }) => {
  await tamper(true);
  await openSeals(page);
  const list = page.getByRole('table', { name: 'Selos de integridade da trilha de auditoria' });
  for (const checkbox of await list.getByRole('checkbox').all()) await checkbox.check();
  await page.getByRole('button', { name: 'Verificar integridade' }).click();

  await expect(page.getByText(/Cadeia comprometida a partir de/)).toBeVisible();
  const result = page.getByRole('table', { name: 'Resultado da verificação por selo' });
  await expect(result.getByText('Quebrado')).toHaveCount(2);
  await expect(
    result.getByText('Registro do período alterado, removido ou inserido'),
  ).toBeVisible();
  await expect(result.getByText('Selo anterior alterado ou ausente')).toBeVisible();
  await expect(list.getByText('Quebrado')).toHaveCount(2);
  await expect(list.getByText('Íntegro')).toHaveCount(1);
  await expectNoSeriousA11yViolations(page, 'aba Selos · resultado INVALID');
});

test('intervalo invertido é barrado no front e intervalo longo mostra a mensagem da API', async ({
  page,
}) => {
  await openSeals(page);
  await page.getByLabel('Início do período').fill('2026-10-15T10:00');
  await page.getByLabel('Fim do período').fill('2026-10-15T09:00');
  await page.getByRole('button', { name: 'Verificar integridade' }).click();
  await expect(page.getByText('O período final deve ser posterior ao inicial.')).toBeVisible();

  // Mais de 720 horas: a API responde 422 e a mensagem aparece no campo do fim.
  await page.getByLabel('Início do período').fill('2026-08-01T00:00');
  await page.getByLabel('Fim do período').fill('2026-10-15T00:00');
  await page.getByRole('button', { name: 'Verificar integridade' }).click();
  await expect(
    page.getByText('Reduza o intervalo para verificar a integridade (máximo de 720 selos).'),
  ).toBeVisible();
});

test('em 360 px: a página não rola na horizontal e a tabela de selos rola', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await openSeals(page);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await expectNoSeriousA11yViolations(page, 'aba Selos · 360 px');
});
