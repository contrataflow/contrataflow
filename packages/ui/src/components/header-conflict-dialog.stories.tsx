import type { Meta, StoryObj } from '@storybook/react-vite';

import { HeaderConflictDialog } from './header-conflict-dialog.js';

const meta = {
  title: 'Componentes/HeaderConflictDialog',
  component: HeaderConflictDialog,
  args: {
    open: true,
    authorName: 'Bruno Carvalho',
    time: '14:31',
    fields: [
      { field: 'priority', label: 'Prioridade', mine: 'Alta', theirs: 'Urgente' },
      {
        field: 'expectedDate',
        label: 'Data pretendida para a contratação',
        mine: '01/12/2026',
        theirs: '01/03/2027',
      },
    ],
    onResolve: () => undefined,
  },
} satisfies Meta<typeof HeaderConflictDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const TwoFields: Story = {};
