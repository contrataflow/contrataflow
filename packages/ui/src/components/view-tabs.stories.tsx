import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { ViewTabs } from './view-tabs.js';

const tabs = [
  { id: 'todos', label: 'Todos', count: 24 },
  { id: 'comigo', label: 'Comigo', count: 7 },
  { id: 'atrasados', label: 'Atrasados', count: 3 },
  { id: 'concluidos', label: 'Concluídos' },
];

function TabsExample() {
  const [value, setValue] = useState('todos');
  return (
    <div className="w-[36rem]">
      <ViewTabs
        tabs={tabs}
        value={value}
        onValueChange={setValue}
        label="Visões salvas"
        panelId="painel-visao"
      />
      <div id="painel-visao" role="tabpanel" aria-label="Visão selecionada" className="p-4 text-sm">
        Visão: {value}
      </div>
    </div>
  );
}

const meta = {
  title: 'Componentes/ViewTabs',
  component: ViewTabs,
  args: { tabs, value: 'todos', label: 'Visões salvas' },
} satisfies Meta<typeof ViewTabs>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Tabs: Story = { render: () => <TabsExample /> };

export const Links: Story = {
  args: {
    tabs: tabs.map((tab) => ({ ...tab, href: `#visao=${tab.id}` })),
    value: 'comigo',
  },
};
