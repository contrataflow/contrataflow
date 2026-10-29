import type { Meta, StoryObj } from '@storybook/react-vite';

import { Separator } from './separator.js';

const meta: Meta<typeof Separator> = {
  title: 'Componentes/Separator',
  component: Separator,
  render: (args) => (
    <div className="flex w-72 flex-col gap-3 text-sm">
      <span>Responsável: Maria Souza</span>
      <Separator {...args} />
      <div className="flex h-5 items-center gap-3">
        <span>Saúde</span>
        <Separator orientation="vertical" />
        <span>Pregão</span>
      </div>
    </div>
  ),
};

export default meta;
type Story = StoryObj<typeof Separator>;

export const Default: Story = {};

export const Semantic: Story = { args: { decorative: false } };
