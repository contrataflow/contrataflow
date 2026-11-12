// @vitest-environment jsdom
import { Toaster, clearToasts } from '@contrataflow/ui';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeQueryClient } from '@/lib/query/query-client';
import { PROCESS_URL } from '@test/support/forward-fixtures';
import { callsTo, problemResponse } from '@test/support/process-fixtures';
import { jsonResponse, renderWithShell } from '@test/support/render';
import {
  RETURN_URL,
  STAGE_ABERTURA,
  STAGE_APROVACAO,
  mockReturnApi,
  returnEntry,
  returnedDto,
} from '@test/support/return-fixtures';
import type { ReturnApiOptions } from '@test/support/return-fixtures';

import { ReturnProcessDialog } from './return-process-dialog';

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

/* US-124 — devolução dentro de um ramo paralelo (PRC-20 com processStageId). */

const REASON = 'Faltou detalhar a justificativa da contratação no DFD';
const BRANCH_STAGE = '0192a000-0000-7000-8000-000000000777';

const branchEntry = returnEntry({ processStageId: BRANCH_STAGE, branchKey: 'JURIDICO' });
const otherBranchEntry = returnEntry({
  processStageId: '0192a000-0000-7000-8000-000000000888',
  branchKey: 'CONTROLE',
  toStageId: STAGE_APROVACAO,
  toStageName: 'Outra etapa',
});

function renderDialog(options: ReturnApiOptions) {
  const api = mockReturnApi(options);
  const client = makeQueryClient();
  client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retry: false } });
  renderWithShell(
    <>
      <ReturnProcessDialog
        processId={PROCESS_URL.split('/').at(-1) ?? ''}
        open
        onOpenChange={() => undefined}
        processStageId={BRANCH_STAGE}
        retry={{ retries: 0 }}
      />
      <Toaster />
    </>,
    { queryClient: client },
  );
  return api;
}

const posts = (api: ReturnType<typeof mockReturnApi>) => callsTo(api, 'POST', RETURN_URL);
const reasonField = () => screen.getByRole('textbox', { name: 'Motivo da devolução' });

describe('Devolução em ramo paralelo (US-124)', () => {
  it('[Validação] devolver antes do split sem confirmar: abre a confirmação e reenvia com confirmBranchCancellation, mantendo o comentário', async () => {
    const user = userEvent.setup();
    let attempt = 0;
    const api = renderDialog({
      actions: [branchEntry, otherBranchEntry],
      giveBack: () => {
        attempt += 1;
        return attempt === 1
          ? problemResponse(422, 'BRANCH_CANCELLATION_NOT_CONFIRMED')
          : jsonResponse({ data: returnedDto() }, { headers: { ETag: '"15"' } });
      },
    });
    await screen.findByRole('radio', { name: /Formalização da demanda/ });
    // Só as entradas do ramo escolhido viram destino.
    expect(screen.queryByRole('radio', { name: /Outra etapa/ })).toBeNull();
    await user.type(reasonField(), REASON);
    await user.click(screen.getByRole('button', { name: 'Devolver' }));

    const confirm = await screen.findByRole('alertdialog');
    expect(
      within(confirm).getByText(
        'Devolver nesta etapa cancela os outros ramos e as aprovações pendentes. Confirme para continuar.',
      ),
    ).toBeTruthy();
    await user.click(within(confirm).getByRole('button', { name: 'Confirmar devolução' }));

    await waitFor(() => {
      expect(posts(api)).toHaveLength(2);
    });
    const [first, second] = posts(api);
    const base = {
      targetStageId: STAGE_ABERTURA,
      comment: REASON,
      expectedStageId: BRANCH_STAGE,
      processStageId: BRANCH_STAGE,
    };
    expect(first?.body).toEqual(base);
    expect(second?.body).toEqual({ ...base, confirmBranchCancellation: true });
    expect(
      await screen.findByText('Ramo JURIDICO devolvido para Formalização da demanda'),
    ).toBeTruthy();
  });

  it('voltar na confirmação não reenvia e mantém o comentário', async () => {
    const user = userEvent.setup();
    const api = renderDialog({
      actions: [branchEntry],
      giveBack: () => problemResponse(422, 'BRANCH_CANCELLATION_NOT_CONFIRMED'),
    });
    await screen.findByRole('radio');
    await user.type(reasonField(), REASON);
    await user.click(screen.getByRole('button', { name: 'Devolver' }));
    const confirm = await screen.findByRole('alertdialog');
    await user.click(within(confirm).getByRole('button', { name: 'Voltar' }));
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    expect(posts(api)).toHaveLength(1);
    expect((reasonField() as HTMLTextAreaElement).value).toBe(REASON);
  });
});
