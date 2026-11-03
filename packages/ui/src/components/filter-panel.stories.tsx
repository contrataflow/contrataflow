import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { Search } from '../icons.js';
import { Field } from './field.js';
import { FilterPanel } from './filter-panel.js';
import { Input } from './input.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select.js';

const ALL = 'todas';

function ProcessFilterPanel({ initialStatus = ALL }: { readonly initialStatus?: string }) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState(initialStatus);
  const [unit, setUnit] = useState(ALL);
  const activeCount = [search !== '', status !== ALL, unit !== ALL].filter(Boolean).length;

  return (
    <div className="w-[min(64rem,100vw-2rem)]">
      <FilterPanel
        activeCount={activeCount}
        moreCount={1}
        onMore={() => undefined}
        onClear={() => {
          setSearch('');
          setStatus(ALL);
          setUnit(ALL);
        }}
      >
        <Field
          label="Buscar"
          description="Número, objeto ou unidade (mín. 2 letras)"
          className="sm:col-span-2"
        >
          <Input
            type="search"
            icon={<Search />}
            placeholder="Ex.: 0001/2026"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </Field>
        <Field label="Situação">
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Todas</SelectItem>
              <SelectItem value="andamento">Em andamento</SelectItem>
              <SelectItem value="atrasado">Atrasado</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Unidade">
          <Select value={unit} onValueChange={setUnit}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Todas</SelectItem>
              <SelectItem value="sec-adm">Secretaria de Administração</SelectItem>
              <SelectItem value="sec-saude">Secretaria de Saúde</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </FilterPanel>
    </div>
  );
}

const meta = {
  title: 'Componentes/FilterPanel',
  component: ProcessFilterPanel,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof ProcessFilterPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithActiveFilter: Story = { args: { initialStatus: 'atrasado' } };
