import type { Meta, StoryObj } from '@storybook/react-vite';

import { Calendar } from './calendar.js';

const meta = {
  title: 'Formulário/Calendar',
  component: Calendar,
  args: { defaultMonth: new Date(2026, 9, 1) },
} satisfies Meta<typeof Calendar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Single: Story = {
  args: { mode: 'single', selected: new Date(2026, 9, 15) },
};

export const Range: Story = {
  args: {
    mode: 'range',
    numberOfMonths: 2,
    selected: { from: new Date(2026, 9, 6), to: new Date(2026, 9, 17) },
  },
};

export const WeekdaysOnly: Story = {
  args: { mode: 'single', disabled: { dayOfWeek: [0, 6] } },
};
