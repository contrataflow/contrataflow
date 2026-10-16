// @vitest-environment jsdom
import type { ActionEntry, ChecklistViolation } from '@contrataflow/validation';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seriousA11yViolations } from '@test/support/axe';
import { jsonResponse, problem, renderWithShell, requestUrl } from '@test/support/render';

import { AvailableActionsPanel } from './available-actions-panel';
import { orderActions, splitViolations } from './process-actions.api';
import { StageChecklist } from './stage-checklist';

configure({ asyncUtilTimeout: 5000 });
vi.setConfig({ testTimeout: 30_000 });

/*
 * US-041 — painel situacional (consumidor de PRC-08/PRC-09): botões habilitados e desabilitados com
 * o motivo acessível, checklist com bloqueantes em destaque, estados de carga e de erro.
 */

const PROCESS = '0192a000-0000-7000-8000-0000000000f1';
const RULE = '0192a000-0000-7000-8000-0000000000e1';

const FORWARD: ActionEntry = {
  action: 'FORWARD',
  transitionKey: 'ESTUDOS_PRELIMINARES_FORWARD_PESQUISA_PRECOS',
  toStageKey: 'PESQUISA_PRECOS',
  label: 'Encaminhar para pesquisa de preços',
  enabled: true,
  primary: true,
  reasons: [],
};
const RETURN: ActionEntry = {
  action: 'RETURN',
  transitionKey: 'ESTUDOS_PRELIMINARES_RETURN_ABERTURA',
  toStageKey: 'ABERTURA',
  label: 'Devolver para a formalização da demanda',
  enabled: false,
  reasons: [
    { code: 'NOT_PROCESS_CUSTODIAN', message: 'Você não é o responsável atual pelo processo.' },
  ],
};
const CANCEL: ActionEntry = {
  action: 'CANCEL',
  label: 'Cancelar processo',
  enabled: true,
  reasons: [],
};

const violation = (overrides: Partial<ChecklistViolation>): ChecklistViolation => ({
  code: 'WORKFLOW_RULE',
  severity: 'BLOCKING',
  message: 'O ETP deve estar completo.',
  ruleId: RULE,
  sectionKey: null,
  field: null,
  itemId: null,
  params: {},
  name: 'ETP completo',
  type: 'REQUIRED_DOCUMENT',
  satisfied: false,
  scope: 'STAGE_EXIT',
  ...overrides,
});

type Handler = () => Response;

function mockApi(routes: { readonly actions?: Handler; readonly checklist?: Handler }) {
  const fetchMock = vi.fn<typeof fetch>((input) => {
    const url = requestUrl(input);
    if (url === `/api/v1/processes/${PROCESS}/available-actions` && routes.actions) {
      return Promise.resolve(routes.actions());
    }
    if (url === `/api/v1/processes/${PROCESS}/checklist` && routes.checklist) {
      return Promise.resolve(routes.checklist());
    }
    return Promise.resolve(problem(404, 'NOT_FOUND'));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AvailableActionsPanel (US-041 · PRC-08)', () => {
  it('ações habilitadas clicáveis; indisponível com aria-disabled e o motivo em aria-describedby (axe sem violações sérias)', async () => {
    mockApi({ actions: () => jsonResponse({ data: [CANCEL, RETURN, FORWARD] }) });
    const onAction = vi.fn();
    const user = userEvent.setup();
    renderWithShell(<AvailableActionsPanel processId={PROCESS} onAction={onAction} />);

    const forward = await screen.findByRole('button', { name: FORWARD.label });
    const buttons = within(screen.getByRole('list')).getAllByRole('button');
    // A principal vem primeiro; as demais na ordem da API.
    expect(buttons.map((button) => button.textContent)).toEqual([
      FORWARD.label,
      CANCEL.label,
      RETURN.label,
    ]);

    await user.click(forward);
    expect(onAction).toHaveBeenCalledWith(FORWARD);

    const back = screen.getByRole('button', { name: RETURN.label });
    expect(back.getAttribute('aria-disabled')).toBe('true');
    const describedBy = back.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toBe(
      'Indisponível: Você não é o responsável atual pelo processo.',
    );
    await user.click(back);
    expect(onAction).toHaveBeenCalledTimes(1);

    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('sem ações para o usuário: mensagem explicativa', async () => {
    mockApi({ actions: () => jsonResponse({ data: [] }) });
    renderWithShell(<AvailableActionsPanel processId={PROCESS} />);
    expect(await screen.findByText('Nenhuma ação disponível para você nesta etapa.')).toBeTruthy();
  });

  it('banco indisponível (503): mensagem e "Tentar novamente" recarrega', async () => {
    // As novas tentativas automáticas (5xx) também falham; só depois do clique o banco volta.
    let healthy = false;
    mockApi({
      actions: () =>
        healthy ? jsonResponse({ data: [FORWARD] }) : problem(503, 'DEPENDENCY_UNAVAILABLE'),
    });
    const user = userEvent.setup();
    renderWithShell(<AvailableActionsPanel processId={PROCESS} />);
    expect(
      await screen.findByText(
        'Não foi possível calcular as ações agora. Tente novamente em instantes.',
        {},
        { timeout: 10_000 },
      ),
    ).toBeTruthy();
    healthy = true;
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByRole('button', { name: FORWARD.label })).toBeTruthy();
  });

  it('processo não encontrado (404) e erro inesperado com o código', async () => {
    mockApi({});
    const { unmount } = renderWithShell(<AvailableActionsPanel processId={PROCESS} />);
    expect(await screen.findByText('Processo não encontrado.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Tentar novamente' })).toBeNull();
    unmount();

    mockApi({ actions: () => problem(500, 'INTERNAL_ERROR', 'corr-123') });
    renderWithShell(<AvailableActionsPanel processId={PROCESS} />);
    // 5xx: o erro aparece depois das novas tentativas automáticas.
    expect(
      await screen.findByText(
        'Ocorreu um erro inesperado. Código: corr-123.',
        {},
        { timeout: 10_000 },
      ),
    ).toBeTruthy();
  });

  it('skeleton anunciado enquanto carrega', async () => {
    let release: (response: Response) => void = () => undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      ),
    );
    renderWithShell(<AvailableActionsPanel processId={PROCESS} />);
    expect(screen.getByText('Carregando as ações do processo…')).toBeTruthy();
    release(jsonResponse({ data: [FORWARD] }));
    expect(await screen.findByRole('button', { name: FORWARD.label })).toBeTruthy();
  });
});

