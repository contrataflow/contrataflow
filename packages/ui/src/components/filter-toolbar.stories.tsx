import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { Download } from '../icons.js';
import { Button } from './button.js';
import { Checkbox } from './checkbox.js';
import { Field, Label } from './field.js';
import { FilterToolbar } from './filter-toolbar.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select.js';

const STATUSES = [
  { value: 'andamento', label: 'Em andamento' },
  { value: 'atrasado', label: 'Atrasado' },
];

function ProcessFilters({ initialStatuses }: { readonly initialStatuses: readonly string[] }) {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('prazo');
  const [statuses, setStatuses] = useState<readonly string[]>(initialStatuses);
  const [unit, setUnit] = useState<string | undefined>(undefined);

  const chips = [
    ...statuses.map((status) => ({
      id: `situacao-${status}`,
      label: `Situação: ${STATUSES.find((item) => item.value === status)?.label ?? status}`,
      removeLabel: 'Remover filtro de situação',
      onRemove: () => {
        setStatuses((current) => current.filter((item) => item !== status));
      },
    })),
    ...(unit
      ? [
          {
            id: 'unidade',
            label: `Unidade: ${unit}`,
            removeLabel: 'Remover filtro de unidade',
            onRemove: () => {
              setUnit(undefined);
            },
          },
        ]
      : []),
  ];

  return (
    <div className="w-[min(56rem,100vw-2rem)]">
      <FilterToolbar
        search={{
          value: search,
          onChange: setSearch,
          label: 'Buscar processos',
          placeholder: 'Número, objeto ou unidade',
        }}
        activeCount={chips.length}
        chips={chips}
        onClearAll={() => {
          setStatuses([]);
          setUnit(undefined);
        }}
        sort={{
          value: sort,
          onValueChange: setSort,
          options: [
            { value: 'prazo', label: 'Prazo mais próximo' },
            { value: 'recentes', label: 'Mais recentes' },
          ],
        }}
        actions={
          <Button variant="secondary" iconLeft={<Download />}>
            Exportar
          </Button>
        }
        filters={
          <>
            <Field label="Situação" group>
              {STATUSES.map((status) => (
                <div key={status.value} className="flex items-center gap-2">
                  <Checkbox
                    id={`f-${status.value}`}
                    checked={statuses.includes(status.value)}
                    onCheckedChange={(checked) => {
                      setStatuses((current) =>
                        checked === true
                          ? [...current, status.value]
                          : current.filter((item) => item !== status.value),
                      );
                    }}
                  />
                  <Label htmlFor={`f-${status.value}`} className="font-normal">
                    {status.label}
                  </Label>
                </div>
              ))}
            </Field>
            <Field label="Unidade">
              <Select value={unit ?? ''} onValueChange={setUnit}>
                <SelectTrigger>
                  <SelectValue placeholder="Todas" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Saúde">Saúde</SelectItem>
                  <SelectItem value="Educação">Educação</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </>
        }
      />
    </div>
  );
}

const meta = {
  title: 'Listas/FilterToolbar',
  component: ProcessFilters,
  args: { initialStatuses: [] },
} satisfies Meta<typeof ProcessFilters>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Idle: Story = {};

export const WithActiveFilters: Story = { args: { initialStatuses: ['andamento', 'atrasado'] } };
