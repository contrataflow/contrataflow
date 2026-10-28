import type { Meta, StoryObj } from '@storybook/react-vite';

import { BarList } from './bar-list.js';

const meta = {
  title: 'Gráficos/BarList',
  component: BarList,
  args: {
    className: 'w-80',
    items: [
      { id: 'dfd', label: 'Formalização da demanda', value: 6, href: '#etapa=dfd' },
      { id: 'etp', label: 'Estudo técnico preliminar', value: 7, href: '#etapa=etp' },
      { id: 'precos', label: 'Pesquisa de preços', value: 4 },
      { id: 'tr', label: 'Termo de referência', value: 3 },
      { id: 'juridico', label: 'Parecer jurídico', value: 0, tone: 'neutral' },
    ],
  },
} satisfies Meta<typeof BarList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ByStage: Story = {};
