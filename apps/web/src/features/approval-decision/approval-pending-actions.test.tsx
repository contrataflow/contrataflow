// @vitest-environment jsdom
import { Toaster, clearToasts } from '@contrataflow/ui';
import type { ApprovalApproverDto } from '@contrataflow/validation';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeQueryClient } from '@/lib/query/query-client';
import {
  APPROVAL_ID,
  APPROVAL_URL,
  DIEGO,
  REASSIGN_URL,
  WITHDRAW_URL,
  approvalDto,
  approvalMeta,
  approvalResponse,
  mockApprovalApi,
  readOnlyMeta,
  reassignLineUrl,
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
      await screen.findByText('Aprovação retirada. O processo voltou para a etapa anterior.'),
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

/*
 * US-135 · SCR-015 — aprovação com várias linhas: "Redirecionar linha N" por linha ainda não
 * decidida (APV-06, If-Match da linha), toast com o novo aprovador, erros por linha e a retirada que
 * explica que os votos ficam no histórico.
 */
const ID_LINE = (n: number) => `0192f135-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const multiLine = (
  status: { readonly second: ApprovalApproverDto['status'] } = { second: 'PENDING' },
): ApprovalApproverDto[] => {
  const base = approvalDto().approvers[0];
  if (!base) throw new Error('linha base ausente');
  return [
    {
      ...base,
      id: ID_LINE(1),
      sequence: 1,
      status: 'APPROVED',
      label: 'Roberto Lima',
      decision: 'APPROVE',
      version: 2,
    },
    {
      ...base,
      id: ID_LINE(2),
      sequence: 2,
      status: status.second,
      label: 'Marcos Prado',
      version: 3,
    },
    {
      ...base,
      id: ID_LINE(3),
      sequence: 3,
      status: 'WAITING',
      label: 'Autoridade competente',
      activatedAt: null,
      version: 1,
    },
  ];
};
const multiApproval = () =>
  approvalDto({ decisionPolicy: 'SEQUENTIAL', approvers: multiLine(), version: 5 });
const multiManager = () => ({
  approval: () =>
    approvalResponse(
      multiApproval(),
      approvalMeta({ allowedActions: ['WITHDRAW', 'REASSIGN'], decisionOptions: [] }),
    ),
});

describe('SCR-015 · Redirecionar linha e retirar aprovação múltipla (US-135)', () => {
  it('[Sucesso] um item por linha não decidida; envia o APV-06 com o If-Match da linha e avisa o novo aprovador', async () => {
    const user = userEvent.setup();
    const second = multiLine()[1];
    if (!second) throw new Error('linha 2 ausente');
    const created = { ...second, id: ID_LINE(4), label: DIEGO.name, version: 1 };
    const { api, invalidate } = renderDetail({
      ...multiManager(),
      reassignLine: () =>
        new Response(
          JSON.stringify({
            data: approvalDto({
              decisionPolicy: 'SEQUENTIAL',
              approvers: [...multiLine(), created],
              version: 6,
            }),
            meta: { newApproverId: created.id },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json', ETag: '"6"' } },
        ),
    });

    await user.click(await screen.findByRole('button', { name: 'Mais ações' }));
    const items = (await screen.findAllByRole('menuitem')).map((item) => item.textContent);
    expect(items).toEqual([
      'Retirar aprovação',
      'Redirecionar linha 2 — Marcos Prado',
      'Redirecionar linha 3 — Autoridade competente',
    ]);
    await user.click(screen.getByRole('menuitem', { name: 'Redirecionar linha 2 — Marcos Prado' }));
    const dialog = await screen.findByRole('dialog', { name: 'Redirecionar linha 2' });
    expect(
      within(dialog).getByText(
        'Escolha quem decide esta linha no lugar de Marcos Prado. Os votos já dados, a ordem e o prazo são mantidos.',
      ),
    ).toBeTruthy();
    expect(await seriousA11yViolations(dialog)).toEqual([]);
    await user.type(
      within(dialog).getByRole('searchbox', { name: 'Buscar pessoa por nome ou e-mail' }),
      'Die',
    );
    await user.click(await within(dialog).findByRole('radio', { name: new RegExp(DIEGO.name) }));
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Motivo do redirecionamento' }),
      LEAVE,
    );
    await user.click(within(dialog).getByRole('button', { name: 'Confirmar redirecionamento' }));

    expect(await screen.findByText(`Linha redirecionada para ${DIEGO.name}.`)).toBeTruthy();
    const [call] = callsTo(api, 'POST', reassignLineUrl(ID_LINE(2)));
    expect(call?.body).toEqual({
      approverType: 'USER',
      targetApproverUserId: DIEGO.id,
      reason: LEAVE,
    });
    expect(call?.headers.get('If-Match')).toBe('"3"');
    expect(call?.headers.get('Idempotency-Key')).toBeTruthy();
    expect(callsTo(api, 'POST', REASSIGN_URL)).toEqual([]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['t', TENANT_A.id, 'tasks'] });
  });

  it('[Validação] pessoa de outra linha: 422 APPROVER_DUPLICATED mantém o diálogo', async () => {
    const user = userEvent.setup();
    renderDetail({
      ...multiManager(),
      reassignLine: () => problemResponse(422, 'APPROVER_DUPLICATED'),
    });

    await openAction(user, 'Redirecionar linha 2 — Marcos Prado');
    const dialog = await screen.findByRole('dialog', { name: 'Redirecionar linha 2' });
    await user.type(
      within(dialog).getByRole('searchbox', { name: 'Buscar pessoa por nome ou e-mail' }),
      'Die',
    );
    await user.click(await within(dialog).findByRole('radio', { name: new RegExp(DIEGO.name) }));
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Motivo do redirecionamento' }),
      LEAVE,
    );
    await user.click(within(dialog).getByRole('button', { name: 'Confirmar redirecionamento' }));

    expect(
      await within(dialog).findByText('Esta pessoa já participa desta aprovação em outra linha.'),
    ).toBeTruthy();
  });

  it('[Concorrência] linha decidida no meio do caminho: 409 APPROVAL_LINE_NOT_PENDING fecha, explica e recarrega', async () => {
    const user = userEvent.setup();
    const { api } = renderDetail({
      ...multiManager(),
      reassignLine: () => problemResponse(409, 'APPROVAL_LINE_NOT_PENDING'),
    });

    await openAction(user, 'Redirecionar linha 2 — Marcos Prado');
    const dialog = await screen.findByRole('dialog', { name: 'Redirecionar linha 2' });
    await user.type(
      within(dialog).getByRole('searchbox', { name: 'Buscar pessoa por nome ou e-mail' }),
      'Die',
    );
    await user.click(await within(dialog).findByRole('radio', { name: new RegExp(DIEGO.name) }));
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Motivo do redirecionamento' }),
      LEAVE,
    );
    const reads = callsTo(api, 'GET', APPROVAL_URL).length;
    await user.click(within(dialog).getByRole('button', { name: 'Confirmar redirecionamento' }));

    expect(
      await screen.findByText('Esta linha já foi decidida e não pode ser redirecionada.'),
    ).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => {
      expect(callsTo(api, 'GET', APPROVAL_URL).length).toBeGreaterThan(reads);
    });
  });

  it('[Sucesso] a retirada explica que os votos ficam no histórico e usa o If-Match da aprovação', async () => {
    const user = userEvent.setup();
    const { api } = renderDetail(multiManager());

    await openAction(user, 'Retirar aprovação');
    const dialog = await screen.findByRole('dialog', { name: 'Retirar aprovação' });
    expect(
      within(dialog).getByText(
        'A aprovação inteira será cancelada. Os votos já dados ficam no histórico e o processo voltará para a etapa anterior. Será preciso solicitar a aprovação de novo.',
      ),
    ).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Confirmar retirada' }));

    expect(
      await screen.findByText('Aprovação retirada. O processo voltou para a etapa anterior.'),
    ).toBeTruthy();
    expect(callsTo(api, 'POST', WITHDRAW_URL)[0]?.headers.get('If-Match')).toBe('"5"');
  });
});
