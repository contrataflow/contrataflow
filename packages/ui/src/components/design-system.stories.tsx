import type { Meta, StoryObj } from '@storybook/react-vite';

import { Avatar } from './avatar.js';
import { BarList } from './bar-list.js';
import { Button } from './button.js';
import { Card } from './card.js';
import { ColumnChart } from './column-chart.js';
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
import { Donut } from './donut.js';
import { EmptyState } from './empty-state.js';
import { FilterChip } from './filter-chip.js';
import { Kbd } from './kbd.js';
import { KpiTile } from './kpi-tile.js';
import { PageHeader } from './page-header.js';
import { StatusChip } from './status-chip.js';
import { ViewTabs } from './view-tabs.js';
import { STATUS_TONES } from '../lib/tones.js';

/* Vitrine do design system v2 (prd-4): os componentes juntos, para conferência nos dois temas. */

function Icon({ d }: { readonly d: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  );
}

const ICONS = {
  inbox:
    'M22 12h-6l-2 3h-4l-2-3H2M5.5 5.2 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.8A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.2z',
  alert:
    'm10.3 3.9-8.5 14.2a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
  folder: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z',
};

const CHIPS = {
  info: 'Em andamento',
  success: 'Concluído',
  warning: 'Devolvido',
  danger: 'Atrasado',
  approval: 'Aguardando aprovação',
  neutral: 'Rascunho',
} as const;

function Showcase() {
  return (
    <div className="flex w-[72rem] flex-col gap-6 bg-background p-8">
      <PageHeader
        title="Sistema de design v2"
        description="Tema claro padrão, paleta viva e componentes base."
        breadcrumbs={[{ label: 'Painel', href: '#painel' }, { label: 'Sistema de design' }]}
        actions={
          <>
            <Button variant="secondary">Secundário</Button>
            <Button>Primário</Button>
          </>
        }
      />
      <div className="grid grid-cols-4 gap-4">
        <KpiTile
          label="Pendências"
          value={7}
          context="Com você e aprovações pendentes"
          icon={<Icon d={ICONS.inbox} />}
          tone="info"
          href="#pendencias"
        />
        <KpiTile
          label="Atrasados"
          value={3}
          context="Prazo da etapa vencido"
          icon={<Icon d={ICONS.alert} />}
          tone="danger"
          emphasizeValue
          href="#atrasados"
        />
        <KpiTile
          label="Próximos do prazo"
          value={4}
          context="Vencem nos próximos 2 dias úteis"
          icon={<Icon d={ICONS.clock} />}
          tone="warning"
          href="#proximos"
        />
        <KpiTile
          label="Abertos"
          value={24}
          context="Em andamento, aguardando, devolvidos ou suspensos"
          icon={<Icon d={ICONS.folder} />}
          tone="success"
          href="#abertos"
        />
      </div>
      <div className="grid grid-cols-3 gap-4">
        <Card
          id="vitrine-situacao"
          title="Processos por situação"
          action={<a href="#tabela">Ver tabela</a>}
        >
          <Donut
            label="24 processos: 11 em andamento, 5 aguardando aprovação, 4 em rascunho, 2 devolvidos, 2 suspensos"
            centerValue={24}
            centerLabel="abertos"
            segments={[
              { id: 'andamento', label: 'Em andamento', value: 11, tone: 'info' },
              { id: 'aprovacao', label: 'Aguardando aprovação', value: 5, tone: 'approval' },
              { id: 'rascunho', label: 'Rascunho', value: 4, tone: 'neutral' },
              { id: 'devolvido', label: 'Devolvido', value: 2, tone: 'warning' },
              { id: 'suspenso', label: 'Suspenso', value: 2, tone: 'danger' },
            ]}
          />
        </Card>
        <Card id="vitrine-etapas" title="Abertos por etapa">
          <BarList
            items={[
              { id: 'dfd', label: 'Formalização da demanda', value: 6 },
              { id: 'etp', label: 'Estudo técnico preliminar', value: 7 },
              { id: 'precos', label: 'Pesquisa de preços', value: 4 },
              { id: 'tr', label: 'Termo de referência', value: 3 },
            ]}
          />
        </Card>
        <Card id="vitrine-tempo" title="Tempo médio por etapa" description="Em dias úteis">
          <ColumnChart
            label="Tempo médio por etapa, em dias úteis: DFD 3, ETP 9, Preços 6, TR 5"
            items={[
              { id: 'dfd', label: 'DFD', value: 3 },
              { id: 'etp', label: 'ETP', value: 9, tone: 'navy' },
              { id: 'precos', label: 'Preços', value: 6 },
              { id: 'tr', label: 'TR', value: 5 },
            ]}
          />
        </Card>
      </div>
      <ViewTabs
        label="Visões salvas"
        value="todos"
        tabs={[
          { id: 'todos', label: 'Todos', count: 24, href: '#todos' },
          { id: 'comigo', label: 'Comigo', count: 7, href: '#comigo' },
          { id: 'atrasados', label: 'Atrasados', count: 3, href: '#atrasados' },
        ]}
      />
      <div className="flex flex-wrap items-center gap-2">
        <FilterChip onRemove={() => undefined} removeLabel="Remover filtro de situação">
          Situação: Em andamento
        </FilterChip>
        {STATUS_TONES.map((tone) => (
          <StatusChip key={tone} tone={tone}>
            {CHIPS[tone]}
          </StatusChip>
        ))}
        <span className="ml-auto text-sm text-muted-foreground">
          Busca global <Kbd>Ctrl K</Kbd>
        </span>
      </div>
      <TableContainer
        label="Processos"
        footer={
          <TableFooter summary="Mostrando 1–2 de 24 processos">
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
              <Th sort="ascending" onSort={() => undefined}>
                Número
              </Th>
              <Th>Objeto</Th>
              <Th>Responsável</Th>
              <Th>Situação</Th>
            </Tr>
          </TableHead>
          <TableBody>
            <Tr>
              <Td className="font-semibold text-brand-ink">0012/2026</Td>
              <Td>Insumos de saúde</Td>
              <Td>
                <span className="flex items-center gap-2">
                  <Avatar name="Ana Ribeiro" size="sm" />
                  Ana Ribeiro
                </span>
              </Td>
              <Td>
                <StatusChip tone="info">Em andamento</StatusChip>
              </Td>
            </Tr>
            <Tr>
              <Td className="font-semibold text-brand-ink">0018/2026</Td>
              <Td>Manutenção de vias</Td>
              <Td>
                <span className="flex items-center gap-2">
                  <Avatar name="Bruno Lima" size="sm" />
                  Bruno Lima
                </span>
              </Td>
              <Td>
                <StatusChip tone="approval">Aguardando aprovação</StatusChip>
              </Td>
            </Tr>
          </TableBody>
        </Table>
      </TableContainer>
      <div className="grid grid-cols-2 gap-4">
        <EmptyState
          icon={<Icon d={ICONS.folder} />}
          title="Nenhum processo por aqui"
          description="Estado vazio sempre explica e oferece a ação seguinte."
          action={<Button>Criar processo</Button>}
        />
        <div className="flex flex-wrap content-start gap-2.5">
          <Button>Primário</Button>
          <Button variant="secondary">Secundário</Button>
          <Button variant="ghost">Fantasma</Button>
          <Button variant="destructive">Perigo</Button>
          <Button disabled>Desabilitado</Button>
        </div>
      </div>
    </div>
  );
}

const meta = {
  title: 'Sistema/Visão geral',
  component: Showcase,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Showcase>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Overview: Story = {};
