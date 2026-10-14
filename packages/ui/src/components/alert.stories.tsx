import type { Meta, StoryObj } from '@storybook/react-vite';

import { Alert } from './alert.js';

const meta = {
  title: 'Componentes/Alert',
  component: Alert,
  args: { title: 'Muitas tentativas. Aguarde alguns segundos.', tone: 'warning' },
} satisfies Meta<typeof Alert>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Warning: Story = {};

export const Failure: Story = {
  args: { tone: 'error', title: 'Ocorreu um erro inesperado.', children: 'Código: 3f2a9c1e' },
};

export const Info: Story = {
  args: { tone: 'info', title: 'Somente consulta e exportação.', live: false },
};

export const Success: Story = { args: { tone: 'success', title: 'Alterações salvas.' } };
