// @vitest-environment jsdom
import { Toaster, clearToasts } from '@contrataflow/ui';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeQueryClient } from '@/lib/query/query-client';
import {
  APPROVAL_ID,
  DIEGO,
  REASSIGN_URL,
  WITHDRAW_URL,
  approvalDto,
  approvalMeta,
  approvalResponse,
  mockApprovalApi,
  readOnlyMeta,
} from '@test/support/approval-fixtures';
import type { ApprovalApiOptions } from '@test/support/approval-fixtures';
import { seriousA11yViolations } from '@test/support/axe';
import { PROCESS_ID, callsTo, problemResponse } from '@test/support/process-fixtures';
import { TENANT_A, renderWithShell } from '@test/support/render';

import { ApprovalDetail } from './approval-detail';

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: navigation.push, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/aprovacoes',
  useSearchParams: () => new URLSearchParams(),
}));

beforeEach(() => {
  navigation.push.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

/*
 * US-053 · SCR-015 — "Retirar aprovação" (APV-04) e "Redirecionar aprovação" (APV-05) no detalhe da
 * aprovação: visíveis só com `WITHDRAW`/`REASSIGN` em `meta.allowedActions`, confirmação com o
 * efeito, motivo (opcional na retirada; ≥ 10 no redirecionamento), If-Match + Idempotency-Key,
 * invalidações e os "Casos de erro".
 */

const LEAVE = 'Carla está de licença médica';

const noRetryClient = () => {
  const client = makeQueryClient();
  client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retry: false } });
  return client;
};

function renderDetail(options: ApprovalApiOptions = {}) {
  const api = mockApprovalApi(options);
  const queryClient = noRetryClient();
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  renderWithShell(
    <>
      <ApprovalDetail approvalId={APPROVAL_ID} retry={{ retries: 0 }} />
      <Toaster />
    </>,
    { queryClient },
  );
  return { api, invalidate };
}

const requester = (data = approvalDto()) => ({
  approval: () =>
    approvalResponse(
      data,
      readOnlyMeta('NOT_DESIGNATED_APPROVER', { allowedActions: ['WITHDRAW'] }),
    ),
});
const manager = () => ({
  approval: () =>
    approvalResponse(
      approvalDto(),
      approvalMeta({ allowedActions: ['REASSIGN'], decisionOptions: [] }),
    ),
});

/** "Retirar"/"Redirecionar" ficam no menu "Mais ações" do cabeçalho (prd-5 · regra 1). */
async function openAction(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole('button', { name: 'Mais ações' }));
  await user.click(await screen.findByRole('menuitem', { name }));
}

describe('SCR-015 · Retirar aprovação (US-053)', () => {
  it('sem WITHDRAW/REASSIGN em allowedActions os botões não aparecem', async () => {
    renderDetail();
    await screen.findByRole('button', { name: 'Aprovar' });
    expect(screen.queryByRole('button', { name: 'Mais ações' })).toBeNull();
  });

  it('[Sucesso] explica o efeito, envia o APV-04 com If-Match/Idempotency-Key e o motivo, avisa, invalida e volta ao processo', async () => {
    const user = userEvent.setup();
    const { api, invalidate } = renderDetail(requester());

    await openAction(user, 'Retirar aprovação');
    const dialog = await screen.findByRole('dialog', { name: 'Retirar aprovação' });
    expect(
      within(dialog).getByText(
        'O processo voltará para a etapa anterior, sob sua responsabilidade. A aprovação pendente será cancelada.',
      ),
    ).toBeTruthy();
    const reason = within(dialog).getByRole('textbox', { name: 'Motivo da retirada (opcional)' });
    await waitFor(() => {
      expect(document.activeElement).toBe(reason);
    });
    expect(await seriousA11yViolations(dialog)).toEqual([]);
    await user.type(reason, 'Enviado antes da hora.');
    await user.click(within(dialog).getByRole('button', { name: 'Confirmar retirada' }));

    expect(
      await screen.findByText('Aprovação retirada. O processo voltou para você.'),
    ).toBeTruthy();
    const [call] = callsTo(api, 'POST', WITHDRAW_URL);
    expect(call?.body).toEqual({ reason: 'Enviado antes da hora.' });
    expect(call?.headers.get('If-Match')).toBe('"3"');
    expect(call?.headers.get('Idempotency-Key')).toBeTruthy();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['t', TENANT_A.id, 'approvals'] });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['t', TENANT_A.id, 'processes', PROCESS_ID],
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['t', TENANT_A.id, 'tasks'] });
    expect(navigation.push).toHaveBeenCalledWith(`/processos/${PROCESS_ID}`);
  });

  it('[FA-01] submissão avulsa: o documento voltará para rascunho; sem motivo, corpo vazio', async () => {
    const user = userEvent.setup();
    const { api } = renderDetail(
      requester(approvalDto({ subjectType: 'DOCUMENT', processStageId: null })),
    );

    await openAction(user, 'Retirar aprovação');
    const dialog = await screen.findByRole('dialog', { name: 'Retirar aprovação' });
    expect(
      within(dialog).getByText(
        'O documento voltará para rascunho. A aprovação pendente será cancelada.',
      ),
    ).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Confirmar retirada' }));

    expect(
      await screen.findByText('Aprovação retirada. O documento voltou para rascunho.'),
    ).toBeTruthy();
    expect(callsTo(api, 'POST', WITHDRAW_URL)[0]?.body).toEqual({});
  });

  it('[Concorrência] já decidida: fecha, explica na tela e recarrega a aprovação', async () => {
    const user = userEvent.setup();
    const { api } = renderDetail({
      ...requester(),
      withdraw: () => problemResponse(409, 'APPROVAL_NOT_PENDING'),
    });

    await openAction(user, 'Retirar aprovação');
    await user.click(await screen.findByRole('button', { name: 'Confirmar retirada' }));

    expect(await screen.findByText('Esta aprovação já foi decidida ou retirada.')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => {
      expect(callsTo(api, 'GET', `/api/v1/approvals/${APPROVAL_ID}`).length).toBeGreaterThan(1);
    });
  });

  it('[Falha de banco] 503: mantém o diálogo com "Tentar novamente"', async () => {
    const user = userEvent.setup();
    renderDetail({
      ...requester(),
      withdraw: () => problemResponse(503, 'DEPENDENCY_UNAVAILABLE'),
    });

    await openAction(user, 'Retirar aprovação');
    await user.click(await screen.findByRole('button', { name: 'Confirmar retirada' }));

    expect(
      await screen.findByText('Não foi possível concluir agora. Tente novamente.'),
    ).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Retirar aprovação' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Tentar novamente' })).toBeTruthy();
  });
});

