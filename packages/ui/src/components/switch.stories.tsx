import type { Meta, StoryObj } from '@storybook/react-vite';

import { Label } from './field.js';
import { Switch } from './switch.js';

const meta: Meta<typeof Switch> = {
  title: 'Formulário/Switch',
  component: Switch,
  args: { id: 'notificar' },
  render: (args) => (
    <div className="flex items-center gap-3">
      <Switch {...args} />
      <Label htmlFor={args.id} className="font-normal">
        Receber resumo diário por e-mail
      </Label>
    </div>
  ),
};

export default meta;
type Story = StoryObj<typeof Switch>;

export const Off: Story = {};

export const On: Story = { args: { defaultChecked: true } };

export const Disabled: Story = { args: { disabled: true } };
