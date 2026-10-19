// @vitest-environment jsdom
import { Toaster, clearToasts } from '@contrataflow/ui';
import type { ActionEntry } from '@contrataflow/validation';
import { act, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api/api-error';
import { makeQueryClient } from '@/lib/query/query-client';
import { seriousA11yViolations } from '@test/support/axe';
import {
  FORWARD_URL,
  PROCESS_URL,
  forwardEntry as previewEntry,
  forwardedDto,
} from '@test/support/forward-fixtures';
import {
  ETP_ID,
  ID,
  MARCOS,
  PROCESS_ID,
  callsTo,
  mockProcessApi,
  problemResponse,
  processDto,
  summaryDto,
} from '@test/support/process-fixtures';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';
import { RETURN_URL, returnEntry, returnedDto } from '@test/support/return-fixtures';

import { ProcessPanel, useStaleProcessRecovery } from './process-panel';
import { PANEL_REFETCH_MS, isStaleProcessError, panelRefetchInterval } from './process-panel.api';

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

/** Navegação simulada: `?aba=` é estado observável (`useSearchParams`) e o roteador o altera. */
const nav = vi.hoisted(() => {
  let search = '';
  const listeners = new Set<() => void>();
  const set = (href: string) => {
    search = href.includes('?') ? (href.split('?')[1] ?? '') : '';
    listeners.forEach((listener) => {
      listener();
    });
  };
  return {
    get: () => search,
    set,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    replace: vi.fn((href: string) => {
      set(href);
    }),
  };
});

vi.mock('next/navigation', async () => {
  const React = await import('react');
  return {
    useRouter: () => ({ push: vi.fn(), replace: nav.replace, refresh: vi.fn() }),
    usePathname: () => `/processos/${PROCESS_ID}`,
    useSearchParams: () => {
      const search = React.useSyncExternalStore(nav.subscribe, nav.get, nav.get);
      return React.useMemo(() => new URLSearchParams(search), [search]);
    },
  };
});

beforeEach(() => {
  nav.set(`/processos/${PROCESS_ID}`);
  nav.replace.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

/** Seção do painel pelo título (`h2`). */
const section = (name: string) => {
  const heading = screen.getByRole('heading', { level: 2, name });
  const region = heading.closest('section');
  if (!region) throw new Error(`seção ${name} ausente`);
  return region;
};

const forwardEntry = (overrides: Partial<ActionEntry> = {}): ActionEntry => ({
  action: 'FORWARD',
  transitionKey: 'ESTUDOS_PARA_PESQUISA',
  label: 'Encaminhar para Pesquisa de preços',
  enabled: false,
  primary: true,
  reasons: [
    {
      code: 'NOT_PROCESS_CUSTODIAN',
      message: 'Somente quem está com o processo pode encaminhá-lo.',
    },
  ],
  ...overrides,
});

const noRetryClient = () => {
  const client = makeQueryClient();
  client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retry: false } });
  return client;
};

