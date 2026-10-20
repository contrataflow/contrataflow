// @vitest-environment jsdom
import { Toaster, clearToasts } from '@contrataflow/ui';
import type {
  ActionEntry,
  ChecklistViolation,
  CompletedProcessDto,
} from '@contrataflow/validation';
import { configure, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeQueryClient } from '@/lib/query/query-client';
import { seriousA11yViolations } from '@test/support/axe';
import {
  PROCESS_URL,
  checklistRule,
  defaultDocuments,
  inStudies,
  violation,
} from '@test/support/forward-fixtures';
import { ID, problemResponse } from '@test/support/process-fixtures';
import type { Handler } from '@test/support/process-fixtures';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { CompleteProcessDialog } from './complete-process-dialog';

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

const nav = { push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn() };
vi.mock('next/navigation', () => ({
  useRouter: () => nav,
  usePathname: () => '/processos/x',
}));

const COMPLETE_URL = `${PROCESS_URL}/complete`;
const PROCESS_ID = PROCESS_URL.split('/').at(-1) ?? '';
const T_COMPLETE = ID(904);
const RULE_ETP = ID(621);
const RULE_RISK = ID(622);
const COMMENT = 'Planejamento pronto para a seleção do fornecedor';
const ETP_MESSAGE = 'O ETP deve estar completo.';
const RISK_MESSAGE = 'Recomenda-se elaborar o mapa de riscos.';

beforeEach(() => {
  nav.push.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

const noRetryClient = () => {
  const client = makeQueryClient();
  client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retry: false } });
  return client;
};

function completeEntry(extra: Partial<ActionEntry> = {}): ActionEntry {
  return {
    action: 'COMPLETE',
    label: 'Concluir planejamento',
    enabled: true,
    reasons: [],
    transitionId: T_COMPLETE,
    transitionKey: 'ESTUDOS_COMPLETE_CONCLUSAO',
    toStageKey: 'CONCLUSAO',
    toStageName: 'Planejamento da contratação concluído',
    toStageType: 'END',
    primary: true,
    ...extra,
  };
}

function completedDto(): CompletedProcessDto {
  return {
    ...inStudies({ status: 'COMPLETED', version: 15 }),
    completedAt: '2026-10-20T15:00:00.000Z',
    completedBy: { id: ID(61), name: 'Carla Mendes' },
  };
}

function mockApi(
  options: { readonly complete?: Handler; readonly checklist?: readonly ChecklistViolation[] } = {},
) {
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    const answer = (handler: Handler) => Promise.resolve(handler(url, init));
    if (method === 'GET' && url === PROCESS_URL) {
      return answer(() => jsonResponse({ data: inStudies() }));
    }
    if (method === 'GET' && url === `${PROCESS_URL}/available-actions`) {
      return answer(() => jsonResponse({ data: [completeEntry()] }));
    }
    if (method === 'GET' && url === `${PROCESS_URL}/checklist`) {
      return answer(() => jsonResponse({ data: { violations: options.checklist ?? [] } }));
    }
    if (method === 'GET' && url.startsWith(`${PROCESS_URL}/documents`)) {
      return answer(() =>
        jsonResponse({
          data: defaultDocuments(),
          meta: { currentStage: null, creatableTypeIds: [], pendingTypeIds: [] },
        }),
      );
    }
    if (method === 'POST' && url === COMPLETE_URL) {
      return answer(options.complete ?? (() => jsonResponse({ data: completedDto() })));
    }
    return Promise.resolve(problemResponse(404, 'NOT_FOUND'));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const callsTo = (api: ReturnType<typeof mockApi>, method: string, url: string) =>
  api.mock.calls
    .filter(([input, init]) => requestUrl(input) === url && (init?.method ?? 'GET') === method)
    .map(([, init]) => ({
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    }));

function Harness({
  onOpenChange,
  onDone,
}: {
  readonly onOpenChange: (open: boolean) => void;
  readonly onDone?: () => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <CompleteProcessDialog
        processId={PROCESS_ID}
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          onOpenChange(next);
        }}
        onDone={onDone}
        retry={{ retries: 0 }}
      />
      <Toaster />
    </>
  );
}

