// @vitest-environment jsdom
import { Toaster, clearToasts } from '@contrataflow/ui';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeQueryClient } from '@/lib/query/query-client';
import {
  APPROVAL_ID,
  APPROVAL_URL,
  CARLA,
  DECIDE_URL,
  DOC_ETP,
  RULE_PARECER,
  RULE_RISCOS,
  T_APROVAR,
  T_DEVOLVER_ABERTURA,
  VERSION_ETP,
  approvalDto,
  approvalMeta,
  approvalResponse,
  decidedApprovalDto,
  decidedDto,
  decisionOption,
  mockApprovalApi,
  readOnlyMeta,
  rejectOption,
  returnOption,
  secondReturnOption,
  transitionRule,
} from '@test/support/approval-fixtures';
import type { ApprovalApiOptions } from '@test/support/approval-fixtures';
import { seriousA11yViolations } from '@test/support/axe';
import { PROCESS_ID, callsTo, problemResponse } from '@test/support/process-fixtures';
import { TENANT_A, jsonResponse, renderWithShell } from '@test/support/render';

import { ApprovalDetail } from './approval-detail';
import type { ApprovalDetailProps } from './approval-detail';

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

const REASON = 'Faltou detalhar a justificativa da contratação no ETP';
const WARNING = transitionRule(RULE_RISCOS, 'WARNING', 'O mapa de riscos não foi atualizado.');
const BLOCKING = transitionRule(RULE_PARECER, 'BLOCKING', 'Falta o parecer jurídico.');

const noRetryClient = () => {
  const client = makeQueryClient();
  client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retry: false } });
  return client;
};

function renderDetail(options: ApprovalApiOptions = {}, props: Partial<ApprovalDetailProps> = {}) {
  const api = mockApprovalApi(options);
  const queryClient = noRetryClient();
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  const { unmount } = renderWithShell(
    <>
      <ApprovalDetail approvalId={APPROVAL_ID} retry={{ retries: 0 }} {...props} />
      <Toaster />
    </>,
    { queryClient },
  );
  return { api, invalidate, unmount };
}

const posts = (api: ReturnType<typeof mockApprovalApi>) => callsTo(api, 'POST', DECIDE_URL);
const gets = (api: ReturnType<typeof mockApprovalApi>) => callsTo(api, 'GET', APPROVAL_URL);
const approveButton = () => screen.findByRole('button', { name: 'Aprovar' });
const returnButton = () => screen.findByRole('button', { name: 'Devolver para ajuste' });
const rejectButton = () => screen.findByRole('button', { name: 'Indeferir' });
const commentField = () => screen.getByRole('textbox', { name: /Comentário/ });
const confirm = (name: string) => screen.getByRole('button', { name });

const withMeta = (meta: ReturnType<typeof approvalMeta>, data = approvalDto()) => ({
  approval: () => approvalResponse(data, meta),
});

