import type { Meta, StoryObj } from '@storybook/react-vite';

import { Checkbox } from './checkbox.js';
import { Label } from './field.js';

const meta: Meta<typeof Checkbox> = {
  title: 'Formulário/Checkbox',
  component: Checkbox,
  args: { id: 'aceite' },
  render: (args) => (
    <div className="flex items-center gap-2">
      <Checkbox {...args} />
      <Label htmlFor={args.id} className="font-normal">
        Declaro que revisei os itens
      </Label>
    </div>
  ),
};

export default meta;
type Story = StoryObj<typeof Checkbox>;

export const Unchecked: Story = {};

export const Checked: Story = { args: { defaultChecked: true } };

export const Indeterminate: Story = { args: { checked: 'indeterminate' } };

export const Disabled: Story = { args: { disabled: true } };
