import type { Meta, StoryObj } from '@storybook/react-vite';

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
import { EmptyState } from './empty-state.js';
import { FilterToolbar } from './filter-toolbar.js';
import { ListPage } from './list-page.js';
import { PageHeader } from './page-header.js';
import { ViewTabs } from './view-tabs.js';

const header = (
  <PageHeader
    title="Processos"
    description="Todos os processos de contratação que você pode ver."
    breadcrumbs={[{ label: 'Painel', href: '#painel' }, { label: 'Processos' }]}
    actions={<Button variant="secondary">Exportar</Button>}
  />
);
const tabs = (
  <ViewTabs
    label="Visões"
    value="todos"
    tabs={[
      { id: 'todos', label: 'Todos', count: 2, href: '#todos' },
      { id: 'meus', label: 'Meus', count: 1, href: '#meus' },
    ]}
  />
);
const toolbar = (
  <FilterToolbar
    search={{ value: '', onChange: () => undefined, label: 'Buscar processos' }}
    filters={<p className="text-sm">Campos do filtro</p>}
  />
);

const meta = {
  title: 'Modelos/ListPage',
  component: ListPage,
  parameters: { layout: 'padded' },
  args: { header, tabs, toolbar },
} satisfies Meta<typeof ListPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    children: (
      <TableContainer label="Processos" footer={<TableFooter summary="Mostrando 1–2 de 2" />}>
        <Table>
          <TableHead>
            <Tr>
              <Th>Número</Th>
              <Th>Título</Th>
            </Tr>
          </TableHead>
          <TableBody>
            <Tr>
              <Td>0001/2026</Td>
              <Td>Manutenção predial</Td>
            </Tr>
            <Tr>
              <Td>0002/2026</Td>
              <Td>Material de limpeza</Td>
            </Tr>
          </TableBody>
        </Table>
      </TableContainer>
    ),
  },
};

export const Loading: Story = { args: { loading: true, loadingLabel: 'Carregando processos…' } };

export const Empty: Story = {
  args: {
    empty: (
      <EmptyState
        title="Nenhum processo encontrado"
        description="Ajuste os filtros para ver mais resultados."
        action={<Button variant="secondary">Limpar filtros</Button>}
      />
    ),
  },
};
