import type { Meta, StoryObj } from '@storybook/react-vite';

import { RecoveredDraftBanner } from './recovered-draft-banner.js';

const meta = {
  title: 'Componentes/RecoveredDraftBanner',
  component: RecoveredDraftBanner,
  args: { time: '14:32', onRestore: () => undefined, onDiscard: () => undefined },
} satisfies Meta<typeof RecoveredDraftBanner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Busy: Story = { args: { busy: true } };
