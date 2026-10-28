// Comportamento dos componentes do design system v2 (prd-4): o axe das histórias cobre a
// acessibilidade estática; aqui ficam iniciais e cor do avatar, arcos do donut, teclado das abas,
// ordenação da tabela e os links dos cartões.
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Avatar, avatarToneOf, initialsOf } from './avatar.js';
import { BarList, barPercent } from './bar-list.js';
import { Card } from './card.js';
import { ColumnChart } from './column-chart.js';
import { Table, TableBody, TableHead, Th, Tr } from './data-table.js';
import { Donut, donutArcs } from './donut.js';
import { FilterChip } from './filter-chip.js';
import { KpiTile } from './kpi-tile.js';
import { PageHeader } from './page-header.js';
import { StatusChip } from './status-chip.js';
import { ViewTabs } from './view-tabs.js';

afterEach(cleanup);

describe('Avatar', () => {
  it('usa as iniciais do primeiro e do último nome', () => {
    expect(initialsOf('Ana Maria Ribeiro')).toBe('AR');
    expect(initialsOf('  élio  ')).toBe('É');
    expect(initialsOf('')).toBe('');
  });

  it('a mesma pessoa tem sempre a mesma cor', () => {
    expect(avatarToneOf('Ana Ribeiro')).toBe(avatarToneOf(' ana ribeiro '));
    expect(avatarToneOf('Ana Ribeiro')).not.toBe('neutral');
  });

  it('decorativo some da árvore; rotulado expõe o nome', () => {
    const { container } = render(<Avatar name="Ana Ribeiro" />);
    expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
    render(<Avatar name="Bruno Lima" decorative={false} />);
    expect(screen.getByRole('img', { name: 'Bruno Lima' }).textContent).toBe('BL');
  });
});

describe('gráficos', () => {
  it('barPercent limita a 0–100 e trata máximo zero', () => {
    expect(barPercent(3, 6)).toBe(50);
    expect(barPercent(9, 6)).toBe(100);
    expect(barPercent(3, 0)).toBe(0);
    expect(barPercent(-1, 6)).toBe(0);
  });

  it('donutArcs fecha a circunferência e ignora fatias vazias', () => {
    const arcs = donutArcs([
      { id: 'a', label: 'A', value: 3, tone: 'info' },
      { id: 'b', label: 'B', value: 0, tone: 'warning' },
      { id: 'c', label: 'C', value: 1, tone: 'danger' },
    ]);
    expect(arcs.map((arc) => arc.id)).toEqual(['a', 'c']);
    const circumference = 2 * Math.PI * 40;
    expect(arcs[0]?.length).toBeCloseTo(circumference * 0.75);
    expect(arcs[1]?.offset).toBeCloseTo(-circumference * 0.75);
    expect(donutArcs([{ id: 'a', label: 'A', value: 0, tone: 'info' }])).toEqual([]);
  });

  it('o donut é uma imagem rotulada com legenda em texto', () => {
    render(
      <Donut
        label="3 processos: 2 em andamento, 1 suspenso"
        segments={[
          { id: 'a', label: 'Em andamento', value: 2, tone: 'info' },
          { id: 'b', label: 'Suspenso', value: 1, tone: 'danger' },
        ]}
      />,
    );
    expect(
      screen.getByRole('img', { name: '3 processos: 2 em andamento, 1 suspenso' }),
    ).toBeTruthy();
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Em andamento 2',
      'Suspenso 1',
    ]);
  });

  it('barras horizontais mostram rótulo e valor e linkam o item', () => {
    render(
      <BarList
        items={[
          { id: 'etp', label: 'ETP', value: 7, href: '#etp' },
          { id: 'tr', label: 'TR', value: 3 },
        ]}
        formatValue={(value) => `${String(value)} proc.`}
      />,
    );
    expect(screen.getByRole('link', { name: 'ETP' }).getAttribute('href')).toBe('#etp');
    expect(screen.getByText('3 proc.')).toBeTruthy();
  });

  it('colunas: imagem rotulada com valores visíveis', () => {
    render(
      <ColumnChart label="Tempo médio: DFD 3" items={[{ id: 'dfd', label: 'DFD', value: 3 }]} />,
    );
    expect(screen.getByRole('img', { name: 'Tempo médio: DFD 3' }).textContent).toBe('3DFD');
  });
});

