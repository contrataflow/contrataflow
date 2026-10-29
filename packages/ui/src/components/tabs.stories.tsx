import type { Meta, StoryObj } from '@storybook/react-vite';

import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs.js';

function ProcessTabs({ defaultValue }: { readonly defaultValue: string }) {
  return (
    <Tabs defaultValue={defaultValue} className="w-[min(40rem,100vw-2rem)]">
      <TabsList aria-label="Seções do processo">
        <TabsTrigger value="resumo">Resumo</TabsTrigger>
        <TabsTrigger value="documentos">Documentos</TabsTrigger>
        <TabsTrigger value="itens">Itens</TabsTrigger>
        <TabsTrigger value="historico">Histórico</TabsTrigger>
        <TabsTrigger value="arquivados" disabled>
          Arquivados
        </TabsTrigger>
      </TabsList>
      <TabsContent value="resumo">Objeto, valores e responsáveis.</TabsContent>
      <TabsContent value="documentos">DFD, ETP e TR.</TabsContent>
      <TabsContent value="itens">Itens e lotes.</TabsContent>
      <TabsContent value="historico">Trâmites e decisões.</TabsContent>
    </Tabs>
  );
}

const meta = {
  title: 'Navegação/Tabs',
  component: ProcessTabs,
  args: { defaultValue: 'resumo' },
} satisfies Meta<typeof ProcessTabs>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const SecondTab: Story = { args: { defaultValue: 'documentos' } };
