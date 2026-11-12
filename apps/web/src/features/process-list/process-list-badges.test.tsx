// @vitest-environment jsdom
import type { ProcessDeadlineDto } from '@contrataflow/validation';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { IntlProvider } from '@test/support/render';

import { DueDateBadge, ProcessStageChips } from './process-list-badges';

afterEach(() => {
  cleanup();
});

function deadline(overrides: Partial<ProcessDeadlineDto> = {}): ProcessDeadlineDto {
  return {
    dueAt: '2026-10-28T02:59:59.999Z',
    slaType: 'BUSINESS',
    daysLeft: 5,
    overdueDays: null,
    isDueSoon: false,
    isOverdue: false,
    isPaused: false,
    ...overrides,
  };
}

function badge(props: Parameters<typeof DueDateBadge>[0]) {
  render(
    <IntlProvider>
      <ul>
        <li>
          <DueDateBadge {...props} />
        </li>
      </ul>
    </IntlProvider>,
  );
}

describe('DueDateBadge — estados do prazo da etapa (US-055 · SCR-004/SCR-006)', () => {
  it.each([
    ['normal', deadline(), 'No prazo'],
    ['a vencer', deadline({ daysLeft: 2, isDueSoon: true }), 'Vence em 2 dias úteis'],
    [
      'atrasado',
      deadline({ daysLeft: null, overdueDays: 1, isOverdue: true }),
      'Atrasado há 1 dia útil',
    ],
    ['suspenso', deadline({ daysLeft: null, isPaused: true }), 'Prazo pausado'],
    ['sem prazo (FA-01)', deadline({ dueAt: null, daysLeft: null }), 'Sem prazo'],
  ])('%s: ícone + texto, nunca só cor', async (_state, value, label) => {
    badge({ deadline: value });
    const text = screen.getByText(label);
    expect(text.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('FA-04: suspenso com o atraso já detectado mostra "Atrasado (suspenso)" até a retomada', () => {
    badge({
      deadline: deadline({ daysLeft: null, isPaused: true }),
      overdueSince: '2026-10-29T03:00:00.000Z',
    });
    expect(screen.getByText('Atrasado (suspenso)').textContent).toBe('Atrasado (suspenso)');
  });
});

describe('ProcessStageChips (US-125 · RN-WF2-36)', () => {
  it('um chip por etapa ativa, com o atraso em texto e a lista anunciada', async () => {
    const stage = (n: number, name: string, isOverdue: boolean) => ({
      processStageId: `0192e125-0000-7000-8000-${String(n).padStart(12, '0')}`,
      stageKey: `ETAPA_${String(n)}`,
      stageName: name,
      branchKey: `RAMO_${String(n)}`,
      branchLabel: name,
      departmentName: 'Procuradoria',
      dueAt: null,
      isOverdue,
    });
    render(
      <IntlProvider>
        <ProcessStageChips
          stages={[stage(1, 'Análise jurídica', true), stage(2, 'Controle interno', false)]}
        />
      </IntlProvider>,
    );
    expect(screen.getByText('Análise jurídica (atrasado)')).toBeTruthy();
    expect(screen.getByText('Controle interno')).toBeTruthy();
    expect(
      screen.getByLabelText('Etapas ativas: Análise jurídica · Controle interno'),
    ).toBeTruthy();
    expect(await seriousA11yViolations()).toEqual([]);
  });
});
