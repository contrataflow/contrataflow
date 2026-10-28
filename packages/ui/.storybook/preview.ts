import type { Preview } from '@storybook/react-vite';

import '../src/styles.css';

const preview: Preview = {
  parameters: {
    // Violações de acessibilidade falham a história (addon-a11y).
    a11y: { test: 'error' },
    layout: 'centered',
  },
  // Tema da interface (US-098 · prd-4): claro é o padrão; o escuro troca só os tokens semânticos.
  globalTypes: {
    theme: {
      description: 'Tema da interface',
      toolbar: {
        title: 'Tema',
        icon: 'mirror',
        items: [
          { value: 'light', title: 'Claro' },
          { value: 'dark', title: 'Escuro' },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: 'light' },
  decorators: [
    (Story, context) => {
      const root = document.documentElement;
      root.dataset.theme = context.globals.theme === 'dark' ? 'dark' : 'light';
      document.body.style.background = 'var(--color-background)';
      document.body.style.color = 'var(--color-foreground)';
      return Story();
    },
  ],
};

export default preview;
