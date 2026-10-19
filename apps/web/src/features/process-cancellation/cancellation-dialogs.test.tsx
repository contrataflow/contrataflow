// @vitest-environment jsdom
import { Toaster, clearToasts } from '@contrataflow/ui';
import type { CanceledProcessDto, ProcessSummaryDto } from '@contrataflow/validation';
import { configure, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeQueryClient } from '@/lib/query/query-client';
import { seriousA11yViolations } from '@test/support/axe';
import { PROCESS_URL, inStudies } from '@test/support/forward-fixtures';
import { problemResponse, summaryDto } from '@test/support/process-fixtures';
import type { Handler } from '@test/support/process-fixtures';
import { jsonResponse, renderWithShell, requestUrl } from '@test/support/render';

import { CancelProcessDialog, DiscardDraftDialog } from './cancellation-dialogs';

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

const nav = { push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn() };
vi.mock('next/navigation', () => ({
  useRouter: () => nav,
  usePathname: () => '/processos/x',
}));

const CANCEL_URL = `${PROCESS_URL}/cancel`;
const PROCESS_ID = PROCESS_URL.split('/').at(-1) ?? '';
const REASON = 'Demanda já atendida por contrato vigente';

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

function canceledDto(): CanceledProcessDto {
  return {
    ...inStudies({ status: 'CANCELED', version: 15 }),
    canceledAt: '2026-10-06T13:00:00.000Z',
    cancellationReason: REASON,
  };
}

function mockApi(options: { readonly cancel?: Handler; readonly discard?: Handler } = {}) {
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    const answer = (handler: Handler) => Promise.resolve(handler(url, init));
    if (method === 'GET' && url === PROCESS_URL) {
      return answer(() => jsonResponse({ data: inStudies() }));
    }
    if (method === 'POST' && url === CANCEL_URL) {
      return answer(options.cancel ?? (() => jsonResponse({ data: canceledDto() })));
    }
    if (method === 'DELETE' && url === PROCESS_URL) {
      return answer(options.discard ?? (() => new Response(null, { status: 204 })));
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

/** Painel com 1 aprovação pendente e o DFD em aprovação (FA-02). */
function awaitingSummary(): ProcessSummaryDto {
  const base = summaryDto();
  return {
    ...base,
    documents: base.documents.map((document, index) => ({ ...document, inApproval: index === 0 })),
    approvals: [
      {
        id: '0192f009-0000-7000-8000-000000000001',
        title: 'Aprovação da autoridade',
        approverLabel: 'Roberto Lima',
        requestedAt: '2026-10-04T12:00:00.000Z',
        dueAt: null,
        isOverdue: false,
        isMine: false,
      },
    ],
  };
}

function CancelHarness({
  summary,
  onOpenChange,
}: {
  readonly summary: ProcessSummaryDto;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <CancelProcessDialog
        processId={PROCESS_ID}
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          onOpenChange(next);
        }}
        summary={summary}
        retry={{ retries: 0 }}
      />
      <Toaster />
    </>
  );
}

function DiscardHarness({
  onOpenChange,
  onCancelInstead,
}: {
  readonly onOpenChange: (open: boolean) => void;
  readonly onCancelInstead?: () => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <DiscardDraftDialog
        processId={PROCESS_ID}
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          onOpenChange(next);
        }}
        onCancelInstead={onCancelInstead}
        retry={{ retries: 0 }}
      />
      <Toaster />
    </>
  );
}

const submitButton = (name: string) => screen.getByRole<HTMLButtonElement>('button', { name });

