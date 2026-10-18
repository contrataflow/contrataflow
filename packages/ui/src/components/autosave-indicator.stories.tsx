import type { Meta, StoryObj } from '@storybook/react-vite';

import { AutosaveIndicator } from './autosave-indicator.js';

const SAVED_AT = Date.UTC(2026, 9, 17, 17, 32);

const meta = {
  title: 'Componentes/AutosaveIndicator',
  component: AutosaveIndicator,
  args: { status: 'saved', savedAt: SAVED_AT, timeZone: 'America/Sao_Paulo' },
} satisfies Meta<typeof AutosaveIndicator>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Saved: Story = {};

export const Dirty: Story = { args: { status: 'dirty' } };

export const Saving: Story = { args: { status: 'saving' } };

export const Offline: Story = { args: { status: 'offline' } };

export const SaveError: Story = {
  args: { status: 'error', message: 'O texto excede 50.000 caracteres.' },
};

export const Conflict: Story = { args: { status: 'conflict' } };
