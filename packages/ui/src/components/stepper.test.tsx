import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Stepper } from './stepper.js';

afterEach(cleanup);

const steps = [
  { id: 'a', label: 'Identificação' },
  { id: 'b', label: 'Origem e planejamento' },
  { id: 'c', label: 'Revisão' },
];

describe('Stepper', () => {
  it('é uma lista ordenada e marca só o passo atual com aria-current="step"', () => {
    render(<Stepper steps={steps} current={1} label="Passos" />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items.map((item) => item.getAttribute('aria-current'))).toEqual([null, 'step', null]);
    expect(screen.getByRole('navigation', { name: 'Passos' })).toBeTruthy();
  });

  it('mostra o indicador compacto "Passo 2 de 3" (e aceita texto próprio)', () => {
    const { rerender } = render(<Stepper steps={steps} current={1} label="Passos" />);
    expect(screen.getByText('Passo 2 de 3')).toBeTruthy();
    rerender(<Stepper steps={steps} current={1} label="Passos" progressLabel="Etapa 2/3" />);
    expect(screen.getByText('Etapa 2/3')).toBeTruthy();
  });

  it('passos concluídos viram botões focáveis (teclado); os demais não', () => {
    const onStepSelect = vi.fn();
    render(<Stepper steps={steps} current={2} onStepSelect={onStepSelect} label="Passos" />);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(2);
    // Botões nativos: alcançáveis por Tab e acionados por Enter/Espaço.
    expect(buttons.map((button) => button.getAttribute('type'))).toEqual(['button', 'button']);
    expect(buttons.every((button) => button.tabIndex === 0)).toBe(true);
    fireEvent.click(buttons[0] ?? document.body);
    expect(onStepSelect).toHaveBeenCalledWith(0);
    fireEvent.click(buttons[1] ?? document.body);
    expect(onStepSelect).toHaveBeenLastCalledWith(1);
  });

  it('sem onStepSelect nenhum passo é botão', () => {
    render(<Stepper steps={steps} current={2} label="Passos" />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});
