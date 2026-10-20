// @vitest-environment jsdom
import { configure, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ID, PROCESS_ID, callsTo, mockProcessApi } from '@test/support/process-fixtures';
import { jsonResponse, renderWithShell } from '@test/support/render';

import ProcessRisksPage from './page';

configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('/processos/[id]/riscos (SCR-011 · US-033 · US-035)', () => {
  it('busca os riscos pelo id da rota e abre na aba "Lista de riscos" com o link de volta', async () => {
    const api = mockProcessApi({
      permissions: ['PROCESS_VIEW'],
      risks: () =>
        jsonResponse({
          data: [],
          meta: {
            scale: {
              max: 5,
              probabilityLabels: ['Muito baixa', 'Baixa', 'Média', 'Alta', 'Muito alta'],
              impactLabels: ['Insignificante', 'Baixo', 'Médio', 'Alto', 'Crítico'],
            },
            levelThresholds: [
              { level: 'LOW', minScore: 1, maxScore: 4 },
              { level: 'MEDIUM', minScore: 5, maxScore: 9 },
              { level: 'HIGH', minScore: 10, maxScore: 16 },
              { level: 'EXTREME', minScore: 17, maxScore: 25 },
            ],
            riskMap: { id: ID(777), code: null, status: 'DRAFT' },
            canManage: true,
            lockReason: null,
          },
        }),
    });
    renderWithShell(await ProcessRisksPage({ params: Promise.resolve({ id: PROCESS_ID }) }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Riscos' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Lista de riscos' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByRole('tab', { name: 'Matriz' }).getAttribute('aria-selected')).toBe('false');
    expect(
      await screen.findByText('Nenhum risco registrado. Comece identificando o primeiro risco.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Novo risco' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Voltar ao processo' }).getAttribute('href')).toBe(
      `/processos/${PROCESS_ID}`,
    );
    expect(
      await screen.findByText('Processo 0012/2026 — Aquisição de cimento para manutenção de vias'),
    ).toBeTruthy();
    expect(callsTo(api, 'GET', `/api/v1/processes/${PROCESS_ID}/risks`)).toHaveLength(1);
  });
});
