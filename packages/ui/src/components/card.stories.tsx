import type { Meta, StoryObj } from '@storybook/react-vite';

import { CalendarDays, Clock } from '../icons.js';
import { Card } from './card.js';
import { StatTile } from './stat-tile.js';

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

export const InverseHeader: Story = {
  args: {
    id: 'destaque',
    className: 'w-[min(40rem,100vw-2rem)]',
    header: {
      badge: 'Hoje',
      title: '5 pendências esperam por você',
      meta: (
        <>
          <span className="inline-flex items-center gap-1.5">
            <Clock aria-hidden="true" />2 atrasadas
          </span>
          <span className="inline-flex items-center gap-1.5">
            <CalendarDays aria-hidden="true" />
            Próximo prazo: 05/11
          </span>
        </>
      ),
    },
    children: (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Pendências" value={5} />
        <StatTile label="Atrasados" value={2} tone="danger" emphasizeValue />
        <StatTile label="Próximos do prazo" value={1} />
        <StatTile label="Aprovações" value={3} />
      </div>
    ),
  },
};
