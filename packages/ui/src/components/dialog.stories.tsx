import type { Meta, StoryObj } from '@storybook/react-vite';

import { Button } from './button.js';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
} from './dialog.js';

function ConflictExample({ defaultOpen }: { readonly defaultOpen: boolean }) {
  return (
    <Dialog defaultOpen={defaultOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary">Abrir diálogo</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>Este registro foi alterado por outra pessoa.</DialogTitle>
        <DialogDescription>
          Recarregue para ver a versão mais recente antes de continuar.
        </DialogDescription>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary">Cancelar</Button>
          </DialogClose>
          <Button>Recarregar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const meta = {
  title: 'Componentes/Dialog',
  component: ConflictExample,
  args: { defaultOpen: false },
} satisfies Meta<typeof ConflictExample>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Closed: Story = {};

export const Open: Story = { args: { defaultOpen: true } };
