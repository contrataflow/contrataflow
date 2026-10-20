// @vitest-environment jsdom
import { configure, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { APPROVAL_ID, APPROVAL_URL, mockApprovalApi } from '@test/support/approval-fixtures';
import { callsTo } from '@test/support/process-fixtures';
import { renderWithShell } from '@test/support/render';

import ApprovalDetailPage from './page';

configure({ asyncUtilTimeout: 10_000 });

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/aprovacoes',
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('/aprovacoes/[id] (SCR-015 · US-052)', () => {
  it('busca a aprovação pelo id da rota e monta o painel de decisão', async () => {
    const api = mockApprovalApi();
    renderWithShell(await ApprovalDetailPage({ params: Promise.resolve({ id: APPROVAL_ID }) }));
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Aprovação do ETP e do Termo de Referência',
      }),
    ).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Aprovar' })).toBeTruthy();
    expect(callsTo(api, 'GET', APPROVAL_URL)).toHaveLength(1);
  });
});
