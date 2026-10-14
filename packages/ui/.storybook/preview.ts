import type { Preview } from '@storybook/react-vite';

import '../src/styles.css';

const preview: Preview = {
  parameters: {
    // Violações de acessibilidade falham a história (addon-a11y).
    a11y: { test: 'error' },
    layout: 'centered',
  },
};

export default preview;
