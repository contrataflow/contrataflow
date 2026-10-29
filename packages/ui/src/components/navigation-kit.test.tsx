import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from './accordion.js';
import { Breadcrumb } from './breadcrumb.js';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './collapsible.js';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from './command.js';
import { Progress } from './progress.js';
import { StageProgress } from './stage-progress.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs.js';
import { ViewTabs } from './view-tabs.js';

afterEach(cleanup);

describe('Tabs', () => {
  function ProcessTabs() {
    return (
      <Tabs defaultValue="resumo">
        <TabsList aria-label="Seções">
          <TabsTrigger value="resumo">Resumo</TabsTrigger>
          <TabsTrigger value="documentos">Documentos</TabsTrigger>
          <TabsTrigger value="historico">Histórico</TabsTrigger>
        </TabsList>
        <TabsContent value="resumo">Painel resumo</TabsContent>
        <TabsContent value="documentos">Painel documentos</TabsContent>
        <TabsContent value="historico">Painel histórico</TabsContent>
      </Tabs>
    );
  }

  it('teclado: setas, Home e End trocam a aba e o painel (ativação automática)', async () => {
    const user = userEvent.setup();
    render(<ProcessTabs />);
    await user.tab();
    const resumo = screen.getByRole('tab', { name: 'Resumo' });
    expect(document.activeElement).toBe(resumo);
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Documentos', selected: true })).toBeTruthy();
    expect(screen.getByRole('tabpanel').textContent).toBe('Painel documentos');
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Histórico', selected: true })).toBeTruthy();
    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'Resumo', selected: true })).toBe(resumo);
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Histórico', selected: true })).toBeTruthy();
  });

  it('a lista quebra linha em vez de rolar (prd-5 · regra 8)', () => {
    render(<ProcessTabs />);
    const list = screen.getByRole('tablist', { name: 'Seções' });
    expect(list.className).toContain('flex-wrap');
    expect(list.className).not.toMatch(/overflow-(x-)?auto/);
  });
});

describe('ViewTabs sobre Radix Tabs (API mantida)', () => {
  function Views({ onChange }: { readonly onChange: (id: string) => void }) {
    const [value, setValue] = useState('todos');
    return (
      <ViewTabs
        label="Visões"
        panelId="painel"
        value={value}
        onValueChange={(id) => {
          setValue(id);
          onChange(id);
        }}
        tabs={[
          { id: 'todos', label: 'Todos', count: 4 },
          { id: 'comigo', label: 'Comigo', count: 1 },
        ]}
      />
    );
  }

  it('setas trocam a visão, com aria-controls no painel externo', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Views onChange={onChange} />);
    await user.tab();
    await user.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenLastCalledWith('comigo');
    const tab = screen.getByRole('tab', { name: /Comigo/, selected: true });
    expect(tab.getAttribute('aria-controls')).toBe('painel');
    expect(tab.getAttribute('data-tab-id')).toBe('comigo');
  });
});

describe('CommandDialog (paleta)', () => {
  function Palette({ onSelect }: { readonly onSelect: (value: string) => void }) {
    return (
      <CommandDialog open title="Paleta de comandos">
        <CommandInput placeholder="Buscar" />
        <CommandList>
          <CommandEmpty>Nada encontrado.</CommandEmpty>
          <CommandGroup heading="Ir para">
            <CommandItem
              onSelect={() => {
                onSelect('painel');
              }}
            >
              Painel
            </CommandItem>
            <CommandItem
              onSelect={() => {
                onSelect('tarefas');
              }}
            >
              Minhas tarefas
            </CommandItem>
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Ações">
            <CommandItem
              onSelect={() => {
                onSelect('novo');
              }}
            >
              Novo processo
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    );
  }

  it('abre com a busca focada; setas (com volta) e Enter executam', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Palette onSelect={onSelect} />);
    const dialog = screen.getByRole('dialog', { name: 'Paleta de comandos' });
    const search = within(dialog).getByPlaceholderText('Buscar');
    expect(document.activeElement).toBe(search);
    expect(
      within(dialog).getByRole('option', { name: 'Painel' }).getAttribute('aria-selected'),
    ).toBe('true');
    await user.keyboard('{ArrowUp}{Enter}');
    expect(onSelect).toHaveBeenCalledWith('novo');
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(onSelect).toHaveBeenLastCalledWith('tarefas');
  });

  it('filtra enquanto digita, esconde o divisor e mostra o vazio', async () => {
    const user = userEvent.setup();
    render(<Palette onSelect={vi.fn()} />);
    await user.keyboard('novo');
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Novo processo',
    ]);
    await user.keyboard('zzz');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('Nada encontrado.')).toBeTruthy();
  });
});

