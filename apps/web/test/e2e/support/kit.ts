// Controles do kit (`@contrataflow/ui`, Radix) nos E2E: no lugar de `selectOption` do `<select>`
// nativo (prd-5 · §3).
import type { Locator, Page } from '@playwright/test';

/** Abre o `Select` de nome `name` (dentro de `scope`) e escolhe a opção `option`. */
export async function chooseOption(
  page: Page,
  name: string | RegExp,
  option: string | RegExp,
  scope: Page | Locator = page,
): Promise<void> {
  await scope.getByRole('combobox', { name }).click();
  await page.getByRole('option', { name: option, exact: typeof option === 'string' }).click();
}
