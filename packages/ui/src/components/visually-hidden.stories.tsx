import type { Meta, StoryObj } from '@storybook/react-vite';

import { VisuallyHidden } from './visually-hidden.js';

const meta = {
  title: 'Componentes/VisuallyHidden',
  component: VisuallyHidden,
  render: (args) => (
    <button type="button">
      <span aria-hidden="true">×</span>
      <VisuallyHidden {...args} />
    </button>
  ),
  args: { children: 'Fechar' },
} satisfies Meta<typeof VisuallyHidden>;

export default meta;
type Story = StoryObj<typeof meta>;

export const InsideButton: Story = {};
