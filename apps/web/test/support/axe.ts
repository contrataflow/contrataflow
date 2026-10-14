// axe-core nos testes de componente (jsdom): violações sérias/críticas reprovam (RN-FND-96).
// Contraste depende de layout real e fica para o Storybook e o E2E.
import axe from 'axe-core';

const BLOCKING = new Set(['serious', 'critical']);

export async function seriousA11yViolations(root: Element = document.body): Promise<string[]> {
  const results = await axe.run(root, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    rules: { 'color-contrast': { enabled: false } },
    resultTypes: ['violations'],
  });
  return results.violations
    .filter((violation) => BLOCKING.has(violation.impact ?? ''))
    .map((violation) => `${violation.id}: ${violation.help}`);
}
