import type { Meta, StoryObj } from '@storybook/react-vite';

import { Progress } from './progress.js';

const meta: Meta<typeof Progress> = {
  title: 'Componentes/Progress',
  component: Progress,
  args: { value: 60, 'aria-label': 'Preenchimento do ETP' },
  decorators: [(Story) => <div className="w-72">{Story()}</div>],
};

export default meta;
type Story = StoryObj<typeof Progress>;

export const Default: Story = {};

export const Warning: Story = { args: { value: 90, tone: 'warning' } };

export const Complete: Story = { args: { value: 100, tone: 'success' } };

export const Indeterminate: Story = { args: { value: null } };
