// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';

import { ProbabilityImpactGrid } from './probability-impact-grid';

const THRESHOLDS = [
  { level: 'LOW', minScore: 1, maxScore: 4 },
  { level: 'MEDIUM', minScore: 5, maxScore: 9 },
  { level: 'HIGH', minScore: 10, maxScore: 16 },
  { level: 'EXTREME', minScore: 17, maxScore: 25 },
] as const;
const SCALE = {
  max: 5,
  probabilityLabels: ['Muito baixa', 'Baixa', 'Média', 'Alta', 'Muito alta'],
  impactLabels: ['Insignificante', 'Baixo', 'Médio', 'Alto', 'Crítico'],
};

function renderGrid(
  props: Partial<React.ComponentProps<typeof ProbabilityImpactGrid>> = {},
  onChange = vi.fn(),
) {
  render(
    <ProbabilityImpactGrid
      id="grid"
      label="Probabilidade × impacto"
      scale={SCALE}
      thresholds={THRESHOLDS}
      probability={null}
      impact={null}
      onChange={onChange}
      probabilityAxisLabel="Probabilidade"
      impactAxisLabel="Impacto"
      {...props}
    />,
  );
  return onChange;
}

describe('ProbabilityImpactGrid (US-033 · SCR-011)', () => {
  it('cada célula tem aria-label com rótulos da escala, escore e nível', () => {
    renderGrid();
    expect(
      screen.getByRole('gridcell', {
        name: 'Probabilidade Alta (4), impacto Médio (3): escore 12, nível Alto',
      }),
    ).toBeTruthy();
    expect(screen.getAllByRole('gridcell')).toHaveLength(25);
    // Nível sempre em texto, não só em cor.
    expect(screen.getAllByText('Extremo').length).toBeGreaterThan(0);
  });

  it('teclado: uma célula na tabulação; setas movem o foco; Enter seleciona', async () => {
    const user = userEvent.setup();
    const onChange = renderGrid();
    const tabbable = screen
      .getAllByRole('gridcell')
      .filter((cell) => cell.getAttribute('tabindex') === '0');
    expect(tabbable).toHaveLength(1);

    await user.tab();
    // Foco inicial no centro (3, 3).
    expect(document.activeElement?.getAttribute('aria-label')).toContain(
      'Probabilidade Média (3), impacto Médio (3)',
    );
    await user.keyboard('{ArrowUp}{ArrowRight}');
    expect(document.activeElement?.getAttribute('aria-label')).toContain(
      'Probabilidade Alta (4), impacto Alto (4): escore 16, nível Alto',
    );
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith(4, 4);
    await user.keyboard(
      '{ArrowDown}{ArrowDown}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}',
    );
    expect(document.activeElement?.getAttribute('aria-label')).toContain(
      'Probabilidade Baixa (2), impacto Insignificante (1)',
    );
    await user.keyboard(' ');
    expect(onChange).toHaveBeenLastCalledWith(2, 1);
  });

  it('clique seleciona; a célula escolhida fica aria-selected e é a da tabulação', async () => {
    const user = userEvent.setup();
    const onChange = renderGrid({ probability: 2, impact: 4 });
    const selected = screen.getByRole('gridcell', { selected: true });
    expect(selected.getAttribute('aria-label')).toContain(
      'Probabilidade Baixa (2), impacto Alto (4): escore 8, nível Médio',
    );
    expect(selected.getAttribute('tabindex')).toBe('0');
    await user.click(
      screen.getByRole('gridcell', {
        name: /Probabilidade Muito alta \(5\), impacto Crítico \(5\)/,
      }),
    );
    expect(onChange).toHaveBeenCalledWith(5, 5);
  });

  it('desabilitada não seleciona; o erro fica ligado à grade', async () => {
    const user = userEvent.setup();
    const onChange = renderGrid({ disabled: true, error: 'Informe a probabilidade.' });
    const [first] = screen.getAllByRole('gridcell');
    if (!first) throw new Error('Grade sem células.');
    await user.click(first);
    expect(onChange).not.toHaveBeenCalled();
    const grid = screen.getByRole('grid');
    expect(grid.getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByText('Informe a probabilidade.')).toBeTruthy();
  });

  it('escala 3×3 mostra 9 células', () => {
    renderGrid({
      scale: {
        max: 3,
        probabilityLabels: ['Baixa', 'Média', 'Alta'],
        impactLabels: ['B', 'M', 'A'],
      },
    });
    expect(screen.getAllByRole('gridcell')).toHaveLength(9);
  });

  it('[Acessibilidade] sem violações sérias (axe)', async () => {
    renderGrid({ probability: 3, impact: 3, required: true });
    expect(await seriousA11yViolations()).toEqual([]);
  });
});
