// Componentes da terceira leva (prd-6 §2.1, padrão do Microlegis): o axe das histórias cobre a
// acessibilidade estática; aqui ficam o recolhimento e as ações do cartão de filtros, o link do
// mostrador, a faixa invertida do cartão e a linha de contagem da lista.
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Card } from './card.js';
import { FilterPanel } from './filter-panel.js';
import { ListPage } from './list-page.js';
import { StatTile } from './stat-tile.js';

afterEach(cleanup);

describe('FilterPanel', () => {
  it('é uma região rotulada e desabilita "Limpar filtros" sem filtro ativo', () => {
    render(
      <FilterPanel onClear={vi.fn()}>
        <span>campo</span>
      </FilterPanel>,
    );
    expect(screen.getByRole('region', { name: 'Filtros' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Limpar filtros' })).toHaveProperty('disabled', true);
  });

  it('limpa e abre "Mais filtros" com o contador no nome acessível', async () => {
    const onClear = vi.fn();
    const onMore = vi.fn();
    render(
      <FilterPanel activeCount={2} moreCount={1} onClear={onClear} onMore={onMore}>
        <span>campo</span>
      </FilterPanel>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Limpar filtros' }));
    expect(onClear).toHaveBeenCalledOnce();
    const more = screen.getByRole('button', { name: 'Mais filtros, 1 ativo' });
    await userEvent.click(more);
    expect(onMore).toHaveBeenCalledWith(more);
  });

  it('em tela estreita começa recolhido atrás de "Filtros (N)"', async () => {
    render(
      <FilterPanel activeCount={3}>
        <span>campo</span>
      </FilterPanel>,
    );
    const toggle = screen.getByRole('button', { name: 'Filtros (3)' });
    const content = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(content?.className).toContain('hidden md:flex');
    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(content?.className).not.toContain('hidden');
  });

  it('sem `collapsible`, não tem o botão de recolher', () => {
    render(
      <FilterPanel collapsible={false}>
        <span>campo</span>
      </FilterPanel>,
    );
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('StatTile', () => {
  it('com `href`, o mostrador inteiro é um link nomeado pelo texto', () => {
    render(<StatTile label="Atrasados" value={3} context="Prazo vencido" href="#atrasados" />);
    expect(screen.getByRole('link', { name: 'Atrasados 3 Prazo vencido' })).toBeTruthy();
  });
});

describe('Card com cabeçalho invertido', () => {
  it('o título da faixa rotula a seção', () => {
    render(
      <Card id="destaque" header={{ badge: 'Hoje', title: '5 pendências', meta: '2 atrasadas' }}>
        corpo
      </Card>,
    );
    const section = screen.getByRole('region', { name: '5 pendências' });
    expect(section.textContent).toContain('Hoje');
    expect(screen.getByRole('heading', { level: 2, name: '5 pendências' })).toBeTruthy();
  });
});

describe('ListPage.summary', () => {
  it('mostra a linha de contagem e a esconde durante a carga', () => {
    const { rerender } = render(
      <ListPage header={<h1>Processos</h1>} summary={{ text: '2 processos encontrados' }} />,
    );
    expect(screen.getByText('2 processos encontrados')).toBeTruthy();
    rerender(
      <ListPage
        header={<h1>Processos</h1>}
        summary={{ text: '2 processos encontrados' }}
        loading
        loadingLabel="Carregando"
      />,
    );
    expect(screen.queryByText('2 processos encontrados')).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Carregando');
  });
});
