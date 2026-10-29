// @vitest-environment jsdom
import { Toaster, clearToasts } from '@contrataflow/ui';
import type { UserLookupItem } from '@contrataflow/validation';
import { configure, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeQueryClient } from '@/lib/query/query-client';
import { seriousA11yViolations } from '@test/support/axe';
import { PROCESS_URL, inStudies } from '@test/support/forward-fixtures';
import { ID, problemResponse } from '@test/support/process-fixtures';
import type { Handler } from '@test/support/process-fixtures';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { AssignProcessDialog } from './assign-process-dialog';

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

/* US-050 · SCR-115 — diálogo "Atribuir/Reatribuir responsável" sobre o PRC-22 e o USR-02. */

const ASSIGN_URL = `${PROCESS_URL}/assign`;
const LOOKUP_URL = '/api/v1/users/lookup';
const PROCESS_ID = PROCESS_URL.split('/').at(-1) ?? '';
const STATUS_HEADER_ID = 'process-status-header';
const FELIPE = { id: ID(1), name: 'Ana Souza' };
const REASON = 'Felipe está de férias';

const member = (id: string, name: string): UserLookupItem => ({
  id,
  name,
  email: `${id}@a.test`,
  membershipType: 'INTERNAL',
  membershipExpiresAt: null,
});
const JULIANA = member(ID(61), 'Juliana Prado');
const TIAGO = member(ID(62), 'Tiago Reis');

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

const noRetryClient = () => {
  const client = makeQueryClient();
  client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retry: false } });
  return client;
};

interface ApiOptions {
  readonly responsible?: { id: string; name: string } | null;
  readonly members?: Handler;
  readonly assign?: Handler;
}

function mockApi(options: ApiOptions = {}) {
  const responsible = options.responsible === undefined ? FELIPE : options.responsible;
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    const answer = (handler: Handler) => Promise.resolve(handler(url, init));
    if (method === 'GET' && url === PROCESS_URL) {
      return answer(() => jsonResponse({ data: inStudies({ currentResponsible: responsible }) }));
    }
    if (method === 'GET' && url.startsWith(LOOKUP_URL)) {
      return answer(
        options.members ??
          (() => jsonResponse({ data: [member(FELIPE.id, FELIPE.name), JULIANA, TIAGO] })),
      );
    }
    if (method === 'POST' && url === ASSIGN_URL) {
      return answer(
        options.assign ??
          (() =>
            jsonResponse({
              data: inStudies({
                currentResponsible: { id: JULIANA.id, name: JULIANA.name },
                version: 15,
              }),
            })),
      );
    }
    return Promise.resolve(problemResponse(404, 'NOT_FOUND'));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const callsTo = (api: ReturnType<typeof mockApi>, method: string, prefix: string) =>
  api.mock.calls
    .filter(
      ([input, init]) => requestUrl(input).startsWith(prefix) && (init?.method ?? 'GET') === method,
    )
    .map(([input, init]) => ({
      url: requestUrl(input),
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    }));

function Harness({ onOpenChange }: { readonly onOpenChange: (open: boolean) => void }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <div id={STATUS_HEADER_ID} tabIndex={-1}>
        Situação do processo
      </div>
      <AssignProcessDialog
        processId={PROCESS_ID}
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          onOpenChange(next);
        }}
        onDone={() => document.getElementById(STATUS_HEADER_ID)?.focus()}
      />
      <Toaster />
    </>
  );
}

const render = (onOpenChange = vi.fn()) =>
  renderWithShell(<Harness onOpenChange={onOpenChange} />, { queryClient: noRetryClient() });
const assigneeField = () => screen.getByRole('combobox', { name: 'Novo responsável' });
const reasonField = () => screen.getByRole('textbox', { name: 'Motivo' });
/** O seletor só aparece depois que os membros da unidade carregam. */
const juliana = () => screen.findByRole('combobox', { name: 'Novo responsável' });
const choose = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
  await user.click(assigneeField());
  await user.click(await screen.findByRole('option', { name }));
};

