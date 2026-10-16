// @vitest-environment jsdom
import { configure, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { PROCESS_ID, callsTo, mockProcessApi, processDto } from '@test/support/process-fixtures';
import { jsonResponse, renderWithShell } from '@test/support/render';

import { ProcessPanel, nextStepOf } from './process-panel';

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => `/processos/${PROCESS_ID}`,
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

const NBSP = String.fromCharCode(160);

describe('SCR-006 · painel do processo criado', () => {
  it('cabeçalho, "Onde está" e o próximo passo "Elabore o DFD" na etapa de abertura', async () => {
    const api = mockProcessApi();
    renderWithShell(<ProcessPanel processId={PROCESS_ID} />);

    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Aquisição de cimento para manutenção de vias',
      }),
    ).toBeTruthy();
    expect(screen.getByText('0012/2026')).toBeTruthy();
    expect(screen.getByText('Rascunho')).toBeTruthy();
    expect(screen.getByText('Prioridade Média')).toBeTruthy();

    const where = screen.getByRole('heading', { level: 2, name: 'Onde está' }).parentElement;
    expect(where).toBeTruthy();
    const whereText = where?.textContent ?? '';
    expect(whereText).toContain('Formalização da demanda');
    expect(whereText).toContain('Setor de Manutenção');
    expect(whereText).toContain('Ana Souza');
    expect(whereText).toContain('Sem prazo definido');

    const next = screen.getByRole('heading', { level: 2, name: 'Próximo passo' }).parentElement;
    expect(
      within(next ?? document.body).getByText('Elabore o DFD para formalizar a demanda.'),
    ).toBeTruthy();

    // Ações disponíveis da US-041 montadas no painel.
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Ações disponíveis' }),
    ).toBeTruthy();
    expect(callsTo(api, 'GET', `/api/v1/processes/${PROCESS_ID}`)).toHaveLength(1);
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('processo sem número (assignOn = START) aparece como "Rascunho (sem número)"', async () => {
    mockProcessApi({
      process: () =>
        jsonResponse({ data: processDto({ code: null, number: null, openedAt: null }) }),
    });
    renderWithShell(<ProcessPanel processId={PROCESS_ID} />);
    expect(await screen.findByText('Rascunho (sem número)')).toBeTruthy();
    expect(screen.queryByText('0012/2026')).toBeNull();
  });

  it('sem tipo de documento conhecido usa a orientação da etapa; sem nada, avisa', async () => {
    const stage = processDto().currentStage;
    if (!stage) throw new Error('fixture sem etapa');
    mockProcessApi({
      process: () =>
        jsonResponse({
          data: processDto({
            currentStage: {
              ...stage,
              documentTypeCodes: ['ETP'],
              instructions: 'Reúna os estudos técnicos.\nConfira os anexos.',
            },
          }),
        }),
    });
    const first = renderWithShell(<ProcessPanel processId={PROCESS_ID} />);
    expect(await screen.findByText(/Reúna os estudos técnicos\./)).toBeTruthy();
    expect(screen.queryByText('Elabore o DFD para formalizar a demanda.')).toBeNull();
    first.unmount();

    mockProcessApi({
      process: () =>
        jsonResponse({
          data: processDto({
            currentStage: { ...stage, documentTypeCodes: [], instructions: null },
          }),
        }),
    });
    renderWithShell(<ProcessPanel processId={PROCESS_ID} />);
    expect(await screen.findByText('Nenhuma orientação cadastrada para esta etapa.')).toBeTruthy();
  });

  it('prazo da etapa, prazo alvo, valor e modalidade nos dados do processo', async () => {
    const stage = processDto().currentStage;
    if (!stage) throw new Error('fixture sem etapa');
    mockProcessApi({
      process: () =>
        jsonResponse({
          data: processDto({
            currentStage: { ...stage, dueAt: '2026-10-20T15:00:00.000Z' },
            targetDate: '2026-12-31',
            estimatedValue: '15000.00',
            currentResponsible: null,
          }),
        }),
    });
    renderWithShell(<ProcessPanel processId={PROCESS_ID} />);
    await screen.findByRole('heading', { level: 1 });
    const text = document.body.textContent;
    expect(text).toContain('20/10/2026');
    expect(text).toContain('31/12/2026');
    expect(text).toContain(`R$${NBSP}15.000,00`);
    expect(text).toContain('Sem responsável definido');
    expect(text).toContain('A definir');
  });

  it('valor restrito (orçamento sigiloso) não é exibido', async () => {
    mockProcessApi({
      process: () =>
        jsonResponse({ data: processDto({ estimatedValue: null, estimatedValueMasked: true }) }),
    });
    renderWithShell(<ProcessPanel processId={PROCESS_ID} />);
    expect(await screen.findByText('Valor restrito')).toBeTruthy();
  });

  it('enquanto carrega mostra o skeleton anunciado', () => {
    mockProcessApi({ process: () => new Promise<Response>(() => undefined) });
    renderWithShell(<ProcessPanel processId={PROCESS_ID} />);
    expect(screen.getByText('Carregando o processo…')).toBeTruthy();
  });
});

describe('nextStepOf', () => {
  const stage = processDto().currentStage;
  if (!stage) throw new Error('fixture sem etapa');

  it('prioriza o tipo de documento da etapa, depois as instruções, depois nada', () => {
    expect(nextStepOf(stage)).toEqual({ kind: 'document', code: 'DFD' });
    expect(
      nextStepOf({ ...stage, documentTypeCodes: ['ETP'], instructions: '  Faça X.  ' }),
    ).toEqual({
      kind: 'instructions',
      text: 'Faça X.',
    });
    expect(nextStepOf({ ...stage, documentTypeCodes: [], instructions: '   ' })).toEqual({
      kind: 'none',
    });
    expect(nextStepOf(null)).toEqual({ kind: 'none' });
  });
});
