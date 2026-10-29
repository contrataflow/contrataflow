import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Plus } from '../icons.js';
import { Button } from './button.js';
import { Checkbox } from './checkbox.js';
import { Combobox } from './combobox.js';
import { Field, Label } from './field.js';
import { Input, Textarea } from './input.js';
import { RadioGroup, RadioGroupItem } from './radio-group.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select.js';
import { Switch } from './switch.js';

afterEach(cleanup);

describe('Field', () => {
  it('liga rótulo, ajuda e erro ao controle (id, aria-describedby, aria-invalid, aria-required)', () => {
    render(
      <Field label="Objeto" description="Até 200 caracteres." error="Obrigatório." required>
        <Input />
      </Field>,
    );
    const input = screen.getByRole('textbox', { name: /Objeto/ });
    const describedBy = (input.getAttribute('aria-describedby') ?? '').split(' ');
    expect(describedBy.map((id) => document.getElementById(id)?.textContent)).toEqual([
      'Até 200 caracteres.',
      'Obrigatório.',
    ]);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-required')).toBe('true');
    // Sem o `required` nativo: a validação é do formulário (sem balão do navegador).
    expect(input.hasAttribute('required')).toBe(false);
  });

  it('props passadas à mão vencem as do Field', () => {
    render(
      <Field label="Justificativa" id="justificativa">
        <Textarea aria-describedby="outra-ajuda" />
      </Field>,
    );
    const textarea = screen.getByRole('textbox', { name: 'Justificativa' });
    expect(textarea.id).toBe('justificativa');
    expect(textarea.getAttribute('aria-describedby')).toBe('outra-ajuda');
  });

  it('em grupo vira fieldset com legend e liga a ajuda ao grupo', () => {
    render(
      <Field label="Modalidade" description="Define o rito." group>
        <RadioGroup aria-label="Modalidade">
          <RadioGroupItem value="pregao" aria-label="Pregão" />
        </RadioGroup>
      </Field>,
    );
    const group = screen.getByRole('group', { name: 'Modalidade' });
    expect(group.tagName).toBe('FIELDSET');
    expect(document.getElementById(group.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'Define o rito.',
    );
  });
});

describe('Button', () => {
  it('renderiza ícones decorativos em volta do texto, também com asChild', () => {
    const { rerender } = render(<Button iconLeft={<Plus />}>Novo processo</Button>);
    const button = screen.getByRole('button', { name: 'Novo processo' });
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    rerender(
      <Button asChild iconLeft={<Plus />}>
        <a href="#novo">Novo processo</a>
      </Button>,
    );
    const link = screen.getByRole('link', { name: 'Novo processo' });
    expect(link.querySelector('svg')).toBeTruthy();
  });
});

describe('Checkbox, RadioGroup e Switch', () => {
  it('Checkbox alterna com Espaço e anuncia o estado', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(
      <>
        <Checkbox id="aceite" onCheckedChange={onCheckedChange} />
        <Label htmlFor="aceite">Aceito</Label>
      </>,
    );
    const checkbox = screen.getByRole('checkbox', { name: 'Aceito' });
    checkbox.focus();
    await user.keyboard(' ');
    expect(onCheckedChange).toHaveBeenCalledWith(true);
    expect(checkbox.getAttribute('aria-checked')).toBe('true');
  });

  it('Checkbox em estado misto anuncia aria-checked="mixed"', () => {
    render(<Checkbox checked="indeterminate" aria-label="Selecionar todos" />);
    expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('mixed');
  });

  it('RadioGroup: setas movem o foco e Espaço escolhe', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <RadioGroup aria-label="Critério" defaultValue="a" onValueChange={onValueChange}>
        <RadioGroupItem value="a" aria-label="Menor preço" />
        <RadioGroupItem value="b" aria-label="Maior desconto" />
      </RadioGroup>,
    );
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Menor preço' }));
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Maior desconto' }));
    await user.keyboard(' ');
    expect(onValueChange).toHaveBeenCalledWith('b');
    expect(screen.getByRole('radio', { name: 'Maior desconto' }).getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  it('Switch alterna com Espaço', async () => {
    const user = userEvent.setup();
    render(<Switch aria-label="Resumo diário" />);
    const toggle = screen.getByRole('switch', { name: 'Resumo diário' });
    toggle.focus();
    await user.keyboard(' ');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });
});

describe('Select', () => {
  function UnitSelect({ onChange }: { readonly onChange: (value: string) => void }) {
    return (
      <Field label="Unidade">
        <Select onValueChange={onChange}>
          <SelectTrigger>
            <SelectValue placeholder="Selecione" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="saude">Saúde</SelectItem>
            <SelectItem value="educacao">Educação</SelectItem>
            <SelectItem value="obras">Obras</SelectItem>
          </SelectContent>
        </Select>
      </Field>
    );
  }

  it('teclado: Enter abre, seta desce, Enter escolhe e o foco volta ao gatilho', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<UnitSelect onChange={onChange} />);
    const trigger = screen.getByRole('combobox', { name: 'Unidade' });
    trigger.focus();
    await user.keyboard('{Enter}');
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).getAllByRole('option')).toHaveLength(3);
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenCalledWith('educacao');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(trigger.textContent).toContain('Educação');
    expect(document.activeElement).toBe(trigger);
  });

  it('teclado: Esc fecha sem escolher', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<UnitSelect onChange={onChange} />);
    screen.getByRole('combobox', { name: 'Unidade' }).focus();
    await user.keyboard('{ArrowDown}');
    await screen.findByRole('listbox');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('Combobox', () => {
  const options = [
    { value: 'f1', label: 'Limpa Tudo Serviços' },
    { value: 'f2', label: 'Hospitalar Norte', keywords: ['hospital'] },
    { value: 'f3', label: 'Papelaria Central' },
  ];

  function SupplierCombobox({ clearable = false }: { readonly clearable?: boolean }) {
    const [value, setValue] = useState<string | undefined>(undefined);
    return (
      <Field label="Fornecedor">
        <Combobox
          options={options}
          value={value}
          onValueChange={setValue}
          clearable={clearable}
          labels={{ search: 'Buscar fornecedor', empty: 'Nenhum fornecedor.' }}
        />
      </Field>
    );
  }

  it('teclado: abre, filtra pela busca, setas navegam e Enter escolhe e fecha', async () => {
    const user = userEvent.setup();
    render(<SupplierCombobox />);
    const trigger = screen.getByRole('combobox', { name: 'Fornecedor' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    trigger.focus();
    await user.keyboard('{Enter}');
    const search = await screen.findByPlaceholderText('Buscar fornecedor');
    expect(document.activeElement).toBe(search);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByRole('option')).toHaveLength(3);

    await user.keyboard('{ArrowDown}{Enter}');
    expect(trigger.textContent).toBe('Hospitalar Norte');
    expect(screen.queryByPlaceholderText('Buscar fornecedor')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await user.keyboard('{Enter}');
    await user.keyboard('papel');
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Papelaria Central',
    ]);
    await user.keyboard('{Enter}');
    expect(trigger.textContent).toBe('Papelaria Central');
  });

  it('mostra "nenhum resultado" quando a busca não casa', async () => {
    const user = userEvent.setup();
    render(<SupplierCombobox />);
    await user.click(screen.getByRole('combobox', { name: 'Fornecedor' }));
    await user.keyboard('xyz');
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('Nenhum fornecedor.')).toBeTruthy();
  });

  it('busca também pelas palavras-chave e desmarca a opção marcada quando clearable', async () => {
    const user = userEvent.setup();
    render(<SupplierCombobox clearable />);
    const trigger = screen.getByRole('combobox', { name: 'Fornecedor' });
    await user.click(trigger);
    await user.keyboard('hospital{Enter}');
    expect(trigger.textContent).toBe('Hospitalar Norte');
    await user.click(trigger);
    await user.click(screen.getByRole('option', { name: 'Hospitalar Norte' }));
    expect(trigger.textContent).toBe('Selecione');
  });

  it('Esc fecha e devolve o foco ao gatilho', async () => {
    const user = userEvent.setup();
    render(<SupplierCombobox />);
    const trigger = screen.getByRole('combobox', { name: 'Fornecedor' });
    trigger.focus();
    await user.keyboard('{Enter}');
    await screen.findByPlaceholderText('Buscar fornecedor');
    await user.keyboard('{Escape}');
    expect(screen.queryByPlaceholderText('Buscar fornecedor')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
