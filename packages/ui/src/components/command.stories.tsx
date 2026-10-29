import type { Meta, StoryObj } from '@storybook/react-vite';

import { FileText, Inbox, LayoutDashboard, Plus, Stamp } from '../icons.js';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from './command.js';

function PaletteItems() {
  return (
    <>
      <CommandInput placeholder="Buscar telas e ações" />
      <CommandList>
        <CommandEmpty>Nenhum resultado encontrado.</CommandEmpty>
        <CommandGroup heading="Ir para">
          <CommandItem>
            <LayoutDashboard />
            Painel
            <CommandShortcut>G P</CommandShortcut>
          </CommandItem>
          <CommandItem>
            <Inbox />
            Minhas tarefas
            <CommandShortcut>G T</CommandShortcut>
          </CommandItem>
          <CommandItem>
            <Stamp />
            Aprovações
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Ações">
          <CommandItem>
            <Plus />
            Novo processo
            <CommandShortcut>N</CommandShortcut>
          </CommandItem>
          <CommandItem disabled>
            <FileText />
            Gerar relatório (sem permissão)
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </>
  );
}

function Palette({ open }: { readonly open: boolean }) {
  if (open) {
    return (
      <CommandDialog open title="Paleta de comandos">
        <PaletteItems />
      </CommandDialog>
    );
  }
  return (
    <Command label="Paleta de comandos" className="w-[min(32rem,100vw-2rem)] shadow-popover">
      <PaletteItems />
    </Command>
  );
}

const meta = {
  title: 'Navegação/Command',
  component: Palette,
  args: { open: false },
} satisfies Meta<typeof Palette>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Inline: Story = {};

export const Dialog: Story = { args: { open: true } };
