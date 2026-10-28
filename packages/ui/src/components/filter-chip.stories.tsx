import type { Meta, StoryObj } from '@storybook/react-vite';

import { FilterChip } from './filter-chip.js';

const meta = {
  title: 'Componentes/FilterChip',
  component: FilterChip,
  args: {
    children: 'Situação: Em andamento',
    removeLabel: 'Remover filtro de situação',
    onRemove: () => undefined,
  },
} satisfies Meta<typeof FilterChip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
