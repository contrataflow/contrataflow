import type { Meta, StoryObj } from '@storybook/react-vite';

import { Search } from '../icons.js';
import { Field } from './field.js';
import { Input, Textarea } from './input.js';

const meta: Meta<typeof Input> = {
  title: 'Formulário/Input',
  component: Input,
  args: { 'aria-label': 'Objeto', placeholder: 'Descreva o objeto' },
  decorators: [(Story) => <div className="w-80">{Story()}</div>],
};

export default meta;
type Story = StoryObj<typeof Input>;

export const Default: Story = {};

export const WithIcon: Story = {
  args: {
    'aria-label': 'Buscar processos',
    placeholder: 'Buscar por número ou objeto',
    icon: <Search />,
    type: 'search',
  },
};

export const Disabled: Story = { args: { disabled: true, value: '0012/2026', readOnly: true } };

export const InField: Story = {
  render: () => (
    <Field label="Objeto" description="Até 200 caracteres." required>
      <Input placeholder="Contratação de serviços de limpeza" />
    </Field>
  ),
};

export const TextareaInField: Story = {
  render: () => (
    <Field label="Justificativa" error="Informe a justificativa da contratação.">
      <Textarea placeholder="Por que contratar?" />
    </Field>
  ),
};
