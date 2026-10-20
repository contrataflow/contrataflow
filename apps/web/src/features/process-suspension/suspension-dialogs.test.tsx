// @vitest-environment jsdom
import { Toaster, clearToasts } from '@contrataflow/ui';
import type { ProcessSummaryDto, SuspensionProcessDto } from '@contrataflow/validation';
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

import { ResumeProcessDialog, SuspendProcessDialog } from './suspension-dialogs';

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

const SUSPEND_URL = `${PROCESS_URL}/suspend`;
const RESUME_URL = `${PROCESS_URL}/resume`;
const BUSINESS_DAYS_URL = '/api/v1/calendar/business-days';
const ADD_DAYS_URL = '/api/v1/calendar/add-business-days';
const PROCESS_ID = PROCESS_URL.split('/').at(-1) ?? '';
const REASON = 'Aguardando definição da dotação pela Secretaria de Finanças';
const STATUS_HEADER_ID = 'process-status-header';

beforeEach(() => {
  // Só o relógio: "hoje" = 13/10/2026 15:00 em Brasília (o userEvent segue com timers reais).
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-13T18:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearToasts();
});

const noRetryClient = () => {
  const client = makeQueryClient();
  client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retry: false } });
  return client;
};

function suspendedDto(extra: Partial<SuspensionProcessDto> = {}): SuspensionProcessDto {
  const process = inStudies({ status: 'SUSPENDED', version: 15 });
  return {
    ...process,
    currentStage:
      process.currentStage === null
        ? null
        : { ...process.currentStage, pausedAt: '2026-10-06T13:00:00.000Z' },
    statusBeforeSuspension: 'IN_PROGRESS',
    suspendedAt: '2026-10-06T13:00:00.000Z',
    suspensionReason: REASON,
    ...extra,
  };
}

interface ApiOptions {
  readonly suspend?: Handler;
  readonly resume?: Handler;
  readonly businessDays?: Handler;
  readonly addDays?: Handler;
}

function mockApi(options: ApiOptions = {}) {
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';
    const answer = (handler: Handler) => Promise.resolve(handler(url, init));
    if (method === 'GET' && url === PROCESS_URL) {
      return answer(() => jsonResponse({ data: inStudies() }));
    }
    if (method === 'POST' && url === SUSPEND_URL) {
      return answer(options.suspend ?? (() => jsonResponse({ data: suspendedDto() })));
    }
    if (method === 'POST' && url === RESUME_URL) {
      return answer(
        options.resume ??
          (() =>
            jsonResponse({
              data: suspendedDto({ status: 'IN_PROGRESS', statusBeforeSuspension: null }),
              meta: {
                extendedBy: { days: 4, slaType: 'BUSINESS' },
                newDueAt: '2026-10-17T02:59:59.999Z',
              },
            })),
      );
    }
    if (method === 'GET' && url.startsWith(BUSINESS_DAYS_URL)) {
      return answer(
        options.businessDays ??
          (() =>
            jsonResponse({
              data: {
                businessDays: 4,
                dates: ['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'],
              },
            })),
      );
    }
    if (method === 'POST' && url === ADD_DAYS_URL) {
      return answer(
        options.addDays ??
          (() => jsonResponse({ data: { dueDateTime: '2026-10-17T02:59:59.999Z' } })),
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

function suspendedSummary(extra: Partial<ProcessSummaryDto> = {}): ProcessSummaryDto {
  const base = summaryDto();
  return {
    ...base,
    where: {
      ...base.where,
      status: 'SUSPENDED',
      statusBeforeSuspension: 'IN_PROGRESS',
      suspendedAt: '2026-10-06T13:00:00.000Z',
      suspensionReason: REASON,
    },
    deadline: {
      dueAt: '2026-10-10T02:59:59.999Z',
      slaType: 'BUSINESS',
      daysLeft: null,
      overdueDays: null,
      isDueSoon: false,
      isOverdue: false,
      isPaused: true,
    },
    ...extra,
  };
}

function SuspendHarness({ onOpenChange }: { readonly onOpenChange: (open: boolean) => void }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <div id={STATUS_HEADER_ID} tabIndex={-1}>
        Situação do processo
      </div>
      <SuspendProcessDialog
        processId={PROCESS_ID}
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          onOpenChange(next);
        }}
        onDone={() => document.getElementById(STATUS_HEADER_ID)?.focus()}
        retry={{ retries: 0 }}
      />
      <Toaster />
    </>
  );
}

function ResumeHarness({
  summary,
  onOpenChange,
  onReviewTargetDate,
}: {
  readonly summary: ProcessSummaryDto;
  readonly onOpenChange: (open: boolean) => void;
  readonly onReviewTargetDate?: () => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <ResumeProcessDialog
        processId={PROCESS_ID}
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          onOpenChange(next);
        }}
        summary={summary}
        onReviewTargetDate={onReviewTargetDate}
        retry={{ retries: 0 }}
      />
      <Toaster />
    </>
  );
}

