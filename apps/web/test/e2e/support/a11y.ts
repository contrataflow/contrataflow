// axe-core em cada página do E2E (US-079 — RN-FND-27 · V-10 · architecture.md §8.13): violações
// sérias ou críticas de WCAG 2.1 AA bloqueiam no mesmo nível que uma falha funcional.
import { createRequire } from 'node:module';

import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { AxeResults, Result } from 'axe-core';

declare global {
  interface Window {
    axe: { run: (context: Document, options: object) => Promise<AxeResults> };
  }
}

const AXE_SCRIPT = createRequire(import.meta.url).resolve('axe-core/axe.min.js');

/** Impactos que bloqueiam o merge. */
export const BLOCKING_IMPACTS = ['serious', 'critical'] as const;

export function a11yMessage(violation: Pick<Result, 'id'>, page: string): string {
  return `Violação de acessibilidade: ${violation.id} em ${page}.`;
}

export async function expectNoSeriousA11yViolations(page: Page, pageName: string): Promise<void> {
  await page.addScriptTag({ path: AXE_SCRIPT });
  const results = await page.evaluate(() =>
    window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    }),
  );
  const blocking = results.violations.filter((violation) =>
    (BLOCKING_IMPACTS as readonly string[]).includes(violation.impact ?? ''),
  );
  expect(blocking.map((violation) => a11yMessage(violation, pageName))).toEqual([]);
}
