import type { Meta, StoryObj } from '@storybook/react-vite';

import { ConflictDialog, SectionDiffView } from './conflict-dialog.js';

const SERVER = 'A UBS Centro atende 12 mil pessoas.\nO estoque de luvas acabou em setembro.';
const LOCAL =
  'A UBS Centro atende 12 mil pessoas.\nO estoque de luvas e seringas acabou em setembro.\nHá risco de interrupção do atendimento.';

const meta = {
  title: 'Componentes/ConflictDialog',
  component: ConflictDialog,
  args: {
    open: true,
    authorName: 'Bruno Carvalho',
    time: '14:31',
    sectionTitle: 'Justificativa da necessidade',
    serverText: SERVER,
    localText: LOCAL,
    onKeepMine: () => undefined,
    onDiscardMine: () => undefined,
  },
} satisfies Meta<typeof ConflictDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const OtherPerson: Story = {};

export const SameUserOtherTab: Story = { args: { isSelf: true } };

export const DiffOnly: Story = {
  render: () => <SectionDiffView serverText={SERVER} localText={LOCAL} />,
};
