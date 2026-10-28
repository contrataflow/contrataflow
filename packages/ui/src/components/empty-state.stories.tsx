import type { Meta, StoryObj } from '@storybook/react-vite';

import { EmptyState } from './empty-state.js';
import { buttonClassName } from '../lib/button-class.js';

function FolderIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

const meta = {
  title: 'Componentes/EmptyState',
  component: EmptyState,
  args: {
    icon: <FolderIcon />,
    title: 'Nenhum processo por aqui',
    description: 'Crie o primeiro processo ou ajuste os filtros para ver outros.',
    action: (
      <a href="#novo" className={buttonClassName()}>
        Criar processo
      </a>
    ),
    className: 'w-96',
  },
} satisfies Meta<typeof EmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithAction: Story = {};

export const TextOnly: Story = { args: { icon: undefined, action: undefined } };