describe('StageProgress', () => {
  const steps = [
    { id: 'dfd', label: 'DFD' },
    { id: 'etp', label: 'ETP', detail: 'Com a Saúde · vence amanhã' },
    { id: 'tr', label: 'TR', detail: 'Detalhe que não aparece' },
  ];

  it('lista ordenada com aria-current na atual, estados lidos e detalhe só da atual', () => {
    render(<StageProgress steps={steps} current={1} label="Etapas do processo" />);
    const nav = screen.getByRole('navigation', { name: 'Etapas do processo' });
    const items = within(nav).getAllByRole('listitem');
    expect(items.map((item) => item.getAttribute('aria-current'))).toEqual([null, 'step', null]);
    expect(items.map((item) => item.textContent)).toEqual([
      'DFD (concluída)',
      'ETP (etapa atual)',
      'TR (pendente)',
    ]);
    expect(within(nav).getByText('Etapa 2 de 3')).toBeTruthy();
    expect(within(nav).getByText('Com a Saúde · vence amanhã')).toBeTruthy();
    expect(within(nav).queryByText('Detalhe que não aparece')).toBeNull();
    expect(within(nav).getByRole('list').className).toContain('flex-wrap');
  });

  it('todas concluídas: sem etapa atual nem detalhe', () => {
    render(<StageProgress steps={steps} current={3} label="Etapas" />);
    expect(screen.queryByText(/Etapa \d de/)).toBeNull();
    expect(screen.getAllByText(/\(concluída\)/)).toHaveLength(3);
  });
});

describe('Breadcrumb, Progress, Collapsible e Accordion', () => {
  it('Breadcrumb: links até a página atual (aria-current) e nada sem itens', () => {
    const { container, rerender } = render(
      <Breadcrumb items={[{ label: 'Processos', href: '/processos' }, { label: '0012/2026' }]} />,
    );
    expect(screen.getByRole('link', { name: 'Processos' }).getAttribute('href')).toBe('/processos');
    expect(screen.getByText('0012/2026').getAttribute('aria-current')).toBe('page');
    rerender(<Breadcrumb items={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('Progress expõe valor e limita a largura entre 0 e 100%', () => {
    render(<Progress value={140} aria-label="Preenchimento" />);
    const bar = screen.getByRole('progressbar', { name: 'Preenchimento' });
    expect(bar.getAttribute('aria-valuenow')).toBe(null);
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('100%');
  });

  it('Collapsible: o gatilho alterna aria-expanded e mostra o conteúdo', async () => {
    const user = userEvent.setup();
    render(
      <Collapsible>
        <CollapsibleTrigger>Ver mais</CollapsibleTrigger>
        <CollapsibleContent>Dotação orçamentária</CollapsibleContent>
      </Collapsible>,
    );
    const trigger = screen.getByRole('button', { name: 'Ver mais' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Dotação orçamentária')).toBeNull();
    await user.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Dotação orçamentária')).toBeTruthy();
  });

  it('Accordion: gatilhos em títulos h3, setas passam entre eles e Enter abre', async () => {
    const user = userEvent.setup();
    render(
      <Accordion type="single" collapsible>
        <AccordionItem value="a">
          <AccordionTrigger>Necessidade</AccordionTrigger>
          <AccordionContent>Texto A</AccordionContent>
        </AccordionItem>
        <AccordionItem value="b">
          <AccordionTrigger>Requisitos</AccordionTrigger>
          <AccordionContent>Texto B</AccordionContent>
        </AccordionItem>
      </Accordion>,
    );
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(2);
    await user.tab();
    await user.keyboard('{ArrowDown}{Enter}');
    const requisitos = screen.getByRole('button', { name: 'Requisitos' });
    expect(document.activeElement).toBe(requisitos);
    expect(requisitos.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Texto B')).toBeTruthy();
  });
});