const reasonField = () => screen.getByLabelText('Motivo');
const commentField = () => screen.getByLabelText('Comentário (opcional)');

describe('SCR-116 · Diálogo "Suspender processo" (US-008)', () => {
  it('[Sucesso] explica os efeitos, envia o PRC-23 com If-Match e Idempotency-Key, avisa e devolve o foco ao painel', async () => {
    const user = userEvent.setup();
    const api = mockApi();
    const onOpenChange = vi.fn();
    renderWithShell(<SuspendHarness onOpenChange={onOpenChange} />, {
      queryClient: noRetryClient(),
    });
    const dialog = await screen.findByRole('dialog', { name: 'Suspender processo' });
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
    expect(
      screen.getByText(
        'Os prazos ficam pausados e ninguém poderá tramitar ou decidir aprovações até a retomada.',
      ),
    ).toBeTruthy();
    await user.type(await screen.findByLabelText('Motivo'), REASON);
    expect(screen.getByText(`${String(REASON.length)} / 5.000`)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Suspender' }));

    await waitFor(() => {
      expect(callsTo(api, 'POST', SUSPEND_URL)).toHaveLength(1);
    });
    const [call] = callsTo(api, 'POST', SUSPEND_URL);
    expect(call?.headers.get('If-Match')).toBe('"14"');
    expect(call?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(call?.body).toEqual({ reason: REASON });
    expect(await screen.findByText('Processo suspenso. Os prazos estão pausados.')).toBeTruthy();
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
    await waitFor(() => {
      expect(document.activeElement?.id).toBe(STATUS_HEADER_ID);
    });
  });

  it('[Validação] motivo curto: erro no campo com foco, sem chamar a API', async () => {
    const user = userEvent.setup();
    const api = mockApi();
    renderWithShell(<SuspendHarness onOpenChange={vi.fn()} />, { queryClient: noRetryClient() });
    await user.type(await screen.findByLabelText('Motivo'), 'Pausa');
    await user.click(screen.getByRole('button', { name: 'Suspender' }));
    expect(
      await screen.findByText('Informe o motivo da suspensão (mínimo de 20 caracteres).'),
    ).toBeTruthy();
    expect(reasonField().getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(reasonField());
    expect(callsTo(api, 'POST', SUSPEND_URL)).toHaveLength(0);
  });

  it('[Concorrência] 412: avisa, mantém o texto digitado e recarrega o processo', async () => {
    const user = userEvent.setup();
    const api = mockApi({ suspend: () => problemResponse(412, 'VERSION_CONFLICT') });
    renderWithShell(<SuspendHarness onOpenChange={vi.fn()} />, { queryClient: noRetryClient() });
    await user.type(await screen.findByLabelText('Motivo'), REASON);
    await user.click(screen.getByRole('button', { name: 'Suspender' }));
    expect(
      await screen.findByText(
        'O processo foi alterado por outra pessoa. Recarregue e tente novamente.',
      ),
    ).toBeTruthy();
    expect((reasonField() as HTMLTextAreaElement).value).toBe(REASON);
    const before = callsTo(api, 'GET', PROCESS_URL).length;
    await user.click(screen.getByRole('button', { name: 'Recarregar' }));
    await waitFor(() => {
      expect(callsTo(api, 'GET', PROCESS_URL).length).toBeGreaterThan(before);
    });
    expect((reasonField() as HTMLTextAreaElement).value).toBe(REASON);
  });

  it('[Falha de banco] 503: mantém o diálogo e o texto, com "Tentar novamente"', async () => {
    const user = userEvent.setup();
    mockApi({ suspend: () => problemResponse(503, 'DEPENDENCY_UNAVAILABLE') });
    renderWithShell(<SuspendHarness onOpenChange={vi.fn()} />, { queryClient: noRetryClient() });
    await user.type(await screen.findByLabelText('Motivo'), REASON);
    await user.click(screen.getByRole('button', { name: 'Suspender' }));
    expect(
      await screen.findByText('Não foi possível concluir agora. Tente novamente em instantes.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Tentar novamente' })).toBeTruthy();
    expect((reasonField() as HTMLTextAreaElement).value).toBe(REASON);
  });

  it('[Validação] 409 INVALID_PROCESS_STATUS: avisa e fecha', async () => {
    const user = userEvent.setup();
    mockApi({ suspend: () => problemResponse(409, 'INVALID_PROCESS_STATUS') });
    const onOpenChange = vi.fn();
    renderWithShell(<SuspendHarness onOpenChange={onOpenChange} />, {
      queryClient: noRetryClient(),
    });
    await user.type(await screen.findByLabelText('Motivo'), REASON);
    await user.click(screen.getByRole('button', { name: 'Suspender' }));
    expect(
      await screen.findByText('Ação indisponível com o processo na situação atual.'),
    ).toBeTruthy();
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('[Acessibilidade] axe sem violações sérias', async () => {
    mockApi();
    renderWithShell(<SuspendHarness onOpenChange={vi.fn()} />, { queryClient: noRetryClient() });
    await screen.findByLabelText('Motivo');
    expect(await seriousA11yViolations()).toEqual([]);
  });
});

describe('SCR-116 · Diálogo "Retomar processo" (US-008)', () => {
  it('[Sucesso] período, 4 dias úteis acrescidos (CAL-05/06), prazo alvo e PRC-24 com comentário', async () => {
    const user = userEvent.setup();
    const api = mockApi();
    const onOpenChange = vi.fn();
    renderWithShell(<ResumeHarness summary={suspendedSummary()} onOpenChange={onOpenChange} />, {
      queryClient: noRetryClient(),
    });
    expect(await screen.findByText('Suspenso desde 06/10/2026')).toBeTruthy();
    expect(
      await screen.findByText('4 dias úteis serão acrescentados. Novo prazo: 16/10/2026.'),
    ).toBeTruthy();
    expect(screen.getByText('O prazo alvo continua 30/11/2026.')).toBeTruthy();
    const [days] = callsTo(api, 'GET', BUSINESS_DAYS_URL);
    expect(days?.url).toContain('from=2026-10-06');
    expect(days?.url).toContain('to=2026-10-12');
    expect(callsTo(api, 'POST', ADD_DAYS_URL)[0]?.body).toEqual({
      fromDateTime: '2026-10-10T02:59:59.999Z',
      businessDays: 4,
      dayCountType: 'BUSINESS',
    });

    await user.type(commentField(), 'Dotação definida.');
    await user.click(screen.getByRole('button', { name: 'Retomar' }));
    await waitFor(() => {
      expect(callsTo(api, 'POST', RESUME_URL)).toHaveLength(1);
    });
    const [call] = callsTo(api, 'POST', RESUME_URL);
    expect(call?.headers.get('If-Match')).toBe('"14"');
    expect(call?.body).toEqual({ comment: 'Dotação definida.' });
    expect(
      await screen.findByText('Processo retomado. Novo prazo da etapa: 16/10/2026.'),
    ).toBeTruthy();
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('FA-04: suspenso hoje — nenhum dia útil acrescentado; sem comentário envia corpo vazio', async () => {
    const user = userEvent.setup();
    const api = mockApi();
    const base = suspendedSummary();
    renderWithShell(
      <ResumeHarness
        summary={{ ...base, where: { ...base.where, suspendedAt: '2026-10-13T12:00:00.000Z' } }}
        onOpenChange={vi.fn()}
      />,
      { queryClient: noRetryClient() },
    );
    expect(await screen.findByText('Nenhum dia útil será acrescentado.')).toBeTruthy();
    expect(callsTo(api, 'GET', BUSINESS_DAYS_URL)).toHaveLength(0);
    await waitFor(() => {
      expect(callsTo(api, 'GET', PROCESS_URL).length).toBeGreaterThan(0);
    });
    await user.click(screen.getByRole('button', { name: 'Retomar' }));
    await waitFor(() => {
      expect(callsTo(api, 'POST', RESUME_URL)[0]?.body).toEqual({});
    });
  });

  it('FA-02: etapa sem prazo', async () => {
    mockApi();
    renderWithShell(
      <ResumeHarness summary={suspendedSummary({ deadline: null })} onOpenChange={vi.fn()} />,
      { queryClient: noRetryClient() },
    );
    expect(await screen.findByText('Esta etapa não tem prazo definido.')).toBeTruthy();
  });

  it('FA-06: "Revisar prazo alvo" fecha o diálogo e abre a edição', async () => {
    const user = userEvent.setup();
    mockApi();
    const onReview = vi.fn();
    const onOpenChange = vi.fn();
    renderWithShell(
      <ResumeHarness
        summary={suspendedSummary()}
        onOpenChange={onOpenChange}
        onReviewTargetDate={onReview}
      />,
      { queryClient: noRetryClient() },
    );
    await user.click(await screen.findByRole('button', { name: 'Revisar prazo alvo' }));
    expect(onReview).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('[Permissão] 403: avisa e fecha', async () => {
    const user = userEvent.setup();
    mockApi({ resume: () => problemResponse(403, 'PERMISSION_DENIED') });
    const onOpenChange = vi.fn();
    renderWithShell(<ResumeHarness summary={suspendedSummary()} onOpenChange={onOpenChange} />, {
      queryClient: noRetryClient(),
    });
    await screen.findByText('Suspenso desde 06/10/2026');
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Retomar' }).getAttribute('aria-disabled'),
      ).toBeNull();
    });
    await user.click(screen.getByRole('button', { name: 'Retomar' }));
    expect(
      await screen.findByText('Você não tem permissão para suspender ou retomar este processo.'),
    ).toBeTruthy();
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('[Acessibilidade] axe sem violações sérias', async () => {
    mockApi();
    renderWithShell(<ResumeHarness summary={suspendedSummary()} onOpenChange={vi.fn()} />, {
      queryClient: noRetryClient(),
    });
    await screen.findByText('Suspenso desde 06/10/2026');
    expect(await seriousA11yViolations()).toEqual([]);
  });
});