describe('ViewTabs', () => {
  function Tabs() {
    const [value, setValue] = useState('todos');
    return (
      <ViewTabs
        label="Visões salvas"
        value={value}
        onValueChange={setValue}
        tabs={[
          { id: 'todos', label: 'Todos', count: 24 },
          { id: 'comigo', label: 'Comigo', count: 7 },
          { id: 'atrasados', label: 'Atrasados' },
        ]}
      />
    );
  }

  it('setas, Home e End movem a seleção e o foco (WAI-ARIA Tabs)', async () => {
    const user = userEvent.setup();
    render(<Tabs />);
    const first = screen.getByRole('tab', { name: 'Todos 24' });
    expect(first.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Comigo 7' }).getAttribute('tabindex')).toBe('-1');

    first.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Comigo 7' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Comigo 7' }));

    await user.keyboard('{End}');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Atrasados' }));
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(first);
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Atrasados' }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('com href, é navegação por links com aria-current na visão ativa', () => {
    render(
      <ViewTabs
        label="Visões salvas"
        value="comigo"
        tabs={[
          { id: 'todos', label: 'Todos', href: '?visao=todos' },
          { id: 'comigo', label: 'Comigo', href: '?visao=comigo' },
        ]}
      />,
    );
    expect(screen.getByRole('navigation', { name: 'Visões salvas' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Comigo' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Todos' }).getAttribute('aria-current')).toBeNull();
  });
});

describe('tabela', () => {
  it('coluna ordenável vira botão e expõe aria-sort', async () => {
    const onSort = vi.fn();
    render(
      <Table>
        <TableHead>
          <Tr>
            <Th sort="descending" onSort={onSort}>
              Número
            </Th>
            <Th>Objeto</Th>
          </Tr>
        </TableHead>
        <TableBody />
      </Table>,
    );
    const header = screen.getByRole('columnheader', { name: 'Número' });
    expect(header.getAttribute('aria-sort')).toBe('descending');
    expect(
      screen.getByRole('columnheader', { name: 'Objeto' }).getAttribute('aria-sort'),
    ).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Número' }));
    expect(onSort).toHaveBeenCalledOnce();
  });
});

describe('cartões, cabeçalho e chips', () => {
  it('KPI com href é um link inteiro; sem href, não', () => {
    const { rerender } = render(
      <KpiTile label="Atrasados" value={3} href="/processos?prazo=vencido" />,
    );
    expect(screen.getByRole('link', { name: /Atrasados\s*3/u }).getAttribute('href')).toBe(
      '/processos?prazo=vencido',
    );
    rerender(<KpiTile label="Atrasados" value={3} />);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('cartão com título vira seção rotulada', () => {
    render(
      <Card id="pendencias" title="Minhas pendências">
        conteúdo
      </Card>,
    );
    expect(screen.getByRole('region', { name: 'Minhas pendências' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Minhas pendências' })).toBeTruthy();
  });

  it('cabeçalho de página: trilha com página atual e título h1', () => {
    render(
      <PageHeader
        title="Processos"
        breadcrumbs={[{ label: 'Painel', href: '/painel' }, { label: 'Processos' }]}
      />,
    );
    const trail = screen.getByRole('navigation', { name: 'Trilha' });
    expect(trail.textContent).toBe('Painel/Processos');
    expect(screen.getByRole('link', { name: 'Painel' }).getAttribute('href')).toBe('/painel');
    expect(screen.getByText('Processos', { selector: '[aria-current="page"]' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Processos' })).toBeTruthy();
  });

  it('chip de filtro remove pelo botão rotulado; chip de situação sempre tem texto', async () => {
    const onRemove = vi.fn();
    render(
      <>
        <FilterChip onRemove={onRemove} removeLabel="Remover filtro de situação">
          Situação: Em andamento
        </FilterChip>
        <StatusChip tone="approval">Aguardando aprovação</StatusChip>
      </>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Remover filtro de situação' }));
    expect(onRemove).toHaveBeenCalledOnce();
    expect(screen.getByText('Aguardando aprovação').classList.contains('bg-approval-soft')).toBe(
      true,
    );
  });
});
