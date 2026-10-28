import type { Meta, StoryObj } from '@storybook/react-vite';

import { ColumnChart } from './column-chart.js';

const meta = {
  title: 'Gráficos/ColumnChart',
  component: ColumnChart,
  args: {
    className: 'w-[28rem]',
    label:
      'Tempo médio por etapa, em dias úteis: DFD 3, ETP 9, Preços 6, TR 5, Jurídico 4, Autorização 2',
    items: [
      { id: 'dfd', label: 'DFD', value: 3 },
      { id: 'etp', label: 'ETP', value: 9, tone: 'navy' },
      { id: 'precos', label: 'Preços', value: 6 },
      { id: 'tr', label: 'TR', value: 5 },
      { id: 'juridico', label: 'Jurídico', value: 4 },
      { id: 'autorizacao', label: 'Autorização', value: 2 },
    ],
  },
} satisfies Meta<typeof ColumnChart>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AverageTime: Story = {};
