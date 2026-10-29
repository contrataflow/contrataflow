import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Button } from './button.js';
import { DatePicker, DateRangePicker, fromIsoDate, toIsoDate } from './date-picker.js';
import type { DateRange } from './date-picker.js';
import { Field } from './field.js';
import { FilterToolbar } from './filter-toolbar.js';
import { Popover, PopoverContent, PopoverTrigger } from './popover.js';
import { Sheet, SheetBody, SheetContent, SheetFooter, SheetHeader, SheetTitle } from './sheet.js';
import { InfoTooltip } from './tooltip.js';

afterEach(cleanup);

describe('DatePicker', () => {
  function Deadline({
    initial,
    onChange,
  }: {
    readonly initial?: Date | undefined;
    readonly onChange?: (date: Date | undefined) => void;
  }) {
    const [value, setValue] = useState<Date | undefined>(initial);
    return (
      <Field label="Prazo">
        <DatePicker
          value={value}
          clearable
          onValueChange={(date) => {
            setValue(date);
            onChange?.(date);
          }}
        />
      </Field>
    );
  }

  it('teclado: Enter abre com foco no dia escolhido, setas navegam, Enter escolhe e fecha', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Deadline initial={new Date(2026, 9, 15)} onChange={onChange} />);
    const trigger = screen.getByRole('button', { name: 'Prazo' });
    expect(trigger.textContent).toBe('15/10/2026');
    trigger.focus();
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'Escolher data' });
    expect(within(dialog).getByRole('grid').getAttribute('aria-label')).toMatch(/outubro/i);
    expect(document.activeElement?.textContent).toBe('15');
    await user.keyboard('{ArrowRight}{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenCalledWith(new Date(2026, 9, 23));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger.textContent).toBe('23/10/2026');
  });

  it('PageDown muda o mês; Esc fecha sem escolher e devolve o foco', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Deadline initial={new Date(2026, 9, 15)} onChange={onChange} />);
    const trigger = screen.getByRole('button', { name: 'Prazo' });
    trigger.focus();
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'Escolher data' });
    await user.keyboard('{PageDown}');
    expect(within(dialog).getByRole('grid').getAttribute('aria-label')).toMatch(/novembro/i);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  });

  it('fora do Field do kit, aceita as ligações aria de um rótulo e erro próprios (sem aria-required)', () => {
    render(
      <DatePicker
        id="prazo"
        aria-label="Prazo alvo"
        aria-describedby="prazo-erro"
        aria-invalid
        aria-required
        value={undefined}
        onValueChange={vi.fn()}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'Prazo alvo' });
    expect(trigger.id).toBe('prazo');
    expect(trigger.getAttribute('aria-describedby')).toBe('prazo-erro');
    expect(trigger.getAttribute('aria-invalid')).toBe('true');
    // `aria-required` não é permitido em botão (axe `aria-allowed-attr`).
    expect(trigger.hasAttribute('aria-required')).toBe(false);
  });

  it('sem valor mostra o placeholder; limpar devolve undefined', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Deadline onChange={onChange} />);
    expect(screen.getByRole('button', { name: 'Prazo' }).textContent).toBe('Selecione a data');
    expect(screen.queryByRole('button', { name: 'Limpar data' })).toBeNull();
    cleanup();
    render(<Deadline initial={new Date(2026, 0, 2)} onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Limpar data' }));
    expect(onChange).toHaveBeenCalledWith(undefined);
    expect(screen.getByRole('button', { name: 'Prazo' }).textContent).toBe('Selecione a data');
  });

  it('converte de e para o aaaa-MM-dd da API', () => {
    expect(toIsoDate(new Date(2026, 1, 3))).toBe('2026-02-03');
    expect(fromIsoDate('2026-02-03')).toEqual(new Date(2026, 1, 3));
    expect(fromIsoDate('')).toBeUndefined();
    expect(fromIsoDate('não é data')).toBeUndefined();
  });
});