describe('StageChecklist (US-041 · PRC-09)', () => {
  it('bloqueantes antes dos avisos, com a severidade escrita (não só cor) e axe sem violações sérias', async () => {
    mockApi({
      checklist: () =>
        jsonResponse({
          data: {
            violations: [
              violation({
                severity: 'WARNING',
                ruleId: '0192a000-0000-7000-8000-0000000000e2',
                name: 'Mapa de riscos',
                message: 'Recomenda-se registrar o mapa de riscos.',
              }),
              violation({}),
            ],
          },
        }),
    });
    renderWithShell(<StageChecklist processId={PROCESS} />);
    expect(await screen.findByText('2 pendências')).toBeTruthy();
    const items = screen.getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'Bloqueante: Impede o avanço até ser resolvida.O ETP deve estar completo.',
      'Aviso: Não impede o avanço; você confirma ciência ao encaminhar.Recomenda-se registrar o mapa de riscos.',
    ]);
    expect(await seriousA11yViolations()).toEqual([]);
  });

  it('sem pendências', async () => {
    mockApi({ checklist: () => jsonResponse({ data: { violations: [] } }) });
    renderWithShell(<StageChecklist processId={PROCESS} />);
    expect(await screen.findByText('Nenhuma pendência nesta etapa.')).toBeTruthy();
  });

  it('falha pontual na sondagem mantém o checklist já exibido', async () => {
    let calls = 0;
    mockApi({
      checklist: () => {
        calls += 1;
        return calls === 1
          ? jsonResponse({ data: { violations: [violation({})] } })
          : problem(503, 'DEPENDENCY_UNAVAILABLE');
      },
    });
    const { queryClient } = renderWithShell(<StageChecklist processId={PROCESS} />);
    expect(await screen.findByText('O ETP deve estar completo.')).toBeTruthy();
    await queryClient.refetchQueries();
    await waitFor(() => {
      expect(calls).toBeGreaterThanOrEqual(2);
    });
    expect(screen.getByText('O ETP deve estar completo.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('modelo do painel', () => {
  it('orderActions: principais primeiro, ordem estável', () => {
    expect(orderActions([CANCEL, RETURN, FORWARD]).map((entry) => entry.action)).toEqual([
      'FORWARD',
      'CANCEL',
      'RETURN',
    ]);
  });

  it('splitViolations separa bloqueantes e avisos', () => {
    const warning = violation({ severity: 'WARNING' });
    expect(splitViolations([warning, violation({})])).toEqual({
      blocking: [violation({})],
      warnings: [warning],
    });
  });
});
