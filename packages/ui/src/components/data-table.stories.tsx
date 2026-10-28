import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { Avatar } from './avatar.js';
import { Button } from './button.js';
import {
  Table,
  TableBody,
  TableContainer,
  TableFooter,
  TableHead,
  Td,
  Th,
  Tr,
} from './data-table.js';
import type { SortDirection } from './data-table.js';
import { StatusChip } from './status-chip.js';

const rows = [
  { id: '0012/2026', object: 'Insumos de saúde', owner: 'Ana Ribeiro', due: 'Vence hoje' },
  { id: '0018/2026', object: 'Manutenção de vias', owner: 'Bruno Lima', due: 'Atrasado há 3 dias' },
  { id: '0009/2026', object: 'Merenda escolar', owner: 'Carla Souza', due: 'Vence em 2 dias' },
];

function TableExample() {
  const [sort, setSort] = useState<SortDirection>('ascending');
  const sorted = sort === 'ascending' ? rows : [...rows].reverse();
  return (
    <TableContainer
      label="Processos"
      className="w-[44rem] max-w-full"
      footer={
        <TableFooter summary="Mostrando 1–3 de 24 processos">
          <Button variant="secondary" size="sm" disabled>
            Anterior
          </Button>
          <Button variant="secondary" size="sm">
            Próxima
          </Button>
        </TableFooter>
      }
    >
      <Table>
        <TableHead>
          <Tr>
            <Th
              sort={sort}
              onSort={() => {
                setSort(sort === 'ascending' ? 'descending' : 'ascending');
              }}
            >
              Número
            </Th>
            <Th>Objeto</Th>
            <Th>Responsável</Th>
            <Th>Prazo da etapa</Th>
          </Tr>
        </TableHead>
        <TableBody>
          {sorted.map((row) => (
            <Tr key={row.id}>
              <Td className="font-semibold text-brand-ink">{row.id}</Td>
              <Td>{row.object}</Td>
              <Td>
                <span className="flex items-center gap-2">
                  <Avatar name={row.owner} size="sm" />
                  {row.owner}
                </span>
              </Td>
              <Td>
                <StatusChip tone={row.due.startsWith('Atrasado') ? 'danger' : 'warning'}>
                  {row.due}
                </StatusChip>
              </Td>
            </Tr>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

const meta = {
  title: 'Componentes/DataTable',
  component: TableContainer,
  parameters: { layout: 'padded' },
  args: { label: 'Processos' },
} satisfies Meta<typeof TableContainer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SortableWithPagination: Story = { render: () => <TableExample /> };
