import type { Meta, StoryObj } from '@storybook/react-vite';

import { Skeleton } from './skeleton.js';

const meta = {
  title: 'Componentes/Skeleton',
  component: Skeleton,
  args: { className: 'h-6 w-64' },
} satisfies Meta<typeof Skeleton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Line: Story = {};

export const Card: Story = { args: { className: 'h-32 w-80' } };
