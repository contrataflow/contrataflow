import type { Meta, StoryObj } from '@storybook/react-vite';

import { StatusChip } from './status-chip.js';
import { STATUS_TONES } from '../lib/tones.js';

const LABELS = {
  info: 'Em andamento',
  success: 'Concluído',
  warning: 'Devolvido',
  danger: 'Atrasado',
  approval: 'Aguardando aprovação',
  neutral: 'Rascunho',
} as const;

const meta = {
  title: 'Componentes/StatusChip',
  component: StatusChip,
  args: { tone: 'info', children: 'Em andamento' },
} satisfies Meta<typeof StatusChip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Info: Story = {};

export const AllTones: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      {STATUS_TONES.map((tone) => (
        <StatusChip key={tone} tone={tone}>
          {LABELS[tone]}
        </StatusChip>
      ))}
    </div>
  ),
};