describe('SCR-116 · Diálogo "Cancelar processo" (US-009)', () => {
  it('[Sucesso] lista os impactos, habilita só com 20 caracteres, envia o PRC-25 com If-Match e avisa', async () => {
    const user = userEvent.setup();
    const api = mockApi();
    const onOpenChange = vi.fn();
    renderWithShell(<CancelHarness summary={awaitingSummary()} onOpenChange={onOpenChange} />, {
      queryClient: noRetryClient(),
    });
    const dialog = await screen.findByRole('dialog', { name: 'Cancelar processo' });
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
    // FA-02: o diálogo avisa o que será encerrado; o aviso descreve o campo (`aria-describedby`).
    const approvals = screen.getByText('1 aprovação pendente será cancelada');
    expect(approvals).toBeTruthy();
    expect(
      screen.getByText(
        '1 documento em aprovação voltará a rascunho ou perderá o selo de aprovação',
      ),
    ).toBeTruthy();
    const field = screen.getByLabelText('Justificativa');
    // Foco inicial no campo de justificativa.
    await waitFor(() => {
      expect(document.activeElement).toBe(field);
    });
    const impactId = approvals.closest('div')?.id ?? '';
    expect(field.getAttribute('aria-describedby')).toContain(impactId);

    // FA-04: desabilitado até atingir 20 caracteres.
    await user.type(field, 'Curta demais');
    expect(submitButton('Cancelar processo').disabled).toBe(true);
    await user.clear(field);
    await user.type(field, REASON);
    expect(screen.getByText(`${String(REASON.length)} / 5.000`)).toBeTruthy();
    await waitFor(() => {
      expect(submitButton('Cancelar processo').disabled).toBe(false);
    });
    expect(await seriousA11yViolations(document.body)).toEqual([]);
    await user.click(submitButton('Cancelar processo'));

    await waitFor(() => {
      expect(callsTo(api, 'POST', CANCEL_URL)).toHaveLength(1);
    });
    const [call] = callsTo(api, 'POST', CANCEL_URL);
    expect(call?.headers.get('If-Match')).toBe('"14"');
    expect(call?.body).toEqual({ cancellationReason: REASON });
    expect(await screen.findByText('Processo cancelado')).toBeTruthy();
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('sem aprovação pendente: só a etapa e o caráter definitivo como impactos', async () => {
    mockApi();
    renderWithShell(<CancelHarness summary={summaryDto()} onOpenChange={vi.fn()} />, {
      queryClient: noRetryClient(),
    });
    await screen.findByRole('dialog', { name: 'Cancelar processo' });
    expect(screen.queryByText(/aprovaç(ão|ões) pendente/)).toBeNull();
    expect(screen.getByText('A etapa atual e a responsabilidade serão encerradas.')).toBeTruthy();
  });

  it('[Concorrência] 412 mantém o texto e oferece "Recarregar"', async () => {
    const user = userEvent.setup();
    const api = mockApi({ cancel: () => problemResponse(412, 'VERSION_CONFLICT') });
    renderWithShell(<CancelHarness summary={summaryDto()} onOpenChange={vi.fn()} />, {
      queryClient: noRetryClient(),
    });
    await user.type(await screen.findByLabelText('Justificativa'), REASON);
    await waitFor(() => {
      expect(submitButton('Cancelar processo').disabled).toBe(false);
    });
    await user.click(submitButton('Cancelar processo'));
    expect(
      await screen.findByText(
        'Este processo foi alterado por outra pessoa. Recarregue a página e tente novamente.',
      ),
    ).toBeTruthy();
    expect(screen.getByLabelText<HTMLTextAreaElement>('Justificativa').value).toBe(REASON);
    await user.click(screen.getByRole('button', { name: 'Recarregar' }));
    await waitFor(() => {
      expect(callsTo(api, 'GET', PROCESS_URL).length).toBeGreaterThanOrEqual(2);
    });
  });

  it('[Duplicidade] 409 INVALID_PROCESS_STATUS fecha o diálogo com o aviso', async () => {
    const user = userEvent.setup();
    mockApi({ cancel: () => problemResponse(409, 'INVALID_PROCESS_STATUS') });
    const onOpenChange = vi.fn();
    renderWithShell(<CancelHarness summary={summaryDto()} onOpenChange={onOpenChange} />, {
      queryClient: noRetryClient(),
    });
    await user.type(await screen.findByLabelText('Justificativa'), REASON);
    await waitFor(() => {
      expect(submitButton('Cancelar processo').disabled).toBe(false);
    });
    await user.click(submitButton('Cancelar processo'));
    expect(await screen.findByText('Este processo já foi encerrado.')).toBeTruthy();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('[Falha de banco] 503 oferece "Tentar novamente" e reenvia', async () => {
    const user = userEvent.setup();
    let calls = 0;
    const api = mockApi({
      cancel: () => {
        calls += 1;
        return calls === 1
          ? problemResponse(503, 'DEPENDENCY_UNAVAILABLE')
          : jsonResponse({ data: canceledDto() });
      },
    });
    renderWithShell(<CancelHarness summary={summaryDto()} onOpenChange={vi.fn()} />, {
      queryClient: noRetryClient(),
    });
    await user.type(await screen.findByLabelText('Justificativa'), REASON);
    await waitFor(() => {
      expect(submitButton('Cancelar processo').disabled).toBe(false);
    });
    await user.click(submitButton('Cancelar processo'));
    expect(await screen.findByText('Não foi possível concluir a ação agora.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByText('Processo cancelado')).toBeTruthy();
    expect(callsTo(api, 'POST', CANCEL_URL)).toHaveLength(2);
  });

  it('[Permissão] 403 fecha o diálogo com o aviso', async () => {
    const user = userEvent.setup();
    mockApi({ cancel: () => problemResponse(403, 'PERMISSION_DENIED') });
    renderWithShell(<CancelHarness summary={summaryDto()} onOpenChange={vi.fn()} />, {
      queryClient: noRetryClient(),
    });
    await user.type(await screen.findByLabelText('Justificativa'), REASON);
    await waitFor(() => {
      expect(submitButton('Cancelar processo').disabled).toBe(false);
    });
    await user.click(submitButton('Cancelar processo'));
    expect(await screen.findByText('Você não tem permissão para esta ação.')).toBeTruthy();
  });
});

describe('SCR-116 · Diálogo "Descartar rascunho" (US-009)', () => {
  it('[Sucesso] envia o PRC-06 com If-Match (sem corpo sem motivo), avisa e volta à lista', async () => {
    const user = userEvent.setup();
    const api = mockApi();
    const onOpenChange = vi.fn();
    renderWithShell(<DiscardHarness onOpenChange={onOpenChange} />, {
      queryClient: noRetryClient(),
    });
    await screen.findByRole('dialog', { name: 'Descartar rascunho' });
    expect(
      screen.getByText(
        'O rascunho será excluído e deixará de aparecer nas listas e buscas. Esta ação não pode ser desfeita.',
      ),
    ).toBeTruthy();
    await waitFor(() => {
      expect(submitButton('Descartar').disabled).toBe(false);
    });
    expect(await seriousA11yViolations(document.body)).toEqual([]);
    await user.click(submitButton('Descartar'));

    await waitFor(() => {
      expect(callsTo(api, 'DELETE', PROCESS_URL)).toHaveLength(1);
    });
    const [call] = callsTo(api, 'DELETE', PROCESS_URL);
    expect(call?.headers.get('If-Match')).toBe('"14"');
    expect(call?.body).toBeUndefined();
    expect(await screen.findByText('Rascunho descartado')).toBeTruthy();
    expect(nav.push).toHaveBeenCalledWith('/processos');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('com motivo: vai no corpo do DELETE', async () => {
    const user = userEvent.setup();
    const api = mockApi();
    renderWithShell(<DiscardHarness onOpenChange={vi.fn()} />, { queryClient: noRetryClient() });
    await user.type(await screen.findByLabelText('Motivo (opcional)'), ' Aberto por engano ');
    await waitFor(() => {
      expect(submitButton('Descartar').disabled).toBe(false);
    });
    await user.click(submitButton('Descartar'));
    await waitFor(() => {
      expect(callsTo(api, 'DELETE', PROCESS_URL)[0]?.body).toEqual({
        reason: 'Aberto por engano',
      });
    });
  });

  it('FA-01: rascunho já numerado → 409 e a oferta "Cancelar processo"', async () => {
    const user = userEvent.setup();
    mockApi({ discard: () => problemResponse(409, 'CANNOT_DISCARD_NUMBERED_PROCESS') });
    const onCancelInstead = vi.fn();
    const onOpenChange = vi.fn();
    renderWithShell(
      <DiscardHarness onOpenChange={onOpenChange} onCancelInstead={onCancelInstead} />,
      { queryClient: noRetryClient() },
    );
    await screen.findByRole('dialog', { name: 'Descartar rascunho' });
    await waitFor(() => {
      expect(submitButton('Descartar').disabled).toBe(false);
    });
    await user.click(submitButton('Descartar'));
    expect(await screen.findByText('Este processo já tem número; cancele-o.')).toBeTruthy();
    expect(nav.push).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Cancelar processo' }));
    expect(onCancelInstead).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('[Tenant incorreto] 404 avisa e volta à lista', async () => {
    const user = userEvent.setup();
    mockApi({ discard: () => problemResponse(404, 'PROCESS_NOT_FOUND') });
    renderWithShell(<DiscardHarness onOpenChange={vi.fn()} />, { queryClient: noRetryClient() });
    await screen.findByRole('dialog', { name: 'Descartar rascunho' });
    await waitFor(() => {
      expect(submitButton('Descartar').disabled).toBe(false);
    });
    await user.click(submitButton('Descartar'));
    expect(await screen.findByText('Processo não encontrado.')).toBeTruthy();
    expect(nav.push).toHaveBeenCalledWith('/processos');
  });
});
