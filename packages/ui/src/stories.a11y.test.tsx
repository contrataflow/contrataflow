/// <reference types="vite/client" />
// Gate de acessibilidade do design system (RN-FND-91/96 · V-05): toda história de todo componente
// é renderizada e auditada pelo axe-core (WCAG 2.1 A/AA); violação séria ou crítica reprova o CI.
// Contraste de cor depende de layout real e é verificado no Storybook (addon-a11y) e no E2E.
import { readdirSync } from 'node:fs';
import path from 'node:path';

import { composeStories } from '@storybook/react-vite';
import { cleanup, render } from '@testing-library/react';
import axe from 'axe-core';
import type { ComponentType } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

type StoryModule = Parameters<typeof composeStories>[0];

const modules = import.meta.glob<StoryModule>('./components/*.stories.tsx', { eager: true });

const COMPONENTS_DIR = path.join(import.meta.dirname, 'components');
const BLOCKING_IMPACTS = new Set(['serious', 'critical']);

afterEach(cleanup);

async function blockingViolations(): Promise<string[]> {
  const results = await axe.run(document.body, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    rules: { 'color-contrast': { enabled: false } },
    resultTypes: ['violations'],
  });
  return results.violations
    .filter((violation) => BLOCKING_IMPACTS.has(violation.impact ?? ''))
    .map((violation) => `${violation.id}: ${violation.help}`);
}

describe('gate de acessibilidade', () => {
  it('barra violação séria (fixture)', async () => {
    render(
      <button type="button">
        <svg aria-hidden="true" />
      </button>,
    );
    expect(await blockingViolations()).toEqual([expect.stringMatching(/^button-name:/)]);
  });
});

describe('V-05 — todo componente tem história no Storybook', () => {
  it.each(
    readdirSync(COMPONENTS_DIR).filter(
      (file) =>
        file.endsWith('.tsx') && !file.endsWith('.test.tsx') && !file.endsWith('.stories.tsx'),
    ),
  )('%s tem história', (file) => {
    const story = `./components/${file.replace(/\.tsx$/, '.stories.tsx')}`;
    expect(Object.keys(modules), `Crie ${story} (história + teste axe obrigatórios).`).toContain(
      story,
    );
  });
});

describe.each(Object.entries(modules))(
  'histórias de %s sem violação séria de acessibilidade',
  (_, module) => {
    const composed: Record<string, ComponentType> = composeStories(module);
    const stories = Object.entries(composed);

    it.each(stories)('%s', async (_name, Story) => {
      render(<Story />);
      expect(await blockingViolations()).toEqual([]);
    });
  },
);
