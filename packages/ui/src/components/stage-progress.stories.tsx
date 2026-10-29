import type { Meta, StoryObj } from '@storybook/react-vite';

import { StageProgress } from './stage-progress.js';

const steps = [
  { id: 'dfd', label: 'DFD' },
  { id: 'etp', label: 'ETP' },
  { id: 'riscos', label: 'Riscos' },
  {
    id: 'precos',
    label: 'Pesquisa de preços',
    detail: 'Com Setor de Cotações · vence em 2 dias úteis',
  },
  { id: 'tr', label: 'Termo de referência' },
  { id: 'juridico', label: 'Parecer jurídico' },
  { id: 'publicacao', label: 'Publicação' },
];

const meta: Meta<typeof StageProgress> = {
  title: 'Navegação/StageProgress',
  component: StageProgress,
  args: { steps, current: 3, label: 'Etapas do processo' },
  decorators: [(Story) => <div className="w-[min(48rem,100vw-2rem)]">{Story()}</div>],
};

export default meta;
type Story = StoryObj<typeof StageProgress>;

export const Default: Story = {};

export const Late: Story = { args: { currentTone: 'warning' } };

export const Start: Story = { args: { current: 0 } };

export const Finished: Story = { args: { current: steps.length } };

export const Narrow: Story = {
  decorators: [(Story) => <div className="w-[22rem]">{Story()}</div>],
};
