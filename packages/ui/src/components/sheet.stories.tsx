import type { Meta, StoryObj } from '@storybook/react-vite';

import { Button } from './button.js';
import { Field } from './field.js';
import { Input, Textarea } from './input.js';
import {
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from './sheet.js';

function EditSheet({
  defaultOpen,
  size,
}: {
  readonly defaultOpen: boolean;
  readonly size: 'default' | 'wide';
}) {
  return (
    <Sheet defaultOpen={defaultOpen}>
      <SheetTrigger asChild>
        <Button variant="secondary">Editar dados</Button>
      </SheetTrigger>
      <SheetContent size={size}>
        <SheetHeader>
          <SheetTitle>Editar dados do processo</SheetTitle>
          <SheetDescription>As mudanças entram no histórico.</SheetDescription>
        </SheetHeader>
        <SheetBody>
          <Field label="Objeto">
            <Input defaultValue="Contratação de limpeza hospitalar" />
          </Field>
          <Field label="Justificativa">
            <Textarea defaultValue="Contrato atual vence em dezembro." />
          </Field>
        </SheetBody>
        <SheetFooter>
          <SheetClose asChild>
            <Button variant="secondary">Cancelar</Button>
          </SheetClose>
          <Button>Salvar</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

const meta = {
  title: 'Sobreposição/Sheet',
  component: EditSheet,
  args: { defaultOpen: false, size: 'default' },
} satisfies Meta<typeof EditSheet>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Closed: Story = {};

export const Open: Story = { args: { defaultOpen: true } };

export const Wide: Story = { args: { defaultOpen: true, size: 'wide' } };
