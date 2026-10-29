import type { Meta, StoryObj } from '@storybook/react-vite';

import { Field } from './field.js';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from './select.js';

function UnitSelect({
  defaultOpen = false,
  error,
}: {
  readonly defaultOpen?: boolean;
  readonly error?: string;
}) {
  return (
    <div className="w-80">
      <Field label="Unidade requisitante" error={error}>
        <Select defaultOpen={defaultOpen}>
          <SelectTrigger>
            <SelectValue placeholder="Selecione a unidade" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>Secretarias</SelectLabel>
              <SelectItem value="saude">Secretaria de Saúde</SelectItem>
              <SelectItem value="educacao">Secretaria de Educação</SelectItem>
            </SelectGroup>
            <SelectSeparator />
            <SelectItem value="gabinete">Gabinete do Prefeito</SelectItem>
            <SelectItem value="extinta" disabled>
              Secretaria extinta
            </SelectItem>
          </SelectContent>
        </Select>
      </Field>
    </div>
  );
}

const meta = {
  title: 'Formulário/Select',
  component: UnitSelect,
} satisfies Meta<typeof UnitSelect>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Closed: Story = {};

export const Invalid: Story = { args: { error: 'Escolha a unidade requisitante.' } };

export const Open: Story = { args: { defaultOpen: true } };
