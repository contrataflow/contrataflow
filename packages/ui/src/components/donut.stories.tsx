import type { Meta, StoryObj } from '@storybook/react-vite';

import { Donut } from './donut.js';

const meta = {
  title: 'Gráficos/Donut',
  component: Donut,
  args: {
    className: 'w-96',
    label:
      '24 processos: 11 em andamento, 5 aguardando aprovação, 4 em rascunho, 2 devolvidos, 2 suspensos',
    centerValue: 24,
    centerLabel: 'abertos',
    segments: [
      { id: 'andamento', label: 'Em andamento', value: 11, tone: 'info' },
      { id: 'aprovacao', label: 'Aguardando aprovação', value: 5, tone: 'approval' },
      { id: 'rascunho', label: 'Rascunho', value: 4, tone: 'neutral' },
      { id: 'devolvido', label: 'Devolvido', value: 2, tone: 'warning' },
      { id: 'suspenso', label: 'Suspenso', value: 2, tone: 'danger' },
    ],
  },
} satisfies Meta<typeof Donut>;

export default meta;
type Story = StoryObj<typeof meta>;

export const BySituation: Story = {};

export const Empty: Story = {
  args: {
    label: 'Nenhum processo aberto',
    centerValue: 0,
    segments: [{ id: 'andamento', label: 'Em andamento', value: 0, tone: 'info' }],
  },
};
