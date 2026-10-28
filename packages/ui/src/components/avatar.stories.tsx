import type { Meta, StoryObj } from '@storybook/react-vite';

import { Avatar } from './avatar.js';

const meta = {
  title: 'Componentes/Avatar',
  component: Avatar,
  args: { name: 'Ana Ribeiro', decorative: false },
} satisfies Meta<typeof Avatar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Labeled: Story = {};

export const BesideName: Story = {
  render: () => (
    <div className="flex flex-col gap-2 text-sm">
      {['Ana Ribeiro', 'Bruno Lima', 'Carla Souza', 'Diego Martins', 'Elisa Prado'].map((name) => (
        <span key={name} className="flex items-center gap-2">
          <Avatar name={name} size="sm" />
          {name}
        </span>
      ))}
    </div>
  ),
};
