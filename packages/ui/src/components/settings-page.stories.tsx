import type { Meta, StoryObj } from '@storybook/react-vite';

import { Card } from './card.js';
import { PageHeader } from './page-header.js';
import { SettingsPage } from './settings-page.js';

const meta = {
  title: 'Modelos/SettingsPage',
  component: SettingsPage,
  parameters: { layout: 'padded' },
  args: {
    header: <PageHeader title="Configurações" />,
    navLabel: 'Seções das configurações',
    current: 'geral',
    sections: [
      { id: 'geral', label: 'Geral', href: '#geral' },
      { id: 'prazos', label: 'Prazos', href: '#prazos' },
      { id: 'notificacoes', label: 'Notificações', href: '#notificacoes' },
    ],
    children: <Card title="Geral">Nome do órgão e fuso horário.</Card>,
  },
} satisfies Meta<typeof SettingsPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const LocalSections: Story = {
  args: {
    sections: [
      { id: 'geral', label: 'Geral' },
      { id: 'prazos', label: 'Prazos' },
    ],
    onSectionChange: () => undefined,
  },
};
