import type { Meta, StoryObj } from '@storybook/react-vite';

import { Button } from './button.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './dropdown-menu.js';

function InstitutionMenu({ defaultOpen }: { readonly defaultOpen: boolean }) {
  return (
    <DropdownMenu defaultOpen={defaultOpen} modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary">Prefeitura A</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel>Instituição ativa</DropdownMenuLabel>
        <DropdownMenuItem>Prefeitura A</DropdownMenuItem>
        <DropdownMenuItem>Prefeitura B</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled>Câmara (vínculo inativo)</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const meta = {
  title: 'Componentes/DropdownMenu',
  component: InstitutionMenu,
  args: { defaultOpen: false },
} satisfies Meta<typeof InstitutionMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Closed: Story = {};

export const Open: Story = { args: { defaultOpen: true } };
