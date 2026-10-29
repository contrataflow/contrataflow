import type { Meta, StoryObj } from '@storybook/react-vite';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './collapsible.js';

function MoreDetails({ defaultOpen }: { readonly defaultOpen: boolean }) {
  return (
    <Collapsible defaultOpen={defaultOpen} className="flex w-80 flex-col gap-2 text-sm">
      <p>Objeto: contratação de limpeza hospitalar.</p>
      <CollapsibleContent className="flex flex-col gap-1 text-muted-foreground">
        <p>Fonte de recurso: Tesouro municipal.</p>
        <p>Dotação: 10.301.0012.2.045.</p>
      </CollapsibleContent>
      <CollapsibleTrigger className="self-start">
        {defaultOpen ? 'Ver menos' : 'Ver mais'}
      </CollapsibleTrigger>
    </Collapsible>
  );
}

const meta = {
  title: 'Componentes/Collapsible',
  component: MoreDetails,
  args: { defaultOpen: false },
} satisfies Meta<typeof MoreDetails>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Closed: Story = {};

export const Open: Story = { args: { defaultOpen: true } };
