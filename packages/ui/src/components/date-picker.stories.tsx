import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { DatePicker, DateRangePicker } from './date-picker.js';
import type { DateRange } from './date-picker.js';
import { Field } from './field.js';

function DeadlinePicker({ initial }: { readonly initial?: Date | undefined }) {
  const [value, setValue] = useState<Date | undefined>(initial);
  return (
    <div className="w-72">
      <Field label="Prazo de entrega">
        <DatePicker value={value} onValueChange={setValue} clearable />
      </Field>
    </div>
  );
}

function PeriodPicker({ initial }: { readonly initial?: DateRange | undefined }) {
  const [value, setValue] = useState<DateRange | undefined>(initial);
  return (
    <div className="w-80">
      <Field label="Período de abertura">
        <DateRangePicker value={value} onValueChange={setValue} clearable />
      </Field>
    </div>
  );
}

const meta = {
  title: 'Formulário/DatePicker',
  component: DeadlinePicker,
} satisfies Meta<typeof DeadlinePicker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

export const WithValue: Story = { args: { initial: new Date(2026, 10, 30) } };

export const Range: Story = {
  render: () => (
    <PeriodPicker initial={{ from: new Date(2026, 9, 1), to: new Date(2026, 9, 31) }} />
  ),
};