describe('DateRangePicker', () => {
  it('dois cliques fecham o período e o gatilho mostra "início a fim"', async () => {
    const user = userEvent.setup();
    function Period() {
      const [value, setValue] = useState<DateRange | undefined>({
        from: new Date(2026, 9, 1),
        to: undefined,
      });
      return (
        <DateRangePicker
          aria-label="Período"
          numberOfMonths={1}
          value={value}
          onValueChange={setValue}
        />
      );
    }
    render(<Period />);
    const trigger = screen.getByRole('button', { name: 'Período' });
    await user.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Escolher período' });
    await user.click(within(dialog).getByRole('button', { name: /, 5 de outubro/ }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: /, 9 de outubro/ }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(trigger.textContent).toBe('01/10/2026 a 09/10/2026');
  });
});

describe('Popover, Tooltip e Sheet', () => {
  it('Popover: Esc fecha e devolve o foco ao gatilho', async () => {
    const user = userEvent.setup();
    render(
      <Popover>
        <PopoverTrigger asChild>
          <Button>Prazo</Button>
        </PopoverTrigger>
        <PopoverContent aria-label="Detalhe do prazo">Vence em 2 dias</PopoverContent>
      </Popover>,
    );
    const trigger = screen.getByRole('button', { name: 'Prazo' });
    await user.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Detalhe do prazo' })).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('InfoTooltip: aparece no foco do teclado, vira descrição e some com Esc', async () => {
    const user = userEvent.setup();
    render(<InfoTooltip label="Ajuda sobre o valor">Soma dos itens.</InfoTooltip>);
    await user.tab();
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toBe('Soma dos itens.');
    const trigger = screen.getByRole('button', { name: 'Ajuda sobre o valor' });
    expect(trigger.getAttribute('aria-describedby')).toBe(tooltip.id);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('Sheet: diálogo modal rotulado, variante larga e corpo como única rolagem', () => {
    render(
      <Sheet open>
        <SheetContent size="wide" aria-describedby={undefined}>
          <SheetHeader>
            <SheetTitle>Comparar propostas</SheetTitle>
          </SheetHeader>
          <SheetBody data-testid="corpo">Tabela</SheetBody>
          <SheetFooter>
            <Button>Fechar</Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Comparar propostas' });
    expect(dialog.className).toContain('md:max-w-4xl');
    expect(screen.getByTestId('corpo').className).toContain('overflow-y-auto');
    expect(screen.getAllByRole('button', { name: 'Fechar' })).toHaveLength(2);
  });
});

describe('FilterToolbar', () => {
  it('busca inline, botão Filtros com contador, chips removíveis e "Limpar filtros"', async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn();
    const onRemove = vi.fn();
    const onClearAll = vi.fn();
    render(
      <FilterToolbar
        search={{ value: '', onChange: onSearch, label: 'Buscar processos' }}
        activeCount={2}
        filters={<p>Campos de filtro</p>}
        chips={[
          { id: 'a', label: 'Situação: Atrasado', removeLabel: 'Remover situação', onRemove },
          { id: 'b', label: 'Unidade: Saúde', removeLabel: 'Remover unidade', onRemove: vi.fn() },
        ]}
        onClearAll={onClearAll}
      />,
    );
    await user.type(screen.getByRole('searchbox', { name: 'Buscar processos' }), 'a');
    expect(onSearch).toHaveBeenCalledWith('a');

    // Filtros fechados por padrão (prd-5 · regra 2).
    expect(screen.queryByText('Campos de filtro')).toBeNull();
    const filters = screen.getByRole('button', { name: 'Filtros, 2 filtros ativos' });
    await user.click(filters);
    expect(screen.getByRole('dialog', { name: 'Filtros' }).textContent).toBe('Campos de filtro');
    await user.keyboard('{Escape}');

    const chips = screen.getByRole('list', { name: 'Filtros aplicados' });
    await user.click(within(chips).getByRole('button', { name: 'Remover situação' }));
    expect(onRemove).toHaveBeenCalledOnce();
    await user.click(within(chips).getByRole('button', { name: 'Limpar filtros' }));
    expect(onClearAll).toHaveBeenCalledOnce();
  });

  it('sem filtros ativos: botão sem contador e sem lista de chips', () => {
    render(<FilterToolbar filters={<p>Campos</p>} />);
    expect(screen.getByRole('button', { name: 'Filtros' })).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('ordenação pelo Select do kit', async () => {
    const user = userEvent.setup();
    const onSort = vi.fn();
    render(
      <FilterToolbar
        sort={{
          value: 'prazo',
          onValueChange: onSort,
          options: [
            { value: 'prazo', label: 'Prazo' },
            { value: 'recentes', label: 'Mais recentes' },
          ],
        }}
      />,
    );
    const trigger = screen.getByRole('combobox', { name: 'Ordenar por' });
    expect(trigger.textContent).toContain('Prazo');
    trigger.focus();
    await user.keyboard('{Enter}');
    await screen.findByRole('listbox');
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onSort).toHaveBeenCalledWith('recentes');
  });
});
