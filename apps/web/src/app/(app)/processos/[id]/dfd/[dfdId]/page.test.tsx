// @vitest-environment jsdom
import { configure, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DFD_ID, PROCESS_ID, callsTo, mockProcessApi } from '@test/support/process-fixtures';
import { renderWithShell } from '@test/support/render';

import ProcessDfdPage from './page';

configure({ asyncUtilTimeout: 5000 });

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => `/processos/${PROCESS_ID}/dfd/${DFD_ID}`,
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('/processos/[id]/dfd/[dfdId] (SCR-007 · US-014)', () => {
  it('busca o DFD pelo id da rota (DFD-03) e mostra "DFD não encontrado." no 404', async () => {
    const api = mockProcessApi({ permissions: ['PROCESS_VIEW'] });
    renderWithShell(
      await ProcessDfdPage({ params: Promise.resolve({ id: PROCESS_ID, dfdId: DFD_ID }) }),
    );
    expect(await screen.findByText('DFD não encontrado.')).toBeTruthy();
    expect(callsTo(api, 'GET', `/api/v1/dfds/${DFD_ID}`)).toHaveLength(1);
  });
});
