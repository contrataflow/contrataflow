// @vitest-environment jsdom
import type { ActionEntry, ActionStageDto } from '@contrataflow/validation';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { jsonResponse, renderWithShell } from '@test/support/render';

import { BranchSelector } from './branch-selector';
import {
  defaultBranchStageId,
  entriesOfStage,
  fetchAvailableActionsResult,
  hasBranches,
} from './process-actions.api';

/* US-124 — escolha do ramo: filtra as entradas de PRC-08 pela etapa e pré-seleciona a minha. */

const PROCESS = '0192a000-0000-7000-8000-0000000000f1';
const S_JUR = '0192a000-0000-7000-8000-000000000a01';
const S_CI = '0192a000-0000-7000-8000-000000000a02';

const STAGES: ActionStageDto[] = [
  {
    processStageId: S_JUR,
    branchKey: 'JURIDICO',
    stageKey: 'ANALISE',
    stageName: 'Análise jurídica',
    isMine: false,
  },
  {
    processStageId: S_CI,
    branchKey: 'CONTROLE',
    stageKey: 'PARECER',
    stageName: 'Parecer do controle',
    isMine: true,
  },
];

const entry = (extra: Partial<ActionEntry>): ActionEntry => ({
  action: 'FORWARD',
  label: 'Encaminhar',
  enabled: true,
  reasons: [],
  ...extra,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('regras do ramo (US-124)', () => {
  it('pré-seleciona a primeira etapa com isMine e, sem nenhuma, a primeira', () => {
    expect(defaultBranchStageId(STAGES)).toBe(S_CI);
    expect(defaultBranchStageId(STAGES.map((s) => ({ ...s, isMine: false })))).toBe(S_JUR);
    expect(defaultBranchStageId(undefined)).toBeNull();
  });

  it('hasBranches só com mais de uma etapa; entriesOfStage filtra e mantém entradas sem etapa', () => {
    expect(hasBranches(STAGES)).toBe(true);
    expect(hasBranches(STAGES.slice(0, 1))).toBe(false);
    const list = [
      entry({ processStageId: S_JUR }),
      entry({ processStageId: S_CI, action: 'RETURN' }),
      entry({ action: 'EDIT' }),
    ];
    expect(entriesOfStage(list, S_CI).map((e) => e.action)).toEqual(['RETURN', 'EDIT']);
    expect(entriesOfStage(list, null)).toHaveLength(3);
  });

  it('fetchAvailableActionsResult lê stages do envelope; sem stages fica undefined', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ data: [entry({})], stages: STAGES }))),
    );
    expect((await fetchAvailableActionsResult(PROCESS)).stages).toEqual(STAGES);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ data: [entry({})] }))),
    );
    const plain = await fetchAvailableActionsResult(PROCESS);
    expect(plain.stages).toBeUndefined();
    expect(plain.entries).toHaveLength(1);
  });
});

function Harness({ stages }: { readonly stages: ActionStageDto[] }) {
  const [value, setValue] = useState<string | null>(defaultBranchStageId(stages));
  return (
    <>
      <BranchSelector stages={stages} value={value} onChange={setValue} />
      <output data-testid="chosen">{value}</output>
    </>
  );
}

describe('BranchSelector (US-124)', () => {
  it('mostra os ramos como radiogroup, com a etapa minha marcada e anunciada', () => {
    renderWithShell(<Harness stages={STAGES} />);
    expect(screen.getByRole('radiogroup', { name: 'Ramo em que você quer agir' })).toBeTruthy();
    const mine = screen.getByRole('radio', { name: /Parecer do controle/ });
    expect(mine.getAttribute('aria-checked')).toBe('true');
    expect(
      screen.getByRole('radio', { name: /Análise jurídica/ }).getAttribute('aria-checked'),
    ).toBe('false');
    expect(screen.getByText('Ramo selecionado: Parecer do controle')).toBeTruthy();
  });

  it('troca o ramo por clique e pelas setas do teclado', async () => {
    const user = userEvent.setup();
    renderWithShell(<Harness stages={STAGES} />);
    await user.click(screen.getByRole('radio', { name: /Análise jurídica/ }));
    expect(screen.getByTestId('chosen').textContent).toBe(S_JUR);
    await user.keyboard('{ArrowRight}');
    await waitFor(() => {
      expect(screen.getByTestId('chosen').textContent).toBe(S_CI);
    });
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: /Parecer do controle/ }));
  });

  it('fora do paralelismo (uma etapa ou nenhuma) não renderiza nada', () => {
    renderWithShell(
      <BranchSelector stages={STAGES.slice(0, 1)} value={S_JUR} onChange={() => undefined} />,
    );
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });
});
