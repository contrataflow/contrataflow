// Interação com os controles do kit (`@contrataflow/ui`, Radix) nos testes de componente: no
// lugar de `selectOptions`/`fireEvent.change` dos controles nativos (prd-5 · §3).
import { screen, within } from '@testing-library/react';
import type { userEvent } from '@testing-library/user-event';

type User = ReturnType<typeof userEvent.setup>;
type Container = HTMLElement;

/** Abre o `Select` (combobox) de nome `name` e escolhe a opção `option`. */
export async function chooseOption(
  user: User,
  name: string | RegExp,
  option: string | RegExp,
  container?: Container,
): Promise<void> {
  const scope = container ? within(container) : screen;
  await user.click(scope.getByRole('combobox', { name }));
  await user.click(await screen.findByRole('option', { name: option }));
}

/** Textos das opções do `Select` de nome `name` (abre e fecha com Esc). */
export async function optionLabels(
  user: User,
  name: string | RegExp,
  container?: Container,
): Promise<string[]> {
  const scope = container ? within(container) : screen;
  await user.click(scope.getByRole('combobox', { name }));
  const labels = (await screen.findAllByRole('option')).map((option) => option.textContent);
  await user.keyboard('{Escape}');
  return labels;
}

const MONTHS = Array.from({ length: 12 }, (_, index) =>
  new Intl.DateTimeFormat('pt-BR', { month: 'long' }).format(new Date(2026, index, 1)),
);

/** Mês exibido na grade ("outubro 2026") como `ano * 12 + mês`. */
function monthOf(caption: string): number {
  const text = caption.toLowerCase();
  const index = MONTHS.findIndex((name) => text.includes(name));
  const year = Number(/\d{4}/.exec(text)?.[0]);
  if (index < 0 || Number.isNaN(year)) throw new Error(`mês do calendário ilegível: ${caption}`);
  return year * 12 + index;
}

/**
 * Escolhe `aaaa-MM-dd` no `DatePicker` de nome `label`: abre o calendário (no mês da data atual
 * ou de hoje), navega mês a mês até o alvo e clica no dia.
 */
export async function pickDate(user: User, label: string | RegExp, iso: string): Promise<void> {
  const [year, month, day] = iso.split('-').map(Number) as [number, number, number];
  const target = year * 12 + month - 1;
  await user.click(screen.getByRole('button', { name: label }));
  const calendar = await screen.findByRole('dialog', { name: /^Escolher/ });
  // Botões de navegação (não o teclado): dentro de Dialog/Sheet o foco inicial não cai na grade.
  for (let step = 0; step < 240; step += 1) {
    const shown = monthOf(within(calendar).getByRole('grid').getAttribute('aria-label') ?? '');
    if (shown === target) break;
    await user.click(
      within(calendar).getByRole('button', {
        name: shown < target ? 'Ir para o próximo mês' : 'Ir para o mês anterior',
      }),
    );
  }
  const cell = within(calendar)
    .getAllByRole('gridcell')
    .find((item) => !item.hasAttribute('data-outside') && item.textContent === String(day));
  const button = cell?.querySelector('button');
  if (!button) throw new Error(`dia ${iso} ausente no calendário`);
  await user.click(button);
}
