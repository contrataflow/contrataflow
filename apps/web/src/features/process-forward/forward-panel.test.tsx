// @vitest-environment jsdom
import { Toaster, clearToasts } from '@contrataflow/ui';
import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeQueryClient } from '@/lib/query/query-client';
import { seriousA11yViolations } from '@test/support/axe';
import {
  COMPRAS,
  DOC_DFD,
  DOC_ETP,
  FORWARD_URL,
  LICITACOES,
  PROCESS_URL,
  RULE_ETP_FORWARD,
  RULE_RISK_FORWARD,
  STAGE_ID,
  T_OUTRA,
  T_PESQUISA,
  approvalEntry,
  checklistRule,
  defaultDocuments,
  documentDto,
  forwardEntry,
  forwardedDto,
  mockForwardApi,
  violation,
} from '@test/support/forward-fixtures';
import type { ForwardApiOptions } from '@test/support/forward-fixtures';
import { pickDate } from '@test/support/kit';
import {
  ID,
  ORG_MAIN,
  PROCESS_ID,
  callsTo,
  problemResponse,
  stagesDto,
} from '@test/support/process-fixtures';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { addDays, localToday } from './forward-model';
import { ForwardPanel } from './forward-panel';
import type { ForwardPanelProps } from './forward-panel';

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

// Os links "Resolver" e "Abrir documento" usam o `Link` do Next.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => `/processos/${PROCESS_ID}`,
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

const noRetryClient = () => {
  const client = makeQueryClient();
  client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retry: false } });
  return client;
};

const STATUS_HEADER_ID = 'process-status-header';
const COMMENT = 'ETP concluído; seguem ETP e mapa de riscos';
const POLICY = { retries: 0 } as const;

function Harness({
  onOpenChange,
  ...props
}: Partial<ForwardPanelProps> & { readonly onOpenChange: (open: boolean) => void }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <div id={STATUS_HEADER_ID} tabIndex={-1}>
        Situação do processo
      </div>
      <ForwardPanel
        processId={PROCESS_ID}
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          onOpenChange(next);
        }}
        onForwarded={() => document.getElementById(STATUS_HEADER_ID)?.focus()}
        retry={POLICY}
        {...props}
      />
      <Toaster />
    </>
  );
}

function renderPanel(options: ForwardApiOptions = {}, props: Partial<ForwardPanelProps> = {}) {
  const api = mockForwardApi(options);
  const onOpenChange = vi.fn();
  const view = renderWithShell(<Harness onOpenChange={onOpenChange} {...props} />, {
    queryClient: noRetryClient(),
  });
  return { api, onOpenChange, view };
}

const posts = (api: ReturnType<typeof mockForwardApi>) => callsTo(api, 'POST', FORWARD_URL);
const submit = () => screen.getByRole('button', { name: 'Encaminhar' });
/** Radix (Checkbox/Radio): o estado vai em `aria-checked`, não em `checked`. */
const isChecked = (control: HTMLElement | undefined) =>
  control?.getAttribute('aria-checked') === 'true';
const isDisabled = (control: HTMLElement) => (control as HTMLButtonElement).disabled;

const loaded = async () => (await screen.findAllByRole('radio'))[0];
/** Parágrafo cujo texto (com os trechos em negrito) é exatamente `text`. */
const paragraph = (text: string) =>
  screen.getByText((_, element) => element?.tagName === 'P' && element.textContent === text);

const problemWith = (status: number, code: string, violations: unknown[]) =>
  problemResponse(status, code, { extension: { violations } });