describe('SCR-006 · Painel situacional do processo (US-004)', () => {
  it('[Sucesso] responde às 7 perguntas sem cliques, com PRC-04/07/08/10 em paralelo', async () => {
    const api = mockProcessApi();
    renderWithShell(<ProcessPanel processId={PROCESS_ID} />);

    const title = await screen.findByRole('heading', {
      level: 1,
      name: 'Aquisição de cimento para manutenção de vias',
    });
    // Foco no título ao carregar.
    expect(document.activeElement).toBe(title);
    expect(screen.getByText('0012/2026')).toBeTruthy();
    expect(screen.getByText('Em andamento', { selector: 'span' })).toBeTruthy();
    // US-033: acesso à tela de riscos (SCR-011).
    expect(screen.getByRole('link', { name: 'Riscos' }).getAttribute('href')).toBe(
      `/processos/${PROCESS_ID}/riscos`,
    );

    expect(section('Onde está').textContent).toContain(
      'ETP e mapa de riscos — Setor de Planejamento — Em andamento',
    );
    const responsible = section('Responsável').textContent;
    expect(responsible).toContain(MARCOS.name);
    expect(responsible).toContain('desde 01/10/2026');
    const pending = section('O que falta');
    expect(pending.textContent).toContain('1 pendência obrigatória e 1 recomendação');
    expect(within(pending).getByText('O ETP deve estar completo.')).toBeTruthy();
    expect(within(pending).getByText('Recomenda-se elaborar o mapa de riscos.')).toBeTruthy();
    const next = section('Próximo passo');
    expect(within(next).getByText('ETP', { selector: 'strong' })).toBeTruthy();
    expect(within(next).getByText('Anexe a pesquisa preliminar')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Encaminhar para Pesquisa de preços' })).toBeTruthy();
    expect(within(section('Prazos')).getByText('Vence em 2 dias úteis')).toBeTruthy();
    expect(section('Prazos').textContent).toContain('Prazo alvo: 30/11/2026');
    const documents = section('Documentos');
    expect(
      within(documents).getByRole('link', { name: 'DFD 0005/2026 — Aprovado — v2' }),
    ).toBeTruthy();
    expect(within(documents).getByRole('link', { name: 'ETP 0003/2026 — Rascunho' })).toBeTruthy();
    expect(
      within(section('Aprovações pendentes')).getByText('Nenhuma aprovação pendente'),
    ).toBeTruthy();

    // Stepper: lista ordenada com a etapa atual em `aria-current="step"` e as passagens.
    const stepper = await screen.findByRole('heading', { level: 2, name: 'Etapas do processo' });
    const current = await waitFor(() => {
      const item = stepper.closest('section')?.querySelector('[aria-current="step"]');
      if (!item) throw new Error('sem etapa atual');
      return item;
    });
    expect(current.textContent).toContain('ETP e mapa de riscos');
    expect(screen.getAllByText('2 passagens')).toHaveLength(2);
    expect(screen.getAllByText(/Não percorrida/)).toHaveLength(2);
    expect(screen.getByText('Planejamento', { selector: 'span' })).toBeTruthy();

    // Abas com os contadores do resumo.
    expect(screen.getByRole('tab', { name: 'Documentos (2)' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Comentários (5)' })).toBeTruthy();

    for (const url of ['', '/summary', '/available-actions', '/stages']) {
      expect(callsTo(api, 'GET', `/api/v1/processes/${PROCESS_ID}${url}`)).toHaveLength(1);
    }
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('[Validação] pendência bloqueante desabilita a ação primária com explicação e leva ao ETP', async () => {
    mockProcessApi();
    renderWithShell(<ProcessPanel processId={PROCESS_ID} />);
    const button = await screen.findByRole('button', {
      name: 'Encaminhar para Pesquisa de preços',
    });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    const hintId = button.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(hintId)?.textContent).toContain(
      'Encaminhar — há 1 pendência obrigatória nesta etapa.',
    );
    expect(screen.getByRole('link', { name: 'Ver pendências' }).getAttribute('href')).toBe(
      '#pendencias',
    );
    fireEvent.click(button);
    expect(screen.queryByRole('status', { name: /diálogo/ })).toBeNull();
    const link = within(section('O que falta')).getByRole('link', { name: 'Abrir documento' });
    expect(link.getAttribute('href')).toBe(`/processos/${PROCESS_ID}/documentos/${ETP_ID}`);
    expect(within(section('O que falta')).getByText('Criar RISK_MAP')).toBeTruthy();
  });

  it('[Sucesso] aprovador designado: "Decidir aprovação" leva à aprovação e o bloco destaca a decisão', async () => {
    const approvalId = ID(900);
    mockProcessApi({
      summary: () =>
        jsonResponse({
          data: summaryDto({
            header: { ...summaryDto().header, status: 'AWAITING_APPROVAL' },
            responsible: {
              user: null,
              queueDepartment: null,
              since: null,
              approver: { approvalId, label: 'Roberto Siqueira', isMine: true },
            },
            nextStep: {
              action: {
                action: 'DECIDE_APPROVAL',
                approvalId,
                label: 'Decidir aprovação',
                enabled: true,
                reasons: [],
              },
              instructions: null,
            },
            approvals: [
              {
                id: approvalId,
                title: 'Aprovação do planejamento',
                approverLabel: 'Roberto Siqueira',
                requestedAt: '2026-10-04T12:00:00.000Z',
                dueAt: '2026-10-09T02:59:59.000Z',
                isOverdue: false,
                isMine: true,
              },
            ],
          }),
        }),
    });
    renderWithShell(<ProcessPanel processId={PROCESS_ID} />);
    const decide = await screen.findByRole('link', { name: 'Decidir aprovação' });
    expect(decide.getAttribute('href')).toBe(`/aprovacoes/${approvalId}`);
    expect(section('Responsável').textContent).toContain('Aguardando decisão de Roberto Siqueira');
    expect(
      within(section('Aprovações pendentes')).getByText('Aguardando sua decisão'),
    ).toBeTruthy();
  });

  it('[Permissão] leitura sem ações e valor sigiloso mascarado; documento restrito com cadeado e sem link', async () => {
    mockProcessApi({
      summary: () =>
        jsonResponse({
          data: summaryDto({
            header: {
              ...summaryDto().header,
              isBudgetConfidential: true,
              estimatedValue: null,
              estimatedValueMasked: true,
            },
            nextStep: { action: null, instructions: null },
            documents: [
              {
                id: ID(503),
                typeCode: 'PRICE_RESEARCH',
                typeName: 'Pesquisa de preços',
                code: 'PP 0002/2026',
                title: 'Pesquisa de preços — limpeza',
                status: 'APPROVED',
                versionNumber: 1,
                confidentiality: 'RESTRICTED',
                restricted: true,
                inApproval: false,
              },
            ],
          }),
        }),
    });
    renderWithShell(<ProcessPanel processId={PROCESS_ID} />);
    // Selo do cabeçalho e o rótulo do interruptor (US-013).
    expect(await screen.findAllByText('Orçamento sigiloso')).not.toHaveLength(0);
    expect(screen.getAllByText('Sigiloso').length).toBeGreaterThan(0);
    // US-013: sem PROCESS_SET_CONFIDENTIAL_BUDGET, o interruptor aparece desabilitado.
    const confidential = await screen.findByRole('switch', { name: 'Orçamento sigiloso' });
    expect((confidential as HTMLButtonElement).disabled).toBe(true);
    const documents = section('Documentos');
    expect(within(documents).queryByRole('link')).toBeNull();
    expect(documents.textContent).toContain('PP 0002/2026 — Aprovado — v1');
    expect(documents.textContent).toContain('Conteúdo restrito (orçamento sigiloso)');
    // Nenhuma ação de tramitação: sem ação primária nem menu "Mais".
    expect(screen.getByText(`Com ${MARCOS.name} — Setor de Planejamento`)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Mais ações do processo' })).toBeNull();
  });

  it('[Permissão] sem custódia: "Com Marcos — Setor de Planejamento" e o encaminhamento em "Mais" com o motivo', async () => {
    mockProcessApi({
      summary: () =>
        jsonResponse({ data: summaryDto({ nextStep: { action: null, instructions: null } }) }),
      actions: () => jsonResponse({ data: [forwardEntry()] }),
    });
    renderWithShell(<ProcessPanel processId={PROCESS_ID} />);
    expect(await screen.findByText(`Com ${MARCOS.name} — Setor de Planejamento`)).toBeTruthy();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Mais ações do processo' }));
    const item = await screen.findByRole('menuitem', {
      name: /Encaminhar para Pesquisa de preços/,
    });
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(item.textContent).toContain(
      'Indisponível: Somente quem está com o processo pode encaminhá-lo.',
    );
  });

  it('[Tenant incorreto] 404: "Processo não encontrado ou você não tem acesso a ele." com volta à lista', async () => {
    mockProcessApi({
      summary: () => problemResponse(404, 'PROCESS_NOT_FOUND'),
      process: () => problemResponse(404, 'PROCESS_NOT_FOUND'),
    });
    renderWithShell(<ProcessPanel processId={PROCESS_ID} />);
    expect(
      await screen.findByText('Processo não encontrado ou você não tem acesso a ele.'),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Voltar para Processos' }).getAttribute('href')).toBe(
      '/processos',
    );
  });

  it('[Falha de banco] sem cache: erro com o código e "Tentar novamente"', async () => {
    let fail = true;
    const api = mockProcessApi({
      summary: () =>
        fail
          ? problemResponse(503, 'DEPENDENCY_UNAVAILABLE', { correlationId: 'c-503' })
          : jsonResponse({ data: summaryDto() }),
    });
    renderWithShell(<ProcessPanel processId={PROCESS_ID} />, { queryClient: noRetryClient() });
    expect(await screen.findByText('Não foi possível carregar o processo agora.')).toBeTruthy();
    expect(screen.getByText('Código: c-503')).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Onde está' })).toBeTruthy();
    expect(callsTo(api, 'GET', `/api/v1/processes/${PROCESS_ID}/summary`)).toHaveLength(2);
  });

  it('[Falha de banco] com cache: mostra os dados com o aviso e desabilita as ações', async () => {
    let fail = false;
    mockProcessApi({
      summary: () =>
        fail
          ? problemResponse(503, 'DEPENDENCY_UNAVAILABLE')
          : jsonResponse({
              data: summaryDto({
                nextStep: {
                  action: { action: 'FORWARD', label: 'Encaminhar', enabled: true, reasons: [] },
                  instructions: null,
                },
              }),
            }),
    });
    const { queryClient } = renderWithShell(<ProcessPanel processId={PROCESS_ID} />, {
      queryClient: noRetryClient(),
    });
    const button = await screen.findByRole('button', { name: 'Encaminhar' });
    expect(button.getAttribute('aria-disabled')).toBeNull();
    fail = true;
    await act(async () => {
      await queryClient.refetchQueries();
    });
    expect(
      await screen.findByText(/^Exibindo dados de \d{2}:\d{2}\. Não foi possível atualizar\.$/),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Encaminhar' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    expect(screen.getByRole('heading', { level: 2, name: 'Onde está' })).toBeTruthy();
  });

  it('ação habilitada sem o diálogo da story dona avisa por toast', async () => {
    mockProcessApi({
      summary: () =>
        jsonResponse({
          data: summaryDto({
            nextStep: {
              action: { action: 'COMPLETE', label: 'Concluir', enabled: true, reasons: [] },
              instructions: null,
            },
          }),
        }),
    });
    renderWithShell(
      <>
        <ProcessPanel processId={PROCESS_ID} />
        <Toaster />
      </>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Concluir' }));
    expect(
      await screen.findByText(
        'Esta ação abre o diálogo próprio, ainda não disponível nesta versão.',
      ),
    ).toBeTruthy();
  });

  it('[Sucesso] US-007: "Etiquetas" no cabeçalho abre o seletor com as etiquetas aplicadas; PUT usa a versão do PRC-04', async () => {
    const tagId = ID(901);
    const api = mockProcessApi({
      permissions: ['PROCESS_VIEW', 'PROCESS_UPDATE'],
      summary: () =>
        jsonResponse({
          data: summaryDto({
            header: {
              ...summaryDto().header,
              tags: [{ id: tagId, name: 'Obras emergenciais', color: '#B45309', isActive: true }],
            },
          }),
        }),
      actions: () =>
        jsonResponse({
          data: [{ action: 'MANAGE_TAGS', label: 'Etiquetas', enabled: true, reasons: [] }],
        }),
      tags: (_url, init) =>
        init?.method === 'PUT'
          ? jsonResponse({ data: { tags: [] } }, { headers: { ETag: '"2"' } })
          : jsonResponse({
              data: [
                {
                  id: tagId,
                  name: 'Obras emergenciais',
                  color: '#B45309',
                  isActive: true,
                  version: 1,
                },
              ],
            }),
    });
    renderWithShell(
      <>
        <ProcessPanel processId={PROCESS_ID} />
        <Toaster />
      </>,
    );
    const chips = await screen.findByRole('list', { name: 'Etiquetas' });
    expect(within(chips).getByText('Obras emergenciais')).toBeTruthy();
    await userEvent.click(await screen.findByRole('button', { name: 'Etiquetas (1)' }));
    const dialog = await screen.findByRole('dialog', { name: 'Etiquetas do processo' });
    const option = await within(dialog).findByRole('option', { name: /Obras emergenciais/ });
    expect(option.getAttribute('aria-selected')).toBe('true');
    await userEvent.click(option);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Aplicar etiquetas' }));
    await waitFor(() => {
      expect(callsTo(api, 'PUT', `/api/v1/processes/${PROCESS_ID}/tags`)).toHaveLength(1);
    });
    const [call] = callsTo(api, 'PUT', `/api/v1/processes/${PROCESS_ID}/tags`);
    // Sem custódia adicional: If-Match = versão do processo (PRC-04) e conjunto vazio.
    expect(call?.headers.get('If-Match')).toBe('"1"');
    expect(call?.body).toEqual({ tagIds: [] });
  });

  it('deep link de aba (`?aba=documentos`) abre a aba; aba desconhecida abre o Resumo (V-06)', async () => {
    mockProcessApi();
    nav.set(`/processos/${PROCESS_ID}?aba=documentos`);
    const { unmount } = renderWithShell(<ProcessPanel processId={PROCESS_ID} />);
    const tab = await screen.findByRole('tab', { name: 'Documentos (2)' });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    // US-062: a aba carrega o painel de documentos (DOC-01 + DTY-01).
    expect(
      await within(screen.getByRole('tabpanel')).findByText('Nenhum documento ainda.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Itens (3)' }));
    expect(nav.replace).toHaveBeenLastCalledWith(`/processos/${PROCESS_ID}?aba=itens`, {
      scroll: false,
    });
    unmount();

    nav.set(`/processos/${PROCESS_ID}?aba=xyz`);
    renderWithShell(<ProcessPanel processId={PROCESS_ID} />);
    expect((await screen.findByRole('tab', { name: 'Resumo' })).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('FA-06/FA-07/FA-08: suspenso com prazo pausado, concluído em modo leitura e rascunho sem número', async () => {
    mockProcessApi({
      summary: () =>
        jsonResponse({
          data: summaryDto({
            where: {
              ...summaryDto().where,
              status: 'SUSPENDED',
              statusBeforeSuspension: 'IN_PROGRESS',
              suspensionReason: 'Aguardando orçamento.',
              suspendedAt: '2026-10-03T12:00:00.000Z',
            },
            deadline: {
              dueAt: '2026-10-08T02:59:59.000Z',
              slaType: 'BUSINESS',
              daysLeft: null,
              overdueDays: null,
              isDueSoon: false,
              isOverdue: false,
              isPaused: true,
            },
            nextStep: {
              action: { action: 'RESUME', label: 'Retomar', enabled: true, reasons: [] },
              instructions: null,
            },
          }),
        }),
    });
    const { unmount } = renderWithShell(<ProcessPanel processId={PROCESS_ID} />);
    expect(
      await screen.findByText('Suspenso em 03/10/2026 — motivo: Aguardando orçamento.'),
    ).toBeTruthy();
    expect(within(section('Prazos')).getByText('Prazo pausado')).toBeTruthy();
    // US-008: banner "Suspenso desde … — motivo" e "Retomar" abre o diálogo SCR-116.
    expect(screen.getByText('Suspenso desde 03/10/2026 — Aguardando orçamento.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Retomar' }));
    expect(await screen.findByRole('dialog', { name: 'Retomar processo' })).toBeTruthy();
    unmount();

    mockProcessApi({
      summary: () =>
        jsonResponse({
          data: summaryDto({
            header: { ...summaryDto().header, code: null, status: 'COMPLETED' },
            where: {
              ...summaryDto().where,
              stage: {
                key: 'CONCLUSAO',
                name: 'Planejamento da contratação concluído',
                type: 'END',
                groupLabel: null,
              },
              status: 'COMPLETED',
              completedAt: '2026-10-02T17:00:00.000Z',
            },
            responsible: { user: null, queueDepartment: null, since: null, approver: null },
            deadline: null,
            nextStep: { action: null, instructions: null },
          }),
        }),
    });
    renderWithShell(<ProcessPanel processId={PROCESS_ID} />);
    expect(
      await screen.findByText('Planejamento da contratação concluído em 02/10/2026'),
    ).toBeTruthy();
    expect(screen.getByText('Processo encerrado — sem prazos em curso.')).toBeTruthy();
    expect(screen.getByText('Processo em modo leitura.')).toBeTruthy();
    expect(screen.getByText('Rascunho (sem número)')).toBeTruthy();
  });

  it('[Concorrência] comando recusado por dado desatualizado: avisa e recarrega o painel', async () => {
    const api = mockProcessApi();
    let recover: ((error: unknown) => boolean) | undefined;
    function Harness() {
      const stale = useStaleProcessRecovery(PROCESS_ID);
      recover = stale.recover;
      return stale.conflict ? <p>Este processo foi atualizado por outra pessoa.</p> : null;
    }
    renderWithShell(
      <>
        <ProcessPanel processId={PROCESS_ID} />
        <Harness />
      </>,
    );
    await screen.findByRole('heading', { level: 2, name: 'Onde está' });
    const before = callsTo(api, 'GET', `/api/v1/processes/${PROCESS_ID}/summary`).length;
    act(() => {
      expect(recover?.(new ApiError({ status: 422, code: 'VALIDATION_ERROR' }))).toBe(false);
      expect(recover?.(new ApiError({ status: 412, code: 'VERSION_CONFLICT' }))).toBe(true);
    });
    expect(await screen.findByText('Este processo foi atualizado por outra pessoa.')).toBeTruthy();
    await waitFor(() => {
      expect(callsTo(api, 'GET', `/api/v1/processes/${PROCESS_ID}/summary`).length).toBeGreaterThan(
        before,
      );
    });
  });

  it('[US-047] "Encaminhar" abre o painel SCR-103 na transição da ação e devolve o foco ao cabeçalho de status', async () => {
    const user = userEvent.setup();
    const base = mockProcessApi({
      summary: () =>
        jsonResponse({
          data: summaryDto({
            nextStep: {
              action: {
                action: 'FORWARD',
                transitionKey: 'ESTUDOS_PARA_PESQUISA',
                label: 'Encaminhar para Pesquisa de preços',
                enabled: true,
                reasons: [],
              },
              instructions: null,
            },
          }),
        }),
      actions: () => jsonResponse({ data: [previewEntry()] }),
    });
    // PRC-09 e PRC-19 não fazem parte do mock padrão do painel.
    const api = vi.fn<typeof fetch>((input, init) => {
      const url = requestUrl(input);
      if (url.endsWith('/checklist')) {
        return Promise.resolve(jsonResponse({ data: { violations: [] } }));
      }
      if (url === FORWARD_URL) return Promise.resolve(jsonResponse({ data: forwardedDto() }));
      return base(input, init);
    });
    vi.stubGlobal('fetch', api);
    renderWithShell(
      <>
        <ProcessPanel processId={PROCESS_ID} />
        <Toaster />
      </>,
    );

    await user.click(
      await screen.findByRole('button', { name: 'Encaminhar para Pesquisa de preços' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Encaminhar processo' });
    expect(
      within(dialog).getByRole<HTMLInputElement>('radio', {
        name: 'Encaminhar para pesquisa de preços',
      }).checked,
    ).toBe(true);

    await user.click(within(dialog).getByRole('button', { name: 'Encaminhar' }));
    expect(
      await screen.findByText(
        'Processo encaminhado para Pesquisa de preços — Departamento de Compras',
      ),
    ).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Encaminhar processo' })).toBeNull();
    });
    // O foco vai ao cabeçalho de status, não ao botão que abriu o painel.
    const status = screen.getByRole('group', { name: 'Situação do processo' });
    await waitFor(() => {
      expect(document.activeElement).toBe(status);
    });
    expect(callsTo(api as never, 'POST', FORWARD_URL)).toHaveLength(1);
  });

  it('[US-048] "Devolver" (menu Mais) abre o diálogo SCR-104 com a etapa da ação e devolve o foco ao cabeçalho de status', async () => {
    const user = userEvent.setup();
    const base = mockProcessApi({
      actions: () => jsonResponse({ data: [returnEntry()] }),
    });
    const api = vi.fn<typeof fetch>((input, init) => {
      if (requestUrl(input) === RETURN_URL) {
        return Promise.resolve(jsonResponse({ data: returnedDto() }));
      }
      return base(input, init);
    });
    vi.stubGlobal('fetch', api);
    renderWithShell(
      <>
        <ProcessPanel processId={PROCESS_ID} />
        <Toaster />
      </>,
    );

    await user.click(await screen.findByRole('button', { name: 'Mais ações do processo' }));
    await user.click(await screen.findByRole('menuitem', { name: /Devolver à formalização/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Devolver processo' });
    expect(
      within(dialog).getByRole<HTMLInputElement>('radio', { name: /Formalização da demanda/ })
        .checked,
    ).toBe(true);
    await user.type(
      within(dialog).getByLabelText('Motivo da devolução'),
      'Faltou detalhar a justificativa da contratação no DFD',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Devolver' }));
    expect(await screen.findByText('Processo devolvido para Formalização da demanda')).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Devolver processo' })).toBeNull();
    });
    const status = screen.getByRole('group', { name: 'Situação do processo' });
    await waitFor(() => {
      expect(document.activeElement).toBe(status);
    });
    expect(callsTo(api as never, 'POST', RETURN_URL)).toHaveLength(1);
  });

  describe('[US-049] Assumir', () => {
    const CLAIM_URL = `${PROCESS_URL}/claim`;
    const claimSummary = () =>
      jsonResponse({
        data: summaryDto({
          nextStep: {
            action: { action: 'CLAIM', label: 'Assumir', enabled: true, reasons: [] },
            instructions: null,
          },
        }),
      });
    const withClaim = (answer: () => Response) => {
      const base = mockProcessApi({ summary: claimSummary });
      const api = vi.fn<typeof fetch>((input, init) => {
        if (requestUrl(input) === CLAIM_URL) return Promise.resolve(answer());
        return base(input, init);
      });
      vi.stubGlobal('fetch', api);
      renderWithShell(
        <>
          <ProcessPanel processId={PROCESS_ID} />
          <Toaster />
        </>,
      );
      return api;
    };

    it('[Sucesso] "Assumir" chama o PRC-21 sem corpo, com o If-Match da versão do PRC-04, avisa por toast e recarrega o painel', async () => {
      const api = withClaim(() => jsonResponse({ data: processDto({ status: 'IN_PROGRESS' }) }));

      fireEvent.click(await screen.findByRole('button', { name: 'Assumir' }));

      expect(await screen.findByText('Você assumiu este processo.')).toBeTruthy();
      const [call, ...more] = callsTo(api, 'POST', CLAIM_URL);
      expect(more).toEqual([]);
      expect(call?.headers.get('If-Match')).toBe(`"${String(processDto().version)}"`);
      expect(call?.init?.body ?? null).toBeNull();
      // Nenhum diálogo de confirmação (ação reversível e sem efeitos sensíveis).
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('[Duplicidade] clique duplo: o 412 do reenvio vale como sucesso já aplicado, sem erro percebido', async () => {
      withClaim(() => problemResponse(412, 'VERSION_CONFLICT'));

      fireEvent.click(await screen.findByRole('button', { name: 'Assumir' }));

      await waitFor(() => {
        expect(screen.queryByRole('button', { name: 'Assumir' })).toBeTruthy();
      });
      expect(screen.queryByText(/Ocorreu um erro inesperado/)).toBeNull();
      expect(screen.queryByText('Os dados do processo mudaram. Atualize a página.')).toBeNull();
    });

    it('[Concorrência] 409 mostra quem assumiu o processo', async () => {
      withClaim(() =>
        problemResponse(409, 'PROCESS_ALREADY_ASSIGNED', {
          extension: { currentResponsible: { id: ID(77), name: 'Marina Costa' } },
        }),
      );

      fireEvent.click(await screen.findByRole('button', { name: 'Assumir' }));

      expect(
        await screen.findByText('Este processo já foi assumido por Marina Costa.'),
      ).toBeTruthy();
    });

    it('[Falha de banco] 503 avisa para tentar de novo e mantém o botão', async () => {
      withClaim(() => problemResponse(503, 'DEPENDENCY_UNAVAILABLE'));

      fireEvent.click(await screen.findByRole('button', { name: 'Assumir' }));

      expect(
        await screen.findByText(
          'Não foi possível assumir o processo agora. Tente novamente em instantes.',
        ),
      ).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Assumir' })).toBeTruthy();
    });
  });
});

describe('process-panel.api', () => {
  it('isStaleProcessError: 409 STAGE_CHANGED, 412 VERSION_CONFLICT e perda de custódia', () => {
    expect(isStaleProcessError(new ApiError({ status: 409, code: 'STAGE_CHANGED' }))).toBe(true);
    expect(isStaleProcessError(new ApiError({ status: 412, code: 'VERSION_CONFLICT' }))).toBe(true);
    expect(isStaleProcessError(new ApiError({ status: 403, code: 'NOT_PROCESS_CUSTODIAN' }))).toBe(
      true,
    );
    expect(isStaleProcessError(new ApiError({ status: 403, code: 'PERMISSION_DENIED' }))).toBe(
      false,
    );
    expect(isStaleProcessError(new Error('x'))).toBe(false);
  });

  it('panelRefetchInterval: 60 s; 429 suspende até o Retry-After', () => {
    const now = 1_000_000;
    const state = (error: unknown, errorUpdatedAt = now) => ({
      state: { error, errorUpdatedAt } as never,
    });
    expect(panelRefetchInterval(state(null), now)).toBe(PANEL_REFETCH_MS);
    const limited = new ApiError({ status: 429, code: 'RATE_LIMITED', retryAfterSeconds: 10 });
    expect(panelRefetchInterval(state(limited), now + 5_000)).toBe(false);
    expect(panelRefetchInterval(state(limited), now + 11_000)).toBe(PANEL_REFETCH_MS);
  });
});

describe('US-008 — suspensão no painel (SCR-006)', () => {
  it('FA-01: aprovação pendente de processo suspenso mostra "decisão indisponível até a retomada"', async () => {
    mockProcessApi({
      summary: () =>
        jsonResponse({
          data: summaryDto({
            where: {
              ...summaryDto().where,
              status: 'SUSPENDED',
              statusBeforeSuspension: 'AWAITING_APPROVAL',
              suspensionReason: 'Determinação do tribunal de contas.',
              suspendedAt: '2026-10-03T12:00:00.000Z',
            },
            responsible: {
              user: null,
              queueDepartment: null,
              since: null,
              approver: { approvalId: ID(777), label: 'Roberto Lima', isMine: true },
            },
          }),
        }),
    });
    renderWithShell(<ProcessPanel processId={PROCESS_ID} />);
    expect(await screen.findByText('Aguardando decisão de Roberto Lima')).toBeTruthy();
    expect(
      screen.getByText('Processo suspenso — decisão indisponível até a retomada'),
    ).toBeTruthy();
  });
});

describe('US-009 — cancelar e descartar no painel (SCR-006)', () => {
  it('"Cancelar processo" e "Descartar rascunho" (menu "Mais") abrem os diálogos SCR-116', async () => {
    const user = userEvent.setup();
    mockProcessApi({
      actions: () =>
        jsonResponse({
          data: [
            { action: 'CANCEL', label: 'Cancelar processo', enabled: true, reasons: [] },
            { action: 'DISCARD', label: 'Descartar rascunho', enabled: true, reasons: [] },
          ],
        }),
    });
    renderWithShell(<ProcessPanel processId={PROCESS_ID} />);

    await user.click(await screen.findByRole('button', { name: 'Mais ações do processo' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Cancelar processo' }));
    expect(await screen.findByRole('dialog', { name: 'Cancelar processo' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Voltar' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Cancelar processo' })).toBeNull();
    });

    await user.click(screen.getByRole('button', { name: 'Mais ações do processo' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Descartar rascunho' }));
    expect(await screen.findByRole('dialog', { name: 'Descartar rascunho' })).toBeTruthy();
  });
});
