import type { Meta, StoryObj } from '@storybook/react-vite';

import { Clock } from '../icons.js';
import { StatTile } from './stat-tile.js';
import { StatusChip } from './status-chip.js';

const meta = {
  title: 'Componentes/StatTile',
  component: StatTile,
  args: {
    label: 'Pendências',
    value: 12,
    context: 'Com você agora',
    className: 'w-56',
  },
} satisfies Meta<typeof StatTile>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Static: Story = {};

export const WithIconAndLink: Story = {
  args: {
    label: 'Próximos do prazo',
    value: 4,
    icon: <Clock />,
    context: 'Vencem em 2 dias úteis',
    href: '#processos?prazo=proximo',
  },
};

export const EmphasizedWithChip: Story = {
  args: {
    label: 'Atrasados',
    value: 3,
    tone: 'danger',
    emphasizeValue: true,
    context: <StatusChip tone="danger">Prazo vencido</StatusChip>,
    href: '#processos?prazo=vencido',
  },
};