describe('SCR-115 · Diálogo "Atribuir responsável" (US-050)', () => {
  it('[Sucesso] reatribui com motivo: lista os membros da unidade (sem o atual), envia o PRC-22 com If-Match, avisa e devolve o foco', async () => {
    const user = userEvent.setup();
    const api = mockApi();
    const onOpenChange = vi.fn();
    render(onOpenChange);
    expect(await screen.findByRole('dialog', { name: 'Reatribuir responsável' })).toBeTruthy();
    await juliana();
    // Foco inicial no seletor; o responsável atual não é oferecido; há "Deixar na fila".
    await waitFor(() => {
      expect(document.activeElement).toBe(assigneeField());
    });
    await user.click(assigneeField());
    expect(await screen.findByRole('option', { name: JULIANA.name })).toBeTruthy();
    expect(screen.queryByRole('option', { name: FELIPE.name })).toBeNull();
    expect(screen.getByRole('option', { name: 'Deixar na fila da unidade' })).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(reasonField().getAttribute('aria-required')).toBe('true');
    const [lookup] = callsTo(api, 'GET', LOOKUP_URL);
    expect(lookup?.url).toContain('departmentId=');

    await choose(user, JULIANA.name);
    await user.type(reasonField(), REASON);
    await user.click(screen.getByRole('button', { name: 'Atribuir' }));

    await waitFor(() => {
      expect(callsTo(api, 'POST', ASSIGN_URL)).toHaveLength(1);
    });
    const [call] = callsTo(api, 'POST', ASSIGN_URL);
    expect(call?.headers.get('If-Match')).toBe('"14"');
    expect(call?.headers.get('Idempotency-Key')).toBeNull();
    expect(call?.body).toEqual({ assigneeId: JULIANA.id, reason: REASON });
    expect(await screen.findByText(`Processo atribuído a ${JULIANA.name}.`)).toBeTruthy();
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    await waitFor(() => {
      expect(document.activeElement?.id).toBe(STATUS_HEADER_ID);
    });
  });

  it('[FA-01] primeira atribuição a partir da fila: motivo opcional e sem "Deixar na fila"', async () => {
    const user = userEvent.setup();
    const api = mockApi({ responsible: null });
    render();
    expect(await screen.findByRole('dialog', { name: 'Atribuir responsável' })).toBeTruthy();
    await juliana();
    await user.click(assigneeField());
    expect(await screen.findByRole('option', { name: JULIANA.name })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Deixar na fila da unidade' })).toBeNull();
    await user.keyboard('{Escape}');
    expect(
      screen.getByRole('textbox', { name: 'Motivo (opcional)' }).getAttribute('aria-required'),
    ).toBeNull();
    await choose(user, JULIANA.name);
    await user.click(screen.getByRole('button', { name: 'Atribuir' }));
    await waitFor(() => {
      expect(callsTo(api, 'POST', ASSIGN_URL)).toHaveLength(1);
    });
    expect(callsTo(api, 'POST', ASSIGN_URL)[0]?.body).toEqual({ assigneeId: JULIANA.id });
  });

  it('[FA-02] deixar na fila da unidade envia assigneeId null e avisa', async () => {
    const user = userEvent.setup();
    const api = mockApi({
      assign: () => jsonResponse({ data: inStudies({ currentResponsible: null, version: 15 }) }),
    });
    render();
    await juliana();
    await choose(user, 'Deixar na fila da unidade');
    await user.type(reasonField(), 'Redistribuir na equipe');
    await user.click(screen.getByRole('button', { name: 'Atribuir' }));
    await waitFor(() => {
      expect(callsTo(api, 'POST', ASSIGN_URL)).toHaveLength(1);
    });
    expect(callsTo(api, 'POST', ASSIGN_URL)[0]?.body).toEqual({
      assigneeId: null,
      reason: 'Redistribuir na equipe',
    });
    expect(await screen.findByText('Processo devolvido para a fila da unidade.')).toBeTruthy();
  });

  it('[Validação] reatribuição sem motivo: erro no campo com foco, sem chamar a API', async () => {
    const user = userEvent.setup();
    const api = mockApi();
    render();
    await juliana();
    await choose(user, JULIANA.name);
    await user.click(screen.getByRole('button', { name: 'Atribuir' }));
    expect(await screen.findByText('Informe o motivo da troca de responsável.')).toBeTruthy();
    expect(document.activeElement).toBe(reasonField());
    expect(reasonField().getAttribute('aria-invalid')).toBe('true');
    expect(callsTo(api, 'POST', ASSIGN_URL)).toHaveLength(0);
  });

  it('[Validação] sem escolha: erro no seletor', async () => {
    const user = userEvent.setup();
    mockApi({ responsible: null });
    render();
    await juliana();
    await user.click(screen.getByRole('button', { name: 'Atribuir' }));
    expect(
      await screen.findByText('Selecione um responsável ou deixe na fila da unidade.'),
    ).toBeTruthy();
    expect(document.activeElement).toBe(assigneeField());
  });

  it('[Validação] 422 VALIDATION_ERROR da API em reason vai para o campo', async () => {
    const user = userEvent.setup();
    mockApi({
      assign: () =>
        problemResponse(422, 'VALIDATION_ERROR', {
          errors: [
            {
              field: 'reason',
              code: 'REQUIRED',
              message: 'Informe o motivo da troca de responsável.',
            },
          ],
        }),
    });
    render();
    await juliana();
    await choose(user, JULIANA.name);
    await user.type(reasonField(), REASON);
    await user.click(screen.getByRole('button', { name: 'Atribuir' }));
    expect(await screen.findByText('Informe o motivo da troca de responsável.')).toBeTruthy();
    expect(reasonField()).toHaveProperty('value', REASON);
  });

  it('[Tenant incorreto/elegibilidade] ASSIGNEE_NOT_ELIGIBLE remove a opção e recarrega a lista', async () => {
    const user = userEvent.setup();
    const api = mockApi({ assign: () => problemResponse(422, 'ASSIGNEE_NOT_ELIGIBLE') });
    render();
    await juliana();
    await choose(user, JULIANA.name);
    await user.type(reasonField(), REASON);
    await user.click(screen.getByRole('button', { name: 'Atribuir' }));
    expect(
      await screen.findByText('Esta pessoa não pode ser responsável por este processo.'),
    ).toBeTruthy();
    await waitFor(() => {
      expect(callsTo(api, 'GET', LOOKUP_URL).length).toBeGreaterThan(1);
    });
    await user.click(assigneeField());
    expect(await screen.findByRole('option', { name: 'Deixar na fila da unidade' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: JULIANA.name })).toBeNull();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(callsTo(api, 'GET', LOOKUP_URL).length).toBeGreaterThan(1);
    });
  });

  it('[Tenant incorreto] REFERENCE_NOT_FOUND pede outra pessoa e recarrega os membros', async () => {
    const user = userEvent.setup();
    const api = mockApi({
      assign: () =>
        problemResponse(422, 'VALIDATION_ERROR', {
          errors: [
            {
              field: 'assigneeId',
              code: 'REFERENCE_NOT_FOUND',
              message: 'Selecione um responsável válido.',
            },
          ],
        }),
    });
    render();
    await juliana();
    await choose(user, JULIANA.name);
    await user.type(reasonField(), REASON);
    await user.click(screen.getByRole('button', { name: 'Atribuir' }));
    expect(await screen.findByText('Selecione um responsável válido.')).toBeTruthy();
    await waitFor(() => {
      expect(callsTo(api, 'GET', LOOKUP_URL).length).toBeGreaterThan(1);
    });
  });

  it('[Duplicidade/Concorrência] 412 VERSION_CONFLICT pede para atualizar e mantém o texto', async () => {
    const user = userEvent.setup();
    mockApi({ assign: () => problemResponse(412, 'VERSION_CONFLICT') });
    render();
    await juliana();
    await choose(user, JULIANA.name);
    await user.type(reasonField(), REASON);
    await user.click(screen.getByRole('button', { name: 'Atribuir' }));
    expect(
      await screen.findByText('Os dados do processo mudaram. Atualize a página.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Recarregar' })).toBeTruthy();
    expect(reasonField()).toHaveProperty('value', REASON);
  });

  it('[Permissão] 403 fecha o diálogo com o aviso', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    mockApi({ assign: () => problemResponse(403, 'PERMISSION_DENIED') });
    render(onOpenChange);
    await juliana();
    await choose(user, JULIANA.name);
    await user.type(reasonField(), REASON);
    await user.click(screen.getByRole('button', { name: 'Atribuir' }));
    expect(
      await screen.findByText('Você não pode atribuir responsáveis neste processo.'),
    ).toBeTruthy();
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('[Falha de banco] 503 oferece "Tentar novamente" e reenvia', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const api = mockApi({
      assign: () => {
        calls += 1;
        return calls === 1
          ? problemResponse(503, 'DEPENDENCY_UNAVAILABLE')
          : jsonResponse({
              data: inStudies({ currentResponsible: { id: JULIANA.id, name: JULIANA.name } }),
            });
      },
    });
    render();
    await juliana();
    await choose(user, JULIANA.name);
    await user.type(reasonField(), REASON);
    await user.click(screen.getByRole('button', { name: 'Atribuir' }));
    expect(
      await screen.findByText(
        'Não foi possível atribuir o processo agora. Tente novamente em instantes.',
      ),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    await waitFor(() => {
      expect(callsTo(api, 'POST', ASSIGN_URL)).toHaveLength(2);
    });
    expect(await screen.findByText(`Processo atribuído a ${JULIANA.name}.`)).toBeTruthy();
  });

  it('[Estados] unidade sem outros membros mostra o vazio; erro de carregamento oferece nova tentativa', async () => {
    const user = userEvent.setup();
    let attempt = 0;
    mockApi({
      members: () => {
        attempt += 1;
        return attempt === 1
          ? problemResponse(503, 'DEPENDENCY_UNAVAILABLE')
          : jsonResponse({ data: [member(FELIPE.id, FELIPE.name)] });
      },
    });
    render();
    expect(
      await screen.findByText('Não foi possível carregar os membros da unidade.'),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByText('Nenhum outro membro ativo nesta unidade.')).toBeTruthy();
  });

  it('[Acessibilidade] axe sem violações sérias', async () => {
    mockApi();
    render();
    await juliana();
    expect(await seriousA11yViolations()).toEqual([]);
  });
});
