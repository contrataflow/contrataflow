// E2E da aba "Comentários" de SCR-006 (US-071): processo criado pelo wizard; comentar, responder,
// editar (até 15 min), excluir o próprio e remover por moderação com motivo, com axe-core em cada
// estado e a largura de 360 px sem rolagem horizontal. A API é simulada (support/mock-api.mjs —
// cada processo nasce com um comentário da Cláudia); schema restrito, POL-09, status final, RLS e
// idempotência são cobertos nos testes da API (módulo `collaboration` e suíte tenant leak).
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { expectNoSeriousA11yViolations } from './support/a11y';

const TITLE = 'Aquisição de material de expediente para as escolas municipais';

async function openComments(page: Page): Promise<void> {
  await page.goto(`/api/auth/login?as=ana&returnTo=${encodeURIComponent('/processos/novo')}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Novo processo' })).toBeVisible();
  await page.getByLabel('Título *').fill(TITLE);
  await page.getByLabel('Objeto *').fill('Material de expediente para o ano letivo das escolas.');
  await page.getByLabel('Tipo de contratação *').selectOption({ label: 'Aquisição de bens' });
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(
    page.getByRole('heading', { level: 2, name: 'Origem e planejamento' }),
  ).toBeVisible();
  await page.getByLabel('Origem *').selectOption({ label: 'Demanda não prevista' });
  await page.getByRole('radio', { name: 'Não se aplica' }).check();
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Revisão' })).toBeVisible();
  await page.getByRole('button', { name: 'Criar processo' }).click();
  await expect(page).toHaveURL(/\/processos\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1, name: TITLE })).toBeVisible();
  await page.getByRole('tab', { name: /^Comentários/ }).click();
  await expect(page.getByText('Favor anexar a planilha de quantitativos do item 2.')).toBeVisible();
}

test('comentar, responder, editar, excluir e moderar na aba "Comentários"', async ({ page }) => {
  await openComments(page);
  const panel = page.getByRole('region', { name: 'Comentários' });
  await expectNoSeriousA11yViolations(page, 'aba Comentários');

  // Comentar (Ctrl+Enter) — o novo aparece no topo.
  const composer = panel.getByLabel('Comentário', { exact: true });
  await composer.fill('Precisamos rever **as quantidades** do item 2.');
  await composer.press('Control+Enter');
  await expect(panel.getByText('Comentário publicado')).toBeAttached();
  const first = panel.getByRole('article').first();
  await expect(first).toHaveAccessibleName(/^Comentário de Ana Souza, /);
  await expect(first.getByText('as quantidades')).toBeVisible();

  // Responder ao comentário da Cláudia.
  const claudia = panel.getByRole('article', { name: /^Comentário de Cláudia Ramos/ });
  await claudia.getByRole('button', { name: 'Responder' }).click();
  await panel.getByLabel('Resposta').fill('Planilha anexada na versão 2.');
  await panel.getByRole('button', { name: 'Responder' }).click();
  await expect(
    panel.getByRole('list', { name: 'Respostas' }).getByText('Planilha anexada na versão 2.'),
  ).toBeVisible();

  // Editar o próprio comentário (até 15 min) — passa a exibir "(editado)".
  await first.getByRole('button', { name: 'Mais ações do comentário de Ana Souza' }).click();
  await page.getByRole('menuitem', { name: /^Editar \(até / }).click();
  const edit = panel.getByLabel('Editar comentário');
  await edit.fill('Precisamos rever as quantidades dos itens 2 e 3.');
  await expectNoSeriousA11yViolations(page, 'edição de comentário');
  await panel.getByRole('button', { name: 'Salvar' }).click();
  await expect(panel.getByText('Precisamos rever as quantidades dos itens 2 e 3.')).toBeVisible();
  await expect(panel.getByRole('article').first()).toContainText('(editado)');

  // Excluir o próprio comentário.
  await panel
    .getByRole('article')
    .first()
    .getByRole('button', { name: 'Mais ações do comentário de Ana Souza' })
    .click();
  await page.getByRole('menuitem', { name: 'Excluir' }).click();
  const confirm = page.getByRole('dialog', { name: 'Excluir comentário' });
  await expect(
    confirm.getByText('O comentário será removido para todos. As respostas permanecem.'),
  ).toBeVisible();
  await confirm.getByRole('button', { name: 'Excluir' }).click();
  await expect(panel.getByText('Comentário excluído pelo autor')).toBeVisible();

  // Remover por moderação, com motivo.
  await claudia.getByRole('button', { name: 'Mais ações do comentário de Cláudia Ramos' }).click();
  await page.getByRole('menuitem', { name: 'Remover por moderação' }).click();
  const moderation = page.getByRole('dialog', { name: 'Remover por moderação' });
  await moderation.getByLabel('Motivo da remoção').fill('curto');
  await moderation.getByRole('button', { name: 'Remover' }).click();
  await expect(
    moderation.getByText('Informe o motivo da remoção (mín. 10 caracteres).'),
  ).toBeVisible();
  await moderation.getByLabel('Motivo da remoção').fill('Contém dados pessoais de terceiro.');
  await expectNoSeriousA11yViolations(page, 'diálogo de moderação');
  await moderation.getByRole('button', { name: 'Remover' }).click();
  await expect(panel.getByText('Comentário removido por moderação')).toBeVisible();
  await expect(panel.getByText('Motivo: Contém dados pessoais de terceiro.')).toBeVisible();
});

test('no celular (360 px) a aba ocupa a largura e continua acessível', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await openComments(page);
  const panel = page.getByRole('region', { name: 'Comentários' });
  await panel.getByLabel('Comentário', { exact: true }).fill('Comentário pelo celular.');
  await panel.getByRole('button', { name: 'Comentar' }).click();
  await expect(panel.getByText('Comentário pelo celular.')).toBeVisible();
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );
  expect(overflows).toBe(false);
  await expectNoSeriousA11yViolations(page, 'aba Comentários em 360 px');
});

test('mencionar com "@": autocomplete por teclado, publicação e menção destacada (US-072)', async ({
  page,
}) => {
  await openComments(page);
  const panel = page.getByRole('region', { name: 'Comentários' });
  const composer = panel.getByLabel('Comentário', { exact: true });
  await composer.pressSequentially('Pode revisar, @clau');
  const listbox = panel.getByRole('listbox', { name: 'Pessoas e unidades para mencionar' });
  await expect(listbox.getByRole('option', { name: /Cláudia Ramos/ })).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'autocomplete de menções');
  await composer.press('Enter');
  await expect(composer).toHaveValue('Pode revisar, @Cláudia Ramos ');
  await composer.pressSequentially('por favor.');
  await composer.press('Control+Enter');
  await expect(panel.getByText('Comentário publicado')).toBeAttached();
  const first = panel.getByRole('article').first();
  await expect(first.getByText('Pessoa:')).toBeAttached();
  await expect(first).toContainText('Cláudia Ramos');

  // FA-05: sem candidatos, a orientação leva a Participantes.
  await composer.pressSequentially('@zzz');
  await expect(panel.getByRole('link', { name: 'Ir para Participantes' })).toBeVisible();
});