describe('SCR-015 · Redirecionar aprovação (US-053 · FA-02)', () => {
  it('[Sucesso] busca o novo aprovador (debounce), exige o motivo e envia o APV-05', async () => {
    const user = userEvent.setup();
    const { api, invalidate } = renderDetail(manager());

    await openAction(user, 'Redirecionar aprovação');
    const dialog = await screen.findByRole('dialog', { name: 'Redirecionar aprovação' });
    const search = within(dialog).getByRole('searchbox', {
      name: 'Buscar pessoa por nome ou e-mail',
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(search);
    });
    await user.type(search, 'Die');
    await user.click(await within(dialog).findByRole('radio', { name: new RegExp(DIEGO.name) }));
    expect(await seriousA11yViolations(dialog)).toEqual([]);
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Motivo do redirecionamento' }),
      LEAVE,
    );
    await user.click(within(dialog).getByRole('button', { name: 'Confirmar redirecionamento' }));

    expect(await screen.findByText('Aprovação redirecionada.')).toBeTruthy();
    const [call] = callsTo(api, 'POST', REASSIGN_URL);
    expect(call?.body).toEqual({
      approverType: 'USER',
      targetApproverUserId: DIEGO.id,
      reason: LEAVE,
    });
    expect(call?.headers.get('If-Match')).toBe('"3"');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['t', TENANT_A.id, 'tasks'] });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('[Validação] sem novo aprovador e sem motivo: não envia e marca os campos', async () => {
    const user = userEvent.setup();
    const { api } = renderDetail(manager());

    await openAction(user, 'Redirecionar aprovação');
    const dialog = await screen.findByRole('dialog', { name: 'Redirecionar aprovação' });
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Motivo do redirecionamento' }),
      'curto',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Confirmar redirecionamento' }));

    expect(await within(dialog).findByText('Revise os campos destacados.')).toBeTruthy();
    expect(within(dialog).getByText('Selecione o novo aprovador.')).toBeTruthy();
    expect(
      within(dialog).getByText('Informe o motivo do redirecionamento (mín. 10 caracteres).'),
    ).toBeTruthy();
    expect(callsTo(api, 'POST', REASSIGN_URL)).toEqual([]);
  });

  it('[V-02] titular de outra unidade inelegível: 422 APPROVER_NOT_ELIGIBLE mantém o diálogo e recarrega a lista', async () => {
    const user = userEvent.setup();
    const { api } = renderDetail({
      ...manager(),
      reassign: () => problemResponse(422, 'APPROVER_NOT_ELIGIBLE'),
    });

    await openAction(user, 'Redirecionar aprovação');
    const dialog = await screen.findByRole('dialog', { name: 'Redirecionar aprovação' });
    await user.click(within(dialog).getByRole('radio', { name: 'O titular de uma unidade' }));
    await user.type(
      within(dialog).getByRole('searchbox', { name: 'Buscar unidade pelo nome' }),
      'Saú',
    );
    await user.click(await within(dialog).findByRole('radio', { name: 'Secretaria de Saúde' }));
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Motivo do redirecionamento' }),
      LEAVE,
    );
    await user.click(within(dialog).getByRole('button', { name: 'Confirmar redirecionamento' }));

    expect(
      await within(dialog).findByText('Selecione um aprovador diferente e elegível.'),
    ).toBeTruthy();
    expect(callsTo(api, 'POST', REASSIGN_URL)[0]?.body).toMatchObject({
      approverType: 'DEPARTMENT_HEAD',
    });
    expect(
      within(dialog)
        .getByRole('radio', { name: 'Secretaria de Saúde' })
        .getAttribute('aria-checked') === 'true',
    ).toBe(false);
  });
});
