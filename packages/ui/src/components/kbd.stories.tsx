import type { Meta, StoryObj } from '@storybook/react-vite';

import { Kbd } from './kbd.js';

const meta = {
  title: 'Componentes/Kbd',
  component: Kbd,
  args: { children: 'Ctrl K' },
} satisfies Meta<typeof Kbd>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Shortcut: Story = {};
