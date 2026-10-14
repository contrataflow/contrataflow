import type { Meta, StoryObj } from '@storybook/react-vite';

import { Button } from './button.js';

const meta = {
  title: 'Componentes/Button',
  component: Button,
  args: { children: 'Salvar' },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = {};

export const Secondary: Story = { args: { variant: 'secondary', children: 'Cancelar' } };

export const Ghost: Story = { args: { variant: 'ghost', children: 'Ver detalhes' } };

export const Destructive: Story = { args: { variant: 'destructive', children: 'Excluir' } };

export const Disabled: Story = { args: { disabled: true, children: 'Indisponível' } };

export const AsLink: Story = {
  args: { asChild: true, variant: 'secondary', children: <a href="#processos">Ver processos</a> },
};
