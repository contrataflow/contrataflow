import type { Meta, StoryObj } from '@storybook/react-vite';

import { Card } from './card.js';

const meta = {
  title: 'Componentes/Card',
  component: Card,
  args: {
    className: 'w-96',
    children: <p className="text-sm">Conteúdo do cartão.</p>,
  },
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Plain: Story = {};

export const WithHeader: Story = {
  args: {
    id: 'pendencias',
    title: 'Minhas pendências',
    description: 'Tarefas com você e aprovações.',
    action: (
      <a href="#tarefas" className="font-semibold text-primary-soft-foreground hover:underline">
        Ver todas
      </a>
    ),
  },
};
