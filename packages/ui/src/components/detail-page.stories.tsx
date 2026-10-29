import type { Meta, StoryObj } from '@storybook/react-vite';

import { Button } from './button.js';
import { Card } from './card.js';
import { DetailPage } from './detail-page.js';
import { StageProgress } from './stage-progress.js';
import { StatusChip } from './status-chip.js';
import { ViewTabs } from './view-tabs.js';

const meta = {
  title: 'Modelos/DetailPage',
  component: DetailPage,
  parameters: { layout: 'padded' },
  args: {
    breadcrumbs: [
      { label: 'Painel', href: '#painel' },
      { label: 'Processos', href: '#processos' },
      { label: '0002/2026' },
    ],
    title: 'Manutenção predial',
    status: <StatusChip tone="info">Em andamento</StatusChip>,
    subtitle: '0002/2026 · Dispensa eletrônica · Setor de Manutenção',
    actions: (
      <>
        <Button variant="secondary">Mais</Button>
        <Button>Enviar para aprovação</Button>
      </>
    ),
    progress: (
      <StageProgress
        label="Etapas do processo"
        current={1}
        steps={[
          { id: 'dfd', label: 'DFD' },
          { id: 'etp', label: 'ETP', detail: 'SLA de 3 dias úteis' },
          { id: 'tr', label: 'Termo de referência' },
        ]}
      />
    ),
    facts: [
      { id: 'etapa', label: 'Etapa atual', value: 'ETP' },
      { id: 'responsavel', label: 'Responsável', value: 'Ana Ribeiro' },
      { id: 'valor', label: 'Valor estimado', value: 'Não informado' },
    ],
    tabs: (
      <ViewTabs
        label="Seções do processo"
        value="resumo"
        tabs={[
          { id: 'resumo', label: 'Resumo', href: '#resumo' },
          { id: 'documentos', label: 'Documentos', count: 2, href: '#documentos' },
        ]}
      />
    ),
    children: <Card title="Próximo passo">Preencher o ETP.</Card>,
    aside: <Card title="Onde está">Setor de Manutenção</Card>,
    asideLabel: 'Resumo do processo',
  },
} satisfies Meta<typeof DetailPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithoutAside: Story = { args: { aside: undefined, progress: undefined } };
