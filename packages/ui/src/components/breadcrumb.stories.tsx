import type { Meta, StoryObj } from '@storybook/react-vite';

import { Breadcrumb } from './breadcrumb.js';

const meta = {
  title: 'Navegação/Breadcrumb',
  component: Breadcrumb,
  args: {
    items: [
      { label: 'Processos', href: '#processos' },
      { label: '0012/2026', href: '#processo' },
      { label: 'Termo de referência' },
    ],
  },
} satisfies Meta<typeof Breadcrumb>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Single: Story = { args: { items: [{ label: 'Painel' }] } };