describe('SCR-103 · Painel "Encaminhar processo" (US-047)', () => {
  it('[Sucesso] envia o PRC-19 com If-Match, Idempotency-Key e corpo; fecha, avisa e leva o foco ao cabeçalho', async () => {
    const user = userEvent.setup();
    const { api, onOpenChange } = renderPanel({
      forward: () => jsonResponse({ data: forwardedDto() }, { headers: { ETag: '"15"' } }),
    });
    const radio = await loaded();
    expect(isChecked(radio)).toBe(true);
    expect(
      screen.getByText('Etapa: Pesquisa de preços · Unidade: Departamento de Compras'),
    ).toBeTruthy();
    // Prazo do PRC-08 no fuso do tenant, com o SLA da etapa de destino (PRC-10).
    expect(screen.getByText('Até 20/10/2026 (5 dias úteis)')).toBeTruthy();
    expect(
      paragraph(
        'O processo irá para Pesquisa de preços — Departamento de Compras, na fila da unidade, com prazo até 20/10/2026.',
      ),
    ).toBeTruthy();

    await user.type(screen.getByLabelText('Comentário'), COMMENT);
    expect(screen.getByText(`${String(COMMENT.length)} / 5.000`)).toBeTruthy();
    await user.click(submit());

    await waitFor(() => {
      expect(posts(api)).toHaveLength(1);
    });
    const [call] = posts(api);
    expect(call?.headers.get('If-Match')).toBe('"14"');
    expect(call?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(call?.headers.get('X-Correlation-Id')).toBeTruthy();
    // Documentos intactos: a API aplica o padrão da passagem (RN-TRAM-12).
    expect(call?.body).toEqual({
      transitionId: T_PESQUISA,
      expectedStageId: STAGE_ID,
      comment: COMMENT,
    });

    expect(
      await screen.findByText(
        'Processo encaminhado para Pesquisa de preços — Departamento de Compras',
      ),
    ).toBeTruthy();
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    await waitFor(() => {
      expect(document.activeElement?.id).toBe(STATUS_HEADER_ID);
    });
    // Processo, ações e demais consultas do painel são relidos.
    await waitFor(() => {
      expect(callsTo(api, 'GET', PROCESS_URL).length).toBeGreaterThan(1);
    });
  });

  it('[FA-07] autuação no 1º encaminhamento: o toast informa o número do processo', async () => {
    const user = userEvent.setup();
    renderPanel({
      forward: () => jsonResponse({ data: forwardedDto({ numberAssigned: true }) }),
    });
    await loaded();
    await user.click(submit());
    expect(
      await screen.findByText(
        'Processo autuado sob o nº 0012/2026 e encaminhado para Pesquisa de preços — Departamento de Compras',
      ),
    ).toBeTruthy();
  });

  it('[Para onde] a principal vem marcada, a indisponível fica desabilitada com o motivo e a escolha vai no corpo', async () => {
    const user = userEvent.setup();
    const { api } = renderPanel({
      actions: [
        forwardEntry(),
        forwardEntry({
          transitionId: T_OUTRA,
          transitionKey: 'OUTRA',
          label: 'Encaminhar para licitação',
          primary: false,
          toStageName: 'Licitação',
          departmentResolution: { mode: 'FIXED', departmentName: LICITACOES.name },
        }),
        forwardEntry({
          transitionId: ID(904),
          label: 'Pular a pesquisa',
          primary: false,
          enabled: false,
          reasons: [
            { code: 'TRANSITION_BLOCKED', message: 'Há 1 pendência obrigatória nesta etapa.' },
          ],
        }),
      ],
    });
    await loaded();
    const radios = screen.getAllByRole('radio');
    expect(radios.map((radio) => [isChecked(radio), isDisabled(radio)])).toEqual([
      [true, false],
      [false, false],
      [false, true],
    ]);
    expect(screen.getByText('Indisponível: Há 1 pendência obrigatória nesta etapa.')).toBeTruthy();

    await user.click(screen.getByRole('radio', { name: 'Encaminhar para licitação' }));
    expect(
      paragraph(
        'O processo irá para Licitação — Departamento de Licitações, na fila da unidade, com prazo até 20/10/2026.',
      ),
    ).toBeTruthy();
    await user.click(submit());
    await waitFor(() => {
      expect(posts(api)).toHaveLength(1);
    });
    expect(posts(api)[0]?.body).toMatchObject({ transitionId: T_OUTRA });
  });

  it('[Para onde] a transitionKey da ação do painel tem precedência sobre a primária', async () => {
    renderPanel(
      {
        actions: [
          forwardEntry(),
          forwardEntry({
            transitionId: T_OUTRA,
            transitionKey: 'OUTRA',
            label: 'Outro caminho',
            primary: false,
          }),
        ],
      },
      { initialTransitionKey: 'OUTRA' },
    );
    await loaded();
    expect(isChecked(screen.getByRole('radio', { name: 'Outro caminho' }))).toBe(true);
  });

  it('[Pendências] bloqueante da saída: link "Resolver", botão desabilitado; regra de outra transição não aparece', async () => {
    renderPanel({
      checklist: [
        checklistRule(RULE_ETP_FORWARD, 'BLOCKING', 'O ETP deve estar completo.', {
          params: { documentTypeCode: 'ETP' },
        }),
        checklistRule(ID(613), 'BLOCKING', 'Regra de outra saída.', {
          scope: 'TRANSITION',
          transitionId: T_OUTRA,
        }),
      ],
    });
    await loaded();
    expect(screen.getByText('O ETP deve estar completo.')).toBeTruthy();
    expect(screen.queryByText('Regra de outra saída.')).toBeNull();
    expect(screen.getByText('1 pendência obrigatória e nenhum aviso.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Resolver' }).getAttribute('href')).toBe(
      `/processos/${PROCESS_ID}/documentos/${DOC_ETP}`,
    );
    expect((submit() as HTMLButtonElement).disabled).toBe(true);
    expect(submit().getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByText('Resolva as pendências obrigatórias para encaminhar.')).toBeTruthy();
  });

  it('[Pendências] "Resolver" sem documento leva à seção #pendencias e fecha o painel', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderPanel({
      checklist: [checklistRule(RULE_ETP_FORWARD, 'BLOCKING', 'Informe o valor estimado.')],
    });
    await loaded();
    const link = screen.getByRole('link', { name: 'Resolver' });
    expect(link.getAttribute('href')).toBe('#pendencias');
    await user.click(link);
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('[FA-09] falha transitória: a retentativa automática reenvia com a MESMA Idempotency-Key', async () => {
    const user = userEvent.setup();
    let call = 0;
    const { api } = renderPanel(
      {
        forward: () => {
          call += 1;
          return call === 1
            ? problemResponse(503, 'DEPENDENCY_UNAVAILABLE')
            : jsonResponse({ data: forwardedDto() });
        },
      },
      { retry: { retries: 1, sleep: () => Promise.resolve() } },
    );
    await loaded();
    await user.click(submit());
    expect(await screen.findByText(/^Processo encaminhado para/)).toBeTruthy();
    const [first, second] = posts(api);
    expect(posts(api)).toHaveLength(2);
    expect(second?.headers.get('Idempotency-Key')).toBe(first?.headers.get('Idempotency-Key'));
    expect(second?.headers.get('X-Correlation-Id')).toBe(first?.headers.get('X-Correlation-Id'));
  });

  it('[Avisos] exige "Estou ciente"; só então envia o id da regra', async () => {
    const user = userEvent.setup();
    const { api } = renderPanel({
      checklist: [
        checklistRule(RULE_RISK_FORWARD, 'WARNING', 'Recomenda-se elaborar o mapa de riscos.'),
      ],
    });
    await loaded();
    expect(screen.getByText('Recomenda-se elaborar o mapa de riscos.')).toBeTruthy();
    await user.click(submit());
    expect(
      await screen.findByText('Confirme que está ciente dos avisos antes de encaminhar.'),
    ).toBeTruthy();
    expect(posts(api)).toHaveLength(0);
    const box = screen.getByRole('checkbox', { name: 'Estou ciente e desejo prosseguir' });
    expect(document.activeElement).toBe(screen.getByRole('list', { name: 'Avisos' }));
    await user.click(box);
    await user.click(submit());
    await waitFor(() => {
      expect(posts(api)).toHaveLength(1);
    });
    expect(posts(api)[0]?.body).toMatchObject({ acknowledgedWarnings: [RULE_RISK_FORWARD] });
  });

  it('[FA-05] WARNINGS_NOT_ACKNOWLEDGED: mostra os avisos com caixa e o reenvio usa nova Idempotency-Key', async () => {
    const user = userEvent.setup();
    let warned = false;
    const warning = violation(
      RULE_RISK_FORWARD,
      'WARNING',
      'Recomenda-se elaborar o mapa de riscos.',
    );
    const { api } = renderPanel({
      // As regras mudaram depois da carga do painel: o PRC-09 relido já traz o aviso.
      checklist: () =>
        jsonResponse({
          data: {
            violations: warned
              ? [checklistRule(RULE_RISK_FORWARD, 'WARNING', warning.message)]
              : [],
          },
        }),
      forward: () => {
        if (warned) return jsonResponse({ data: forwardedDto() });
        warned = true;
        return problemWith(422, 'WARNINGS_NOT_ACKNOWLEDGED', [warning]);
      },
    });
    await loaded();
    await user.click(submit());
    const box = await screen.findByRole('checkbox', { name: 'Estou ciente e desejo prosseguir' });
    expect(
      screen.getAllByText('Confirme que está ciente dos avisos antes de encaminhar.').length,
    ).toBeGreaterThan(0);
    await user.click(box);
    await user.click(submit());
    await waitFor(() => {
      expect(posts(api)).toHaveLength(2);
    });
    const [first, second] = posts(api);
    expect(first?.body).not.toHaveProperty('acknowledgedWarnings');
    expect(second?.body).toMatchObject({ acknowledgedWarnings: [RULE_RISK_FORWARD] });
    expect(second?.headers.get('Idempotency-Key')).not.toBe(first?.headers.get('Idempotency-Key'));
  });

  it('[FA-06] TRANSITION_BLOCKED lista as violações do problem e mantém o botão desabilitado', async () => {
    const user = userEvent.setup();
    let blocked = false;
    const rule = violation(RULE_ETP_FORWARD, 'BLOCKING', 'O ETP deve estar completo.', {
      params: { documentTypeCode: 'ETP' },
    });
    const { api } = renderPanel({
      checklist: () =>
        jsonResponse({
          data: {
            violations: blocked
              ? [checklistRule(RULE_ETP_FORWARD, 'BLOCKING', rule.message, { params: rule.params })]
              : [],
          },
        }),
      forward: () => {
        blocked = true;
        return problemWith(422, 'TRANSITION_BLOCKED', [rule]);
      },
    });
    await loaded();
    await user.click(submit());
    expect(await screen.findByText('Há 1 pendência obrigatória na etapa.')).toBeTruthy();
    expect(await screen.findByText('O ETP deve estar completo.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Resolver' }).getAttribute('href')).toBe(
      `/processos/${PROCESS_ID}/documentos/${DOC_ETP}`,
    );
    await waitFor(() => {
      expect((submit() as HTMLButtonElement).disabled).toBe(true);
    });
    expect(posts(api)).toHaveLength(1);
  });

  it('[Validação] unidade escolhida no encaminhamento: "Escolha a unidade de destino." e DEP-02 do órgão do processo', async () => {
    const user = userEvent.setup();
    const { api } = renderPanel({
      actions: [forwardEntry({ departmentResolution: { mode: 'CHOSEN_ON_FORWARD' } })],
    });
    await loaded();
    expect(
      paragraph(
        'O processo irá para Pesquisa de preços. Escolha a unidade de destino para ver o resumo completo.',
      ),
    ).toBeTruthy();
    await user.click(submit());
    expect(await screen.findByText('Escolha a unidade de destino.')).toBeTruthy();
    expect(posts(api)).toHaveLength(0);
    // O foco vai ao campo da unidade.
    expect(document.activeElement).toBe(
      screen.getByRole('searchbox', { name: 'Unidade de destino' }),
    );

    const lookup = api.mock.calls
      .map(([input]) => requestUrl(input))
      .find((url) => url.startsWith('/api/v1/departments/lookup'));
    expect(lookup).toBe(`/api/v1/departments/lookup?organizationId=${ORG_MAIN.id}`);

    await user.click(await screen.findByRole('button', { name: LICITACOES.name }));
    expect(screen.getByText('Selecionado: Departamento de Licitações')).toBeTruthy();
    expect(screen.queryByText('Escolha a unidade de destino.')).toBeNull();
    await user.click(submit());
    await waitFor(() => {
      expect(posts(api)).toHaveLength(1);
    });
    expect(posts(api)[0]?.body).toMatchObject({ toDepartmentId: LICITACOES.id });
  });

  it('[Padrão] a unidade vem da última passagem pela etapa de destino', async () => {
    const stages = stagesDto().map((stage) =>
      stage.key === 'PESQUISA_PRECOS'
        ? {
            ...stage,
            passes: [
              {
                processStageId: ID(830),
                sequence: 3,
                status: 'COMPLETED' as const,
                department: COMPRAS,
                assignee: null,
                enteredAt: '2026-09-10T12:00:00.000Z',
                exitedAt: '2026-09-12T12:00:00.000Z',
                dueAt: null,
                dueDateOverridden: false,
                overdueSince: null,
              },
            ],
          }
        : stage,
    );
    const { api } = renderPanel({
      actions: [forwardEntry({ departmentResolution: { mode: 'CHOSEN_ON_FORWARD' } })],
      stages: () => jsonResponse({ data: stages }),
    });
    await loaded();
    expect(screen.getByText('Selecionado: Departamento de Compras')).toBeTruthy();
    fireEvent.click(submit());
    await waitFor(() => {
      expect(posts(api)).toHaveLength(1);
    });
    expect(posts(api)[0]?.body).toMatchObject({ toDepartmentId: COMPRAS.id });
  });

  it('[Atribuição direta] busca a pessoa (USR-02, mín. 2 letras) e envia toUserId', async () => {
    const user = userEvent.setup();
    const { api } = renderPanel();
    await loaded();
    await user.type(screen.getByRole('searchbox', { name: 'Atribuir diretamente a' }), 'Ru');
    await user.click(await screen.findByRole('button', { name: /Rui Almeida/ }));
    expect(screen.getByText('Selecionado: Rui Almeida')).toBeTruthy();
    expect(
      paragraph(
        'O processo irá para Pesquisa de preços — Departamento de Compras, atribuído a Rui Almeida, com prazo até 20/10/2026.',
      ),
    ).toBeTruthy();
    await user.click(submit());
    await waitFor(() => {
      expect(posts(api)).toHaveLength(1);
    });
    expect(posts(api)[0]?.body).toMatchObject({ toUserId: ID(61) });
  });

  it('[Comentário] obrigatório na transição: V-02 antes de enviar', async () => {
    const user = userEvent.setup();
    const { api } = renderPanel({ actions: [forwardEntry({ requiresComment: true })] });
    await loaded();
    expect(screen.getByLabelText('Comentário (obrigatório)')).toBeTruthy();
    await user.click(submit());
    expect(await screen.findByText('Informe um comentário (mín. 10 caracteres).')).toBeTruthy();
    expect(posts(api)).toHaveLength(0);
    expect(document.activeElement).toBe(screen.getByLabelText('Comentário (obrigatório)'));
  });

  it('[FA-04] "Alterar prazo" só com permissão da transição: data e motivo obrigatórios', async () => {
    const user = userEvent.setup();
    const today = localToday(new Date(), 'America/Sao_Paulo');
    const { api } = renderPanel({ actions: [forwardEntry({ allowDueDateOverride: true })] });
    await loaded();
    await user.click(screen.getByRole('button', { name: 'Alterar prazo' }));

    // Dias fora de hoje..limite ficam desabilitados no calendário; sem data, o erro de faixa vale.
    await user.type(screen.getByLabelText('Motivo da alteração do prazo'), 'curto');
    await user.click(submit());
    expect(
      await screen.findByText(/^Informe uma data entre hoje e \d{2}\/\d{2}\/\d{4}/),
    ).toBeTruthy();
    expect(
      screen.getByText('Informe o motivo da alteração do prazo (10 a 1.000 caracteres).'),
    ).toBeTruthy();
    expect(posts(api)).toHaveLength(0);

    const due = addDays(today, 10);
    await pickDate(user, 'Novo prazo', due);
    await user.clear(screen.getByLabelText('Motivo da alteração do prazo'));
    await user.type(screen.getByLabelText('Motivo da alteração do prazo'), 'Volume alto de itens');
    await user.click(submit());
    await waitFor(() => {
      expect(posts(api)).toHaveLength(1);
    });
    expect(posts(api)[0]?.body).toMatchObject({
      dueAt: due,
      dueDateOverrideReason: 'Volume alto de itens',
    });
  });

  it('transição sem sobrescrita não oferece "Alterar prazo"; sem prévia mostra "Sem prazo definido"', async () => {
    renderPanel({ actions: [forwardEntry({ dueAtPreview: null })] });
    await loaded();
    expect(screen.getByText('Sem prazo definido')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Alterar prazo' })).toBeNull();
  });

  it('[FA-01] destino de aprovação: sem atribuição direta, documentos travados e resumo com o aprovador', async () => {
    const dfd = documentDto(DOC_DFD, 'DFD — cimento', 'DFD', 'DFD', {
      status: 'DRAFT',
      currentVersionNumber: 1,
    });
    const { api } = renderPanel({
      actions: [approvalEntry()],
      documents: [dfd],
    });
    await screen.findByRole('radio', { name: 'Enviar para aprovação da demanda' });
    expect(screen.queryByLabelText('Atribuir diretamente a')).toBeNull();
    expect(
      screen.getByText('Aprovador: Carlos Lima (titular da Secretaria de Obras)'),
    ).toBeTruthy();
    const box = screen.getByRole('checkbox', { name: /DFD — cimento/ });
    expect(isChecked(box)).toBe(true);
    expect(isDisabled(box)).toBe(true);
    expect(screen.getByText('Será submetido para aprovação')).toBeTruthy();
    expect(
      paragraph('O processo irá para aprovação de Carlos Lima (titular da Secretaria de Obras).'),
    ).toBeTruthy();
    expect(paragraph('O DFD será submetido na versão 2.')).toBeTruthy();

    fireEvent.click(submit());
    await waitFor(() => {
      expect(posts(api)).toHaveLength(1);
    });
    expect(posts(api)[0]?.body).toEqual({ transitionId: ID(902), expectedStageId: STAGE_ID });
  });

  it('[Documentos] marcados os alterados na etapa; só enviam documentIds se o usuário mexer', async () => {
    const user = userEvent.setup();
    const { api } = renderPanel();
    await loaded();
    const etp = screen.getByRole('checkbox', { name: /ETP — cimento/ });
    const risks = screen.getByRole('checkbox', { name: /Mapa de riscos/ });
    const dfd = screen.getByRole('checkbox', { name: /DFD — cimento/ });
    expect([etp, risks, dfd].map(isChecked)).toEqual([true, true, false]);
    expect(screen.getByText('2 documentos selecionados (máx. 50)')).toBeTruthy();

    await user.click(risks);
    await user.click(dfd);
    await user.click(submit());
    await waitFor(() => {
      expect(posts(api)).toHaveLength(1);
    });
    expect(posts(api)[0]?.body).toMatchObject({ documentIds: [DOC_ETP, DOC_DFD] });
  });

  describe('erros da API', () => {
    it('[FA-08] 409 STAGE_CHANGED abre o diálogo; "Recarregar" relê o processo e fecha o painel', async () => {
      const user = userEvent.setup();
      const { api, onOpenChange } = renderPanel({
        forward: () => problemResponse(409, 'STAGE_CHANGED'),
      });
      await loaded();
      await user.click(submit());
      const dialog = await screen.findByRole('dialog', { name: 'Processo movimentado' });
      expect(
        within(dialog).getByText(
          'Este processo acabou de ser movimentado por outra pessoa. Recarregue para ver a situação atual.',
        ),
      ).toBeTruthy();
      expect(onOpenChange).not.toHaveBeenCalledWith(false);
      const before = callsTo(api, 'GET', PROCESS_URL).length;
      await user.click(within(dialog).getByRole('button', { name: 'Recarregar' }));
      await waitFor(() => {
        expect(onOpenChange).toHaveBeenCalledWith(false);
      });
      await waitFor(() => {
        expect(callsTo(api, 'GET', PROCESS_URL).length).toBeGreaterThan(before);
      });
    });

    it('412 VERSION_CONFLICT recarrega o processo e mantém o comentário digitado', async () => {
      const user = userEvent.setup();
      const { api } = renderPanel({
        forward: () => problemResponse(412, 'VERSION_CONFLICT'),
      });
      await loaded();
      const comment = screen.getByLabelText('Comentário');
      await user.type(comment, COMMENT);
      const before = callsTo(api, 'GET', PROCESS_URL).length;
      await user.click(submit());
      expect(
        await screen.findByText('O processo foi alterado. Recarregue para continuar.'),
      ).toBeTruthy();
      expect((comment as HTMLTextAreaElement).value).toBe(COMMENT);
      await waitFor(() => {
        expect(callsTo(api, 'GET', PROCESS_URL).length).toBeGreaterThan(before);
      });
    });

    it('403 NOT_PROCESS_CUSTODIAN fecha o painel e avisa', async () => {
      const user = userEvent.setup();
      const { onOpenChange } = renderPanel({
        forward: () => problemResponse(403, 'NOT_PROCESS_CUSTODIAN'),
      });
      await loaded();
      await user.click(submit());
      expect(await screen.findByText('Você não está com este processo.')).toBeTruthy();
      await waitFor(() => {
        expect(onOpenChange).toHaveBeenCalledWith(false);
      });
    });

    it('409 INVALID_PROCESS_STATUS e 422 TRANSITION_NOT_AVAILABLE recarregam o painel com a orientação', async () => {
      const user = userEvent.setup();
      let call = 0;
      const { api } = renderPanel({
        forward: () => {
          call += 1;
          return call === 1
            ? problemResponse(409, 'INVALID_PROCESS_STATUS', {
                detail: 'O processo está suspenso e não pode ser encaminhado.',
              })
            : problemResponse(422, 'TRANSITION_NOT_AVAILABLE');
        },
      });
      await loaded();
      await user.click(submit());
      expect(
        await screen.findByText('O processo está suspenso e não pode ser encaminhado.'),
      ).toBeTruthy();
      await user.click(submit());
      expect(await screen.findByText('Este caminho não está disponível agora.')).toBeTruthy();
      expect(callsTo(api, 'GET', `${PROCESS_URL}/available-actions`).length).toBeGreaterThan(1);
    });

    it('422 VALIDATION_ERROR marca o campo e leva o foco ao primeiro erro', async () => {
      const user = userEvent.setup();
      renderPanel({
        forward: () =>
          problemResponse(422, 'VALIDATION_ERROR', {
            errors: [
              {
                field: 'comment',
                code: 'TOO_LONG',
                message: 'O comentário pode ter até 5.000 caracteres.',
              },
              {
                field: 'dueDateOverrideReason',
                code: 'CONDITIONAL_REQUIRED',
                message: 'Informe o motivo.',
              },
            ],
          }),
      });
      await loaded();
      await user.click(submit());
      expect(await screen.findByText('Revise os campos destacados.')).toBeTruthy();
      const comment = screen.getByLabelText('Comentário');
      expect(comment.getAttribute('aria-invalid')).toBe('true');
      expect(screen.getByText('O comentário pode ter até 5.000 caracteres.')).toBeTruthy();
      expect(document.activeElement).toBe(comment);
    });

    it('422 DEPARTMENT_REQUIRED foca a unidade; ASSIGNEE_NOT_ELIGIBLE limpa a pessoa', async () => {
      const user = userEvent.setup();
      let call = 0;
      renderPanel({
        actions: [forwardEntry({ departmentResolution: { mode: 'CHOSEN_ON_FORWARD' } })],
        forward: () => {
          call += 1;
          return call === 1
            ? problemResponse(422, 'ASSIGNEE_NOT_ELIGIBLE')
            : problemResponse(422, 'DEPARTMENT_REQUIRED');
        },
      });
      await loaded();
      await user.click(await screen.findByRole('button', { name: COMPRAS.name }));
      await user.type(screen.getByRole('searchbox', { name: 'Atribuir diretamente a' }), 'Ru');
      await user.click(await screen.findByRole('button', { name: /Rui Almeida/ }));
      await user.click(submit());
      expect(
        await screen.findByText('Esta pessoa não pode receber o processo nesta unidade.'),
      ).toBeTruthy();
      expect(screen.queryByText('Selecionado: Rui Almeida')).toBeNull();
      expect(document.activeElement).toBe(
        screen.getByRole('searchbox', { name: 'Atribuir diretamente a' }),
      );

      await user.click(submit());
      expect(await screen.findByText('Escolha a unidade de destino.')).toBeTruthy();
    });

    it('422 DUE_DATE_OVERRIDE_NOT_ALLOWED restaura o prazo calculado', async () => {
      const user = userEvent.setup();
      const today = localToday(new Date(), 'America/Sao_Paulo');
      renderPanel({
        actions: [forwardEntry({ allowDueDateOverride: true })],
        forward: () => problemResponse(422, 'DUE_DATE_OVERRIDE_NOT_ALLOWED'),
      });
      await loaded();
      await user.click(screen.getByRole('button', { name: 'Alterar prazo' }));
      await pickDate(user, 'Novo prazo', addDays(today, 5));
      await user.type(
        screen.getByLabelText('Motivo da alteração do prazo'),
        'Volume alto de itens',
      );
      await user.click(submit());
      expect(await screen.findByText('Esta etapa não permite alterar o prazo.')).toBeTruthy();
      expect(screen.getByText('O prazo calculado foi restaurado.')).toBeTruthy();
      expect(screen.queryByLabelText('Novo prazo')).toBeNull();
    });

    it('[FA-11] 422 DOCUMENT_INCOMPLETE lista as pendências por documento com link ao editor', async () => {
      const user = userEvent.setup();
      renderPanel({
        actions: [approvalEntry()],
        forward: () =>
          problemWith(422, 'DOCUMENT_INCOMPLETE', [
            violation('r1', 'BLOCKING', 'O objeto é obrigatório.', {
              ruleId: null,
              params: { documentId: DOC_DFD },
            }),
          ]),
      });
      await screen.findByRole('radio', { name: 'Enviar para aprovação da demanda' });
      await user.click(submit());
      expect(await screen.findByText('Complete o DFD — cimento antes de enviar.')).toBeTruthy();
      expect(screen.getByText('O objeto é obrigatório.')).toBeTruthy();
      expect(screen.getByRole('link', { name: 'Abrir documento' }).getAttribute('href')).toBe(
        `/processos/${PROCESS_ID}/documentos/${DOC_DFD}`,
      );
    });

    it('[FA-12] 422 APPROVER_UNRESOLVED mantém o painel com a orientação', async () => {
      const user = userEvent.setup();
      const { onOpenChange } = renderPanel({
        actions: [approvalEntry()],
        forward: () =>
          problemResponse(422, 'APPROVER_UNRESOLVED', {
            detail: 'A Secretaria de Obras não tem titular apto a decidir.',
          }),
      });
      await screen.findByRole('radio', { name: 'Enviar para aprovação da demanda' });
      await user.click(submit());
      expect(
        await screen.findByText(
          'Não há aprovador configurado para esta etapa. Fale com o administrador do órgão.',
        ),
      ).toBeTruthy();
      expect(
        screen.getByText('A Secretaria de Obras não tem titular apto a decidir.'),
      ).toBeTruthy();
      expect(onOpenChange).not.toHaveBeenCalled();
    });

    it('[US-051 · V-02] APPROVER_UNRESOLVED com o detail padrão da API mostra a orientação uma vez só', async () => {
      const user = userEvent.setup();
      renderPanel({
        actions: [approvalEntry()],
        forward: () =>
          problemResponse(422, 'APPROVER_UNRESOLVED', {
            detail:
              'Não há aprovador configurado para esta etapa. Fale com o administrador do órgão.',
          }),
      });
      await screen.findByRole('radio', { name: 'Enviar para aprovação da demanda' });
      await user.click(submit());
      expect(
        await screen.findAllByText(
          'Não há aprovador configurado para esta etapa. Fale com o administrador do órgão.',
        ),
      ).toHaveLength(1);
    });

    it('[Falha de banco] 503 mantém os dados, mostra o código e "Tentar novamente" reenvia', async () => {
      const user = userEvent.setup();
      let call = 0;
      const { api } = renderPanel({
        forward: () => {
          call += 1;
          return call === 1
            ? problemResponse(503, 'DEPENDENCY_UNAVAILABLE', { correlationId: 'c-503' })
            : jsonResponse({ data: forwardedDto() });
        },
      });
      await loaded();
      const comment = screen.getByLabelText('Comentário');
      await user.type(comment, COMMENT);
      await user.click(submit());
      expect(
        await screen.findByText('Não foi possível encaminhar agora. Tente novamente em instantes.'),
      ).toBeTruthy();
      expect(screen.getByText('Código: c-503')).toBeTruthy();
      expect((comment as HTMLTextAreaElement).value).toBe(COMMENT);
      await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
      await waitFor(() => {
        expect(posts(api)).toHaveLength(2);
      });
      expect(posts(api)[1]?.body).toMatchObject({ comment: COMMENT });
      expect(await screen.findByText(/^Processo encaminhado para/)).toBeTruthy();
    });

    it('500 mostra o código do erro inesperado e mantém os dados', async () => {
      const user = userEvent.setup();
      renderPanel({
        forward: () => problemResponse(500, 'INTERNAL_ERROR', { correlationId: 'c-500' }),
      });
      await loaded();
      await user.click(submit());
      expect(await screen.findByText('Ocorreu um erro inesperado. Código: c-500.')).toBeTruthy();
      expect(screen.getByRole('radio', { name: /Encaminhar para/ })).toBeTruthy();
    });

    it('envio em andamento: botão "Encaminhando…" desabilitado (sem segundo POST)', async () => {
      const user = userEvent.setup();
      let release: (response: Response) => void = () => undefined;
      const { api } = renderPanel({
        forward: () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      });
      await loaded();
      await user.click(submit());
      const busy = await screen.findByRole('button', { name: 'Encaminhando…' });
      expect((busy as HTMLButtonElement).disabled).toBe(true);
      expect(posts(api)).toHaveLength(1);
      release(jsonResponse({ data: forwardedDto() }));
      expect(await screen.findByText(/^Processo encaminhado para/)).toBeTruthy();
    });
  });

  describe('estados e fechamento', () => {
    it('skeleton enquanto PRC-08/PRC-09/DOC-01 carregam', async () => {
      renderPanel({ actions: () => new Promise<Response>(() => undefined) });
      const status = await screen.findByRole('status');
      expect(within(status).getByText('Carregando as opções de encaminhamento…')).toBeTruthy();
    });

    it('sem transições FORWARD: "Não há encaminhamentos disponíveis nesta etapa."', async () => {
      renderPanel({ actions: [] });
      expect(
        await screen.findByText('Não há encaminhamentos disponíveis nesta etapa.'),
      ).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Encaminhar' })).toBeNull();
    });

    it('erro de carga: mensagem com "Tentar novamente"', async () => {
      const user = userEvent.setup();
      let fail = true;
      renderPanel({
        checklist: () =>
          fail
            ? problemResponse(503, 'DEPENDENCY_UNAVAILABLE', { correlationId: 'c-load' })
            : jsonResponse({ data: { violations: [] } }),
      });
      expect(await screen.findByText('Não foi possível carregar o encaminhamento.')).toBeTruthy();
      expect(screen.getByText('Código: c-load')).toBeTruthy();
      fail = false;
      await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
      expect(await loaded()).toBeTruthy();
    });

    it('fechar sem dados fecha direto; com dados digitados pede confirmação', async () => {
      const user = userEvent.setup();
      const { onOpenChange } = renderPanel();
      await loaded();
      await user.type(screen.getByLabelText('Comentário'), 'Rascunho do comentário');
      await user.click(screen.getByRole('button', { name: 'Cancelar' }));
      const dialog = await screen.findByRole('dialog', { name: 'Descartar o encaminhamento?' });
      expect(onOpenChange).not.toHaveBeenCalled();
      await user.click(within(dialog).getByRole('button', { name: 'Continuar editando' }));
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(screen.getByLabelText<HTMLTextAreaElement>('Comentário').value).toBe(
        'Rascunho do comentário',
      );

      await user.keyboard('{Escape}');
      const again = await screen.findByRole('dialog', { name: 'Descartar o encaminhamento?' });
      await user.click(within(again).getByRole('button', { name: 'Descartar' }));
      await waitFor(() => {
        expect(onOpenChange).toHaveBeenCalledWith(false);
      });
    });

    it('sem nada digitado, "Cancelar" fecha sem confirmação', async () => {
      const user = userEvent.setup();
      const { onOpenChange } = renderPanel();
      await loaded();
      await user.click(screen.getByRole('button', { name: 'Cancelar' }));
      await waitFor(() => {
        expect(onOpenChange).toHaveBeenCalledWith(false);
      });
      expect(screen.queryByRole('dialog', { name: 'Descartar o encaminhamento?' })).toBeNull();
    });
  });

  it('[Acessibilidade] axe: painel carregado, com pendência, aviso, prazo e documentos', async () => {
    const user = userEvent.setup();
    renderPanel({
      actions: [forwardEntry({ allowDueDateOverride: true, requiresComment: true })],
      checklist: [
        checklistRule(RULE_ETP_FORWARD, 'BLOCKING', 'O ETP deve estar completo.', {
          params: { documentTypeCode: 'ETP' },
        }),
        checklistRule(RULE_RISK_FORWARD, 'WARNING', 'Recomenda-se elaborar o mapa de riscos.'),
      ],
      documents: [
        ...defaultDocuments(),
        documentDto(ID(580), 'Cancelado', 'X', 'X', { status: 'CANCELED' }),
      ],
    });
    await loaded();
    await user.click(screen.getByRole('button', { name: 'Alterar prazo' }));
    expect(await seriousA11yViolations()).toEqual([]);
  });
});
