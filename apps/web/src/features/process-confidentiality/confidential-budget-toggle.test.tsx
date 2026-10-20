// @vitest-environment jsdom
import { Toaster, clearToasts } from '@contrataflow/ui';
import { configure, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeQueryClient } from '@/lib/query/query-client';
import { seriousA11yViolations } from '@test/support/axe';
import {
  PROCESS_ID,
  callsTo,
  mockProcessApi,
  problemResponse,
  processDto,
} from '@test/support/process-fixtures';
import type { ProcessApiOptions } from '@test/support/process-fixtures';
import { renderWithShell } from '@test/support/render';

import { ConfidentialBudgetToggle } from './confidential-budget-toggle';

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

const PUT_URL = `/api/v1/processes/${PROCESS_ID}/confidentiality`;

const noRetryClient = () => {
  const client = makeQueryClient();
  client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retry: false } });
  return client;
};

function renderToggle(
  process = processDto({ version: 1 }),
  options: ProcessApiOptions = {},
  permissions: readonly string[] = ['PROCESS_VIEW', 'PROCESS_SET_CONFIDENTIAL_BUDGET'],
) {
  const api = mockProcessApi({ permissions, ...options });
  renderWithShell(
    <>
      <ConfidentialBudgetToggle processId={PROCESS_ID} process={process} />
      <Toaster />
    </>,
    { queryClient: noRetryClient() },
  );
  return api;
}

const toggle = () => screen.getByRole('switch', { name: 'Orçamento sigiloso' });

describe('SCR-006 · Interruptor "Orçamento sigiloso" (US-013)', () => {
  it('[Sucesso] ativa com confirmação: PUT com If-Match da versão lida e o toast', async () => {
    const user = userEvent.setup();
    const api = renderToggle();
    await waitFor(() => {
      expect((toggle() as HTMLButtonElement).disabled).toBe(false);
    });
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(toggle().getAttribute('aria-describedby')).toBeTruthy();

    await user.click(toggle());
    const dialog = await screen.findByRole('dialog', { name: 'Marcar o orçamento como sigiloso?' });
    expect(dialog.textContent).toContain('órgãos de controle continuam vendo normalmente');
    expect(await seriousA11yViolations(dialog)).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Marcar como sigiloso' }));

    // Toast e anúncio `aria-live`.
    expect(await screen.findAllByText('Orçamento marcado como sigiloso')).not.toHaveLength(0);
    const [call, ...others] = callsTo(api, 'PUT', PUT_URL);
    expect(others).toEqual([]);
    expect(call?.headers.get('If-Match')).toBe('"1"');
    expect(call?.body).toEqual({ isBudgetConfidential: true });
  });

  it('[Sucesso] desativa: o diálogo explica a reversão e envia false', async () => {
    const user = userEvent.setup();
    const api = renderToggle(processDto({ isBudgetConfidential: true, version: 2 }), {
      confidentiality: () =>
        new Response(JSON.stringify({ data: processDto({ version: 3 }) }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    });
    await waitFor(() => {
      expect((toggle() as HTMLButtonElement).disabled).toBe(false);
    });
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    await user.click(toggle());
    await screen.findByRole('dialog', { name: 'Tornar o orçamento público?' });
    await user.click(screen.getByRole('button', { name: 'Tornar público' }));
    await waitFor(() => {
      expect(callsTo(api, 'PUT', PUT_URL)).toHaveLength(1);
    });
    const [call] = callsTo(api, 'PUT', PUT_URL);
    expect(call?.headers.get('If-Match')).toBe('"2"');
    expect(call?.body).toEqual({ isBudgetConfidential: false });
  });

  it('[Validação] cancelar o diálogo não envia nada e mantém o estado', async () => {
    const user = userEvent.setup();
    const api = renderToggle();
    await waitFor(() => {
      expect((toggle() as HTMLButtonElement).disabled).toBe(false);
    });
    await user.click(toggle());
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: 'Cancelar' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(callsTo(api, 'PUT', PUT_URL)).toEqual([]);
    expect(toggle().getAttribute('aria-checked')).toBe('false');
  });

  it('[Permissão] sem PROCESS_SET_CONFIDENTIAL_BUDGET: desabilitado com a dica', async () => {
    renderToggle(processDto({ isBudgetConfidential: true }), {}, ['PROCESS_VIEW']);
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    expect((toggle() as HTMLButtonElement).disabled).toBe(true);
    expect(
      await screen.findByText('Só o gestor ou a autoridade competente pode alterar'),
    ).toBeTruthy();
  });

  it('[Concorrência] 412 VERSION_CONFLICT: toast de conflito e o estado anterior é mantido', async () => {
    const user = userEvent.setup();
    renderToggle(processDto({ version: 1 }), {
      confidentiality: () =>
        problemResponse(412, 'VERSION_CONFLICT', { extension: { currentVersion: 2 } }),
    });
    await waitFor(() => {
      expect((toggle() as HTMLButtonElement).disabled).toBe(false);
    });
    await user.click(toggle());
    await user.click(await screen.findByRole('button', { name: 'Marcar como sigiloso' }));
    expect(
      await screen.findByText(
        'Este processo foi alterado por outra pessoa. Recarregue e tente novamente.',
      ),
    ).toBeTruthy();
    expect(toggle().getAttribute('aria-checked')).toBe('false');
  });

  it('[Falha de banco] 503: "Não foi possível salvar agora" e o estado anterior é mantido', async () => {
    const user = userEvent.setup();
    renderToggle(processDto({ version: 1 }), {
      confidentiality: () => problemResponse(503, 'DEPENDENCY_UNAVAILABLE'),
    });
    await waitFor(() => {
      expect((toggle() as HTMLButtonElement).disabled).toBe(false);
    });
    await user.click(toggle());
    await user.click(await screen.findByRole('button', { name: 'Marcar como sigiloso' }));
    expect(
      await screen.findByText('Não foi possível salvar agora. Tente novamente em instantes.'),
    ).toBeTruthy();
    expect(toggle().getAttribute('aria-checked')).toBe('false');
  });
});
