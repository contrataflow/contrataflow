import type { Meta, StoryObj } from '@storybook/react-vite';

import { Stepper } from './stepper.js';

const steps = [
  { id: 'identificacao', label: 'Identificação' },
  { id: 'origem', label: 'Origem e planejamento' },
  { id: 'revisao', label: 'Revisão' },
];

const meta = {
  title: 'Componentes/Stepper',
  component: Stepper,
  args: { steps, current: 0, label: 'Passos para criar o processo' },
} satisfies Meta<typeof Stepper>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FirstStep: Story = {};

export const MiddleStepNavigable: Story = {
  args: { current: 1, onStepSelect: () => undefined },
};

export const LastStep: Story = { args: { current: 2, onStepSelect: () => undefined } };
