import type { Meta, StoryObj } from '@storybook/react-vite';

import { BrandLogo, BrandMark } from './brand-logo.js';

const meta = {
  title: 'Marca/BrandLogo',
  component: BrandLogo,
  args: { size: 'md' },
} satisfies Meta<typeof BrandLogo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithTagline: Story = {
  args: { size: 'lg', tagline: 'Do planejamento à contratação' },
};

export const OnDark: Story = {
  args: { tone: 'onDark', size: 'lg', tagline: 'Do planejamento à contratação' },
  render: (args) => (
    <div className="bg-sidebar p-6">
      <BrandLogo {...args} />
    </div>
  ),
};

export const Small: Story = {
  args: { size: 'sm' },
};

export const Mark: Story = {
  render: () => (
    <div className="flex items-center gap-4">
      <BrandMark />
      <span className="bg-sidebar p-2">
        <BrandMark tone="onDark" />
      </span>
    </div>
  ),
};
