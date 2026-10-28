import type { Meta, StoryObj } from '@storybook/react-vite';

import { KpiTile } from './kpi-tile.js';

function ClockIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </svg>
  );
}

const meta = {
  title: 'Componentes/KpiTile',
  component: KpiTile,
  args: {
    label: 'Próximos do prazo',
    value: 4,
    context: 'Vencem nos próximos 2 dias úteis',
    icon: <ClockIcon />,
    tone: 'warning',
    className: 'w-64',
  },
} satisfies Meta<typeof KpiTile>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Static: Story = {};

export const AsLink: Story = { args: { href: '#processos?prazo=proximo' } };

export const Emphasized: Story = {
  args: {
    label: 'Atrasados',
    value: 3,
    context: 'Prazo da etapa vencido',
    tone: 'danger',
    emphasizeValue: true,
    href: '#processos?prazo=vencido',
  },
};
