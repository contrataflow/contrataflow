// @vitest-environment jsdom
import { configure, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PROCESS_ID, callsTo, mockProcessApi } from '@test/support/process-fixtures';
import { renderWithShell } from '@test/support/render';

import ProcessDetailPage from './[id]/page';
import NewProcessRoutePage from './novo/page';

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/processos/novo',
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('rotas de processo (US-001)', () => {
  it('/processos/novo abre o wizard SCR-005 para quem tem PROCESS_CREATE', async () => {
    mockProcessApi();
    renderWithShell(<NewProcessRoutePage />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Novo processo' })).toBeTruthy();
    expect(await screen.findByRole('heading', { level: 2, name: 'Identificação' })).toBeTruthy();
  });

  it('/processos/novo sem PROCESS_CREATE mostra o 403 do SCR-111', async () => {
    mockProcessApi({ permissions: [] });
    renderWithShell(<NewProcessRoutePage />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Acesso negado' })).toBeTruthy();
  });

  it('/processos/[id] busca o processo pelo id da rota (SCR-006)', async () => {
    const api = mockProcessApi();
    renderWithShell(await ProcessDetailPage({ params: Promise.resolve({ id: PROCESS_ID }) }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Onde está' })).toBeTruthy();
    expect(callsTo(api, 'GET', `/api/v1/processes/${PROCESS_ID}`)).toHaveLength(1);
    expect(callsTo(api, 'GET', `/api/v1/processes/${PROCESS_ID}/summary`)).toHaveLength(1);
  });
});