describe('SCR-015 · Detalhe da aprovação (US-052)', () => {
  it('mostra o esqueleto durante a carga e depois título, situação, solicitante, prazo, comentário e documentos com a versão analisada', async () => {
    renderDetail();
    expect(screen.getByText('Carregando a aprovação…')).toBeTruthy();

    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: 'Aprovação do ETP e do Termo de Referência',
      }),
    ).toBeTruthy();
    expect(screen.getByText('Pendente')).toBeTruthy();
    expect(screen.getByText('Marcos Vinícius Rocha')).toBeTruthy();
    expect(screen.getByText(/14\/10\/2026/)).toBeTruthy();
    expect(screen.getByText(/20\/10\/2026/)).toBeTruthy();
    expect(screen.getByText('Seguem o ETP e o TR para a sua análise.')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Processo 0012\/2026/ }).getAttribute('href')).toBe(
      `/processos/${PROCESS_ID}`,
    );

    const documents = screen.getByRole('region', { name: 'Documentos cobertos' });
    expect(within(documents).getByText('2 documentos')).toBeTruthy();
    const etp = within(documents).getByRole('link', {
      name: 'Abrir a versão analisada de ETP — cimento',
    });
    expect(etp.getAttribute('href')).toBe(
      `/processos/${PROCESS_ID}/documentos/${DOC_ETP}?versao=${VERSION_ETP}`,
    );
    expect(within(documents).getByText('v2')).toBeTruthy();
    expect(within(documents).getByText('v1')).toBeTruthy();
    expect(within(documents).getByText(/ETP 0003\/2026 · Estudo Técnico Preliminar/)).toBeTruthy();
    expect(within(documents).getByText(/Sem código · Termo de Referência/)).toBeTruthy();

    // Os três botões de decisão, nenhum pressionado.
    for (const button of [await approveButton(), await returnButton(), await rejectButton()]) {
      expect(button.getAttribute('aria-pressed')).toBe('false');
    }
  });

  it('[Sucesso] aprovar: envia o APV-03 com If-Match e Idempotency-Key, avisa, invalida as consultas e volta ao processo', async () => {
    const user = userEvent.setup();
    const { api, invalidate } = renderDetail();
    const approve = await approveButton();
    await user.click(approve);
    expect(approve.getAttribute('aria-pressed')).toBe('true');
    await user.click(confirm('Confirmar aprovação'));

    await waitFor(() => {
      expect(posts(api)).toHaveLength(1);
    });
    const [call] = posts(api);
    expect(call?.headers.get('If-Match')).toBe('"3"');
    expect(call?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(call?.body).toEqual({ decision: 'APPROVE', transitionId: T_APROVAR });

    expect(await screen.findByText('Aprovação decidida: Aprovada.')).toBeTruthy();
    await waitFor(() => {
      expect(navigation.push).toHaveBeenCalledWith(`/processos/${PROCESS_ID}`);
    });
    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(keys).toEqual(
      expect.arrayContaining([
        ['t', TENANT_A.id, 'approvals'],
        ['t', TENANT_A.id, 'processes', PROCESS_ID],
        ['t', TENANT_A.id, 'tasks'],
      ]),
    );
  });

  it('o comentário opcional da aprovação vai sem espaços nas pontas', async () => {
    const user = userEvent.setup();
    const { api } = renderDetail();
    await user.click(await approveButton());
    await user.type(commentField(), '  De acordo com o parecer.  ');
    await user.click(confirm('Confirmar aprovação'));
    await waitFor(() => {
      expect(posts(api)).toHaveLength(1);
    });
    expect(posts(api)[0]?.body).toMatchObject({
      decision: 'APPROVE',
      comment: 'De acordo com o parecer.',
    });
  });

  it('[Validação] devolver sem comentário: mostra "Informe o motivo (mín. 10 caracteres).", foca o campo e não chama a API', async () => {
    const user = userEvent.setup();
    const { api } = renderDetail();
    await user.click(await returnButton());
    await user.click(confirm('Confirmar devolução'));

    expect(await screen.findByText('Informe o motivo (mín. 10 caracteres).')).toBeTruthy();
    expect(screen.getByText('Revise os campos destacados.')).toBeTruthy();
    expect(commentField().getAttribute('aria-invalid')).toBe('true');
    await waitFor(() => {
      expect(document.activeElement).toBe(commentField());
    });
    expect(posts(api)).toHaveLength(0);

    // Corrigido o motivo, o erro some e a devolução segue com o transitionId da etapa.
    await user.type(commentField(), REASON);
    expect(screen.queryByText('Informe o motivo (mín. 10 caracteres).')).toBeNull();
    await user.click(confirm('Confirmar devolução'));
    await waitFor(() => {
      expect(posts(api)).toHaveLength(1);
    });
    expect(posts(api)[0]?.body).toMatchObject({ decision: 'RETURN', comment: REASON });
    expect(await screen.findByText('Aprovação decidida: Aprovada.')).toBeTruthy();
  });

  it('indeferir também exige o motivo; sem decisão escolhida pede "Selecione uma decisão."', async () => {
    const user = userEvent.setup();
    const { api } = renderDetail();
    await approveButton();
    await user.click(confirm('Confirmar decisão'));
    expect(await screen.findByText('Selecione uma decisão.')).toBeTruthy();
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Aprovar' }));
    });

    await user.click(await rejectButton());
    expect(screen.queryByText('Selecione uma decisão.')).toBeNull();
    await user.click(confirm('Confirmar indeferimento'));
    expect(await screen.findByText('Informe o motivo (mín. 10 caracteres).')).toBeTruthy();
    expect(posts(api)).toHaveLength(0);
  });

  it('422 VALIDATION_ERROR do servidor marca o campo e o foca', async () => {
    const user = userEvent.setup();
    renderDetail({
      decide: () =>
        problemResponse(422, 'VALIDATION_ERROR', {
          errors: [
            {
              field: 'comment',
              code: 'TOO_SHORT',
              message: 'Informe o motivo (mín. 10 caracteres).',
            },
          ],
        }),
    });
    await user.click(await returnButton());
    await user.type(commentField(), REASON);
    await user.click(confirm('Confirmar devolução'));

    expect(await screen.findByText('Informe o motivo (mín. 10 caracteres).')).toBeTruthy();
    expect(screen.getByText('Revise os campos destacados.')).toBeTruthy();
    expect(commentField().getAttribute('aria-invalid')).toBe('true');
    await waitFor(() => {
      expect(document.activeElement).toBe(commentField());
    });
  });

  it('[Avisos] WARNING exige "Estou ciente e desejo continuar" antes de habilitar a confirmação e envia o ruleId', async () => {
    const user = userEvent.setup();
    const { api } = renderDetail(
      withMeta(
        approvalMeta({
          decisionOptions: [
            decisionOption({ violations: [WARNING] }),
            returnOption(),
            rejectOption(),
          ],
        }),
      ),
    );
    await user.click(await approveButton());

    expect(screen.getByText('O mapa de riscos não foi atualizado.')).toBeTruthy();
    const confirmButton = confirm('Confirmar aprovação') as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);
    expect(
      screen.getByText('Marque a ciência de todos os avisos para poder confirmar.'),
    ).toBeTruthy();

    await user.click(screen.getByRole('checkbox', { name: 'Estou ciente e desejo continuar' }));
    expect(confirmButton.disabled).toBe(false);
    await user.click(confirmButton);
    await waitFor(() => {
      expect(posts(api)).toHaveLength(1);
    });
    expect(posts(api)[0]?.body).toEqual({
      decision: 'APPROVE',
      transitionId: T_APROVAR,
      acknowledgedWarnings: [RULE_RISCOS],
    });
  });

  it('a ciência dos avisos vale só para a opção: trocar de decisão a zera', async () => {
    const user = userEvent.setup();
    renderDetail(
      withMeta(
        approvalMeta({
          decisionOptions: [
            decisionOption({ violations: [WARNING] }),
            returnOption({ violations: [WARNING] }),
            rejectOption(),
          ],
        }),
      ),
    );
    await user.click(await approveButton());
    await user.click(screen.getByRole('checkbox', { name: 'Estou ciente e desejo continuar' }));
    await user.click(await returnButton());
    const checkbox = screen.getByRole('checkbox', { name: 'Estou ciente e desejo continuar' });
    expect(checkbox.getAttribute('aria-checked')).toBe('false');
    expect((confirm('Confirmar devolução') as HTMLButtonElement).disabled).toBe(true);
  });

  it('422 WARNINGS_NOT_ACKNOWLEDGED: avisa, relê a aprovação e mostra os avisos novos', async () => {
    const user = userEvent.setup();
    let reads = 0;
    const { api } = renderDetail({
      approval: () => {
        reads += 1;
        return approvalResponse(
          approvalDto(),
          reads === 1
            ? approvalMeta()
            : approvalMeta({
                decisionOptions: [
                  decisionOption({ violations: [WARNING] }),
                  returnOption(),
                  rejectOption(),
                ],
              }),
        );
      },
      decide: () => problemResponse(422, 'WARNINGS_NOT_ACKNOWLEDGED'),
    });
    await user.click(await approveButton());
    await user.click(confirm('Confirmar aprovação'));
    expect(
      (await screen.findAllByText('Confirme que está ciente dos avisos para continuar.')).length,
    ).toBeGreaterThan(0);
    expect(await screen.findByText('O mapa de riscos não foi atualizado.')).toBeTruthy();
    expect(gets(api)).toHaveLength(2);
    expect((confirm('Confirmar aprovação') as HTMLButtonElement).disabled).toBe(true);
  });

  it('[Regra bloqueante] a decisão fica desabilitada com a mensagem da regra', async () => {
    const { api } = renderDetail(
      withMeta(
        approvalMeta({
          decisionOptions: [
            decisionOption({ violations: [BLOCKING] }),
            returnOption(),
            rejectOption(),
          ],
        }),
      ),
    );
    const approve = (await approveButton()) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(
      screen.getByText('Não é possível concluir esta decisão agora: Falta o parecer jurídico.'),
    ).toBeTruthy();
    expect(((await returnButton()) as HTMLButtonElement).disabled).toBe(false);
    expect(posts(api)).toHaveLength(0);
  });

  it('[Devolução] várias etapas: pede o destino e envia o transitionId escolhido', async () => {
    const user = userEvent.setup();
    const { api } = renderDetail(
      withMeta(
        approvalMeta({
          decisionOptions: [decisionOption(), returnOption(), secondReturnOption(), rejectOption()],
        }),
      ),
    );
    await user.click(await returnButton());
    const group = screen.getByRole('group', { name: 'Etapa de destino' });
    const radios = within(group).getAllByRole('radio');
    expect(radios).toHaveLength(2);
    expect(within(group).getByText('ETP e mapa de riscos')).toBeTruthy();

    await user.type(commentField(), REASON);
    await user.click(confirm('Confirmar devolução'));
    expect(
      await screen.findByText('Escolha a etapa para a qual o processo será devolvido.'),
    ).toBeTruthy();
    await waitFor(() => {
      expect(document.activeElement).toBe(radios[0]);
    });
    expect(posts(api)).toHaveLength(0);

    await user.click(within(group).getByRole('radio', { name: 'Formalização da demanda' }));
    expect(screen.queryByText('Escolha a etapa para a qual o processo será devolvido.')).toBeNull();
    await user.click(confirm('Confirmar devolução'));
    await waitFor(() => {
      expect(posts(api)).toHaveLength(1);
    });
    expect(posts(api)[0]?.body).toEqual({
      decision: 'RETURN',
      comment: REASON,
      transitionId: T_DEVOLVER_ABERTURA,
    });
  });

  it('[Permissão] não designado: o painel some e a tela explica o motivo', async () => {
    renderDetail(withMeta(readOnlyMeta('NOT_DESIGNATED_APPROVER')));
    expect(await screen.findByText('Você não pode decidir esta aprovação.')).toBeTruthy();
    expect(
      screen.getByText('Você não é o aprovador designado nem o substituto desta aprovação.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Aprovar' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Devolver para ajuste' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Indeferir' })).toBeNull();
    // Os documentos continuam visíveis para a consulta.
    expect(screen.getByRole('region', { name: 'Documentos cobertos' })).toBeTruthy();
  });

  it('[Permissão] autor do documento: explica a segregação de funções', async () => {
    renderDetail(withMeta(readOnlyMeta('SELF_APPROVAL_FORBIDDEN')));
    expect(await screen.findByText('Você não pode decidir esta aprovação.')).toBeTruthy();
    expect(screen.getByText(/segregação de funções/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Aprovar' })).toBeNull();
  });

  it('aprovação já decidida: mostra a decisão registrada (decisor, data, substituto e comentário), sem o painel', async () => {
    renderDetail(
      withMeta(
        readOnlyMeta('NOT_PENDING'),
        decidedApprovalDto({ decidedAsDeputy: true, allowDeputy: true }),
      ),
    );
    const record = await screen.findByRole('region', { name: 'Decisão registrada' });
    expect(within(record).getByText('Aprovada')).toBeTruthy();
    expect(within(record).getByText(`${CARLA.name}, como substituto`)).toBeTruthy();
    expect(within(record).getByText(/15\/10\/2026/)).toBeTruthy();
    expect(within(record).getByText('De acordo com o parecer jurídico.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Aprovar' })).toBeNull();
    // Decidida: o aviso do substituto não faz mais sentido.
    expect(
      screen.queryByText('O substituto do aprovador também pode decidir esta aprovação.'),
    ).toBeNull();
  });

  it('aprovação cancelada: avisa que não pode mais ser decidida', async () => {
    renderDetail(
      withMeta(readOnlyMeta('NOT_PENDING'), approvalDto({ status: 'CANCELED', version: 5 })),
    );
    expect(
      await screen.findByText('Esta aprovação foi cancelada e não pode mais ser decidida.'),
    ).toBeTruthy();
    expect(screen.getByText('Cancelada')).toBeTruthy();
  });

  it('FA-02: avisa que o substituto também pode decidir e quando você decide como substituto', async () => {
    renderDetail(
      withMeta(approvalMeta({ decidesAsDeputy: true }), approvalDto({ allowDeputy: true })),
    );
    expect(
      await screen.findByText('O substituto do aprovador também pode decidir esta aprovação.'),
    ).toBeTruthy();
    expect(screen.getByText('Você decide esta aprovação como substituto.')).toBeTruthy();
  });

  it('[Concorrência] 409 APPROVAL_NOT_PENDING: avisa, relê a aprovação e mostra a decisão registrada', async () => {
    const user = userEvent.setup();
    let decided = false;
    const { api } = renderDetail({
      approval: () =>
        decided
          ? approvalResponse(
              decidedApprovalDto({ decidedBy: { id: CARLA.id, name: 'Diego Lima' } }),
              readOnlyMeta('NOT_PENDING'),
            )
          : approvalResponse(approvalDto(), approvalMeta()),
      decide: () => {
        decided = true;
        return problemResponse(409, 'APPROVAL_NOT_PENDING');
      },
    });
    await user.click(await approveButton());
    await user.click(confirm('Confirmar aprovação'));

    expect(await screen.findByText('Esta aprovação já foi decidida.')).toBeTruthy();
    const record = await screen.findByRole('region', { name: 'Decisão registrada' });
    expect(within(record).getByText('Diego Lima')).toBeTruthy();
    expect(gets(api)).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Confirmar aprovação' })).toBeNull();
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it('412 VERSION_CONFLICT: avisa, relê e mantém o formulário para confirmar de novo com a versão nova', async () => {
    const user = userEvent.setup();
    let reads = 0;
    let attempts = 0;
    const { api } = renderDetail({
      approval: () => {
        reads += 1;
        return approvalResponse(approvalDto({ version: reads === 1 ? 3 : 4 }), approvalMeta());
      },
      decide: () => {
        attempts += 1;
        return attempts === 1
          ? problemResponse(412, 'VERSION_CONFLICT')
          : jsonResponse({ data: decidedDto() });
      },
    });
    await user.click(await returnButton());
    await user.type(commentField(), REASON);
    await user.click(confirm('Confirmar devolução'));

    expect(
      await screen.findByText(/Esta aprovação foi atualizada por outra pessoa\./),
    ).toBeTruthy();
    await waitFor(() => {
      expect(gets(api)).toHaveLength(2);
    });
    expect((commentField() as HTMLTextAreaElement).value).toBe(REASON);

    await user.click(confirm('Confirmar devolução'));
    await waitFor(() => {
      expect(posts(api)).toHaveLength(2);
    });
    expect(posts(api)[0]?.headers.get('If-Match')).toBe('"3"');
    expect(posts(api)[1]?.headers.get('If-Match')).toBe('"4"');
    await waitFor(() => {
      expect(navigation.push).toHaveBeenCalledWith(`/processos/${PROCESS_ID}`);
    });
  });

  it('403 NOT_DESIGNATED_APPROVER na decisão: avisa e esconde as ações depois de reler', async () => {
    const user = userEvent.setup();
    let denied = false;
    renderDetail({
      approval: () =>
        approvalResponse(
          approvalDto(),
          denied ? readOnlyMeta('NOT_DESIGNATED_APPROVER') : approvalMeta(),
        ),
      decide: () => {
        denied = true;
        return problemResponse(403, 'NOT_DESIGNATED_APPROVER');
      },
    });
    await user.click(await approveButton());
    await user.click(confirm('Confirmar aprovação'));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Aprovar' })).toBeNull();
    });
    expect(screen.getAllByText('Você não pode decidir esta aprovação.').length).toBeGreaterThan(0);
    expect(
      screen.getByText('Você não é o aprovador designado nem o substituto desta aprovação.'),
    ).toBeTruthy();
  });

  it('[Falha de banco] 503: mantém o formulário com "Tentar novamente", que reenvia', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const { api } = renderDetail({
      decide: () => {
        calls += 1;
        return calls === 1
          ? problemResponse(503, 'DEPENDENCY_UNAVAILABLE')
          : jsonResponse({ data: decidedDto() });
      },
    });
    await user.click(await returnButton());
    await user.type(commentField(), REASON);
    await user.click(confirm('Confirmar devolução'));
    expect(
      await screen.findByText('Não foi possível registrar a decisão agora. Tente novamente.'),
    ).toBeTruthy();
    expect((commentField() as HTMLTextAreaElement).value).toBe(REASON);
    expect(navigation.push).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    await waitFor(() => {
      expect(posts(api)).toHaveLength(2);
    });
    await waitFor(() => {
      expect(navigation.push).toHaveBeenCalledWith(`/processos/${PROCESS_ID}`);
    });
  });

  it('422 APPROVER_UNRESOLVED e TRANSITION_BLOCKED: mantêm a decisão pendente com a mensagem', async () => {
    const user = userEvent.setup();
    let calls = 0;
    renderDetail({
      decide: () => {
        calls += 1;
        if (calls === 1) return problemResponse(422, 'APPROVER_UNRESOLVED');
        return new Response(
          JSON.stringify({
            type: 'https://docs.contrataflow.com.br/errors/transition-blocked',
            title: 'TRANSITION_BLOCKED',
            status: 422,
            detail: 'TRANSITION_BLOCKED',
            instance: '/api/v1/approvals',
            code: 'TRANSITION_BLOCKED',
            correlationId: 'c-52',
            errors: [],
            violations: [
              {
                code: 'WORKFLOW_RULE',
                severity: 'BLOCKING',
                message: 'Falta o parecer jurídico.',
                ruleId: RULE_PARECER,
                sectionKey: null,
                field: null,
                itemId: null,
                params: { documentTypeCode: 'ETP' },
              },
            ],
          }),
          { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
        );
      },
    });
    await user.click(await approveButton());
    await user.click(confirm('Confirmar aprovação'));
    expect(
      await screen.findByText(
        'Não foi possível determinar quem deve aprovar a próxima etapa. Contate o administrador.',
      ),
    ).toBeTruthy();

    await user.click(confirm('Confirmar aprovação'));
    expect(await screen.findByText('Não é possível concluir esta decisão agora.')).toBeTruthy();
    expect(screen.getByText(/Falta o parecer jurídico\./)).toBeTruthy();
    const alert = screen.getByRole('alert');
    expect(within(alert).getByRole('link', { name: 'Abrir documento' }).getAttribute('href')).toBe(
      `/processos/${PROCESS_ID}/documentos/${DOC_ETP}`,
    );
  });

  it('500: mostra o código de correlação com "Copiar código"', async () => {
    const user = userEvent.setup();
    renderDetail({
      decide: () => problemResponse(500, 'INTERNAL_ERROR', { correlationId: 'corr-52' }),
    });
    await user.click(await approveButton());
    await user.click(confirm('Confirmar aprovação'));
    expect(await screen.findByText('Ocorreu um erro inesperado. Código: corr-52.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copiar código' })).toBeTruthy();
  });

  it('durante o envio o botão fica desabilitado e um segundo clique não reenvia', async () => {
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { api } = renderDetail({
      decide: async () => {
        await gate;
        return jsonResponse({ data: decidedDto() });
      },
    });
    await user.click(await approveButton());
    await user.click(confirm('Confirmar aprovação'));
    const sending = await screen.findByRole('button', { name: 'Registrando a decisão…' });
    expect(sending.getAttribute('aria-disabled')).toBe('true');
    await user.click(sending);
    await user.click(await approveButton());
    expect(posts(api)).toHaveLength(1);

    release();
    expect(await screen.findByText('Aprovação decidida: Aprovada.')).toBeTruthy();
    expect(posts(api)).toHaveLength(1);
  });

  it('404 na carga: "Não encontramos a aprovação solicitada."', async () => {
    renderDetail({ approval: () => problemResponse(404, 'APPROVAL_NOT_FOUND') });
    expect(await screen.findByText('Não encontramos a aprovação solicitada.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Voltar para as aprovações' })).toBeTruthy();
  });

  it('erro de carga: mensagem com código e "Tentar novamente" que lê de novo', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const { api } = renderDetail({
      approval: () => {
        calls += 1;
        return calls === 1
          ? problemResponse(503, 'DEPENDENCY_UNAVAILABLE', { correlationId: 'corr-load' })
          : approvalResponse(approvalDto(), approvalMeta());
      },
    });
    expect(await screen.findByText('Não foi possível carregar a aprovação agora.')).toBeTruthy();
    expect(screen.getByText('Código: corr-load.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await approveButton()).toBeTruthy();
    expect(gets(api)).toHaveLength(2);
  });

  it('[Acessibilidade] axe sem violações sérias: carregado, com avisos/erros e sem permissão', async () => {
    const user = userEvent.setup();
    const { unmount } = renderDetail(
      withMeta(
        approvalMeta({
          decisionOptions: [
            decisionOption({ violations: [WARNING] }),
            returnOption(),
            secondReturnOption(),
            rejectOption({ violations: [BLOCKING] }),
          ],
        }),
      ),
    );
    await approveButton();
    expect(await seriousA11yViolations()).toEqual([]);

    await user.click(await returnButton());
    await user.click(confirm('Confirmar devolução'));
    await screen.findByText('Informe o motivo (mín. 10 caracteres).');
    expect(screen.getByText('Escolha a etapa para a qual o processo será devolvido.')).toBeTruthy();
    expect(await seriousA11yViolations()).toEqual([]);
    unmount();

    renderDetail(withMeta(readOnlyMeta('SELF_APPROVAL_FORBIDDEN')));
    await screen.findAllByText('Você não pode decidir esta aprovação.');
    expect(await seriousA11yViolations()).toEqual([]);
  });
});
