import type { StorybookConfig } from '@storybook/react-vite';

// Storybook do design system (RN-FND-91): uma história por componente, com o painel de
// acessibilidade (axe) falhando em violação — o gate de CI roda as mesmas histórias no Vitest
// (src/stories.a11y.test.tsx).
const config: StorybookConfig = {
  framework: '@storybook/react-vite',
  stories: ['../src/**/*.stories.tsx'],
  addons: ['@storybook/addon-a11y'],
  core: { disableTelemetry: true },
};

export default config;