const submitButton = () =>
  screen.getByRole<HTMLButtonElement>('button', { name: 'Concluir processo' });

describe('SCR-116 · Diálogo "Concluir processo" (US-010)', () => {
  it('[Sucesso] confirma com a observação, envia o PRC-26 com If-Match e Idempotency-Key e avisa "Processo concluído"', async () => {
    const user = userEvent.setup();
    const api = mockApi();
    const onOpenChange = vi.fn();
    const onDone = vi.fn();
    renderWithShell(<Harness onOpenChange={onOpenChange} onDone={onDone} />, {
      queryClient: noRetryClient(),
    });
    await screen.findByRole('dialog', { name: 'Concluir processo' });
    expect(
      await screen.findByText('Etapa final: Planejamento da contratação concluído'),
    ).toBeTruthy();
    expect(screen.getByText('Nenhuma pendência nesta etapa.')).toBeTruthy();
    const field = screen.getByLabelText('Observação (opcional)');
    await waitFor(() => {
      expect(document.activeElement).toBe(field);
    });
    await user.type(field, COMMENT);
    await waitFor(() => {
      expect(submitButton().disabled).toBe(false);
    });
    expect(await seriousA11yViolations(document.body)).toEqual([]);
    await user.click(submitButton());

    await waitFor(() => {
      expect(callsTo(api, 'POST', COMPLETE_URL)).toHaveLength(1);
    });
    const [call] = callsTo(api, 'POST', COMPLETE_URL);
    expect(call?.headers.get('If-Match')).toBe('"14"');
    expect(call?.headers.get('Idempotency-Key')).toBeTruthy();
    expect(call?.body).toEqual({ comment: COMMENT });
    expect(await screen.findByText('Processo concluído')).toBeTruthy();
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    expect(onDone).toHaveBeenCalled();
  });

  it('[Validação] pendência BLOCKING: botão desabilitado com a dica e a pendência listada', async () => {
    mockApi({ checklist: [checklistRule(RULE_ETP, 'BLOCKING', ETP_MESSAGE)] });
    renderWithShell(<Harness onOpenChange={vi.fn()} />, { queryClient: noRetryClient() });
    expect(await screen.findByText(ETP_MESSAGE)).toBeTruthy();
    expect(
      screen.getByText(
        'Há pendências que impedem a conclusão. Resolva-as no painel para continuar.',
      ),
    ).toBeTruthy();
    expect(submitButton().disabled).toBe(true);
  });

  it('FA-02: aviso WARNING exige "Entendo os avisos e quero continuar" e vai em acknowledgedWarnings', async () => {
    const user = userEvent.setup();
    const api = mockApi({ checklist: [checklistRule(RULE_RISK, 'WARNING', RISK_MESSAGE)] });
    renderWithShell(<Harness onOpenChange={vi.fn()} />, { queryClient: noRetryClient() });
    expect(await screen.findByText(RISK_MESSAGE)).toBeTruthy();
    await waitFor(() => {
      expect(submitButton().disabled).toBe(true);
    });
    await user.click(screen.getByLabelText('Entendo os avisos e quero continuar'));
    await waitFor(() => {
      expect(submitButton().disabled).toBe(false);
    });
    expect(await seriousA11yViolations(document.body)).toEqual([]);
    await user.click(submitButton());
    await waitFor(() => {
      expect(callsTo(api, 'POST', COMPLETE_URL)).toHaveLength(1);
    });
    expect(callsTo(api, 'POST', COMPLETE_URL)[0]?.body).toEqual({
      acknowledgedWarnings: [RULE_RISK],
    });
  });

  it('FA-01: 422 TRANSITION_BLOCKED da API mostra as pendências e mantém o diálogo aberto', async () => {
    const user = userEvent.setup();
    mockApi({
      complete: () =>
        problemResponse(422, 'TRANSITION_BLOCKED', {
          extension: { violations: [violation(RULE_ETP, 'BLOCKING', ETP_MESSAGE)] },
        }),
    });
    const onOpenChange = vi.fn();
    renderWithShell(<Harness onOpenChange={onOpenChange} />, { queryClient: noRetryClient() });
    await screen.findByText('Nenhuma pendência nesta etapa.');
    await waitFor(() => {
      expect(submitButton().disabled).toBe(false);
    });
    await user.click(submitButton());
    expect(await screen.findByText('Há pendências que impedem a conclusão.')).toBeTruthy();
    expect(screen.getByText(ETP_MESSAGE)).toBeTruthy();
    expect(submitButton().disabled).toBe(true);
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('[Concorrência] 412 mantém a observação e oferece "Recarregar"', async () => {
    const user = userEvent.setup();
    const api = mockApi({ complete: () => problemResponse(412, 'VERSION_CONFLICT') });
    renderWithShell(<Harness onOpenChange={vi.fn()} />, { queryClient: noRetryClient() });
    await user.type(await screen.findByLabelText('Observação (opcional)'), COMMENT);
    await waitFor(() => {
      expect(submitButton().disabled).toBe(false);
    });
    await user.click(submitButton());
    expect(
      await screen.findByText(
        'Este processo foi alterado por outra pessoa. Recarregue a página e tente novamente.',
      ),
    ).toBeTruthy();
    expect(screen.getByLabelText<HTMLTextAreaElement>('Observação (opcional)').value).toBe(COMMENT);
    await user.click(screen.getByRole('button', { name: 'Recarregar' }));
    await waitFor(() => {
      expect(callsTo(api, 'GET', PROCESS_URL).length).toBeGreaterThanOrEqual(2);
    });
  });

  it('[Permissão] 403 NOT_PROCESS_CUSTODIAN fecha o diálogo com a mensagem', async () => {
    const user = userEvent.setup();
    mockApi({ complete: () => problemResponse(403, 'NOT_PROCESS_CUSTODIAN') });
    const onOpenChange = vi.fn();
    renderWithShell(<Harness onOpenChange={onOpenChange} />, { queryClient: noRetryClient() });
    await screen.findByText('Nenhuma pendência nesta etapa.');
    await waitFor(() => {
      expect(submitButton().disabled).toBe(false);
    });
    await user.click(submitButton());
    expect(
      await screen.findByText('Apenas quem está com o processo pode concluí-lo.'),
    ).toBeTruthy();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('FA-04: 409 INVALID_PROCESS_STATUS (suspenso) fecha com "Retome o processo antes de concluí-lo."', async () => {
    const user = userEvent.setup();
    mockApi({ complete: () => problemResponse(409, 'INVALID_PROCESS_STATUS') });
    const onOpenChange = vi.fn();
    renderWithShell(<Harness onOpenChange={onOpenChange} />, { queryClient: noRetryClient() });
    await screen.findByText('Nenhuma pendência nesta etapa.');
    await waitFor(() => {
      expect(submitButton().disabled).toBe(false);
    });
    await user.click(submitButton());
    expect(await screen.findByText('Retome o processo antes de concluí-lo.')).toBeTruthy();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('[Falha de banco] 503 oferece "Tentar novamente" e reenvia', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const api = mockApi({
      complete: () => {
        calls += 1;
        return calls === 1
          ? problemResponse(503, 'DEPENDENCY_UNAVAILABLE')
          : jsonResponse({ data: completedDto() });
      },
    });
    renderWithShell(<Harness onOpenChange={vi.fn()} />, { queryClient: noRetryClient() });
    await screen.findByText('Nenhuma pendência nesta etapa.');
    await waitFor(() => {
      expect(submitButton().disabled).toBe(false);
    });
    await user.click(submitButton());
    await user.click(await screen.findByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByText('Processo concluído')).toBeTruthy();
    expect(callsTo(api, 'POST', COMPLETE_URL)).toHaveLength(2);
  });
});
