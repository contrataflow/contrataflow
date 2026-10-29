import type { Meta, StoryObj } from '@storybook/react-vite';

import { Pencil } from '../icons.js';
import { Button } from './button.js';
import { InfoTooltip, Tooltip, TooltipContent, TooltipTrigger } from './tooltip.js';

function IconAction({ defaultOpen }: { readonly defaultOpen: boolean }) {
  return (
    <Tooltip defaultOpen={defaultOpen}>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Editar processo">
          <Pencil />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Editar processo</TooltipContent>
    </Tooltip>
  );
}

const meta = {
  title: 'Sobreposição/Tooltip',
  component: IconAction,
  args: { defaultOpen: false },
} satisfies Meta<typeof IconAction>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Closed: Story = {};

export const Open: Story = { args: { defaultOpen: true } };

export const Info: Story = {
  render: () => (
    <span className="flex items-center gap-1 text-sm font-semibold">
      Valor estimado
      <InfoTooltip label="Ajuda sobre o valor estimado">
        Soma dos itens a partir da pesquisa de preços.
      </InfoTooltip>
    </span>
  ),
};
