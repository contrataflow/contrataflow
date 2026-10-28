import type { Meta, StoryObj } from '@storybook/react-vite';

import { Button } from './button.js';
import { PageHeader } from './page-header.js';

const meta = {
  title: 'Componentes/PageHeader',
  component: PageHeader,
  parameters: { layout: 'padded' },
  args: {
    title: 'Processos',
    description: 'Todos os processos de contratação que você pode ver.',
    breadcrumbs: [{ label: 'Painel', href: '#painel' }, { label: 'Processos' }],
    actions: <Button>Novo processo</Button>,
  },
} satisfies Meta<typeof PageHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const TitleOnly: Story = {
  args: { breadcrumbs: undefined, description: undefined, actions: undefined },
};
