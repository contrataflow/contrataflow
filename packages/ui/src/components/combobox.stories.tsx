import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { Combobox } from './combobox.js';
import type { ComboboxOption } from './combobox.js';
import { Field } from './field.js';

const suppliers: ComboboxOption[] = [
  { value: 'f1', label: 'Limpa Tudo Serviços Ltda.', description: '12.345.678/0001-90' },
  { value: 'f2', label: 'Hospitalar Norte S.A.', description: '98.765.432/0001-10' },
  {
    value: 'f3',
    label: 'Papelaria Central ME',
    description: '11.222.333/0001-44',
    keywords: ['papel'],
  },
  { value: 'f4', label: 'Fornecedor impedido', description: 'Sanção ativa', disabled: true },
];

function SupplierCombobox({ initial }: { readonly initial?: string | undefined }) {
  const [value, setValue] = useState<string | undefined>(initial);
  return (
    <div className="w-80">
      <Field label="Fornecedor">
        <Combobox
          options={suppliers}
          value={value}
          onValueChange={setValue}
          clearable
          labels={{ placeholder: 'Selecione o fornecedor', search: 'Buscar por nome ou CNPJ' }}
        />
      </Field>
    </div>
  );
}

const meta = {
  title: 'Formulário/Combobox',
  component: SupplierCombobox,
} satisfies Meta<typeof SupplierCombobox>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

export const Selected: Story = { args: { initial: 'f2' } };
